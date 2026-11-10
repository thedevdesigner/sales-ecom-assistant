import { getVendor } from '../loaders/vendorLoader.js';

const ipRateLimitMap = new Map();     // Key: `${ip}:${vendorId}`
const sessionRateLimitMap = new Map(); // Key: `${sessionId}:${vendorId}`
const monthlyAiUsageMap = new Map();   // Key: `${vendorId}:${YYYY-MM}`

export function gateMiddleware(req, res, next) {
  const vendorId = req.params.vendorId || req.body?.vendorId;

  if (!vendorId) {
    return res.status(400).json({ error: { code: 400, message: 'Missing vendorId' } });
  }

  const vendor = getVendor(vendorId);
  if (!vendor) {
    return res.status(404).json({ error: { code: 404, message: 'Vendor not found' } });
  }

  // 1. Origin check. CORS response headers are handled by cors() in index.js; this only decides who may use the vendor.
  const toOrigin = (v) => { try { return new URL(v).origin; } catch { return null; } };
  const requestOrigin = toOrigin(req.headers.origin || req.headers.referer || '');
  const allowedOrigins = (vendor.allowedOrigins || []).map(toOrigin).filter(Boolean);
  const isAllowedOrigin = Boolean(requestOrigin) && allowedOrigins.includes(requestOrigin);

  if (!isAllowedOrigin && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: { code: 403, message: 'Origin not allowed by vendor policy' } });
  }

  // 2. Monthly AI Call Cap Check
  const currentMonthKey = `${vendorId}:${new Date().toISOString().slice(0, 7)}`;
  const currentUsage = monthlyAiUsageMap.get(currentMonthKey) || 0;
  if (currentUsage >= vendor.limits.monthlyAiCallCap) {
    return res.status(429).json({ error: { code: 429, message: 'Monthly AI call capacity reached for this vendor.' } });
  }

  // 3. Rate Limiting (IP & Session level)
  const clientIp = req.ip || req.socket.remoteAddress;
  const sessionId = req.body?.sessionId || req.query?.sessionId || 'anonymous';
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour

  const ipKey = `${clientIp}:${vendorId}`;
  let ipRecord = ipRateLimitMap.get(ipKey);
  if (!ipRecord || now > ipRecord.resetTime) {
    ipRecord = { count: 0, resetTime: now + windowMs };
    ipRateLimitMap.set(ipKey, ipRecord);
  }

  const sessionKey = `${sessionId}:${vendorId}`;
  let sessionRecord = sessionRateLimitMap.get(sessionKey);
  if (!sessionRecord || now > sessionRecord.resetTime) {
    sessionRecord = { count: 0, resetTime: now + windowMs };
    sessionRateLimitMap.set(sessionKey, sessionRecord);
  }

  const maxPerHour = vendor.limits.messagesPerVisitorPerHour;
  if (ipRecord.count >= maxPerHour * 3 || sessionRecord.count >= maxPerHour) {
    return res.status(429).json({ error: { code: 429, message: 'Rate limit exceeded. Please try again later.' } });
  }

  ipRecord.count++;
  sessionRecord.count++;

  req.vendor = vendor;
  req.incrementAiUsage = () => {
    const usage = monthlyAiUsageMap.get(currentMonthKey) || 0;
    monthlyAiUsageMap.set(currentMonthKey, usage + 1);
  };

  next();
}