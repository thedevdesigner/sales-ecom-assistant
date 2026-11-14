import fs from 'fs';
import path from 'path';

// Use process.cwd() so it always finds your root config folder accurately
const configPath = path.join(process.cwd(),'src', 'config', 'allowedVendors.json');

let allowedMap = {};
try {
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const vendor of data) {
    if (vendor.allowedOrigins) {
      for (const url of vendor.allowedOrigins) {
        const cleanUrl = url.toLowerCase().replace(/\/+$/, '');
        allowedMap[cleanUrl] = vendor;
      }
    }
  }
  console.log("Successfully loaded allowedMap with keys:", Object.keys(allowedMap));
} catch (e) {
  console.log("Could not load allowedVendors.json:", e.message);
}

export function verifyDomainMiddleware(req, res, next) {
  const incoming = (req.headers.origin || req.headers.referer || '').toLowerCase().replace(/\/+$/, '');
  
  console.log("Incoming request header:", incoming); // <-- Check your Render logs for this!

  // TEMPORARY BYPASS FOR LOCAL TESTING / DIRECT BROWSER URL TESTING:
  // If no header is sent (like typing it in the browser), let it pass for now so you can test the route
  if (!incoming) {
    console.log("No origin/referer header detected. Allowing request for testing.");
    return next();
  }

  const matchedVendor = allowedMap[incoming];
  if (!matchedVendor) {
    console.log(`Blocked unauthorized domain: "${incoming}"`);
    return res.status(403).json({ error: 'Unauthorized', received: incoming });
  }

  req.vendor = matchedVendor;
  next();
}