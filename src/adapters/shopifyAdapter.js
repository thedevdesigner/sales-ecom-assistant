import { normalizeProduct } from './baseAdapter.js';

// Global cache so we only fetch the full store catalog once per server lifecycle (or refreshed periodically)
const storeCache = new Map();

async function getCachedCatalog(storeUrl) {
  if (storeCache.has(storeUrl)) {
    return storeCache.get(storeUrl);
  }

  let allProducts = [];
  let page = 1;
  let hasMore = true;

  // Background fetch (runs smoothly, but we optimize by capping or streaming if needed)
  while (hasMore && page <= 10) { // Safety guard
    try {
      const res = await fetch(`${storeUrl}/products.json?limit=250&page=${page}`, {
        headers: { 'User-Agent': 'AISalesAssistant/1.0' }
      });
      if (!res.ok) break;
      const data = await res.json();
      const products = data.products || [];
      
      if (products.length === 0) {
        hasMore = false;
      } else {
        allProducts = allProducts.concat(products);
        if (products.length < 250) hasMore = false;
        else page++;
      }
    } catch (e) {
      break;
    }
  }

  storeCache.set(storeUrl, allProducts);
  return allProducts;
}

export async function searchShopifyProducts(storeUrl, criteria, currency = 'USD') {
  const searchCriteria = typeof criteria === 'string' ? { query: criteria } : (criteria || {});
  const query = (searchCriteria.query || '').toLowerCase().trim();
  const maxPrice = searchCriteria.maxPrice ?? null;
  const targetColor = searchCriteria.color ? searchCriteria.color.toLowerCase() : null;

  // 1. FAST PATH: If it's a simple name search without complex price/color filters, use Shopify suggest first!
  if (query && maxPrice === null && !targetColor) {
    try {
      const suggestRes = await fetch(`${storeUrl}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product`, {
        headers: { 'User-Agent': 'AISalesAssistant/1.0' }
      });
      if (suggestRes.ok) {
        const suggestData = await suggestRes.json();
        const results = suggestData.resources?.results?.products || [];
        if (results.length > 0) {
          return results.slice(0, 8).map(p => normalizeProduct({
            id: p.id,
            title: p.title,
            price: p.price,
            currency,
            imageUrl: p.image,
            url: `${storeUrl}${p.url}`,
            inStock: p.available ?? true
          }, currency));
        }
      }
    } catch (e) {
      // Fallback to full catalog if suggest fails
    }
  }

  // 2. DEEP PATH: For complex filters (price, variants, colors), pull from our cached catalog instantly
  const allProducts = await getCachedCatalog(storeUrl);
  if (allProducts.length === 0) return [];

  const filtered = allProducts.filter(p => {
    const title = (p.title || '').toLowerCase();
    const variants = p.variants || [p];
    
    let matchesQuery = !query || title.includes(query);
    let matchesVariantCriteria = false;

    for (const v of variants) {
      const price = parseFloat(v.price || 0);
      if (maxPrice !== null && price > maxPrice) continue;

      const vTitle = (v.title || '').toLowerCase();
      if (targetColor && !vTitle.includes(targetColor)) continue;

      matchesVariantCriteria = true;
      break;
    }

    return matchesQuery && matchesVariantCriteria;
  });

  return filtered.slice(0, 8).map(p => {
    const defaultVariant = p.variants?.[0] || p;
    return normalizeProduct({
      id: p.id,
      title: p.title,
      price: defaultVariant.price || p.price,
      currency,
      imageUrl: p.images?.[0]?.src || '',
      url: `${storeUrl}/products/${p.handle}`,
      inStock: defaultVariant.available ?? true
    }, currency);
  });
}