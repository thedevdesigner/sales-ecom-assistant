import fs from 'fs';
import path from 'path';

const configPath = path.join(process.cwd(), 'src', 'config', 'allowedVendors.json');

// Normalize anything (origin or full URL) down to "https://host"
function toOrigin(value) {
  if (!value) return '';
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return '';
  }
}

const allowedMap = {};
try {
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const vendor of data) {
    const origins = [...(vendor.allowedOrigins || []), vendor.storeUrl];
    for (const url of origins) {
      const origin = toOrigin(url);
      if (origin) allowedMap[origin] = vendor;
    }
  }
  console.log('Loaded allowedMap keys:', Object.keys(allowedMap));
} catch (e) {
  console.error('Could not load allowedVendors.json:', e.message);
}

export function verifyDomainMiddleware(req, res, next) {
  const incoming = toOrigin(req.headers.origin) || toOrigin(req.headers.referer);

  if (!incoming) {
    // Only allow header-less requests when explicitly enabled (local dev)
    if (process.env.ALLOW_NO_ORIGIN === 'true') return next();
    return res.status(403).json({ error: 'Missing origin' });
  }

  const matchedVendor = allowedMap[incoming];
  if (!matchedVendor) {
    console.log(`Blocked unauthorized domain: "${incoming}"`);
    return res.status(403).json({ error: 'Unauthorized', received: incoming });
  }

  req.vendor = matchedVendor;
  next();
}