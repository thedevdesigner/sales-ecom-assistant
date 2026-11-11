import { generateAICompletion, generateAICompletionStream } from '../services/aiClient.js';
import { searchShopifyProducts, discoverStorePages } from '../adapters/shopifyAdapter.js';
import { scrapeProductDetails } from '../adapters/productScraper.js';
import { logger } from '../utils/logger.js';

const agentTools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search store catalog for PURCHASE intent (e.g., 'do you have X?', items under a price limit, or asking to buy products).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Clean target product keyword." },
          maxPrice: { type: "number", description: "Maximum budget limit." },
          minPrice: { type: "number", description: "Minimum budget limit." },
          limit: { type: "number", description: "Set to 1 for a single specific item, or more for browsing." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "discover_store_pages",
      description: "MANDATORY FOR INQUIRIES. Discover official store pages (policies, refund, return, shipping, terms, contact) by keyword. NEVER answer policy questions from memory without checking first.",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Keyword to search (e.g., 'refund', 'shipping', 'contact', 'terms')" }
        },
        required: ["keyword"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scrape_product_details",
      description: "Scrape and read deep page content or policy text via Jina AI for INQUIRY intent.",
      parameters: {
        type: "object",
        properties: {
          productUrl: { type: "string", description: "The full URL of the page to inspect." }
        },
        required: ["productUrl"]
      }
    }
  }
];

