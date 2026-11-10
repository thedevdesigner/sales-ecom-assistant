import { generateAICompletion, generateAICompletionStream } from '../services/aiClient.js';
import { searchShopifyProducts } from '../adapters/shopifyAdapter.js';
import { scrapeProductDetails } from '../adapters/productScraper.js';
import { logger } from '../utils/logger.js';

const agentTools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search the store catalog when the user explicitly asks to find, list, filter, or buy products. Never use this for general conversation.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Clean target product keyword (e.g. 'knife'). Do not include budget text." },
          maxPrice: { type: "number", description: "Maximum budget filter in store currency." },
          minPrice: { type: "number", description: "Minimum budget filter in store currency." },
          color: { type: "string", description: "Color variant if specified." },
          sortBy: { type: "string", enum: ["price_asc", "price_desc", "newest", "relevance"] }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scrape_product_details",
      description: "Scrape and read deep product page specs/content using Jina AI when comparing products or answering specific technical questions about an item.",
      parameters: {
        type: "object",
        properties: {
          productUrl: { type: "string", description: "The full URL of the product page to inspect." }
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
    content: `You are an expert sales assistant for ${vendor.name}.
- You have access to search tools and a web page reader tool.
- DO NOT call search tools or scrapers unless the user is explicitly asking to view, find, filter, or compare products.
- For general conversation, questions, greetings, or policies, reply naturally without calling tools (products array should be empty).
- When searching products, pass clean keywords to 'query' and put numerical limits in 'maxPrice' or 'minPrice'. Never invent products or prices.`
  };

  const conversationHistory = [systemMessage, ...messages.slice(-8)];

  let productsToDeliver = [];
  let chips = [];
  let updatedHistory = [...conversationHistory];

  try {
    // STEP 1: Let OpenAI evaluate the conversation and decide whether to call a tool
    const initialResponse = await generateAICompletion(conversationHistory, {
      tools: agentTools,
      tool_choice: "auto"
    });

    // Normalize AI response object structure safely
    const assistantMessage = typeof initialResponse === 'string'
      ? { role: 'assistant', content: initialResponse }
      : initialResponse;

    // STEP 2: Check if OpenAI requested any Tool Calls
    if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
      updatedHistory.push(assistantMessage); // Record tool call intent in history

      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        let args = {};

        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (parseErr) {
          logger.error('[Pipeline] Tool arguments JSON parse error', { raw: toolCall.function.arguments });
        }

        let toolResult = null;

        try {
          if (funcName === "search_products") {
            const searchResults = await searchShopifyProducts(storeUrl, args, vendor.currency || 'USD');
            productsToDeliver = Array.isArray(searchResults) ? searchResults : [];
            toolResult = productsToDeliver;

            if (productsToDeliver.length === 0) {
              chips = ["Browse bestsellers", "View new arrivals", "Contact support"];
            }
          } 
          else if (funcName === "scrape_product_details") {
            toolResult = await scrapeProductDetails(args.productUrl);
          }
        } catch (toolExecErr) {
          logger.error(`[Pipeline] Execution error in tool '${funcName}'`, { error: toolExecErr.message });
          toolResult = { error: `Failed to execute tool ${funcName}. Proceed with general knowledge.` };
        }

        // Always push valid stringified result for OpenAI function loop
        updatedHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult ?? {})
        });
      }
    } else {
      // No tools called: Pure conversation mode
      const directReply = assistantMessage.content || "How can I help you shop today?";
      return emitAndReturn(sink, directReply, [], chips);
    }

    // STEP 3: Send metadata frame to frontend sink before streaming text
    if (sink) {
      sink.meta({
        products: productsToDeliver.slice(0, 8),
        chips,
        state: 'normal',
        strikes: 0
      });
    }

    // STEP 4: Stream or generate final conversational response based on tool outputs
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
        ? `Here are the top options I found for you at ${vendor.name}:`
        : `I couldn't fetch specific details right now, but feel free to browse our main catalog!`;
      if (sink) sink.delta(finalReplyText);
    }

    const result = {
      reply: finalReplyText,
      products: productsToDeliver.slice(0, 8),
      state: 'normal',
      strikes: 0,
      ...(chips.length > 0 ? { chips } : {})
    };

    if (sink) sink.done({ state: 'normal', strikes: 0 });
    return result;

  } catch (criticalErr) {
    logger.error('[Pipeline Critical Failure]', { error: criticalErr.message, stack: criticalErr.stack });
    
    const fallbackMessage = "I'm having a little trouble connecting to our catalog right now. Please try again in a moment!";
    return emitAndReturn(sink, fallbackMessage, [], ["Try again", "View catalog"]);
  }
}

function emitAndReturn(sink, reply, products, chips = []) {
  if (sink) {
    sink.meta({ products, chips, state: 'normal', strikes: 0 });
    sink.delta(reply);
    sink.done({ state: 'normal', strikes: 0 });
  }
  return {
    reply,
    products,
    state: 'normal',
    strikes: 0,
    ...(chips.length > 0 ? { chips } : {})
  };
}