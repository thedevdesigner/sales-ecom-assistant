export function normalizeProduct(raw, currency = 'USD') {
  return {
    id: String(raw.id || raw.sku || ''),
    title: raw.title || raw.name || 'Untitled Product',
    price: parseFloat(raw.price || raw.variants?.[0]?.price || 0),
    currency: raw.currency || currency,
    imageUrl: raw.imageUrl || raw.image_url || raw.images?.[0]?.src || raw.images?.[0]?.url || '',
    url: raw.url || raw.permalink || '',
    inStock: raw.inStock ?? raw.available ?? raw.variants?.[0]?.available ?? true,
    category: raw.category || raw.product_type || ''
  };
}