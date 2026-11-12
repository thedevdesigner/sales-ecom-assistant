import { generateAICompletion, generateAICompletionStream } from '../services/aiClient.js';
import { searchShopifyProducts, discoverStorePages } from '../adapters/shopifyAdapter.js';
import { scrapeProductDetails } from '../adapters/productScraper.js';
import { logger } from '../utils/logger.js';

const agentTools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search store catalog for specific product names or keywords. Never call for bestsellers or general catalogs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Specific product keyword. Never pass empty or generic terms." },
          maxPrice: { type: "number", description: "Maximum budget limit." },
          limit: { type: "number", description: "Number of items to fetch (max 8)." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "discover_store_pages",
      description: "Discover official store pages (policies, refund, return, shipping, terms, contact).",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Keyword to search ('refund', 'shipping', 'contact')" }
        },
        required: ["keyword"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scrape_product_details",
      description: "Scrape and read page content or policy text via URL.",
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
  const storeName = vendor.name || 'this store';
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const normalizedUserQuery = lastUserMsg.toLowerCase().trim();

  let productsToDeliver = [];
  let chips = [];
  let intent = 'inquiry';
  let contextInjected = false;

  const updateStatus = (text) => {
    if (sink && typeof sink.status === 'function') sink.status(text);
  };

  // ---------------------------------------------------------------------------
  // 1. FAST-PATH POLICY PRE-ROUTER
  // ---------------------------------------------------------------------------
  const policyRegex = /(refund|return|policy|shipping|deliver|terms|privacy|contact|support|about|faq)/i;
  
  if (policyRegex.test(normalizedUserQuery)) {
    let kw = 'policy';
    if (/refund|return/.test(normalizedUserQuery)) kw = 'refund';
    else if (/shipping|deliver/.test(normalizedUserQuery)) kw = 'shipping';
    else if (/contact|support|reach/.test(normalizedUserQuery)) kw = 'contact';

    try {
      updateStatus('Checking store policies...');
      const discoveredPages = await discoverStorePages(storeUrl, kw);
      if (discoveredPages && discoveredPages.length > 0) {
        updateStatus('Reading official policy page...');
        const scraped = await scrapeProductDetails(discoveredPages[0]);
        if (scraped && scraped.content && !scraped.error) {
          messages.push({
            role: "system",
            content: `[VERIFIED STORE POLICY FROM ${discoveredPages[0]}]:\n${scraped.content}\nAnswer strictly based on this context. Keep products [] empty.`
          });
          contextInjected = true;
          intent = 'inquiry';
        }
      }
    } catch (e) {
      logger.warn('[Pre-Router] Policy check skipped', { error: e.message });
    }
  }

  const systemMessage = {
    role: "system",
    content: `You are an expert, helpful AI shopping assistant for ${storeName}. 

Follow these core rules strictly:
1. **GREETINGS & GENERAL INQUIRIES** (e.g., "Hello", "Hi, can you help me?"):
   - Respond warmly and directly as the store's shopping assistant. Explain how you can help (finding specific products, comparing items, or checking store policies). Do NOT call any tools.

2. **BEST-SELLER / POPULARITY REQUESTS** (e.g., "What are your bestsellers?", "Show me top selling items"):
   - Store sales volumes and best-seller rankings are not publicly listed in the catalog.
   - Politely inform the user that best-selling rankings aren't listed, and ask what specific product type or category they are looking for. Do NOT call "search_products".

3. **PURCHASE & PRODUCT SEARCH**:
   - When the user asks for a specific product name or category, call "search_products" with a clear keyword. Never pass vague or empty terms like "catalog", "all", or "bestsellers".

4. **INQUIRY (POLICIES & SUPPORT)**:
   - Use verified policy context or discover/scrape store pages. Keep products empty.

5. **OFF-TOPIC**:
   - Politely decline in 1 sentence and pivot back to helping them shop at ${storeName}.

- Never output raw JSON, code blocks, or markdown code formatting in your reply text.`
  };

  const conversationHistory = [systemMessage, ...messages.slice(-6)];
  let updatedHistory = [...conversationHistory];

  try {
    updateStatus('Analyzing request...');
    let currentResponse = await generateAICompletion(conversationHistory, contextInjected ? {} : {
      tools: agentTools,
      tool_choice: "auto"
    });

    // Single-turn tool execution guard
    if (currentResponse?.tool_calls && currentResponse.tool_calls.length > 0) {
      const assistantMessage = currentResponse;
      updatedHistory.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch(e){}

        let toolResult = { status: 'EMPTY_RESULTS', products: [] };

        try {
          if (funcName === "search_products") {
            intent = 'purchase';
            let cleanQuery = (args.query || '').trim();
            
            const broadQueryRegex = /^(all|catalog|store|products|items|latest|collection|browse|bestseller|best seller|popular|sale|new)$/i;
            if (!cleanQuery || broadQueryRegex.test(cleanQuery)) {
              toolResult = {
                status: 'UNAVAILABLE_METRIC',
                message: 'Catalog rankings are not listed. Ask the user for a specific product keyword.'
              };
              chips = ['Browse categories', 'Contact support'];
            } else {
              updateStatus('Searching catalog...');
              console.time('⏱️ Vector Search / Product Lookup');
              const searchResults = await searchShopifyProducts(storeUrl, { query: cleanQuery, inStockOnly: true, limit: args.limit || 6 }, vendor.currency || 'USD');
              console.timeEnd('⏱️ Vector Search / Product Lookup');

              productsToDeliver = Array.isArray(searchResults) ? searchResults.slice(0, 6) : [];
              toolResult = {
                status: productsToDeliver.length > 0 ? 'FOUND' : 'EMPTY_RESULTS',
                products: productsToDeliver
              };

              if (productsToDeliver.length === 0) {
                chips = ["Try another keyword", "Contact support"];
              }
            }
          } 
          else if (funcName === "discover_store_pages") {
            intent = 'inquiry';
            const discoveredPages = await discoverStorePages(storeUrl, args.keyword || '');
            toolResult = { status: discoveredPages.length > 0 ? 'FOUND' : 'EMPTY_RESULTS', pages: discoveredPages };
          }
          else if (funcName === "scrape_product_details") {
            intent = 'inquiry';
            const scrapedData = await scrapeProductDetails(args.productUrl);
            toolResult = { status: 'FOUND', details: scrapedData };
          }
        } catch (toolErr) {
          logger.error(`[Pipeline] Tool execution error '${funcName}'`, { error: toolErr.message });
        }

        // CRITICAL FIX: Include tool_call_id so aiClient correctly maps the response back to Gemini
        updatedHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: funcName,
          content: JSON.stringify(toolResult)
        });
      }

      updateStatus('Synthesizing answer...');
      currentResponse = await generateAICompletion(updatedHistory);
    }

    if (currentResponse?.content) {
      updatedHistory.push(currentResponse);
    }

    if (sink) {
      sink.meta({ intent, products: productsToDeliver, chips, state: 'normal', strikes: 0 });
    }

    updateStatus('Streaming response...');
    let finalReplyText = '';
    
    if (sink && typeof generateAICompletionStream === 'function') {
      console.time('⏱️ LLM Token Generation / Response');
      finalReplyText = await generateAICompletionStream(updatedHistory, {
        onDelta: (text) => sink.delta(text),
        isAborted: () => sink.aborted
      });
      console.timeEnd('⏱️ LLM Token Generation / Response');
    } else {
      const finalMsg = typeof currentResponse === 'string' ? currentResponse : (currentResponse?.content || await generateAICompletion(updatedHistory));
      finalReplyText = typeof finalMsg === 'string' ? finalMsg : finalMsg?.content || '';
      if (sink) sink.delta(finalReplyText);
    }

    if (!finalReplyText || !finalReplyText.trim()) {
      finalReplyText = productsToDeliver.length > 0
        ? `Here are the items I found for you at ${storeName}:`
        : `Hi there! I'm your shopping assistant for ${storeName}. What product, category, or store question can I help you with today?`;
      if (sink) sink.delta(finalReplyText);
    }

    if (sink) sink.done({ state: 'normal', strikes: 0 });

    return {
      reply: finalReplyText,
      intent,
      products: productsToDeliver,
      state: 'normal',
      strikes: 0,
      ...(chips.length > 0 ? { chips } : {})
    };

  } catch (criticalErr) {
    logger.error('[Pipeline Critical Failure]', { error: criticalErr.message });
    const fallbackMessage = "I'm having a little trouble connecting right now. Please try again in a moment!";
    if (sink) {
      sink.meta({ intent: 'inquiry', products: [], chips: ["Try again"], state: 'normal', strikes: 0 });
      sink.delta(fallbackMessage);
      sink.done({ state: 'normal', strikes: 0 });
    }
    return { reply: fallbackMessage, intent: 'inquiry', products: [], state: 'normal', strikes: 0 };
  }
}