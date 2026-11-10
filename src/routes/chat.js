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
    const latestMessage = messages[messages.length - 1].content;

    // --- Step B. QUIET-STATE & STRIKE CHECK (same logic as before) ---
    const activeStrikes = getCombinedStrikes(sessionId, clientIp, clientStrikes);

    const isFollowUp =
      messages.length > 1 &&
      activeStrikes === 0 &&
      latestMessage.trim().split(/\s+/).length <= 5;

    const quietCheck = await evaluateQuietState(latestMessage, req.vendor, activeStrikes, sessionId, clientIp, { isFollowUp });

    if (!quietCheck.bypassQuiet) {
      // Warned / quiet replies are fixed strings: meta -> one delta -> done
      sink.meta({ products: [], state: quietCheck.state, strikes: quietCheck.strikes });
      sink.delta(quietCheck.reply);
      sink.done({ state: quietCheck.state, strikes: quietCheck.strikes });
      return sink.end();
    }

    // --- Steps C through H (streams meta, deltas, done internally) ---
    await runChatPipeline(req.vendor, messages, sink);

    if (req.incrementAiUsage) {
      req.incrementAiUsage();
    }

    sink.end();
  } catch (err) {
    // Headers already sent -> CANNOT res.status(500).json anymore.
    // The only honest channel left is an error frame on the stream.
    logger.error('Chat endpoint streaming error', { error: err.message, stack: err.stack });
    sink.error("I'm having a little trouble connecting to our catalog right now. Please try again in a moment!");
    sink.end();
  }
});

/**
 * The original behavior, preserved verbatim for non-streaming clients.
 */
async function handleLegacy(req, res) {
  try {
    const { messages, sessionId, strikes: clientStrikes } = req.validatedBody;
    const clientIp = req.ip || req.socket.remoteAddress;
    const latestMessage = messages[messages.length - 1].content;

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

    const result = await runChatPipeline(req.vendor, messages);

    if (req.incrementAiUsage) {
      req.incrementAiUsage();
    }

    res.status(200).json({
      ...result,
      state: 'normal',
      strikes: 0
    });
  } catch (err) {
    logger.error('Chat endpoint execution error', { error: err.message, stack: err.stack });
    res.status(500).json({
      reply: "I'm having a little trouble connecting to our catalog right now. Please try again in a moment!",
      products: [],
      state: 'normal',
      strikes: 0
    });
  }
}

export default router;