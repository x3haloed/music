import { execFile } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonical, digest } from './canonical.js';
import { defineWorld, WorldRegistry } from './world.js';
import { localWorlds } from './local-worlds.js';

export function builtinWorlds() {
  return new WorldRegistry([
    ...localWorlds(),
    defineWorld({
      id: 'operator-outbox',
      version: '1',
      description: 'Deliver one durable message to the machine owner through the run outbox.',
      effects: ['operator.message'],
      attestationTypes: ['operator.message.delivery-result'],
      identityMaterial: { implementation: 'music-v3-operator-outbox-1', storage: 'run-local-idempotent-json' },
      publicContract: {
        input: { audience: 'short string', message: 'JSON value' },
        output: { delivered: 'boolean', deliveryId: 'exactly 64 lowercase hexadecimal characters', audience: 'short string' },
        idempotency: 'One immutable outbox record is retained per Music contact key.',
      },
      conform(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
        const reasons = [];
        if (typeof input.audience !== 'string' || input.audience.length < 1 || input.audience.length > 256) reasons.push('audience must be a short string');
        if (!Object.hasOwn(input, 'message')) reasons.push('message is required');
        return reasons;
      },
      conformOutput(output) {
        return output && typeof output.delivered === 'boolean' && /^[a-f0-9]{64}$/.test(output.deliveryId) && typeof output.audience === 'string'
          ? [] : ['output must contain Boolean delivered, exactly 64 lowercase hexadecimal deliveryId characters, and string audience'];
      },
      attest: (input, output) => [{ type: 'operator.message.delivery-result', value: { audience: input.audience, messageDigest: digest(input.message), delivered: output.delivered, deliveryId: output.deliveryId } }],
      async execute(input, context) {
        const record = {
          format: 'music-v3-outbox-message-1',
          deliveryId: digest({ idempotencyKey: context.idempotencyKey }),
          idempotencyKey: context.idempotencyKey,
          audience: input.audience,
          message: input.message,
          subjectId: context.subjectId,
          cycleId: context.cycleId,
        };
        const path = join(context.runRoot, 'outbox', `${record.deliveryId}.json`);
        const bytes = `${canonical(record)}\n`;
        if (existsSync(path)) {
          if (readFileSync(path, 'utf8') !== bytes) throw new Error('outbox idempotency collision');
        } else atomicWrite(path, bytes);
        return { kind: 'operator-outbox-receipt', delivered: true, deliveryId: record.deliveryId, audience: record.audience };
      },
    }),
    defineWorld({
      id: 'http-json',
      version: '1',
      description: 'Bounded HTTP JSON contact. The remote service must honor Idempotency-Key for effecting methods.',
      effects: ['network.fetch'],
      attestationTypes: ['network.http.response'],
      identityMaterial: { implementation: 'music-v3-http-json-2', maximumResponseBytes: 2097152 },
      publicContract: {
        input: { url: 'absolute http(s) URL', method: 'GET|POST|PUT|PATCH|DELETE', body: 'optional JSON', headers: 'optional string map' },
        output: { status: 'integer', ok: 'boolean', body: 'parsed JSON or text, at most 2 MiB', headers: 'string map' },
        idempotency: 'Music supplies the retained key in Idempotency-Key.',
      },
      conform(input) {
        const reasons = [];
        if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
        try {
          const url = new URL(input.url);
          if (!['http:', 'https:'].includes(url.protocol)) reasons.push('url must use http or https');
        } catch { reasons.push('url must be absolute'); }
        if (input.method !== undefined && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)) reasons.push('unsupported method');
        if (input.headers !== undefined && (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers))) reasons.push('headers must be an object');
        return reasons;
      },
      conformOutput(output) {
        return output && typeof output === 'object' && Number.isInteger(output.status) && typeof output.ok === 'boolean'
          ? [] : ['output must contain integer status and Boolean ok'];
      },
      attest: (input, output) => [{ type: 'network.http.response', value: { requestedUrl: input.url, finalUrl: output.finalUrl, method: output.method, status: output.status, ok: output.ok } }],
      async execute(input, context) {
        const method = input.method ?? 'GET';
        const response = await fetch(input.url, {
          method,
          headers: { ...(input.headers ?? {}), 'Idempotency-Key': context.idempotencyKey, Accept: 'application/json, text/plain;q=0.8' },
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await boundedText(response, 2 * 1024 * 1024);
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        return {
          kind: 'http-json-receipt',
          requestedUrl: input.url,
          finalUrl: response.url,
          method,
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        };
      },
    }),
    defineWorld({
      id: 'json-command',
      version: '1',
      description: 'Execute one external program with a JSON request on stdin and capture one JSON result on stdout.',
      effects: ['local.execute'],
      attestationTypes: ['local.json-command.result'],
      identityMaterial: { implementation: 'music-v3-json-command-1', maximumBufferBytes: 2097152 },
      publicContract: {
        input: { executable: 'absolute path', args: 'string array', cwd: 'absolute path', payload: 'JSON value' },
        output: { exitCode: 'integer', result: 'JSON value', stderr: 'bounded string' },
        idempotency: 'The retained key is included in the stdin envelope; the external program owns effect deduplication.',
      },
      conform(input) {
        const reasons = [];
        if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
        if (typeof input.executable !== 'string' || !input.executable.startsWith('/')) reasons.push('executable must be an absolute path');
        if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(value => typeof value !== 'string'))) reasons.push('args must be strings');
        if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.startsWith('/'))) reasons.push('cwd must be absolute');
        return reasons;
      },
      conformOutput(output) {
        return output && typeof output === 'object' && Number.isInteger(output.exitCode) && Object.hasOwn(output, 'result')
          ? [] : ['output must contain exitCode and result'];
      },
      attest: (input, output) => [{ type: 'local.json-command.result', value: { executable: input.executable, args: input.args ?? [], cwd: input.cwd ?? null, exitCode: output.exitCode } }],
      execute(input, context) {
        return new Promise((resolveResult, reject) => {
          const child = execFile(input.executable, input.args ?? [], {
            cwd: input.cwd ? resolve(input.cwd) : undefined,
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
          }, (error, stdout, stderr) => {
            if (error && error.killed) return reject(error);
            let result;
            try { result = JSON.parse(stdout); }
            catch (parseError) { return reject(new Error('json-command stdout is not one JSON value', { cause: parseError })); }
            resolveResult({ kind: 'json-command-receipt', exitCode: error?.code ?? 0, result, stderr: stderr.slice(-32_768) });
          });
          child.stdin.end(`${JSON.stringify({ idempotencyKey: context.idempotencyKey, payload: input.payload ?? null })}\n`);
        });
      },
    }),
  ]);
}

export function readOperatorOutbox(root) {
  const path = join(root, 'outbox');
  if (!existsSync(path)) return [];
  return readdirSync(path).filter(name => name.endsWith('.json')).sort()
    .map(name => JSON.parse(readFileSync(join(path, name), 'utf8')));
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const file = openSync(temporary, 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function boundedText(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`HTTP response exceeds ${maximumBytes} bytes`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error(`HTTP response exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
