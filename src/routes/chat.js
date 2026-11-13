import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const storeTools = [{
  functionDeclarations: [{
    name: "search_products",
    description: "Extract search parameters when the shopper wants to find, buy, or check stock of products.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Core product keywords only, e.g. 'combat knife'." },
        maxPrice: { type: "number", description: "Upper budget limit, if stated." },
        minPrice: { type: "number", description: "Lower budget limit, if stated." },
        inStockOnly: { type: "boolean", description: "true unless shopper asks for sold-out items." }
      },
      required: ["query"]
    }
  }]
}];

router.post('/', async (req, res) => {
  const sendFrame = (event, data) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify({ event, data }) + '\n');
    }
  };

  try {
    const { messages, vendorId, localProducts } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    const storeName = vendorId || 'Store';

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const model = env.PRIMARY_MODEL || 'gemini-2.5-flash';
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    // 🌟 STEP A: If the frontend already performed the local IndexedDB search and sent results back
    if (localProducts !== undefined) {
      sendFrame('status', { text: 'Synthesizing response...' });

      const contextPrompt = localProducts.length > 0
        ? `Here are the exact products found in our local catalog matching the user's request: ${JSON.stringify(localProducts)}.`
        : `No matching products were found in our local catalog for this request. Politely let the user know and offer alternatives.`;

      contents.push({
        role: 'user',
        parts: [{ text: contextPrompt }]
      });

      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: {
            parts: [{ text: `You are an AI shopping assistant for ${storeName}. Speak naturally and base your response strictly on the provided local catalog results.` }]
          }
        }
      });

      for await (const chunk of stream) {
        if (chunk.text) sendFrame('delta', { text: chunk.text });
      }

      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    // 🌟 STEP B: Initial Turn - Extract search filters via tool calling
    sendFrame('status', { text: 'Analyzing request...' });

    const initialResponse = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: {
          parts: [{ text: `You are an AI shopping assistant for ${storeName}. Use the search_products tool if the user wants to find products.` }]
        },
        tools: storeTools
      }
    });

    const calls = initialResponse.functionCalls || [];

    if (calls.length === 0) {
      sendFrame('intent', { filters: null, state: 'inquiry' });
      sendFrame('delta', { text: initialResponse.text || '' });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    let extractedFilters = {};
    for (const fc of calls) {
      if (fc.name === 'search_products') {
        extractedFilters = fc.args || {};
      }
    }

    // Send the intent filters down to the frontend so it can query IndexedDB locally
    sendFrame('intent', { filters: extractedFilters, state: 'purchase' });
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