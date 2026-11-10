import { generateAICompletion, generateAICompletionStream } from '../services/aiClient.js';
import { searchShopifyProducts } from '../adapters/shopifyAdapter.js';
import { scrapeProductDetails } from '../adapters/productScraper.js';

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

  // STEP 1: Let OpenAI evaluate the conversation and decide whether to call a tool
  const initialMessage = await generateAICompletion(conversationHistory, {
    tools: agentTools,
    tool_choice: "auto"
  });

  let productsToDeliver = [];
  let updatedHistory = [...conversationHistory];

  // STEP 2: Check if OpenAI invoked tool calls
  if (initialMessage.tool_calls && initialMessage.tool_calls.length > 0) {
    updatedHistory.push(initialMessage); // Record assistant's tool call intent

    for (const toolCall of initialMessage.tool_calls) {
      const funcName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments || '{}');
      let toolResult = null;

      if (funcName === "search_products") {
        // Search using your high-performance adapter with accurate price constraints
        productsToDeliver = await searchShopifyProducts(storeUrl, args, vendor.currency || 'USD');
        toolResult = productsToDeliver;
      } 
      else if (funcName === "scrape_product_details") {
        // Fetch clean markdown page content via Jina AI
        toolResult = await scrapeProductDetails(args.productUrl);
      }

      // Feed the tool data back into the conversation history for OpenAI to read
      updatedHistory.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult)
      });
    }
  } else {
    // No tools called: Pure conversation mode
    const directReply = initialMessage.content || '';
    return emitAndReturn(sink, directReply, []);
  }

  // STEP 3: Send metadata frame to frontend carousel if products were found
  if (sink && productsToDeliver.length > 0) {
    sink.meta({ products: productsToDeliver.slice(0, 8), chips: [], state: 'normal', strikes: 0 });
  }

  // STEP 4: Stream the final response back to the widget based on the tool results
  let finalReplyText = '';
  try {
    if (sink && typeof generateAICompletionStream === 'function') {
      finalReplyText = await generateAICompletionStream(updatedHistory, {
        onDelta: (text) => sink.delta(text),
        isAborted: () => sink.aborted
      });
    } else {
      const finalMsg = await generateAICompletion(updatedHistory);
      finalReplyText = typeof finalMsg === 'string' ? finalMsg : finalMsg.content;
      sink?.delta(finalReplyText);
    }
  } catch (err) {
    finalReplyText = "Here are the options I found matching your request:";
    sink?.delta(finalReplyText);
  }

  const result = {
    reply: finalReplyText,
    products: productsToDeliver.slice(0, 8),
    state: 'normal',
    strikes: 0
  };

  if (sink) sink.done({ state: 'normal', strikes: 0 });
  return result;
}

function emitAndReturn(sink, reply, products) {
  if (sink) {
    sink.meta({ products, chips: [], state: 'normal', strikes: 0 });
    sink.delta(reply);
    sink.done({ state: 'normal', strikes: 0 });
  }
  return { reply, products, state: 'normal', strikes: 0 };
}