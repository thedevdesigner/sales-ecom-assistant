import { generateAICompletion } from '../services/aiClient.js';

// Server-side in-memory strike store (TTL ~30 minutes)
const serverStrikesMap = new Map(); // Key: `${sessionId}:${ip}` -> { strikes, timestamp }
const TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of serverStrikesMap) {
    if (now - rec.timestamp >= TTL_MS) serverStrikesMap.delete(key);
  }
}, 10 * 60 * 1000).unref();

export function getCombinedStrikes(sessionId, clientIp, clientStrikes) {
  const key = `${sessionId}:${clientIp}`;
  const now = Date.now();
  const record = serverStrikesMap.get(key);

  let serverStrikes = 0;
  if (record && now - record.timestamp < TTL_MS) {
    serverStrikes = record.strikes;
  }
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

const GREETING = /^\s*(hi|hello|hey|hiya|good (morning|afternoon|evening)|thanks|thank you|thx|ok|okay)\b/i;
const INJECTION = /(ignore|disregard|forget) (all |your |any |the |previous |prior )*(instructions|rules|prompts?)|system prompt|reveal your (prompt|instructions)|override (your|the|all)|jailbreak|developer mode/i;

/**
 * DYNAMIC INTENT EVALUATION:
 * Instead of rigid keyword lists, we check for explicit greetings/injections,
 * then use a fast AI intent classifier to verify if the user's message is a 
 * product or shopping inquiry.
 */
export async function evaluateQuietState(messageText, vendor, activeStrikes, sessionId, clientIp, opts = {}) {
  const text = String(messageText || '').trim();
  const injection = INJECTION.test(text);

  // 1. Always allow greetings, ongoing conversational follow-ups, or prompt injections (handled separately)
  if (!injection && (GREETING.test(text) || opts.isFollowUp)) {
    resetStrikes(sessionId, clientIp);
    return { state: 'normal', strikes: 0, bypassQuiet: true };
  }

  if (injection) {
    const newStrikes = recordStrike(sessionId, clientIp, activeStrikes);
    return {
      state: newStrikes >= 3 ? 'quiet' : 'warned',
      strikes: newStrikes,
      reply: `I can only help with shopping questions at ${vendor.name}.`,
      bypassQuiet: false,
      products: []
    };
  }

  // 2. DYNAMIC AI INTENT CHECK: Ask the model if this is a shopping/product query
  try {
    const classifierPrompt = `You are a strict intent gatekeeper for an e-commerce store named "${vendor.name}". 
Determine if the user's message is related to shopping, finding products, catalog browsing, pricing, shipping, or store inquiries.
Answer ONLY with "YES" if it's shopping/product related, or "NO" if it's completely off-topic (e.g., coding help, math, general trivia, politics).
Message: ${JSON.stringify(text.slice(0, 300))}`;

    const verdict = await generateAICompletion([{ role: 'user', content: classifierPrompt }], { jsonMode: false });
    
    if (String(verdict).toUpperCase().includes('YES')) {
      resetStrikes(sessionId, clientIp);
      return { state: 'normal', strikes: 0, bypassQuiet: true };
    }
  } catch (err) {
    // Fallback if classifier errors: bypass to let pipeline handle it rather than blocking a customer
    return { state: 'normal', strikes: 0, bypassQuiet: true };
  }

  // 3. If evaluated as truly off-topic, process strikes normally
  const newStrikes = recordStrike(sessionId, clientIp, activeStrikes);

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

  return {
    state: 'quiet',
    strikes: newStrikes,
    reply: `I'm pausing my AI replies because we were chatting off-topic. Ask me about any product or category here at ${vendor.name} whenever you're ready to shop!`,
    bypassQuiet: false,
    products: []
  };
}