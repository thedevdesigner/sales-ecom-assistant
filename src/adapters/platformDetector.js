import { searchShopifyProducts } from './shopifyAdapter.js';
import { searchWooProducts } from './wooAdapter.js';

const cache = new Map();
const inflightRequests = new Map();
const TTL_MS = 7 * 60 * 1000; // 7 minutes

export async function detectPlatform(storeUrl) {
  try {
    const shopifyCheck = await fetch(`${storeUrl}/products.json?limit=1`, { method: 'HEAD' });
    if (shopifyCheck.ok) return 'shopify';

    const wooCheck = await fetch(`${storeUrl}/wp-json/wc/store/v1/products`, { method: 'HEAD' });
    if (wooCheck.ok) return 'woocommerce';
  } catch (err) {
    // Probe failed
  }
  return 'auto';
}

export async function searchProducts(vendor, query) {
  const cacheKey = `search:${vendor.id}:${query.toLowerCase().trim()}`;
  const now = Date.now();

  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (now < cached.expiry) return cached.data;
    cache.delete(cacheKey);
  }

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const promise = (async () => {
    let results = [];
    const platform = vendor.platform === 'auto' ? await detectPlatform(vendor.storeUrl) : vendor.platform;

    if (platform === 'shopify') {
      results = await searchShopifyProducts(vendor.storeUrl, query, vendor.currency);
    } else if (platform === 'woocommerce') {
      results = await searchWooProducts(vendor.storeUrl, query, vendor.currency);
    }

    cache.set(cacheKey, { data: results, expiry: Date.now() + TTL_MS });
    inflightRequests.delete(cacheKey);
    return results;
  })();

  inflightRequests.set(cacheKey, promise);
  return promise;
}