import { convert as convertMarkdown } from '@vakra-dev/supermarkdown';
import MiniSearch from 'minisearch';
import { normalizeProduct } from './baseAdapter.js';

/**
 * Shopify search: index once, search in memory with robust 429 rate-limit handling.
 *
 *  BUILD  (off the request path, once per store per 15 min)  O(N) in total catalog text
 *    /products.json pages of 250, fetched in safe waves  ->  compact docs  ->  inverted index
 *  QUERY  (every shopper message)                            O(m + P)
 *    Repeated questions hit a small result cache: O(1).
 *
 * Needs: npm i minisearch @vakra-dev/supermarkdown
 */

const UA = { 'User-Agent': 'AISalesAssistant/1.0' };
const PAGE_SIZE = 250;
const WAVE = 2;                       // Reduced parallel requests to prevent Shopify 429 rate limits
const MAX_PRODUCTS = 25000;           // memory guard
const TTL_MS = 15 * 60 * 1000;        // catalog refresh interval (stale data is served while refreshing)
const RETRY_AFTER_FAIL_MS = 60 * 1000;
const QUERY_CACHE_MAX = 500;
const QUERY_CACHE_TTL = 2 * 60 * 1000;

const stores = new Map();             // storeUrl -> { value, builtAt, building, failedAt, version }
const queryCache = new Map();         // key -> { at, value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- text normalisation (used at index time AND query time) ---------------- */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'me', 'my', 'i', 'you', 'is', 'are', 'do', 'does', 'have', 'any', 'some', 'show', 'find', 'looking', 'want', 'need', 'please', 'under', 'below', 'over', 'than', 'less', 'more', 'cheap', 'cheaper', 'good', 'best', 'something', 'anything', 'one']);
const IRREGULAR = { knives: 'knife', shelves: 'shelf', leaves: 'leaf', wolves: 'wolf', men: 'man', women: 'woman', children: 'child', feet: 'foot' };

