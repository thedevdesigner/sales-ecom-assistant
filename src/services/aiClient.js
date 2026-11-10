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

/* ============================ STREAMING ============================ */

/**
 * OpenRouter returns an OpenAI-compatible SSE stream. Frame shape:
 *   data: {"choices":[{"delta":{"content":" partial"}}]}\n\n
 *   data: [DONE]
 */
async function* iterateSseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return;
        yield JSON.parse(payload);
      }
    }
  }
}

/**
 * Single streaming attempt against one model.
 *
 * Semantics that DIFFER from callOpenRouter (deliberately):
 *  - The timeout only guards the time until the FIRST token arrives.
 *    Once bytes are flowing, a fixed 6s cap would kill healthy long
 *    replies, so it is cleared on first delta.
 *  - isAborted() (client disconnect) aborts the fetch via the same
 *    AbortController; we surface it as a 408-style cancel so the
 *    caller can distinguish "user left" from "provider down".
 */
async function callOpenRouterStream(model, messages, { onDelta, isAborted, firstTokenTimeoutMs = 8000 }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), firstTokenTimeoutMs);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ai-sales-assistant.render.com',
        'X-Title': 'AI Sales Assistant Widget',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      const err = new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
      err.status = response.status;
      throw err;
    }

    let fullText = '';
    let sawToken = false;

    for await (const frame of iterateSseStream(response.body)) {
      if (isAborted?.()) {
        controller.abort();
        const cancelErr = new Error('Client disconnected mid-stream');
        cancelErr.status = 408;
        cancelErr.aborted = true;
        cancelErr.partialText = fullText;
        throw cancelErr;
      }

      const token = frame.choices?.[0]?.delta?.content || '';
      if (token) {
        if (!sawToken) {
          sawToken = true;
          clearTimeout(timeoutId); // first byte arrived -> stop the clock
        }
        fullText += token;
        onDelta(token);
      }
    }

    clearTimeout(timeoutId);
    return fullText;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('AI stream timed out');
      timeoutErr.status = 408;
      timeoutErr.partialText = err.partialText || '';
      timeoutErr.aborted = Boolean(err.aborted); // preserve client-disconnect signal
      throw timeoutErr;
    }
    throw err;
  }
}

/**
 * Streaming twin of generateAICompletion.
 *
 * THE one rule that makes streaming safe: the backup-model fallback is
 * only possible BEFORE the first token reaches the client. After that,
 * retrying would make the user see the answer start twice. So:
 *  - pre-token failure  -> retry backup model (same retryable logic)
 *  - mid-stream failure -> record the failure, return what we already
 *                          streamed (partialText) so the pipeline can
 *                          finish gracefully
 *
 * @returns the complete reply text (same contract as generateAICompletion)
 */
export async function generateAICompletionStream(messages, { onDelta, isAborted } = {}) {
  checkCircuitBreaker();

  const modelsToTry = [env.PRIMARY_MODEL, env.BACKUP_MODEL];
  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const result = await callOpenRouterStream(model, messages, { onDelta, isAborted });
      recordSuccess();
      return result;
    } catch (err) {
      lastError = err;

      if (err.aborted) {
        // User disconnected: do NOT count it against the circuit breaker,
        // do NOT retry, and do NOT throw — the caller's socket is gone anyway.
        return err.partialText || '';
      }

      // Tokens already reached the client -> NEVER retry (would re-send the
      // beginning of the answer). Return what we have; the pipeline finishes
      // the turn with a partial reply, which is better than a duplicate.
      if (err.partialText) {
        recordFailure();
        return err.partialText;
      }

      const isRetryable = err.status === 408 || err.status === 429 || (err.status >= 500 && err.status < 600) || !err.status;
      if (!isRetryable || i === modelsToTry.length - 1) {
        break;
      }
    }
  }

  recordFailure();
  throw lastError || new Error('All AI models failed');
}