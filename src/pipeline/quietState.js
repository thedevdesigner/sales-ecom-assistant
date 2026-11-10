import { generateAICompletion } from '../services/aiClient.js';

// ---------------------------------------------------------------------------
// NOTE (streaming refactor): this file needs NO logic changes.
//
// Every reply it produces is a fixed template string, so the route simply
// sends it as a single delta on the stream:
//     sink.meta({ products: [], state, strikes });
//     sink.delta(quietCheck.reply);
//     sink.done({ state, strikes });
//
// One genuine gap that streaming exposes: the strike-3 short-message
// classifier below makes the client WAIT on an AI call before ANY byte is
// written. With streaming you could instead send a "thinking..." delta first
// (or a meta frame with {state:'checking'}) — optional, cost-free polish.
// ---------------------------------------------------------------------------

// Server-side in-memory strike store (TTL ~30 minutes)
const serverStrikesMap = new Map(); // Key: `${sessionId}:${ip}` -> { strikes, timestamp }
const TTL_MS = 30 * 60 * 1000;

// Purge expired records so the map never grows without limit
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of serverStrikesMap) {
    if (now - rec.timestamp >= TTL_MS) serverStrikesMap.delete(key);
  }
}, 10 * 60 * 1000).unref();

// GAP (pre-existing, unrelated to streaming): this Map is per-process.
// If you ever run more than one Node instance, strikes reset randomly
// depending on which instance serves the request. Migrate to Redis or a
// shared store keyed by `${sessionId}:${ip}` when you scale.
export function getCombinedStrikes(sessionId, clientIp, clientStrikes) {
  const key = `${sessionId}:${clientIp}`;
  const now = Date.now();
  const record = serverStrikesMap.get(key);

  let serverStrikes = 0;
  if (record && now - record.timestamp < TTL_MS) {
    serverStrikes = record.strikes;
  }

  // Use the stricter (higher) of client vs server strikes
  return Math.max(serverStrikes, Number(clientStrikes) || 0);
}

export function recordStrike(sessionId, clientIp, currentStrikes) {
  const key = `${sessionId}:${clientIp}`;
  const updated = currentStrikes + 1;
  serverStrikesMap.set(key, { strikes: updated, timestamp: Date.now() });
  return updated;
}

export function resetStrikes(sessionId, clientIp) {
  serverStrikesMap.delete(`${sessionId}:${clientIp}`);
}

/* ---------- Free (no-AI) topic detection ---------- */

// Whole-word matches only, so "hi" can no longer match "this" or "machine"
const GENERIC = /\b(buy|purchase|price|prices|pricing|cheap|cheaper|cheapest|expensive|under|below|budget|deal|deals|sale|discount|cost|how much|do you have|do you sell|recommend|suggest|looking for|need|want|show me|find|compare|best|bestseller|bestsellers|gift|available|availability|in stock|stock|size|sizes|color|colour|shipping|delivery|return|returns|refund|warranty|policy|order|product|products|shop|store|catalog|category|categories)\b/i;
const GREETING = /^\s*(hi|hello|hey|hiya|good (morning|afternoon|evening)|thanks|thank you|thx|ok|okay)\b/i;
const INJECTION = /(ignore|disregard|forget) (all |your |any |the |previous |prior )*(instructions|rules|prompts?)|system prompt|reveal your (prompt|instructions)|override (your|the|all)|jailbreak|developer mode/i;

const kwCache = new Map(); // vendor.id -> RegExp | null

function vendorRegex(vendor) {
  if (!kwCache.has(vendor.id)) {
    const words = [vendor.name, ...(vendor.keywords || [])]
      .filter(Boolean)
      .map((w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    kwCache.set(vendor.id, words.length ? new RegExp(`\\b(${words.join('|')})`, 'i') : null);
  }
  return kwCache.get(vendor.id);
}

// Accepts a vendor object (preferred) or, for backward compatibility, a vendor name string
export function hasShoppingSignal(messageText, vendor) {
  const v = typeof vendor === 'string' ? { id: vendor, name: vendor } : vendor || {};
  const text = String(messageText || '');
  return GENERIC.test(text) || Boolean(vendorRegex(v)?.test(text));
}

/**
 * opts.isFollowUp: true when this is a short reply inside an ongoing, on-topic
 * conversation (e.g. tapping a chip like "Party"). These never earn a strike.
 */
export async function evaluateQuietState(messageText, vendor, activeStrikes, sessionId, clientIp, opts = {}) {
  const text = String(messageText || '');
  const injection = INJECTION.test(text);

  // On-topic: greetings, store questions, shopping words, the store's own product words, short follow-ups
  if (!injection && (GREETING.test(text) || opts.isFollowUp || hasShoppingSignal(text, vendor))) {
    resetStrikes(sessionId, clientIp);
    return { state: 'normal', strikes: 0, bypassQuiet: true };
  }

  // Off-topic or injection attempt: count a strike
  const newStrikes = recordStrike(sessionId, clientIp, activeStrikes);

  // Injection attempts get a short neutral line, no friendly coaching
  if (injection) {
    return {
      state: newStrikes >= 3 ? 'quiet' : 'warned',
      strikes: newStrikes,
      reply: `I can only help with shopping questions at ${vendor.name}.`,
      bypassQuiet: false,
      products: []
    };
  }

  if (newStrikes === 1 || newStrikes === 2) {
    return {
      state: 'warned',
      strikes: newStrikes,
      reply: `I'm your shopping assistant for ${vendor.name}! I can help you find products, check prices, or answer store questions. What are you looking for today?`,
      bypassQuiet: false,
      products: []
    };
  }

  if (newStrikes === 3) {
    return {
      state: 'warned',
      strikes: newStrikes,
      reply: `Just a heads-up: I'm designed specifically to help you shop and find products here at ${vendor.name}. If we keep chatting about off-topic subjects, I'll pause my AI responses. How can I help you find what you need?`,
      bypassQuiet: false,
      products: []
    };
  }

  // Beyond strike 3 (quiet state). The free shopping check already ran above, so the only
  // second chance is ONE tiny AI classification, for short ambiguous messages.
  if (text.trim().split(/\s+/).length <= 6) {
    try {
      const classifierPrompt = `Is this message related to shopping or a product inquiry? Answer ONLY with YES or NO.\nMessage: ${JSON.stringify(text.slice(0, 200))}`;
      const verdict = await generateAICompletion([{ role: 'user', content: classifierPrompt }], false);
      if (String(verdict).toUpperCase().includes('YES')) {
        resetStrikes(sessionId, clientIp);
        return { state: 'normal', strikes: 0, bypassQuiet: true };
      }
    } catch (err) {
      // If the classifier fails, stay quiet
    }
  }

  // Quiet state reply (zero cost, fixed message)
  return {
    state: 'quiet',
    strikes: newStrikes,
    reply: `I'm pausing my AI replies because we were chatting off-topic. Ask me about any product or category here at ${vendor.name} whenever you're ready to shop!`,
    bypassQuiet: false,
    products: []
  };
}