export async function runChatPipeline(vendor, messages, sink = null) {
  const storeUrl = vendor.storeUrl || `https://${vendor.domain || 'nordicknives.com'}`;
  
  // Extract latest user query
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const normalizedUserQuery = lastUserMsg.toLowerCase().trim();

  let productsToDeliver = [];
  let chips = [];
  let intent = 'inquiry';
  let contextInjected = false;

  // ---------------------------------------------------------------------------
  // 1. DETERMINISTIC PRE-ROUTER (Bypasses LLM Parametric Laziness completely)
  // ---------------------------------------------------------------------------
  const policyRegex = /(refund|return|policy|shipping|deliver|terms|privacy|contact|support|about|faq)/i;
  
  if (policyRegex.test(normalizedUserQuery)) {
    let kw = 'policy';
    if (/refund|return/.test(normalizedUserQuery)) kw = 'refund';
    else if (/shipping|deliver/.test(normalizedUserQuery)) kw = 'shipping';
    else if (/contact|support|reach/.test(normalizedUserQuery)) kw = 'contact';
    else if (/terms|condition/.test(normalizedUserQuery)) kw = 'terms';

    try {
      logger.info(`⚡ [Pre-Router] Intercepted policy inquiry. Discovering paths for: "${kw}"`);
      const discoveredPages = await discoverStorePages(storeUrl, kw);
      
      if (discoveredPages && discoveredPages.length > 0) {
        const targetUrl = discoveredPages[0];
        logger.info(`⚡ [Pre-Router] Scraping live context from: ${targetUrl}`);
        const scraped = await scrapeProductDetails(targetUrl);
        
        if (scraped && scraped.content && !scraped.error) {
          // Force-inject live scraped context into system context
          messages.push({
            role: "system",
            content: `[OFFICIAL VERIFIED STORE CONTEXT FROM ${targetUrl}]:\n${scraped.content}\n\n[INSTRUCTION]: Answer the user's inquiry strictly based on the verified context above. Keep products [] empty.`
          });
          contextInjected = true;
        }
      }
    } catch (preRouterErr) {
      logger.error('[Pre-Router] Execution failed, falling back to agent tool selection', { error: preRouterErr.message });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. SYSTEM PROMPT & FEW-SHOT INSTRUCTION SCALPEL
  // ---------------------------------------------------------------------------
  const systemMessage = {
    role: "system",
    content: `You are an expert sales assistant for ${vendor.name}. Classify every user message into one of three strict intents and handle it accordingly:

1. **INQUIRY**: 
   - User asks about company trust, policies, background ("Is this company trusted?", "What is your return policy?"), or general info.
   - **Rule**: NEVER guess or answer policies from pre-trained knowledge. If official store context is injected in system messages, summarize it directly. Otherwise, call \`discover_store_pages\`, then \`scrape_product_details\`. \`products\` must be empty \`[]\`.

2. **PURCHASE**: 
   - User wants to buy, asks if an item is in stock ("Do you have..."), or gives a budget ("under $100").
   - **Rule**: Call \`search_products\`. Return 1 item if specific, or up to 8 if browsing.

3. **COMPARISON**: 
   - User wants to compare two or more specific items.
   - **Rule**: Fetch compared items and contrast Option A vs Option B in text reply.

- NEVER output raw JSON, code blocks, or markdown code formatting in your reply text.`
  };

  const conversationHistory = [systemMessage, ...messages.slice(-8)];
  let updatedHistory = [...conversationHistory];

  try {
    let currentResponse = await generateAICompletion(conversationHistory, {
      tools: agentTools,
      tool_choice: contextInjected ? "none" : "auto" // Skip tool overhead if context was pre-routed
    });

    let iterations = 0;
    // Multi-turn tool execution loop (allows discovering paths -> then scraping)
    while (currentResponse?.tool_calls && currentResponse.tool_calls.length > 0 && iterations < 2) {
      iterations++;
      const assistantMessage = typeof currentResponse === 'string'
        ? { role: 'assistant', content: currentResponse }
        : currentResponse;

      updatedHistory.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        let args = {};

        try {
          args = typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments || '{}')
            : (toolCall.function.arguments || {});
        } catch (parseErr) {
          logger.error('[Pipeline] Tool arguments parse error', { raw: toolCall.function.arguments });
        }

        let toolResult = null;

        try {
          if (funcName === "search_products") {
            intent = 'purchase';
            
            // Normalize generic browse/bestseller terms to fetch available active catalog items
            let cleanQuery = args.query || '';
            const genericBrowseRegex = /(bestseller|best seller|popular|sale|new|catalog|browse|recommend)/i;
            if (genericBrowseRegex.test(cleanQuery)) {
              cleanQuery = ''; 
            }

            const searchResults = await searchShopifyProducts(storeUrl, { ...args, query: cleanQuery, inStockOnly: true }, vendor.currency || 'USD');
            let rawProducts = Array.isArray(searchResults) ? searchResults : [];
            
            if (args.limit === 1 && rawProducts.length > 0) {
              productsToDeliver = [rawProducts[0]];
            } else {
              productsToDeliver = rawProducts.slice(0, 8);
            }

            toolResult = {
              status: productsToDeliver.length > 0 ? 'FOUND' : 'EMPTY_RESULTS',
              totalFound: productsToDeliver.length,
              products: productsToDeliver
            };

            if (productsToDeliver.length === 0) {
              chips = ["Browse catalog", "View new arrivals", "Contact support"];
            }
          } 
          else if (funcName === "discover_store_pages") {
            intent = 'inquiry';
            const discoveredPages = await discoverStorePages(storeUrl, args.keyword || '');
            toolResult = {
              status: discoveredPages.length > 0 ? 'FOUND' : 'EMPTY_RESULTS',
              pages: discoveredPages
            };
          }
          else if (funcName === "scrape_product_details") {
            intent = 'inquiry';
            const scrapedData = await scrapeProductDetails(args.productUrl);
            toolResult = { status: 'FOUND', details: scrapedData };
          }
        } catch (toolExecErr) {
          logger.error(`[Pipeline] Tool execution error '${funcName}'`, { error: toolExecErr.message });
          toolResult = { status: 'ERROR', totalFound: 0 };
        }

        updatedHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: funcName,
          content: JSON.stringify(toolResult ?? {})
        });
      }

      // If tools were called, check if the model wants to call more tools or if we reached max iterations
      if (iterations < 2) {
        currentResponse = await generateAICompletion(updatedHistory, {
          tools: agentTools,
          tool_choice: "auto"
        });
      } else {
        break;
      }
    }

    // If the model produced a direct text response without tool calls initially, push it safely
    if (currentResponse?.content && (!currentResponse.tool_calls || currentResponse.tool_calls.length === 0)) {
      updatedHistory.push(currentResponse);
    }

    if (sink) {
      sink.meta({
        intent,
        products: productsToDeliver,
        chips,
        state: 'normal',
        strikes: 0
      });
    }

    let finalReplyText = '';
    try {
      // If history ends with tool calls or user messages, generate stream directly
      if (sink && typeof generateAICompletionStream === 'function') {
        finalReplyText = await generateAICompletionStream(updatedHistory, {
          onDelta: (text) => sink.delta(text),
          isAborted: () => sink.aborted
        });
      } else {
        const finalMsg = await generateAICompletion(updatedHistory);
        finalReplyText = typeof finalMsg === 'string' ? finalMsg : finalMsg?.content || '';
        if (sink) sink.delta(finalReplyText);
      }
    } catch (streamErr) {
      logger.error('[Pipeline] Final response generation failed', { error: streamErr.message });
      finalReplyText = productsToDeliver.length > 0
        ? `Here are the options I found for you at ${vendor.name}:`
        : `I'm happy to assist you with any questions regarding ${vendor.name}'s products or policies!`;
      if (sink) sink.delta(finalReplyText);
    }

    if (!finalReplyText || !finalReplyText.trim()) {
      finalReplyText = productsToDeliver.length > 0
        ? `Here are the options I found for you at ${vendor.name}:`
        : `I'm happy to assist you with any questions regarding ${vendor.name}'s products or policies!`;
      if (sink) sink.delta(finalReplyText);
    }

    const result = {
      reply: finalReplyText,
      intent,
      products: productsToDeliver,
      state: 'normal',
      strikes: 0,
      ...(chips.length > 0 ? { chips } : {})
    };

    if (sink) sink.done({ state: 'normal', strikes: 0 });
    return result;

  } catch (criticalErr) {
    logger.error('[Pipeline Critical Failure]', { error: criticalErr.message });
    const fallbackMessage = "I'm having a little trouble connecting right now. Please try again in a moment!";
    return emitAndReturn(sink, fallbackMessage, [], ["Try again", "View catalog"], 'inquiry');
  }
}

function emitAndReturn(sink, reply, products, chips = [], intent = 'inquiry') {
  if (sink) {
    sink.meta({ intent, products, chips, state: 'normal', strikes: 0 });
    sink.delta(reply);
    sink.done({ state: 'normal', strikes: 0 });
  }
  return {
    reply,
    intent,
    products,
    state: 'normal',
    strikes: 0,
    ...(chips.length > 0 ? { chips } : {})
  };
}