import { generateAICompletion, generateAICompletionStream } from '../services/aiClient.js';
import { searchShopifyProducts } from '../adapters/shopifyAdapter.js';
import { scrapeProductDetails } from '../adapters/productScraper.js';
import { logger } from '../utils/logger.js';

const agentTools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search store catalog for PURCHASE intent (e.g., 'do you have X?', looking for items under a price, or asking to see/buy products).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Clean target product keyword." },
          maxPrice: { type: "number", description: "Maximum budget limit." },
          minPrice: { type: "number", description: "Minimum budget limit." },
          limit: { type: "number", description: "Set to 1 if user is asking for a specific single product, or more for browsing." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scrape_product_details",
      description: "Scrape and read deep product specs or company 'about' info via Jina AI for INQUIRY or COMPARISON intent.",
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

  const systemMessage = {
    role: "system",
    content: `You are an expert sales assistant for ${vendor.name}. Classify every user message into one of three strict intents and handle it accordingly:

1. **INQUIRY**: 
   - User asks about company trust, policies, background ("Is this company trusted?", "What is your return policy?"), or general product information/how-tos without asking to buy or see catalog items.
   - **Rule**: Do not trigger product carousels. Answer via text (use scraper if checking about/policy pages). \`products\` must be empty \`[]\`.

2. **PURCHASE**: 
   - User wants to buy, asks if an item is in stock ("Do you have..."), or gives a budget ("under $100").
   - **Rule**: Call \`search_products\`. If looking for a single specific item, return 1 product card. If browsing a category, return matching items for a carousel.

3. **COMPARISON**: 
   - User wants to compare two or more specific items.
   - **Rule**: Fetch the compared items. Label them clearly in your reply text (e.g. Option A vs Option B) so the user can easily contrast them.

- NEVER output raw JSON, code blocks, or markdown code formatting in your reply text. 
- Always ensure speech matches reality: if \`totalFound === 0\`, politely state we don't have it in stock without inventing items or brands.`
  };

  const conversationHistory = [systemMessage, ...messages.slice(-8)];

  let productsToDeliver = [];
  let chips = [];
  let intent = 'inquiry'; // default fallback
  let updatedHistory = [...conversationHistory];

  try {
    const initialResponse = await generateAICompletion(conversationHistory, {
      tools: agentTools,
      tool_choice: "auto"
    });

    const assistantMessage = typeof initialResponse === 'string'
      ? { role: 'assistant', content: initialResponse }
      : initialResponse;

    if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
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
            const searchResults = await searchShopifyProducts(storeUrl, args, vendor.currency || 'USD');
            let rawProducts = Array.isArray(searchResults) ? searchResults : [];
            
            // If user asked for a single item or limit is 1, isolate top 1 result
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
              chips = ["Browse bestsellers", "View new arrivals", "Contact support"];
            }
          } 
          else if (funcName === "scrape_product_details") {
            intent = 'inquiry'; // or comparison depending on context
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
    } else {
      intent = 'inquiry';
      const directReply = assistantMessage.content || "How can I help you today?";
      return emitAndReturn(sink, directReply, [], chips, intent);
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
        : `I'm sorry, we don't currently have that item in stock. Feel free to explore our catalog!`;
      if (sink) sink.delta(finalReplyText);
    }

    if (!finalReplyText || !finalReplyText.trim()) {
      finalReplyText = productsToDeliver.length > 0
        ? `Here are the options I found for you at ${vendor.name}:`
        : `I'm sorry, we don't currently have any items matching that request in stock at ${vendor.name}.`;
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