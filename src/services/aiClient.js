import { env } from '../config/env.js';

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

async function callOpenRouter(model, messages, jsonMode = false, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      model,
      messages,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ai-sales-assistant.render.com',
        'X-Title': 'AI Sales Assistant Widget',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('AI request timed out');
      timeoutErr.status = 408;
      throw timeoutErr;
    }
    throw err;
  }
}

export async function generateAICompletion(messages, jsonMode = false) {
  checkCircuitBreaker();

  const modelsToTry = [env.PRIMARY_MODEL, env.BACKUP_MODEL];
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const result = await callOpenRouter(model, messages, jsonMode);
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
  let rawOutput = await generateAICompletion(messages, true);

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
      rawOutput = await generateAICompletion(correctionMessages, true);
    }
  }
}