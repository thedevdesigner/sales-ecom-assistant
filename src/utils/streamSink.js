/**
 * streamSink.js
 *
 * Transport layer for streaming chat responses.
 *
 * Protocol: NDJSON over application/octet-stream.
 * Every frame is ONE line of JSON: {"event":"<name>","data":{...}}\n
 *
 * Why octet-stream + NDJSON instead of SSE or plain text:
 *  - The client asked for raw chunked octet-stream semantics (payload,
 *    then response arrives chunk by chunk).
 *  - Works over POST with fetch() + response.body.getReader()
 *    (EventSource/SSE cannot do POST bodies).
 *  - Each line is a self-parsing frame, so text deltas never collide
 *    with metadata frames (products, state, strikes, chips).
 *
 * Frame contract (client must handle all four):
 *  meta  -> {"products":[...], "chips":[...], "state":"...", "strikes":n}
 *           Sent ONCE, BEFORE any delta. Everything the UI needs to render
 *           cards/chips while the text is still typing.
 *  delta -> {"text":" partial sentence..."}   (many of these, concatenate)
 *  done  -> {"state":"normal", "strikes":0}   (stream finished cleanly)
 *  error -> {"message":"..."}                 (server-side failure)
 */

export function createStreamSink(res) {
  let aborted = false;

  res.status(200);
  res.setHeader('Content-Type', 'application/octet-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  // Critical behind nginx/Cloudflare: otherwise the proxy buffers the
  // whole body and the client receives one big chunk at the end.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const frame = (event, data) => {
    if (aborted || res.writableEnded) return false;
    return res.write(JSON.stringify({ event, data }) + '\n');
  };

  return {
    meta:  (data) => frame('meta', data),
    delta: (text) => frame('delta', { text }),
    done:  (data = {}) => frame('done', data),
    error: (message) => frame('error', { message }),
    end:   () => { if (!res.writableEnded) res.end(); },
    get aborted() { return aborted; },
    /** Wire client disconnect so upstream AI calls can be cancelled. */
    attachAbort(req) {
      req.on('close', () => { aborted = true; });
    }
  };
}

 