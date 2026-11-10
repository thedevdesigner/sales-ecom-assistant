import { generateStructuredAIResponse, generateAICompletion } from '../services/aiClient.js';
import { searchProducts } from '../adapters/platformDetector.js';
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
  purpose: z.string().optional(),
  unclear: z.boolean()
});

export async function runChatPipeline(vendor, messages) {
  // Step C. UNDERSTAND (AI Call 1)
  const understandMessages = [
    {
      role: 'system',
      content: 'You are an e-commerce intent parser. Analyze the recent shopper conversation and output strict JSON matching the schema: intent (product_search, store_info, followup, chitchat, off_topic), productType, budget ({min, max}), preferences ({color, size, brand, flavor, other}), purpose, unclear (boolean).'
    },
    ...messages.slice(-6)
  ];

  let intentData;
  try {
    intentData = await generateStructuredAIResponse(understandMessages, understandSchema);
  } catch (err) {
    intentData = { intent: 'product_search', productType: messages[messages.length - 1]?.content || '', unclear: false };
  }

  if (intentData.intent === 'off_topic' || intentData.intent === 'chitchat') {
    const reply = intentData.intent === 'chitchat'
      ? `Hello! I'm your shopping assistant here at ${vendor.name}. What can I help you find today?`
      : `I focus specifically on helping you find products here at ${vendor.name}. What are you shopping for?`;
    return { reply, products: [], state: 'normal', strikes: 0 };
  }

  // Step D. FETCH (No AI)
  const searchQuery = intentData.productType || vendor.name;
  const rawProducts = await searchProducts(vendor, searchQuery);

  // Step E. FILTER AND RANK (No AI)
  let products = [...rawProducts];

  if (intentData.budget?.max) {
    products = products.filter(p => p.price <= intentData.budget.max);
  }
  if (intentData.budget?.min) {
    products = products.filter(p => p.price >= intentData.budget.min);
  }

  if (intentData.preferences?.color) {
    const col = intentData.preferences.color.toLowerCase();
    products = products.filter(p => p.title.toLowerCase().includes(col));
  }

  products.sort((a, b) => {
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return 0;
  });

  products = products.slice(0, 4);

  // Step F. ZERO-RESULT & ALTERNATIVE LOGIC
  let chips = [];
  if (products.length === 0) {
    chips = ["Browse bestsellers", "View new arrivals", "Contact support"];
  }

  // Step G. REPLY (AI Call 2)
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

  let replyText;
  try {
    replyText = await generateAICompletion(replyMessages, false);
  } catch (err) {
    replyText = products.length > 0
      ? `Here are some great options I found matching what you're looking for at ${vendor.name}:`
      : `I couldn't find an exact match right now, but feel free to explore our main categories!`;
  }

  return {
    reply: replyText,
    products,
    state: 'normal',
    strikes: 0,
    ...(chips.length > 0 ? { chips } : {})
  };
}