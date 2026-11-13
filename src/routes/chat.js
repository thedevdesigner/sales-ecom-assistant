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
    description: "Search the store catalog. Use it whenever the shopper wants to find, buy or check stock of products. Put the core product words in query and every stated constraint in its own field.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Core product keywords only, e.g. 'combat knife'. No prices, colors or filler words." },
        maxPrice: { type: "number", description: "Upper budget limit, if stated." },
        minPrice: { type: "number", description: "Lower budget limit, if stated." },
        color: { type: "string", description: "A color, if stated." },
        attributes: { type: "array", items: { type: "string" }, description: "Any other stated requirement, one per item, e.g. '5 inch', 'carbon steel'." },
        inStockOnly: { type: "boolean", description: "true unless the shopper asks to see sold-out items." }
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

    // 2. Run EVERY tool call the model made (it can make several at once)
    const calls = initialResponse.functionCalls || [];

    if (calls.length === 0) {
      // No tool needed: the first response already is the answer. Stream it instead of generating it a second time.
      sendFrame('meta', { products: [], chips: [], state: intent });
      sendFrame('delta', { text: initialResponse.text || '' });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    const responseParts = await Promise.all(calls.map(async (fc) => {
      let payload = { error: `Unknown tool: ${fc.name}` };

      if (fc.name === 'search_products') {
        intent = 'purchase';
        const a = fc.args || {};
        sendFrame('status', { text: `Searching catalog for "${a.query || ''}"...` });
        try {
          // The tool arguments already use the adapter's criteria names, so they go straight through (maxPrice, minPrice, color, attributes, inStockOnly)
          const results = await searchShopifyProducts(storeUrl, { ...a, limit: 4 }, 'USD');
          for (const r of results) if (!productsFound.some((p) => p.id === r.id)) productsFound.push(r);
          payload = { count: results.length, products: results.map(({ title, price, currency, inStock, description, attributeMatches, attributesRequested }) => ({ title, price, currency, inStock, description, attributeMatches, attributesRequested })) };
        } catch (err) {
          logger.error('[Chat] Shopify search failed', { storeUrl, error: err.message, stack: err.stack });
          payload = { count: 0, products: [], error: 'search_failed' };
        }
      }

      // One functionResponse per functionCall, same order; id is echoed when the API supplied one
      return { functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: payload } };
    }));

    // The model's own turn goes back UNTOUCHED (keeps ids and thoughtSignature); the tool results are a USER turn.
    const candidate = initialResponse.candidates?.[0];
    if (!candidate?.content) {
    throw new Error('Gemini returned no usable candidate content');
    }
    finalContents.push(candidate.content);
    finalContents.push({ role: 'user', parts: responseParts });

    // Send Meta frame containing products and intent state
    sendFrame('meta', { products: productsFound.slice(0, 6), chips: [], state: intent });
    sendFrame('status', { text: 'Synthesizing response...' });

    // 3. Stream final tokens from Gemini
    const stream = await ai.models.generateContentStream({
      model,
      contents: finalContents,
      config: {
        systemInstruction: {
          parts: [{ text: `You are a helpful e-commerce shopping assistant for ${storeName}. Keep answers natural, highlighting found products if any. If attributeMatches is lower than attributesRequested, say the item is a close match rather than an exact one.` }]
        },
        tools: storeTools,
        toolConfig: { functionCallingConfig: { mode: 'NONE' } }
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