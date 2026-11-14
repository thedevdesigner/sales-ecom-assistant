import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// Tool declaration: Instructs Gemini to output structured search filters instead of executing code
const storeTools = [{
  functionDeclarations: [{
    name: "search_products",
    description: "Extract search parameters when the shopper wants to find, buy, or check stock of products. Use this to structure their request into clean filters.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Core product keywords only, e.g. 'combat knife'. No filler words." },
        maxPrice: { type: "number", description: "Upper budget limit, if stated." },
        minPrice: { type: "number", description: "Lower budget limit, if stated." },
        inStockOnly: { type: "boolean", description: "true unless the shopper asks for sold-out items." }
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
    const { messages, vendorId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    const storeName = vendorId || 'Store';

    // Stream headers for instant response
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

    // 1. Initial LLM Call to evaluate user intent
    const initialResponse = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: {
          parts: [{ text: `You are an AI shopping assistant for ${storeName}. Be concise, friendly, and helpful. If the user is looking for products, use the search_products tool to extract their search criteria.` }]
        },
        tools: storeTools
      }
    });

    let finalContents = [...contents];
    let intent = 'inquiry';
    const calls = initialResponse.functionCalls || [];

    // 2. If no product search tool is called, stream standard conversational response
    if (calls.length === 0) {
      sendFrame('intent', { filters: null, state: 'inquiry' });
      sendFrame('delta', { text: initialResponse.text || '' });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    // 3. Process tool calls: Emit structured filters down to the client for local IndexedDB execution
    let extractedFilters = {};
    for (const fc of calls) {
      if (fc.name === 'search_products') {
        intent = 'purchase';
        extractedFilters = fc.args || {};
        sendFrame('status', { text: `Searching catalog for "${extractedFilters.query || ''}"...` });
      }
    }

    // Send the intent frame to the frontend so it can query IndexedDB locally (Zero 429s!)
    sendFrame('intent', { filters: extractedFilters, state: intent });

    // Construct the model conversation turn for token streaming
    const candidate = initialResponse.candidates?.[0];
    if (candidate?.content) {
      finalContents.push(candidate.content);
      // Fulfill the tool call requirement with a mock success response so Gemini can continue its conversational turn
      const responseParts = calls.map(fc => ({
        functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: { status: 'success', handledLocally: true } }
      }));
      finalContents.push({ role: 'user', parts: responseParts });
    }

    sendFrame('status', { text: 'Synthesizing response...' });

    // 4. Stream final conversational tokens from Gemini
    const stream = await ai.models.generateContentStream({
      model,
      contents: finalContents,
      config: {
        systemInstruction: {
          parts: [{ text: `You are an AI shopping assistant for ${storeName}. Acknowledge the user's request naturally and present the products being shown to them.` }]
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