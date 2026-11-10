import { normalizeProduct } from './baseAdapter.js';

export async function searchWooProducts(storeUrl, query, currency = 'USD') {
  try {
    const searchUrl = `${storeUrl}/wp-json/wc/store/v1/products?search=${encodeURIComponent(query)}&per_page=10`;
    const res = await fetch(searchUrl, { headers: { 'User-Agent': 'AISalesAssistant/1.0' } });
    
    if (!res.ok) throw new Error(`WooCommerce Store API error: ${res.status}`);

    const items = await res.json();
    return items.map(item => {
      const minorUnit = item.prices?.currency_minor_unit || 2;
      const divisor = Math.pow(10, minorUnit);
      const rawPrice = parseInt(item.prices?.price || 0, 10);
      const price = rawPrice / divisor;

      return normalizeProduct({
        id: item.id,
        title: item.name,
        price,
        currency: item.prices?.currency_code || currency,
        imageUrl: item.images?.[0]?.src,
        url: item.permalink,
        inStock: item.is_in_stock ?? true,
        category: item.categories?.[0]?.name
      }, currency);
    });
  } catch (err) {
    return [];
  }
}