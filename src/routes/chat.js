import { Router } from 'express';
import { gateMiddleware } from '../middleware/gate.js';
import { validateBody, chatBodySchema } from '../middleware/validator.js';
import { runChatPipeline } from '../pipeline/chatPipeline.js';

const router = Router();

router.post('/', gateMiddleware, validateBody(chatBodySchema), async (req, res, next) => {
  try {
    const { messages } = req.validatedBody;
    const result = await runChatPipeline(req.vendor, messages);
    
    if (req.incrementAiUsage) {
      req.incrementAiUsage();
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({
      reply: "I'm having a little trouble connecting to our catalog right now. Please try again in a moment!",
      products: [],
      state: 'normal',
      strikes: 0
    });
  }
});

export default router;