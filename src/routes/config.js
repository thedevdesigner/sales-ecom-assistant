import { Router } from 'express';
import { gateMiddleware } from '../middleware/gate.js';

const router = Router();

router.get('/:vendorId', gateMiddleware, (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).json({
    vendorId: req.vendor.id,
    name: req.vendor.name,
    currency: req.vendor.currency,
    widgetConfig: req.vendor.widgetConfig
  });
});

export default router;