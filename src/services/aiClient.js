import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

let circuitState = {
  failures: 0,
  lastFailureTime: null,
  state: 'CLOSED',
  threshold: 5,
  cooldownMs: 30000
};

function checkCircuitBreaker() {
  const now = Date.now();
  if (circuitState.state === 'OPEN') {
    if (now - circuitState.lastFailureTime > circuitState.cooldownMs) {
      circuitState.state = 'HALF-OPEN';
    } else {
      throw new Error('Circuit breaker is OPEN. AI service temporarily degraded.');
    }
  }
}

function recordSuccess() {
  circuitState.failures = 0;
  circuitState.state = 'CLOSED';
}

function recordFailure() {
  circuitState.failures++;
  circuitState.lastFailureTime = Date.now();
  if (circuitState.failures >= circuitState.threshold) {
    circuitState.state = 'OPEN';
  }
}

function withTimeout(promise, ms = 15000, label = 'Gemini API') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildGeminiContents(messages) {
  const contents = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'assistant') {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      contents.push({ role: 'model', parts });
    } else if (msg.role === 'tool') {
      let responseObj = {};
      try { responseObj = JSON.parse(msg.content); } catch { responseObj = { result: msg.content }; }
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name: msg.name || 'unknown_tool', response: responseObj } }]
      });
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
      });
    }
  }
  return contents;
}

function extractSystemInstruction(messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  if (!systemMsg) return undefined;
  const text = typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content);
  return { parts: [{ text }] };
}

async function callGemini(model, messages, options = {}) {
  const contents = buildGeminiContents(messages);
  const config = {};
  const systemInstruction = extractSystemInstruction(messages);
  if (systemInstruction) config.systemInstruction = systemInstruction;

  if (options.tools) {
    config.tools = [{
      functionDeclarations: options.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }];
  }

  const response = await withTimeout(
    ai.models.generateContent({ model, contents, config }),
    15000,
    `generateContent (${model})`
  );

  if (response.functionCalls && response.functionCalls.length > 0) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: response.functionCalls.map((fc, index) => ({
        id: `call_${index}`,
        type: 'function',
        function: { name: fc.name, arguments: JSON.stringify(fc.args) }
      }))
    };
  }

  return response.text || '';
}

export async function generateAICompletion(messages, options = {}) {
  checkCircuitBreaker();
  const modelsToTry = [env.PRIMARY_MODEL, env.BACKUP_MODEL].filter(Boolean);
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const result = await callGemini(model, messages, options);
      recordSuccess();
      return result;
    } catch (err) {
      lastError = err;
      const isRetryable = err.status === 408 || err.status === 429 || (err.status >= 500 && err.status < 600) || !err.status;
      if (!isRetryable || i === modelsToTry.length - 1) break;
    }
  }

  recordFailure();
  throw lastError || new Error('All AI models failed');
}

export async function generateAICompletionStream(messages, { onDelta, isAborted } = {}) {
  checkCircuitBreaker();
  const modelsToTry = [env.PRIMARY_MODEL, env.BACKUP_MODEL].filter(Boolean);
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const contents = buildGeminiContents(messages);
      const config = {};
      const systemInstruction = extractSystemInstruction(messages);
      if (systemInstruction) config.systemInstruction = systemInstruction;

      const responseStream = await withTimeout(
        ai.models.generateContentStream({ model, contents, config }),
        15000,
        `generateContentStream (${model})`
      );

      let fullText = '';
      for await (const chunk of responseStream) {
        if (isAborted && isAborted()) return fullText;
        const chunkText = chunk.text || '';
        if (chunkText) {
          fullText += chunkText;
          if (onDelta) onDelta(chunkText);
        }
      }

      recordSuccess();
      return fullText;
    } catch (err) {
      lastError = err;
      const isRetryable = err.status === 408 || err.status === 429 || (err.status >= 500 && err.status < 600) || !err.status;
      if (!isRetryable || i === modelsToTry.length - 1) break;
    }
  }

  recordFailure();
  throw lastError || new Error('All AI models failed');
}