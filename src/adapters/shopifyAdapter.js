import MiniSearch from 'minisearch';
import { normalizeProduct } from './baseAdapter.js';

/**
 * Shopify search: index once, search in memory.
 *
 *  BUILD  (off the request path, once per store per 15 min)  O(N) in total catalog text
 *    /products.json pages of 250, fetched 5 at a time  ->  compact docs  ->  inverted index
 *  QUERY  (every shopper message)                            O(m + P)
 *    m = words in the query, P = postings of those words. Independent of catalog size for selective words.
 *    Repeated questions hit a small result cache: O(1).
 *
 * Needs: npm i minisearch
 */

const UA = { 'User-Agent': 'AISalesAssistant/1.0' };
const PAGE_SIZE = 250;
const WAVE = 5;                       // parallel page requests per wave (be polite to the store)
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

/* ---------------- fetching the catalog ---------------- */
async function fetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fetchPage(storeUrl, page) {
  const url = `${storeUrl}/products.json?limit=${PAGE_SIZE}&page=${page}`;
  try { return (await fetchJson(url)).products || []; }
  catch (err) {
    if (err.status === 429 || !err.status) { await sleep(1200); return (await fetchJson(url)).products || []; } // one retry
    throw err;
  }
}

async function fetchCatalog(storeUrl) {
  const all = [];
  for (let page = 1; all.length < MAX_PRODUCTS; page += WAVE) {
    const batch = await Promise.all(Array.from({ length: WAVE }, (_, k) =>
      fetchPage(storeUrl, page + k).catch((err) => {
        if (page + k === 1) throw err;            // page 1 failing = catalog not available at all
        console.warn('[shopify] page', page + k, 'failed:', err.message);
        return [];
      })));
    let done = false;
    for (const items of batch) { for (const p of items) all.push(p); if (items.length < PAGE_SIZE) done = true; }
    if (done) break;
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
      fuzzy: (t) => (t.length > 4 ? 0.2 : false),   // typo tolerance only for longer words
    },
  });
  await ms.addAllAsync(docs, { chunkSize: 500 });    // chunked so the server keeps answering while indexing
  const byId = new Map(docs.map((d) => [d.id, d]));
  return { ms, byId, docs, version: Date.now() };
}

/** Returns the index (or null if this store does not expose /products.json). Never blocks when a stale copy exists. */
function getStore(storeUrl) {
  let e = stores.get(storeUrl);
  if (!e) { e = { value: null, builtAt: 0, building: null, failedAt: 0 }; stores.set(storeUrl, e); }
  const stale = Date.now() - e.builtAt > TTL_MS;
  if ((!e.value || stale) && !e.building && Date.now() - e.failedAt > RETRY_AFTER_FAIL_MS) {
    e.building = buildStore(storeUrl)               // single-flight: concurrent callers share one build
      .then((v) => { e.value = v; e.builtAt = Date.now(); })
      .catch((err) => { e.failedAt = Date.now(); console.warn('[shopify] index build failed:', err.message); })
      .finally(() => { e.building = null; });
  }
  if (e.value) return Promise.resolve(e.value);     // fresh or stale: answer immediately
  return (e.building || Promise.resolve(null)).then(() => e.value);
}

/** Call at server start and from GET /config so the index is ready before the first question. */
export function warmShopifyCatalog(storeUrl) { return getStore(storeUrl).then(() => undefined).catch(() => undefined); }

/* ---------------- filtering and searching ---------------- */
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The variant that satisfies price / colour / stock, so the card shows the right price, image and link. */
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
    if (hits.length < 3 && terms.length > 1) hits = store.ms.search(buildQuery(terms, synonyms, 'OR'), { filter: pass }); // relax: more matched words rank higher
    ids = hits.slice(0, limit).map((h) => h.id);
  } else {
    // No text (e.g. "show me something under $30"): filter-only scan, in-stock first
    const matched = [];
    for (const d of store.docs) { const v = matchVariant(d, f); if (v) matched.push({ d, v }); }
    matched.sort((a, b) => Number(b.v.available) - Number(a.v.available));
    ids = matched.slice(0, limit).map((m) => m.d.id);
  }
  return ids.map((id) => store.byId.get(id));
}

/* ---------------- fallback when /products.json is blocked: the store's own live search ---------------- */
async function suggestFallback(storeUrl, f, currency, limit) {
  if (!f.query) return [];
  try {
    const data = await fetchJson(`${storeUrl}/search/suggest.json?q=${encodeURIComponent(f.query)}&resources[type]=product&resources[limit]=10`, 6000);
    return (data.resources?.results?.products || [])
      .map((p) => ({ p, price: parseFloat(String(p.price).replace(/[^0-9.]/g, '')) }))
      .filter(({ p, price }) => (f.maxPrice === null || price <= f.maxPrice) && (f.minPrice === null || price >= f.minPrice) &&
        (!f.color || String(p.title).toLowerCase().includes(f.color)))
      .slice(0, limit)
      .map(({ p, price }) => normalizeProduct({ id: p.id, title: p.title, price, currency, imageUrl: p.image, url: `${storeUrl}${p.url}`, inStock: p.available ?? true }, currency));
  } catch { return []; }
}

/**
 * criteria: string, or { query, maxPrice, minPrice, color, inStockOnly, limit, synonyms }
 * Push the budget and colour INTO this call (do not filter afterwards), so a $50 limit searches the
 * whole catalog instead of filtering whichever 8 results happened to rank first.
 */
export async function searchShopifyProducts(storeUrl, criteria, currency = 'USD') {
  const c = typeof criteria === 'string' ? { query: criteria } : criteria || {};
  const f = {
    query: String(c.query || '').trim(),
    maxPrice: num(c.maxPrice), minPrice: num(c.minPrice),
    color: c.color ? String(c.color).toLowerCase().trim() : null,
    inStockOnly: Boolean(c.inStockOnly),
  };
  const limit = Math.min(Number(c.limit) || 12, 24);

  const store = await getStore(storeUrl);
  if (!store) return suggestFallback(storeUrl, f, currency, limit);

  const key = `${storeUrl}|${store.version}|${JSON.stringify(f)}|${limit}|${JSON.stringify(c.synonyms || {})}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < QUERY_CACHE_TTL) return hit.value;           // O(1)

  const docs = searchIndex(store, f, limit, normaliseSynonyms(c.synonyms));
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