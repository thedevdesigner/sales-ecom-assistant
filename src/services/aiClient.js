import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';

// Initialize Google Gen AI client with the explicit API key
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

let circuitState = {
  failures: 0,
  lastFailureTime: null,
  state: 'CLOSED', // CLOSED, OPEN, HALF-OPEN
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

/**
 * Maps standard message history and OpenAI-style tools to Gemini format
 */
async function callGemini(model, messages, options = {}) {
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
  }));

  const config = {};

  // Map OpenAI tool declarations to Gemini functionDeclarations
  if (options.tools) {
    config.tools = [{
      functionDeclarations: options.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }];
  }

  const response = await ai.models.generateContent({
    model,
    contents,
    config
  });

  // WHY: Check response.functionCalls FIRST before accessing response.text.
  // Accessing response.text first triggers the "non-text parts functionCall" warning in the SDK.
  if (response.functionCalls && response.functionCalls.length > 0) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: response.functionCalls.map((fc, index) => ({
        id: `call_${index}`,
        type: 'function',
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args)
        }
      }))
    };
  }

  return response.text || '';
}

export async function generateAICompletion(messages, options = {}) {
  checkCircuitBreaker();

  const modelsToTry = [env.PRIMARY_MODEL, env.BACKUP_MODEL];
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
      if (!isRetryable || i === modelsToTry.length - 1) {
        break;
      }
    }
  }

  recordFailure();
  throw lastError || new Error('All AI models failed');
}

export async function generateStructuredAIResponse(messages, validatorSchema) {
  let rawOutput = await generateAICompletion(messages, { jsonMode: true });
  
  // Ensure output is string content if an object was returned
  if (typeof rawOutput === 'object') {
    rawOutput = JSON.stringify(rawOutput);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let cleaned = rawOutput.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
      else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
      cleaned = cleaned.trim();

      const parsedJson = JSON.parse(cleaned);
      const validationResult = validatorSchema.safeParse(parsedJson);

      if (!validationResult.success) {
        throw new Error(`Schema validation failed: ${JSON.stringify(validationResult.error.format())}`);
      }

      return validationResult.data;
    } catch (err) {
      if (attempt === 2) {
        throw new Error(`Malformed JSON response from AI after retry: ${err.message}`);
      }
      const correctionMessages = [
        ...messages,
        { role: 'assistant', content: rawOutput },
        { role: 'user', content: 'Your previous response was not valid JSON matching the required schema. Please output strictly valid JSON without extra text or markdown wrapping.' }
      ];
      rawOutput = await generateAICompletion(correctionMessages);
      if (typeof rawOutput === 'object') rawOutput = JSON.stringify(rawOutput);
    }
  }
}

/* ============================ STREAMING ============================ */

export async function generateAICompletionStream(messages, { onDelta, isAborted } = {}) {
  checkCircuitBreaker();

  const modelsToTry = [env.PRIMARY_MODEL, env.BACKUP_MODEL];
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const contents = messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
      }));

      const responseStream = await ai.models.generateContentStream({
        model,
        contents
      });

      let fullText = '';
      for await (const chunk of responseStream) {
        if (isAborted && isAborted()) {
          return fullText;
        }
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
      if (!isRetryable || i === modelsToTry.length - 1) {
        break;
      }
    }
  }

  recordFailure();
  throw lastError || new Error('All AI models failed');
}