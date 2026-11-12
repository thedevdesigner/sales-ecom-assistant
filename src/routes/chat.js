import { Router } from 'express';
import { gateMiddleware } from '../middleware/gate.js';
import { validateBody, chatBodySchema } from '../middleware/validator.js';
import { runChatPipeline } from '../pipeline/chatPipeline.js';
import { createStreamSink } from '../utils/streamSink.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Streaming is OPT-IN so old clients keep working untouched:
 *   POST /api/chat
 *   Header:  Accept: application/octet-stream     (or body { stream: true })
 */
router.post('/', gateMiddleware, validateBody(chatBodySchema), async (req, res) => {
  const wantsStream =
    (req.headers.accept || '').includes('application/octet-stream') ||
    req.validatedBody.stream === true;

  const { messages, sessionId, strikes: clientStrikes } = req.validatedBody;
  const latestMessage = messages[messages.length - 1]?.content || '';

  // ============ FAST-PATH GREETINGS (Instant response, bypasses LLM delay) ============
  const greetingRegex = /^(hi|hello|hey|greetings|good morning|good afternoon|good evening)\b/i;
  if (greetingRegex.test(latestMessage.trim()) && messages.length <= 2) {
    const greetingReply = {
      reply: "Hello! How can I help you find the right product today?",
      intent: 'greeting',
      products: [],
      chips: ['Show me bestsellers', "What's on sale?"]
    };

    if (wantsStream) {
      const sink = createStreamSink(res);
      sink.attachAbort(req);
      try {
        sink.meta({ 
          products: greetingReply.products, 
          chips: greetingReply.chips, 
          state: greetingReply.intent, 
          strikes: clientStrikes || 0 
        });
        sink.delta(greetingReply.reply);
        sink.done({ state: 'normal', strikes: clientStrikes || 0 });
      } catch (err) {
        sink.error("Failed to render greeting.");
      }
      return sink.end();
    } else {
      return res.status(200).json(greetingReply);
    }
  }

  if (!wantsStream) {
    return handleLegacy(req, res, messages);
  }

  // ============ STREAMING PATH (Direct to Pipeline) ============
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
    
    // CRITICAL FIX: Since headers are already sent by createStreamSink, 
    // we must push an explicit NDJSON error frame instead of checking !res.headersSent!
    try {
      sink.error("I'm having a little trouble connecting to our catalog right now. Please try again in a moment!");
    } catch (e) {}
    
    sink.end();
  }
});

/**
 * Legacy behavior for non-streaming clients (Direct to Pipeline).
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