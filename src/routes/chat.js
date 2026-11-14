import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { storeTools } from '../utils/llmTools.js';
import { resolveStoreOrigin } from '../utils/resolveOrigin.js';
import {fetchStorePageContent} from '../adapters/storePageFetcher.js'

const router = Router();
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/**
 * ============================================================================
 * MASTER CONTROL PLAN: BACKEND ROUTE HANDLER
 * ============================================================================
 */
router.post('/', async (req, res) => {
  const sendFrame = (event, data) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify({ event, data }) + '\n');
    }
  };

  try {
    const { messages, vendorId, localProducts, intentType } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' });
    }

    const storeName = vendorId || 'Store';
    const storeOrigin = resolveStoreOrigin(req);

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
     * MASTER CONTROL - PHASE 2: PRODUCT SYNTHESIS & RENDER DIRECTIVE
     * ========================================================================
     */
    if (localProducts !== undefined) {
      sendFrame('status', { text: 'Synthesizing response...' });

      const activeIntent = intentType || 'purchase';
      const lastContent = contents[contents.length - 1];

      if (lastContent && lastContent.role === 'user') {
        const contextPrompt = localProducts.length > 0
          ? `\n\n[Verified Catalog Data (Intent: ${activeIntent}): ${JSON.stringify(localProducts)}]`
          : `\n\n[Verified Catalog Data: None found]`;
        
        if (lastContent.parts && lastContent.parts[0]) {
          lastContent.parts[0].text += contextPrompt;
        }
      }

      const systemPrompt = activeIntent === 'product_info'
        ? `You are an AI shopping assistant for ${storeName}. Answer the user's specific product question accurately using ONLY the verified catalog data (description and rawAttributes) provided. Do not invent specifications not present in the data.`
        : `You are an AI shopping assistant for ${storeName}. Speak naturally and base your response strictly on the verified catalog results provided.`;

      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: { parts: [{ text: systemPrompt }] }
        }
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          sendFrame('delta', { text: chunk.text });
        }
      }

      const productsToRender = (activeIntent === 'purchase' && localProducts.length > 0) ? localProducts : [];
      sendFrame('products', { items: productsToRender, intent: activeIntent });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    /**
     * ========================================================================
     * MASTER CONTROL - PHASE 1: INTENT & TOOL DISPATCH
     * ========================================================================
     */
    sendFrame('status', { text: 'Analyzing request...' });

    const initialResponse = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: {
          parts: [{
            text: `You are an AI shopping assistant for ${storeName}. 
- Use 'search_products' when the user wants to find products (intentType: 'purchase') OR asks for specifications/details of a product (intentType: 'product_info').
- Use 'get_store_info' when the user asks about return/refund policies, shipping, terms, privacy, contact email/phone, or company background.`
          }]
        },
        tools: storeTools
      }
    });

    const calls = initialResponse.functionCalls || [];

    if (calls.length === 0) {
      sendFrame('intent', { filters: null, state: 'inquiry' });
      sendFrame('delta', { text: initialResponse.text || '' });
      sendFrame('products', { items: [], intent: 'inquiry' });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    const firstCall = calls[0];

    // SPECTRUM 2: HANDLE STORE/POLICY INFO VIA JINA AI
    if (firstCall.name === 'get_store_info') {
      const topic = firstCall.args?.topic || 'general';
      sendFrame('status', { text: 'Checking store information...' });

      const markdownPageData = await fetchStorePageContent(storeOrigin, topic);

      const modelTurn = initialResponse.candidates?.[0]?.content;
      const followUpContents = [
        ...contents,
        modelTurn,
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: firstCall.name,
              ...(firstCall.id ? { id: firstCall.id } : {}),
              response: { topic, markdownContent: markdownPageData }
            }
          }]
        }
      ];

      sendFrame('status', { text: 'Synthesizing answer...' });

      const infoStream = await ai.models.generateContentStream({
        model,
        contents: followUpContents,
        config: {
          systemInstruction: {
            parts: [{
              text: `You are an AI shopping assistant for ${storeName}. Answer the user's question accurately using ONLY the retrieved Markdown website content. Extract exact emails, phone numbers, or policy rules clearly. If not listed, state politely that it isn't shown on that page.`
            }]
          },
          tools: storeTools,
          toolConfig: { functionCallingConfig: { mode: 'NONE' } }
        }
      });

      for await (const chunk of infoStream) {
        if (chunk.text) {
          sendFrame('delta', { text: chunk.text });
        }
      }

      sendFrame('products', { items: [], intent: 'inquiry' });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

    // SPECTRUM 1: HANDLE PRODUCT SEARCH OR PRODUCT INFO DISPATCH
    if (firstCall.name === 'search_products') {
      const extractedFilters = firstCall.args || {};
      const resolvedIntent = extractedFilters.intentType || 'purchase';

      sendFrame('intent', { filters: extractedFilters, state: resolvedIntent });
      sendFrame('done', { status: 'ok', strikes: 0 });
      return res.end();
    }

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