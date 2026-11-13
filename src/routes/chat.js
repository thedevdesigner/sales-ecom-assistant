import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { searchShopifyProducts } from '../adapters/shopifyAdapter.js';
import { logger } from '../utils/logger.js';

const router = Router();
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// Define the store search tool directly
const storeTools = [{
  functionDeclarations: [{
    name: "search_products",
    description: "Search store catalog for specific product names or keywords.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product keyword to search." },
        limit: { type: "number", description: "Number of items to fetch (max 6)." }
      },
      required: ["query"]
    }
  }]
}];

router.post('/', async (req, res) => {
  try {
    const { messages, vendorId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    // Set headers for NDJSON / Chunked stream immediately so browser stops "pending"
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const storeUrl = 'https://nordicknives.com'; // Fallback or pull dynamically
    const model = env.PRIMARY_MODEL || 'gemini-1.5-flash';

    // Format incoming messages for Gemini SDK
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    // 1. Initial Call to check if Gemini wants to call a tool (like search_products)
    const initialResponse = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: { parts: [{ text: "You are a helpful e-commerce shopping assistant. Be concise and friendly." }] },
        tools: storeTools
      }
    });

    let finalContents = [...contents];
    let productsFound = [];

    // 2. Handle Tool Execution if Gemini triggers search_products
    if (initialResponse.functionCalls && initialResponse.functionCalls.length > 0) {
      const fc = initialResponse.functionCalls[0];
      const args = fc.args || {};

      if (fc.name === 'search_products') {
        const query = args.query || '';
        logger.info(`[Simple Chat] Tool execution: searching products for '${query}'`);
        
        try {
          const results = await searchShopifyProducts(storeUrl, { query, limit: 4 }, 'USD');
          productsFound = Array.isArray(results) ? results : [];
        } catch (err) {
          logger.error('[Simple Chat] Shopify search failed', { error: err.message });
        }
      }

      // Append assistant call and function response back into conversation history
      finalContents.push({
        role: 'model',
        parts: [{ functionCall: { name: fc.name, args: fc.args } }]
      });

      finalContents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: fc.name,
            response: { products: productsFound }
          }
        }]
      });
    } else if (initialResponse.text) {
      // If no tool was called, we can push the initial text or let the stream generate it
    }

    // 3. Send Meta Frame first so frontend knows about products/chips instantly
    res.write(JSON.stringify({ event: 'meta', data: { products: productsFound, chips: [] } }) + '\n');

    // 4. Stream final response tokens directly from Gemini
    const stream = await ai.models.generateContentStream({
      model,
      contents: finalContents,
      config: {
        systemInstruction: { parts: [{ text: "You are a helpful e-commerce shopping assistant. Keep answers natural and helpful." }] }
      }
    });

    for await (const chunk of stream) {
      const chunkText = chunk.text || '';
      if (chunkText) {
        // Send delta frame for every token chunk
        res.write(JSON.stringify({ event: 'delta', data: { text: chunkText } }) + '\n');
      }
    }

    // 5. Send Done Frame and close the loop cleanly
    res.write(JSON.stringify({ event: 'done', data: { status: 'ok' } }) + '\n');
    res.end();

  } catch (err) {
    logger.error('[Simple Chat Error]', { error: err.message, stack: err.stack });
    try {
      res.write(JSON.stringify({ event: 'error', data: { message: err.message } }) + '\n');
      res.end();
    } catch (e) {
      res.end();
    }
  }
});

export default router;