function stem(t) {
  if (IRREGULAR[t]) return IRREGULAR[t];
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && /(ches|shes|sses|xes|zes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return t.slice(0, -1);
  return t;
}
function processTerm(term) {
  const t = String(term).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!t || STOP.has(t)) return null;
  const s = stem(t);
  return STOP.has(s) ? null : s;
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const queryTerms = (q) => [...new Set(norm(q).split(' ').map(processTerm).filter(Boolean))];

/* ---------------- robust JSON fetch with 429 rate-limit backoff ---------------- */
async function fetchJson(url, timeoutMs = 12000, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: UA, signal: ctrl.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        if (attempt === retries) { const e = new Error(`HTTP 429 Rate Limited`); e.status = 429; throw e; }
        const backoff = attempt * 2500; // Progressive backoff (2.5s, 5s, 7.5s)
        console.warn(`[shopify] Rate limited (429) on ${url}. Retrying in ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

async function fetchPage(storeUrl, page) {
  const url = `${storeUrl}/products.json?limit=${PAGE_SIZE}&page=${page}`;
  try { 
    const data = await fetchJson(url);
    return data.products || []; 
  } catch (err) {
    if (page === 1) throw err; // Page 1 failing means catalog is restricted/unavailable
    console.warn('[shopify] page', page, 'failed safely:', err.message);
    return [];
  }
}

async function fetchCatalog(storeUrl) {
  const all = [];
  for (let page = 1; all.length < MAX_PRODUCTS; page += WAVE) {
    const batch = await Promise.all(Array.from({ length: WAVE }, (_, k) => fetchPage(storeUrl, page + k)));
    let done = false;
    for (const items of batch) { 
      for (const p of items) all.push(p); 
      if (items.length < PAGE_SIZE) done = true; 
    }
    if (done) break;
    await sleep(600); // Politeness delay between waves to prevent 429 triggers
  }
  return all;
}

/* ---------------- compact documents ---------------- */
function toDoc(p) {
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  const cover = p.images?.[0]?.src || p.image?.src || '';
  const imgByVariant = new Map();
  for (const im of p.images || []) for (const vid of im.variant_ids || []) imgByVariant.set(vid, im.src);

  const variants = (p.variants || []).map((v) => ({
    id: v.id,
    price: Number(v.price),
    available: v.available !== false,
    opts: [v.option1, v.option2, v.option3].filter(Boolean).map((s) => String(s).toLowerCase()),
    img: imgByVariant.get(v.id) || cover,
  })).filter((v) => Number.isFinite(v.price));
  if (!variants.length) return null;

  const optValues = new Set();
  variants.forEach((v) => v.opts.forEach((o) => optValues.add(o)));
  const title = p.title || '';
  return {
    id: String(p.id), handle: p.handle, title, type: p.product_type || '', vendor: p.vendor || '',
    tags: tags.join(' '), opts: [...optValues].join(' '),
    desc: String(p.body_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    textLc: `${title} ${tags.join(' ')} ${p.product_type || ''}`.toLowerCase(),
    variants,
  };
}

async function buildStore(storeUrl) {
  const raw = await fetchCatalog(storeUrl);
  const docs = raw.map(toDoc).filter(Boolean);
  if (!docs.length) throw new Error('empty catalog');
  const ms = new MiniSearch({
    idField: 'id',
    fields: ['title', 'type', 'tags', 'opts', 'vendor', 'desc'],
    storeFields: [],
    processTerm,
    searchOptions: {
      boost: { title: 3, type: 2, tags: 2, opts: 2, vendor: 1.2, desc: 0.5 },
      prefix: (t) => t.length >= 3,
      fuzzy: (t) => (t.length > 4 ? 0.2 : false),
    },
  });
  await ms.addAllAsync(docs, { chunkSize: 500 });
  const byId = new Map(docs.map((d) => [d.id, d]));
  return { ms, byId, docs, version: Date.now() };
}

function getStore(storeUrl) {
  let e = stores.get(storeUrl);
  if (!e) { e = { value: null, builtAt: 0, building: null, failedAt: 0 }; stores.set(storeUrl, e); }
  const stale = Date.now() - e.builtAt > TTL_MS;
  if ((!e.value || stale) && !e.building && Date.now() - e.failedAt > RETRY_AFTER_FAIL_MS) {
    e.building = buildStore(storeUrl)
      .then((v) => { e.value = v; e.builtAt = Date.now(); })
      .catch((err) => { e.failedAt = Date.now(); console.warn('[shopify] index build failed:', err.message); })
      .finally(() => { e.building = null; });
  }
  if (e.value) return Promise.resolve(e.value);
  return (e.building || Promise.resolve(null)).then(() => e.value);
}

export function warmShopifyCatalog(storeUrl) { return getStore(storeUrl).then(() => undefined).catch(() => undefined); }

/* ---------------- filtering and searching ---------------- */
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function matchVariant(p, f) {
  if (!p) return null;
  if (f.maxPrice === null && f.minPrice === null && !f.color && !f.inStockOnly) {
    return p.variants.find((v) => v.available) || p.variants[0];
  }
  let best = null;
  for (const v of p.variants) {
    if (f.inStockOnly && !v.available) continue;
    if (f.maxPrice !== null && !(v.price <= f.maxPrice)) continue;
    if (f.minPrice !== null && !(v.price >= f.minPrice)) continue;
    if (f.color && !(v.opts.some((o) => o.includes(f.color)) || p.textLc.includes(f.color))) continue;
    if (!best || (v.available && !best.available) || (v.available === best.available && v.price < best.price)) best = v;
  }
  return best;
}

function buildQuery(terms, synonyms, mode) {
  return {
    combineWith: mode,
    queries: terms.map((t) => (synonyms[t]?.length ? { combineWith: 'OR', queries: [t, ...synonyms[t]] } : t)),
  };
}

function normaliseSynonyms(raw) {
  const out = {};
  for (const [k, list] of Object.entries(raw || {})) {
    const key = processTerm(k);
    if (!key) continue;
    out[key] = [...new Set((list || []).map((w) => processTerm(w)).filter(Boolean))];
  }
  return out;
}

function searchIndex(store, f, limit, synonyms) {
  const terms = queryTerms(f.query);
  const pass = (r) => !!matchVariant(store.byId.get(r.id), f);
  let ids;

  if (terms.length) {
    let hits = store.ms.search(buildQuery(terms, synonyms, 'AND'), { filter: pass });
    if (hits.length < 3 && terms.length > 1) hits = store.ms.search(buildQuery(terms, synonyms, 'OR'), { filter: pass });
    ids = hits.slice(0, limit).map((h) => h.id);
  } else {
    const matched = [];
    for (const d of store.docs) { const v = matchVariant(d, f); if (v) matched.push({ d, v }); }
    matched.sort((a, b) => Number(b.v.available) - Number(b.v.available));
    ids = matched.slice(0, limit).map((m) => m.d.id);
  }
  return ids.map((id) => store.byId.get(id));
}

/* ---------------- fallback suggest API (Guarantees results when products.json is rate-limited) ---------------- */
async function suggestFallback(storeUrl, f, currency, limit) {
  try {
    const searchQuery = f.query || 'knife'; // Fallback keyword for browse requests like bestsellers
    const data = await fetchJson(`${storeUrl}/search/suggest.json?q=${encodeURIComponent(searchQuery)}&resources[type]=product&resources[limit]=12`, 6000);
    return (data.resources?.results?.products || [])
      .map((p) => ({ p, price: parseFloat(String(p.price).replace(/[^0-9.]/g, '')) }))
      .filter(({ p, price }) => (f.maxPrice === null || price <= f.maxPrice) && (f.minPrice === null || price >= f.minPrice) &&
        (!f.color || String(p.title).toLowerCase().includes(f.color)))
      .slice(0, limit)
      .map(({ p, price }) => normalizeProduct({ 
        id: p.id, 
        title: p.title, 
        price, 
        currency, 
        imageUrl: p.image || p.featured_image?.url, 
        url: `${storeUrl}${p.url}`, 
        inStock: p.available ?? true 
      }, currency));
  } catch (err) {
    console.warn('[shopify] suggest fallback failed:', err.message);
    return [];
  }
}

export async function searchShopifyProducts(storeUrl, criteria, currency = 'USD') {
  const c = typeof criteria === 'string' ? { query: criteria } : criteria || {};
  const f = {
    query: String(c.query || '').trim(),
    maxPrice: num(c.maxPrice), 
    minPrice: num(c.minPrice),
    color: c.color ? String(c.color).toLowerCase().trim() : null,
    // 🌟 Enforce in-stock filtering by default unless explicitly set to false
    inStockOnly: c.inStockOnly !== undefined ? Boolean(c.inStockOnly) : true,
  };
  const limit = Math.min(Number(c.limit) || 12, 24);

  const store = await getStore(storeUrl);
  if (!store) {
    return suggestFallback(storeUrl, f, currency, limit);
  }

  const key = `${storeUrl}|${store.version}|${JSON.stringify(f)}|${limit}|${JSON.stringify(c.synonyms || {})}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_CACHE_TTL) return hit.value;

  // 🌟 Search across all dynamic options, tags, titles, and variant descriptions in memory (<5ms)
  const docs = searchIndex(store, f, limit, normaliseSynonyms(c.synonyms));
  
  if (docs.length === 0 && !f.query) {
    return suggestFallback(storeUrl, f, currency, limit);
  }

  const value = docs.map((d) => {
    const v = matchVariant(d, f);
    return {
      ...normalizeProduct({
        id: d.id, title: d.title, price: v.price, currency, imageUrl: v.img,
        url: `${storeUrl}/products/${d.handle}?variant=${v.id}`, inStock: v.available,
      }, currency),
      description: d.desc,
    };
  });

  queryCache.set(key, { at: Date.now(), value });
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  return value;
}
/* ---------------- FAST PATH-BASED PAGE & POLICY DISCOVERY ---------------- */
const PATH_MAPS = {
  refund: [
    '/policies/refund-policy',
    '/pages/refund-policy',
    '/policies/return-policy',
    '/pages/returns',
    '/pages/return-policy'
  ],
  shipping: [
    '/policies/shipping-policy',
    '/pages/shipping',
    '/pages/shipping-policy',
    '/pages/delivery'
  ],
  terms: [
    '/policies/terms-of-service',
    '/pages/terms-of-service',
    '/pages/terms-and-conditions'
  ],
  privacy: [
    '/policies/privacy-policy',
    '/pages/privacy-policy'
  ],
  contact: [
    '/pages/contact',
    '/pages/contact-us',
    '/contact',
    '/pages/support'
  ],
  about: [
    '/pages/about-us',
    '/pages/about',
    '/about'
  ],
  faq: [
    '/pages/faq',
    '/pages/faqs',
    '/pages/frequently-asked-questions'
  ]
};

export async function discoverStorePages(storeUrl, keyword = '') {
  const normalizedKeyword = String(keyword || '').toLowerCase().trim();
  const candidateUrls = new Set();

  let matchedCategories = [];
  if (/refund|return/.test(normalizedKeyword)) matchedCategories.push('refund');
  if (/shipping|deliver/.test(normalizedKeyword)) matchedCategories.push('shipping');
  if (/terms|condition/.test(normalizedKeyword)) matchedCategories.push('terms');
  if (/privacy/.test(normalizedKeyword)) matchedCategories.push('privacy');
  if (/contact|support|reach/.test(normalizedKeyword)) matchedCategories.push('contact');
  if (/about|who/.test(normalizedKeyword)) matchedCategories.push('about');
  if (/faq|question/.test(normalizedKeyword)) matchedCategories.push('faq');

  for (const cat of matchedCategories) {
    if (PATH_MAPS[cat]) {
      PATH_MAPS[cat].forEach(path => candidateUrls.add(`${storeUrl}${path}`));
    }
  }

  if (candidateUrls.size === 0) {
    Object.values(PATH_MAPS).flat().forEach(path => candidateUrls.add(`${storeUrl}${path}`));
  }

  const pathList = Array.from(candidateUrls);

  const probePromises = pathList.map(async (url) => {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: UA,
        signal: AbortSignal.timeout(2500)
      });
      if (res.status === 200) return url;
    } catch (e) {}
    return null;
  });

  const verifiedUrls = (await Promise.all(probePromises)).filter(Boolean);

  if (verifiedUrls.length > 0) {
    return verifiedUrls.slice(0, 3);
  }

  try {
    const homeRes = await fetch(storeUrl, {
      headers: UA,
      signal: AbortSignal.timeout(3000)
    });

    if (homeRes.status === 200) {
      const html = await homeRes.text();
      const markdownOutput = convertMarkdown(html);
      const urlRegex = /https?:\/\/[^\s)]+|href="([^"]+)"/g;
      const scrapedLinks = new Set();
      
      let match;
      while ((match = urlRegex.exec(markdownOutput)) !== null) {
        const href = match[1] || match[0];
        if (href) {
          const fullUrl = href.startsWith('http') ? href : `${storeUrl}${href.startsWith('/') ? '' : '/'}${href}`;
          if (/(policy|refund|return|shipping|terms|contact|about|faq)/i.test(fullUrl)) {
            scrapedLinks.add(fullUrl);
          }
        }
      }

      const linksArray = Array.from(scrapedLinks);
      if (normalizedKeyword) {
        linksArray.sort((a, b) => (b.toLowerCase().includes(normalizedKeyword) ? 1 : -1));
      }
      return linksArray.slice(0, 3);
    }
  } catch (homeErr) {}

  return pathList.slice(0, 3);
}