import { Router } from 'express';
import { gateMiddleware } from '../middleware/gate.js';
import { validateBody, chatBodySchema } from '../middleware/validator.js';
import { runChatPipeline } from '../pipeline/chatPipeline.js';
import { createStreamSink } from '../utils/streamSink.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * POST /chat
 * Supports NDJSON streaming (Accept: application/octet-stream or { stream: true })
 * and legacy JSON responses. All messages, including greetings, flow to the LLM.
 */
router.post('/', gateMiddleware, validateBody(chatBodySchema), async (req, res) => {
  const wantsStream =
    (req.headers.accept || '').includes('application/octet-stream') ||
    req.validatedBody.stream === true;

  const { messages } = req.validatedBody;

  if (!wantsStream) {
    return handleLegacy(req, res, messages);
  }

  const sink = createStreamSink(res);
  sink.attachAbort(req);

  try {
    await runChatPipeline(req.vendor, messages, sink);

    if (typeof req.incrementAiUsage === 'function') {
      req.incrementAiUsage();
    }

    if (!sink.aborted) {
      sink.end();
    }
  } catch (err) {
    logger.error('Chat endpoint streaming error', { error: err.message, stack: err.stack });

    try {
      sink.error("I'm having a little trouble connecting to our catalog right now. Please try again in a moment!");
    } catch (e) {}

    sink.end();
  }
});

/**
 * Legacy behavior for non-streaming clients.
 */
async function handleLegacy(req, res, messages) {
  try {
    const result = await runChatPipeline(req.vendor, messages, null);

    if (typeof req.incrementAiUsage === 'function') {
      req.incrementAiUsage();
    }

    return res.status(200).json({
      reply: result.reply,
      products: result.products || [],
      state: result.state || 'normal',
      strikes: result.strikes || 0,
      ...(result.chips ? { chips: result.chips } : {})
    });
  } catch (err) {
    logger.error('Chat endpoint execution error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      reply: "I'm having a little trouble connecting to our catalog right now. Please try again in a moment!",
      products: [],
      state: 'normal',
      strikes: 0
    });
  }
}

export default router;