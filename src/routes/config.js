import { Router } from 'express';
import { verifyDomainMiddleware } from '../middleware/authorizeVendor.js';

const router = Router();

router.get('/:vendorId', verifyDomainMiddleware, (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  
  // If req.vendor exists, return its details safely
  if (!req.vendor) {
    return res.status(404).json({ error: 'Vendor info not found' });
  }

  res.status(200).json({
    vendorId: req.vendor.id,
    name: req.vendor.name,
    currency: req.vendor.currency || 'USD', // Fallback if undefined
    widgetConfig: req.vendor.widgetConfig || {}
  });
});

export default router;