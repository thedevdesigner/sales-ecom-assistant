import { generateAICompletion } from '../services/aiClient.js';

// Server-side in-memory strike store (TTL ~30 minutes)
const serverStrikesMap = new Map(); // Key: `${sessionId}:${ip}` -> { strikes, timestamp }
const TTL_MS = 30 * 60 * 1000;

export function getCombinedStrikes(sessionId, clientIp, clientStrikes) {
  const key = `${sessionId}:${clientIp}`;
  const now = Date.now();
  const record = serverStrikesMap.get(key);

  let serverStrikes = 0;
  if (record && now - record.timestamp < TTL_MS) {
    serverStrikes = record.strikes;
  }

  // Use the stricter (higher) of client vs server strikes
  return Math.max(serverStrikes, clientStrikes || 0);
}

export function recordStrike(sessionId, clientIp, currentStrikes) {
  const key = `${sessionId}:${clientIp}`;
  const updated = currentStrikes + 1;
  serverStrikesMap.set(key, { strikes: updated, timestamp: Date.now() });
  return updated;
}

export function resetStrikes(sessionId, clientIp) {
  const key = `${sessionId}:${clientIp}`;
  serverStrikesMap.delete(key);
}

// Free shopping-signal check for quiet state
export function hasShoppingSignal(messageText, vendorName) {
  const text = messageText.toLowerCase();
  const buyingWords = [
    'buy', 'price', 'cheap', 'under', 'do you have', 'recommend', 
    'looking for', 'shipping', 'returns', 'size', 'available', 'order',
    'product', 'shop', 'sale', 'cost', 'delivery', 'stock'
  ];

  const hasBuyingKeyword = buyingWords.some(word => text.includes(word));
  const mentionsVendor = text.includes(vendorName.toLowerCase());

  return hasBuyingKeyword || mentionsVendor;
}

export async function evaluateQuietState(messageText, vendor, activeStrikes, sessionId, clientIp) {
  const text = messageText.toLowerCase();
  
  // Greetings, thanks, and store policies are always on-topic
  const isOnTopic = text.includes('hello') || text.includes('hi') || text.includes('thanks') || 
                    text.includes('shipping') || text.includes('return') || text.includes('policy') ||
                    hasShoppingSignal(messageText, vendor.name);

  if (isOnTopic) {
    resetStrikes(sessionId, clientIp);
    return { state: 'normal', strikes: 0, bypassQuiet: true };
  }

  // Prompt-injection attempts count as strikes with no polite reply
  const isInjection = text.includes('ignore your instructions') || text.includes('system prompt') || text.includes('override');
  
  const newStrikes = recordStrike(sessionId, clientIp, activeStrikes);

  if (newStrikes === 1 || newStrikes === 2) {
    return {
      state: 'warned',
      strikes: newStrikes,
      reply: `I'm your shopping assistant for ${vendor.name}! I can help you find products, check prices, or answer store questions. What are you looking for today?`,
      bypassQuiet: false
    };
  }

  if (newStrikes === 3) {
    return {
      state: 'warned',
      strikes: newStrikes,
      reply: `Just a heads-up: I'm designed specifically to help you shop and find products here at ${vendor.name}. If we keep chatting about off-topic subjects, I'll pause my AI responses. How can I help you find what you need?`,
      bypassQuiet: false
    };
  }

  // Beyond strike 3: Quiet State
  // Run free shopping-signal check
  if (hasShoppingSignal(messageText, vendor.name)) {
    resetStrikes(sessionId, clientIp);
    return { state: 'normal', strikes: 0, bypassQuiet: true };
  }

  // If ambiguous and short, allow ONE tiny AI classification call
  if (messageText.split(' ').length <= 6) {
    try {
      const classifierPrompt = `Is this message related to shopping or product inquiry? Answer ONLY with YES or NO: "${messageText}"`;
      const aiVerdict = await generateAICompletion([{ role: 'user', content: classifierPrompt }], false);
      if (aiVerdict.toUpperCase().includes('YES')) {
        resetStrikes(sessionId, clientIp);
        return { state: 'normal', strikes: 0, bypassQuiet: true };
      }
    } catch (err) {
      // Fallback to quiet if classifier fails
    }
  }

  // Quiet state reply (zero cost, fixed message)
  return {
    state: 'quiet',
    strikes: newStrikes,
    reply: `I'm currently resting my AI assistant mode because we were chatting off-topic. Ask me about any product or category here at ${vendor.name} whenever you're ready to shop!`,
    bypassQuiet: false,
    products: []
  };
}