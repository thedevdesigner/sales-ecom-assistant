import fs from 'fs';
import path from 'path';


const configPath =path.resolve( '../config/allowedVendors.json');
const allowedMap = {};
console.log(configPath)
try {
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const vendor of data) {
    if (vendor.allowedOrigins) {
      for (const url of vendor.allowedOrigins) {
        allowedMap[url.toLowerCase().replace(/\/+$/, '')] = true;
      }
    }
  }
} catch (e) {
  console.log("Allowlist skipped or missing");
}

// Runtime check: 0 loops, instant lookup
export function verifyDomainMiddleware(req, res, next) {
  const incoming = (req.headers.origin || req.headers.referer || '').toLowerCase().replace(/\/+$/, '');
  
  if (Object.keys(allowedMap).length > 0 && !allowedMap[incoming]) {
const matchedVendor = allowedMap[incoming];
    if (!matchedVendor) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    // Attach the verified vendor object to the request!
    req.vendor = matchedVendor;  }
  
  next();
}