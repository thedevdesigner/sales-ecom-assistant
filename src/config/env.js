import { generateStructuredAIResponse, generateAICompletion, generateAICompletionStream } from '../services/aiClient.js';
import { searchShopifyProducts } from '../adapters/shopifyAdapter.js'; // Upgraded hybrid search adapter
import { z } from 'zod';

const understandSchema = z.object({
  intent: z.enum(['product_search', 'store_info', 'followup', 'chitchat', 'off_topic']),
  productType: z.string().optional(),
  budget: z.object({
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional()
  }).optional(),
  preferences: z.object({
    color: z.string().optional(),
    size: z.string().optional(),
    brand: z.string().optional(),
    flavor: z.string().optional(),
    other: z.string().optional()
  }).optional(),
  sortBy: z.enum(['price_asc', 'price_desc', 'newest', 'relevance']).optional(),
  purpose: z.string().optional(),
  unclear: z.boolean()
});

/**
 * Steps C–H: Orchestrates intent parsing, deep catalog search, filtering, and streaming.
 */
export async function runChatPipeline(vendor, messages, sink = null) {
  // Step C. UNDERSTAND (AI Call 1) — Parses search parameters, price, color, size, and sorting
  const understandMessages = [
    {
      role: 'system',
      content: 'You are an e-commerce intent parser. Analyze the shopper conversation and output strict JSON matching the schema: intent (product_search, store_info, followup, chitchat, off_topic), productType, budget ({min, max}), preferences ({color, size, brand, flavor, other}), sortBy (price_asc, price_desc, newest, relevance), purpose, unclear (boolean).'
    },
    ...messages.slice(-6)
  ];

  let intentData;
  try {
    intentData = await generateStructuredAIResponse(understandMessages, understandSchema);
  } catch (err) {
    intentData = { intent: 'product_search', productType: messages[messages.length - 1]?.content || '', unclear: false };
  }

  // Fixed-string paths for chitchat/off-topic
  if (intentData.intent === 'off_topic' || intentData.intent === 'chitchat') {
    const reply = intentData.intent === 'chitchat'
      ? `Hello! I'm your shopping assistant here at ${vendor.name}. What can I help you find today?`
      : `I focus specifically on helping you find products here at ${vendor.name}. What are you shopping for?`;
    return emitAndReturn(sink, reply, []);
  }

  // Step D & E. HYBRID CATALOG SEARCH & MULTI-DIMENSIONAL FILTERING
  // Passes query, price caps, color/size preferences, and sorting criteria directly to the adapter
  const criteria = {
    query: intentData.productType || messages[messages.length - 1]?.content || '',
    maxPrice: intentData.budget?.max ?? null,
    minPrice: intentData.budget?.min ?? null,
    color: intentData.preferences?.color ?? null,
    size: intentData.preferences?.size ?? null,
    sortBy: intentData.sortBy || 'relevance'
  };

  // Uses storeUrl from your vendor config (e.g. vendor.storeUrl) and currency
  const storeUrl = vendor.storeUrl || `https://${vendor.domain || 'nordicknives.com'}`;
  let products = await searchShopifyProducts(storeUrl, criteria, vendor.currency || 'USD');

  // Limit results to top 4-8 items for the carousel widget
  products = products.slice(0, 8);

  // Step F. ZERO-RESULT & ALTERNATIVE LOGIC
  let chips = [];
  if (products.length === 0) {
    chips = ["Browse bestsellers", "View new arrivals", "Contact support"];
  }

  // --- METADATA GOES OUT FIRST ---
  if (sink) sink.meta({ products, chips, state: 'normal', strikes: 0 });

  // Step G. REPLY (AI Call 2) — Streams response text back to client
  const replyMessages = [
    {
      role: 'system',
      content: `You are a friendly sales assistant for ${vendor.name}. Write 1 to 3 friendly sentences responding to the shopper. You may mention ONLY the provided real products. If a constraint or fact is not in the product data, state that it isn't listed and suggest checking the product page. Never invent facts.`
    },
    {
      role: 'user',
      content: `Shopper request: "${messages[messages.length - 1].content}"\nAvailable products matching constraints: ${JSON.stringify(products)}`
    }
  ];

  let replyText = '';
  try {
    if (sink && typeof generateAICompletionStream === 'function') {
      replyText = await generateAICompletionStream(replyMessages, {
        onDelta: (text) => sink.delta(text),
        isAborted: () => sink.aborted
      });
    } else {
      replyText = await generateAICompletion(replyMessages, false);
      sink?.delta(replyText);
    }
  } catch (err) {
    replyText = products.length > 0
      ? `Here are some great options I found matching what you're looking for at ${vendor.name}:`
      : `I couldn't find an exact match right now, but feel free to explore our main categories!`;
    sink?.delta(replyText);
  }

  const result = {
    reply: replyText,
    products,
    state: 'normal',
    strikes: 0,
    ...(chips.length > 0 ? { chips } : {})
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