import fs from 'fs';
import path from 'path';


const configPath = path.resolve( '../config/allowedVendors.json');
// 2. Load the vendors once when server boots
let allowedMap = {};
try {
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const vendor of data) {
    if (vendor.allowedOrigins) {
      for (const url of vendor.allowedOrigins) {
        // Clean trailing slashes so matching is foolproof
        const cleanUrl = url.toLowerCase().replace(/\/+$/, '');
        allowedMap[cleanUrl] = vendor;
      }
    }
  }
} catch (e) {
  console.log("Could not load allowedVendors.json");
}

// 3. The simple check middleware
export function verifyDomainMiddleware(req, res, next) {
  const incoming = (req.headers.origin || req.headers.referer || '').toLowerCase().replace(/\/+$/, '');
  
  // If the incoming URL is not in our map, block it
  const matchedVendor = allowedMap[incoming];
  if (!matchedVendor) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Attach vendor to request so your route can use it instantly
  req.vendor = matchedVendor;
  next();
}