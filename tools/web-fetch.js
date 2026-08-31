import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialWebFetchTool() {
  return validateToolModule({
    id: 'web_fetch',
    version: 1,
    parent: null,
    description: 'Make a direct unrestricted HTTP request and return bounded response status, headers, and body. Use text for textual resources or base64 for binary bytes; request and response material is retained with the invocation.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 8_192 },
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string', maxLength: 1_048_576 },
        responseMode: { type: 'string', enum: ['text', 'base64'] },
        redirect: { type: 'string', enum: ['follow', 'manual', 'error'] },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 120_000 },
        maxBytes: { type: 'integer', minimum: 1_024, maximum: 1_048_576 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    source: sourceBody(webFetch),
  });
}

async function webFetch(input) {
  if (!input || typeof input !== 'object') throw new Error('web_fetch input must be an object');
  if (typeof input.url !== 'string' || !input.url) throw new Error('web_fetch needs a URL');
  const method = input.method ?? 'GET';
  if ((method === 'GET' || method === 'HEAD') && input.body !== undefined) throw new Error(`${method} web_fetch cannot carry a body`);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxBytes = input.maxBytes ?? 262_144;
  const responseMode = input.responseMode ?? 'text';
  const startedAt = Date.now();
  const response = await fetch(input.url, {
    method,
    headers: input.headers,
    body: input.body,
    redirect: input.redirect ?? 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const chunks = [];
  let receivedBytes = 0;
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - receivedBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining));
        receivedBytes += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      receivedBytes += value.byteLength;
      if (receivedBytes === maxBytes) {
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) truncated = true;
      }
    }
  }
  const bytes = Buffer.concat(chunks);
  return {
    ok: response.ok,
    kind: 'web-response',
    requestedUrl: input.url,
    url: response.url,
    method,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    responseMode,
    body: responseMode === 'base64' ? bytes.toString('base64') : bytes.toString('utf8'),
    bytes: bytes.length,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
