import { Router } from 'express';
import { gateMiddleware } from '../middleware/gate.js';
import { validateBody, chatBodySchema } from '../middleware/validator.js';
import { getCombinedStrikes, evaluateQuietState } from '../pipeline/quietState.js';
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

  if (!wantsStream) {
    return handleLegacy(req, res);
  }

  // ============ STREAMING PATH ============
  const sink = createStreamSink(res);
  sink.attachAbort(req); // stop burning AI tokens if the client disconnects

  try {
    const { messages, sessionId, strikes: clientStrikes } = req.validatedBody;
    const clientIp = req.ip || req.socket.remoteAddress;
    const latestMessage = messages[messages.length - 1]?.content || '';

    // --- Step B. QUIET-STATE & STRIKE CHECK ---
    const activeStrikes = getCombinedStrikes(sessionId, clientIp, clientStrikes);

    const isFollowUp =
      messages.length > 1 &&
      activeStrikes === 0 &&
      latestMessage.trim().split(/\s+/).length <= 5;

    const quietCheck = await evaluateQuietState(latestMessage, req.vendor, activeStrikes, sessionId, clientIp, { isFollowUp });

    if (!quietCheck.bypassQuiet) {
      sink.meta({ products: [], state: quietCheck.state, strikes: quietCheck.strikes });
      sink.delta(quietCheck.reply);
      sink.done({ state: quietCheck.state, strikes: quietCheck.strikes });
      return sink.end();
    }

    // --- Run Pipeline with Streaming Sink ---
    const result = await runChatPipeline(req.vendor, messages, sink);
  console.log(result)
    if (typeof req.incrementAiUsage === 'function') {
      req.incrementAiUsage();
    }

    // Ensure sink is ended if pipeline didn't close it explicitly
    if (!sink.ended) {
      sink.end();
    }
  } catch (err) {
    logger.error('Chat endpoint streaming error', { error: err.message, stack: err.stack });
    if (!res.headersSent) {
      sink.error("I'm having a little trouble connecting to our catalog right now. Please try again in a moment!");
      sink.end();
    }
  }
});

/**
 * Legacy behavior for non-streaming clients.
 */
async function handleLegacy(req, res) {
  try {
    const { messages, sessionId, strikes: clientStrikes } = req.validatedBody;
    const clientIp = req.ip || req.socket.remoteAddress;
    const latestMessage = messages[messages.length - 1]?.content || '';

    const activeStrikes = getCombinedStrikes(sessionId, clientIp, clientStrikes);

    const isFollowUp =
      messages.length > 1 &&
      activeStrikes === 0 &&
      latestMessage.trim().split(/\s+/).length <= 5;

    const quietCheck = await evaluateQuietState(latestMessage, req.vendor, activeStrikes, sessionId, clientIp, { isFollowUp });

    if (!quietCheck.bypassQuiet) {
      return res.status(200).json({
        reply: quietCheck.reply,
        products: quietCheck.products || [],
        state: quietCheck.state,
        strikes: quietCheck.strikes
      });
    }

    // Run pipeline without a sink (returns full result object)
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