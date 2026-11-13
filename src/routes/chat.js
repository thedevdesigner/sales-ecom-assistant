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
    description: "Search the store catalog dynamically for any product name, variant property, material, size, or keyword.",
    parameters: {
      type: "object",
      properties: {
        query: { 
          type: "string", 
          description: "The full search query containing all keywords, variant traits, materials, sizes, or preferences mentioned by the user (e.g., 'carbon steel combat knife under 500')." 
        },
        maxPrice: { type: "number", description: "Maximum budget limit if specified." },
        inStockOnly: { type: "boolean", description: "Always true by default to ensure in-stock items are prioritized." }
      },
      required: ["query"]
    }
  }]
}];

/**
 * Dynamically resolves the base store origin from incoming request metadata.
 */
function resolveStoreUrl(req) {
  const { storeUrl, pageUrl } = req.body || {};

  if (storeUrl && /^https?:\/\//i.test(storeUrl)) {
    return new URL(storeUrl).origin;
  }
  if (pageUrl && /^https?:\/\//i.test(pageUrl)) {
    try {
      return new URL(pageUrl).origin;
    } catch {}
  }
  const headerOrigin = req.headers.origin || req.headers.referer;
  if (headerOrigin && /^https?:\/\//i.test(headerOrigin)) {
    try {
      return new URL(headerOrigin).origin;
    } catch {}
  }
  return null;
}

router.post('/', async (req, res) => {
  const sendFrame = (event, data) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify({ event, data }) + '\n');
    }
  };

  try {
    const { messages, vendorId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    const storeUrl = resolveStoreUrl(req);
    if (!storeUrl) {
      return res.status(400).json({ error: 'Unable to determine store URL from request.' });
    }

    const storeName = vendorId || new URL(storeUrl).hostname;

    // Stream headers to kill the browser "pending" state instantly
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const model = env.PRIMARY_MODEL || 'gemini-2.5-flash';

    sendFrame('status', { text: 'Analyzing request...' });

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    // 1. Initial Call to check for tool calls
    const initialResponse = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: {
          parts: [{ text: `You are a helpful e-commerce shopping assistant for ${storeName}. Be concise and friendly.` }]
        },
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
          const results = await searchShopifyProducts(storeUrl, { query, limit: args.limit || 4 }, 'USD');
          productsFound = Array.isArray(results) ? results : [];
        } catch (err) {
          logger.error('[Chat] Shopify search failed', { storeUrl, error: err.message });
        }
      }

      // Append model function call block
      finalContents.push({
        role: 'model',
        parts: [{ functionCall: { name: fc.name, args: fc.args } }]
      });

      // Append SDK-compliant function response under model role parts
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

    // Send Meta frame containing products and intent state
    sendFrame('meta', { products: productsFound, chips: [], state: intent });
    sendFrame('status', { text: 'Synthesizing response...' });

    // 3. Stream final tokens from Gemini
    const stream = await ai.models.generateContentStream({
      model,
      contents: finalContents,
      config: {
        systemInstruction: {
          parts: [{ text: `You are a helpful e-commerce shopping assistant for ${storeName}. Keep answers natural, highlighting found products if any.` }]
        }
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
    } catch {
      res.end();
    }
  }
});

export default router;