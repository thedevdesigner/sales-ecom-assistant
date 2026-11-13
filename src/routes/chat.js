import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { searchShopifyProducts } from '../adapters/shopifyAdapter.js';
import { logger } from '../utils/logger.js';

const router = Router();
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

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
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    // Stream headers
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const storeUrl = 'https://nordicknives.com';
    const model = env.PRIMARY_MODEL || 'gemini-3.5-flash';

    const sendFrame = (event, data) => {
      res.write(JSON.stringify({ event, data }) + '\n');
    };

    // Micro-action: Analyzing
    sendFrame('status', { text: 'Analyzing request...' });

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    // 1. Initial Call
    const initialResponse = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: { parts: [{ text: "You are a helpful e-commerce shopping assistant for Nordic Knives. Be concise and friendly." }] },
        tools: storeTools
      }
    });

    let finalContents = [...contents];
    let productsFound = [];
    let intent = 'inquiry';

    // 2. Handle Tool Execution
    if (initialResponse.functionCalls && initialResponse.functionCalls.length > 0) {
      const fc = initialResponse.functionCalls[0];
      const args = fc.args || {};

      if (fc.name === 'search_products') {
        intent = 'purchase';
        const query = args.query || '';
        sendFrame('status', { text: `Searching catalog for "${query}"...` });
        
        try {
          const results = await searchShopifyProducts(storeUrl, { query, limit: 4 }, 'USD');
          productsFound = Array.isArray(results) ? results : [];
        } catch (err) {
          logger.error('[Chat] Shopify search failed', { error: err.message });
        }
      }

      // Append assistant call parts
      finalContents.push({
        role: 'model',
        parts: [{ functionCall: { name: fc.name, args: fc.args } }]
      });

      // Append SDK-compliant function response part
      finalContents.push({
        role: 'model',
        parts: [{
          functionResponse: {
            name: fc.name,
            response: { products: productsFound }
          }
        }]
      });
    }

    // Send Meta Frame (products & intent)
    sendFrame('meta', { products: productsFound, chips: [], state: intent });

    sendFrame('status', { text: 'Synthesizing response...' });

    // 3. Stream final response tokens
    const stream = await ai.models.generateContentStream({
      model,
      contents: finalContents,
      config: {
        systemInstruction: { parts: [{ text: "You are a helpful e-commerce shopping assistant. Keep answers natural, highlighting the found products if any." }] }
      }
    });

    for await (const chunk of stream) {
      const chunkText = chunk.text || '';
      if (chunkText) {
        sendFrame('delta', { text: chunkText });
      }
    }

    sendFrame('done', { status: 'ok', strikes: 0 });
    res.end();

  } catch (err) {
    logger.error('[Chat Error]', { error: err.message, stack: err.stack });
    try {
      sendFrame('error', { message: "I'm having a little trouble connecting right now. Please try again in a moment!" });
      res.end();
    } catch (e) {
      res.end();
    }
  }
});

export default router;