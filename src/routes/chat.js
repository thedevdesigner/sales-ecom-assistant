import { Router } from 'express';
import { gateMiddleware } from '../middleware/gate.js';
import { validateBody, chatBodySchema } from '../middleware/validator.js';
import { getCombinedStrikes, evaluateQuietState } from '../pipeline/quietState.js';
import { runChatPipeline } from '../pipeline/chatPipeline.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.post('/', gateMiddleware, validateBody(chatBodySchema), async (req, res) => {
  try {
    const { messages, sessionId, strikes: clientStrikes } = req.validatedBody;
    const clientIp = req.ip || req.socket.remoteAddress;
    const latestMessage = messages[messages.length - 1].content;

    // --- Step B. QUIET-STATE & STRIKE CHECK ---
    const activeStrikes = getCombinedStrikes(sessionId, clientIp, clientStrikes);
    const quietCheck = await evaluateQuietState(latestMessage, req.vendor, activeStrikes, sessionId, clientIp);

    if (!quietCheck.bypassQuiet) {
      return res.status(200).json({
        reply: quietCheck.reply,
        products: quietCheck.products || [],
        state: quietCheck.state,
        strikes: quietCheck.strikes
      });
    }

    // --- Steps C through H: PIPELINE EXECUTION ---
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
});

export default router;