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

/**
 * ============================================================================
 * MASTER CONTROL PLAN: BACKEND ROUTE HANDLER
 * ============================================================================
 * Acts as the absolute master controller. Coordinates the two-phase handshake:
 * Phase 1: Analyzes user intent and issues a search directive to the frontend.
 * Phase 2: Receives local database results from the frontend, validates truth,
 *          and streams both the fact-checked text and an explicit product rendering directive.
 */
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

    // Stream headers for instant response
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const model = env.PRIMARY_MODEL || 'gemini-2.5-flash';
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    /**
     * ========================================================================
     * MASTER CONTROL - PHASE 2: SYNTHESIS & PRODUCT DIRECTIVE
     * ========================================================================
     * Triggered when the subordinate frontend sends back the local IndexedDB results.
     * The backend master injects this truth into Gemini to prevent hallucinations,
     * streams the conversational response, and issues an explicit product rendering directive.
     */
    if (localProducts !== undefined) {
      sendFrame('status', { text: 'Synthesizing response...' });

      const contextPrompt = localProducts.length > 0
        ? `Here are the exact verified products found in the catalog matching the user's request: ${JSON.stringify(localProducts)}. You MUST reference these exact items.`
        : `No matching products were found in the catalog for this request. Politely let the user know and offer alternatives.`;

      contents.push({
        role: 'user',
        parts: [{ text: contextPrompt }]
      });

      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: {
            parts: [{ text: `You are an AI shopping assistant for ${storeName}. Speak naturally and base your response strictly on the verified catalog results provided.` }]
          }
        }
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          sendFrame('delta', { text: chunk.text });
        }
      }

      // MASTER DIRECTIVE: Explicitly command the frontend on what products to render
      sendFrame('products', { items: localProducts, intent: localProducts.length > 0 ? 'purchase' : 'inquiry' });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    /**
     * ========================================================================
     * MASTER CONTROL - PHASE 1: INTENT & SEARCH DIRECTIVE DISPATCH
     * ========================================================================
     * Evaluates initial user message. If product search is requested, extracts filters
     * and commands the frontend subordinate to query its local database.
     */
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

    // If no product search is required, stream standard text response directly
    if (calls.length === 0) {
      sendFrame('intent', { filters: null, state: 'inquiry' });
      sendFrame('delta', { text: initialResponse.text || '' });
      sendFrame('products', { items: [], intent: 'inquiry' });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    let extractedFilters = {};
    for (const fc of calls) {
      if (fc.name === 'search_products') {
        extractedFilters = fc.args || {};
      }
    }

    // MASTER DIRECTIVE: Issue search filters down to the subordinate frontend
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