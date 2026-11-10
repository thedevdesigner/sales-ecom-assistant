import { Router } from 'express';
import { gateMiddleware } from '../middleware/gate.js';
import { validateBody, chatBodySchema } from '../middleware/validator.js';

const router = Router();

router.post('/', gateMiddleware, validateBody(chatBodySchema), (req, res) => {
  res.status(200).json({
    reply: "Chat endpoint gated and validated successfully. Pipeline processing coming in upcoming phases.",
    products: [],
    state: "normal",
    strikes: 0
  });
});

export default router;