import { normalizeProduct } from './baseAdapter.js';

export async function searchShopifyProducts(storeUrl, query, currency = 'USD') {
  try {
    const suggestUrl = `${storeUrl}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product`;
    const res = await fetch(suggestUrl, { headers: { 'User-Agent': 'AISalesAssistant/1.0' } });
    
    if (res.ok) {
      const data = await res.json();
      const products = data.resources?.results?.products || [];
      if (products.length > 0) {
        return products.map(p => normalizeProduct({
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
  } catch (err) {
    // Fallback to products.json
  }

  try {
    const productsUrl = `${storeUrl}/products.json?limit=50`;
    const res = await fetch(productsUrl, { headers: { 'User-Agent': 'AISalesAssistant/1.0' } });
    if (!res.ok) throw new Error(`Shopify products.json error: ${res.status}`);

    const data = await res.json();
    const items = data.products || [];
    const lowerQuery = query.toLowerCase();

    const filtered = items.filter(p => 
      p.title.toLowerCase().includes(lowerQuery) || 
      (p.product_type && p.product_type.toLowerCase().includes(lowerQuery))
    );

    return filtered.map(p => normalizeProduct({
      id: p.id,
      title: p.title,
      price: p.variants?.[0]?.price,
      currency,
      imageUrl: p.images?.[0]?.src,
      url: `${storeUrl}/products/${p.handle}`,
      inStock: p.variants?.[0]?.available ?? true,
      category: p.product_type
    }, currency));
  } catch (err) {
    return [];
  }
}