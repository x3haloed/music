import { z } from 'zod';
import Ajv from 'ajv';
import { canonical } from './canonical.js';
import { IdentifierSchema, JsonValueSchema } from './schema.js';

export const ToolArtifactSchema = z.object({
  format: z.literal('music-v2-tool-1'),
  manifest: z.object({
    id: IdentifierSchema,
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    inputSchema: JsonValueSchema,
    outputSchema: JsonValueSchema,
    effects: z.array(IdentifierSchema).max(32),
  }),
  source: z.string().min(1).max(512 * 1024),
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function executeTool(toolValue, input, context) {
  const tool = ToolArtifactSchema.parse(toolValue);
  JsonValueSchema.parse(input);
  validateContract(tool.manifest.inputSchema, input, `${tool.manifest.id} input`);
  const granted = new Set(context.grants.filter(grant => grant.active).map(grant => grant.capability));
  for (const effect of tool.manifest.effects) {
    if (!granted.has(effect)) throw new Error(`effect is not granted: ${effect}`);
  }
  const run = new AsyncFunction('input', 'context', `'use strict';\n${tool.source}`);
  const output = await run(structuredClone(input), Object.freeze({
    habitat: context.habitat,
    invocationId: context.invocationId ?? null,
    wagerId: context.wagerId ?? null,
    environment: Object.freeze(structuredClone(context.environment ?? {})),
    emitObservation: context.emitObservation,
  }));
  JsonValueSchema.parse(output);
  validateContract(tool.manifest.outputSchema, output, `${tool.manifest.id} output`);
  canonical(output);
  return output;
}

export function starterTools() {
  return [
    artifact('read_file', 'Read file', 'Read UTF-8 text with line numbers and bounded pagination. Relative paths resolve from the resident home; absolute paths are accepted.',
      objectSchema({
        path: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 1_000 }, maxChars: { type: 'integer', minimum: 1_024, maximum: 262_144 },
      }, ['path']),
      objectSchema({
        ok: { type: 'boolean' }, kind: { const: 'file-read' }, path: { type: 'string' }, resolvedPath: { type: 'string' },
        bytes: { type: 'integer', minimum: 0 }, modifiedAt: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' },
        returnedLines: { type: 'integer' }, totalLines: { type: 'integer' }, hasMore: { type: 'boolean' },
        truncatedByCharacters: { type: 'boolean' }, content: { type: 'string' }, error: { type: 'string' },
      }, ['ok', 'kind', 'path', 'resolvedPath']),
      ['local.read'], `
const { readFile, stat } = await import('node:fs/promises');
const { resolve } = await import('node:path');
const file = resolve(context.environment.home || context.habitat, input.path);
const metadata = await stat(file);
if (!metadata.isFile()) return { ok: false, kind: 'file-read', path: input.path, resolvedPath: file, error: 'Path is not a regular file.' };
const bytes = await readFile(file);
if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) {
  return { ok: false, kind: 'file-read', path: input.path, resolvedPath: file, bytes: bytes.length, error: 'This appears to be a binary file.' };
}
const lines = bytes.toString('utf8').split(/\\r?\\n/);
const offset = input.offset ?? 1;
const limit = input.limit ?? 500;
const maxChars = input.maxChars ?? 131072;
const selected = lines.slice(offset - 1, offset - 1 + limit);
const numbered = selected.map((line, index) => (offset + index) + ': ' + line).join('\\n');
const content = numbered.length > maxChars ? numbered.slice(0, maxChars) : numbered;
return {
  ok: true, kind: 'file-read', path: input.path, resolvedPath: file, bytes: bytes.length,
  modifiedAt: metadata.mtime.toISOString(), offset, limit, returnedLines: selected.length, totalLines: lines.length,
  hasMore: offset - 1 + selected.length < lines.length, truncatedByCharacters: content.length < numbered.length, content,
};
`),
    artifact('write_file', 'Write file', 'Atomically create a UTF-8 file and missing parents. Existing files are refused unless overwrite is explicitly true.',
      objectSchema({ path: { type: 'string', minLength: 1 }, content: { type: 'string', maxLength: 1_048_576 }, overwrite: { type: 'boolean' } }, ['path', 'content']),
      objectSchema({
        ok: { type: 'boolean' }, kind: { const: 'file-write' }, path: { type: 'string' }, resolvedPath: { type: 'string' },
        bytes: { type: 'integer', minimum: 0 }, overwritten: { type: 'boolean' }, sha256: { type: 'string' }, error: { type: 'string' },
      }, ['ok', 'kind', 'path', 'resolvedPath']),
      ['local.write'], `
const { link, mkdir, open, rename, stat, unlink } = await import('node:fs/promises');
const { dirname, resolve } = await import('node:path');
const { createHash, randomUUID } = await import('node:crypto');
const file = resolve(context.environment.home || context.habitat, input.path);
await mkdir(dirname(file), { recursive: true });
let existing = null;
try { existing = await stat(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (existing && input.overwrite !== true) return { ok: false, kind: 'file-write', path: input.path, resolvedPath: file, error: 'File already exists; set overwrite=true to replace it.' };
if (existing && !existing.isFile()) return { ok: false, kind: 'file-write', path: input.path, resolvedPath: file, error: 'Existing path is not a regular file.' };
const data = Buffer.from(input.content, 'utf8');
const temporary = file + '.music-' + process.pid + '-' + randomUUID() + '.tmp';
let handle;
try {
  handle = await open(temporary, 'wx', existing?.mode ?? 0o600);
  await handle.writeFile(data); await handle.sync(); await handle.close(); handle = undefined;
  if (existing) await rename(temporary, file); else { await link(temporary, file); await unlink(temporary); }
  const directory = await open(dirname(file), 'r').catch(() => null);
  if (directory) try { await directory.sync(); } finally { await directory.close(); }
} catch (error) {
  if (handle) await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;
}
return { ok: true, kind: 'file-write', path: input.path, resolvedPath: file, bytes: data.length, overwritten: Boolean(existing), sha256: createHash('sha256').update(data).digest('hex') };
`),
    artifact('file_patch', 'Patch file', 'Atomically apply an exact textual replacement after verifying the expected occurrence count.',
      objectSchema({ path: { type: 'string', minLength: 1 }, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' }, expectedOccurrences: { type: 'integer', minimum: 1 } }, ['path', 'oldText', 'newText']),
      objectSchema({ kind: { const: 'file-patch' }, path: { type: 'string' }, resolvedPath: { type: 'string' }, occurrences: { type: 'integer' }, before: { type: 'string' }, after: { type: 'string' } }, ['kind', 'path', 'resolvedPath', 'occurrences', 'before', 'after']),
      ['local.write'], `
const { open, readFile, rename, stat, unlink } = await import('node:fs/promises');
const { dirname, resolve } = await import('node:path');
const { randomUUID, createHash } = await import('node:crypto');
const file = resolve(context.environment.home || context.habitat, input.path);
const before = await readFile(file, 'utf8');
const occurrences = before.split(input.oldText).length - 1;
const expected = input.expectedOccurrences ?? 1;
if (occurrences !== expected) throw new Error('file_patch expected ' + expected + ' occurrence(s), found ' + occurrences);
const after = before.split(input.oldText).join(input.newText);
const metadata = await stat(file);
const temporary = file + '.music-' + process.pid + '-' + randomUUID() + '.tmp';
let handle;
try {
  handle = await open(temporary, 'wx', metadata.mode); await handle.writeFile(after, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
  await rename(temporary, file);
  const directory = await open(dirname(file), 'r').catch(() => null); if (directory) try { await directory.sync(); } finally { await directory.close(); }
} catch (error) { if (handle) await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
const sha256 = value => createHash('sha256').update(value).digest('hex');
return { kind: 'file-patch', path: input.path, resolvedPath: file, occurrences, before: sha256(before), after: sha256(after) };
`),
    artifact('search_files', 'Search files', 'Search UTF-8 contents with ripgrep or discover file paths containing a substring. Results are bounded.',
      objectSchema({ pattern: { type: 'string' }, target: { enum: ['content', 'files'] }, path: { type: 'string' }, fileGlob: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['pattern']),
      objectSchema({ ok: { const: true }, kind: { const: 'file-search' }, target: { type: 'string' }, path: { type: 'string' }, resolvedPath: { type: 'string' }, matches: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' }, truncated: { type: 'boolean' } }, ['ok', 'kind', 'target', 'path', 'resolvedPath', 'matches', 'count', 'truncated']),
      ['local.read'], `
const { execFile } = await import('node:child_process');
const { resolve } = await import('node:path');
const target = input.target ?? 'content';
const home = context.environment.home || context.habitat;
const root = resolve(home, input.path ?? '.');
const limit = input.limit ?? 50;
const run = args => new Promise((resolveResult, reject) => execFile('rg', args, { cwd: home, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
  if (error && error.code !== 1) { error.message = (error.message + '\\n' + stderr).trim(); reject(error); } else resolveResult(stdout);
}));
let available;
if (target === 'files') available = (await run(['--files', root])).split('\\n').filter(Boolean).filter(path => path.includes(input.pattern));
else {
  const args = ['--line-number', '--column', '--no-heading', '--color', 'never']; if (input.fileGlob) args.push('--glob', input.fileGlob); args.push(input.pattern, root);
  available = (await run(args)).split('\\n').filter(Boolean);
}
const matches = available.slice(0, limit);
return { ok: true, kind: 'file-search', target, path: input.path ?? '.', resolvedPath: root, matches, count: matches.length, truncated: available.length > limit };
`),
    artifact('shell', 'Run shell command', 'Run an unrestricted foreground shell command with bounded output, process-group timeout handling, and explicit partial-effect uncertainty.',
      objectSchema({ command: { type: 'string', minLength: 1, maxLength: 65_536 }, workdir: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 600_000 }, maxOutputChars: { type: 'integer', minimum: 1_024, maximum: 200_000 } }, ['command']),
      objectSchema({
        ok: { type: 'boolean' }, kind: { const: 'shell-command' }, command: { type: 'string' }, cwd: { type: 'string' }, status: { enum: ['timeout', 'exited'] }, effect: { enum: ['possibly-partial', 'completed'] },
        exitCode: { type: ['integer', 'null'] }, signal: { type: ['string', 'null'] }, durationMs: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' }, stdoutTruncated: { type: 'boolean' }, stderrTruncated: { type: 'boolean' },
      }, ['ok', 'kind', 'command', 'cwd', 'status', 'effect', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated']),
      ['local.execute'], `
const { spawn } = await import('node:child_process');
const { resolve } = await import('node:path');
const home = context.environment.home || context.habitat;
const cwd = resolve(home, input.workdir ?? '.');
const timeoutMs = input.timeoutMs ?? 120000;
const maxOutputChars = input.maxOutputChars ?? 20000;
const captureLimit = 200000;
const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-captureLimit);
const startedAt = Date.now();
const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', input.command], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let stdout = '', stderr = '', stdoutDropped = false, stderrDropped = false, timedOut = false;
child.stdout.on('data', chunk => { if ((stdout + chunk).length > captureLimit) stdoutDropped = true; stdout = append(stdout, chunk); });
child.stderr.on('data', chunk => { if ((stderr + chunk).length > captureLimit) stderrDropped = true; stderr = append(stderr, chunk); });
const terminate = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error?.code !== 'ESRCH') stderr = append(stderr, '\\nCould not send ' + signal + ': ' + error.message); } };
let forceTimer;
const timeout = setTimeout(() => { timedOut = true; terminate('SIGTERM'); forceTimer = setTimeout(() => terminate('SIGKILL'), 250); forceTimer.unref?.(); }, timeoutMs); timeout.unref?.();
const result = await new Promise((resolveResult, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal })); }).finally(() => { clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer); });
const clip = value => value.length > maxOutputChars ? value.slice(-maxOutputChars) : value;
return { ok: !timedOut && result.exitCode === 0, kind: 'shell-command', command: input.command, cwd, status: timedOut ? 'timeout' : 'exited', effect: timedOut ? 'possibly-partial' : 'completed', exitCode: result.exitCode, signal: result.signal, durationMs: Date.now() - startedAt, stdout: clip(stdout), stderr: clip(stderr), stdoutTruncated: stdoutDropped || stdout.length > maxOutputChars, stderrTruncated: stderrDropped || stderr.length > maxOutputChars };
`),
    artifact('web_fetch', 'Fetch web resource', 'Make an unrestricted bounded HTTP request with methods, headers, body, redirects, timeout, and text/base64 response modes.',
      objectSchema({ url: { type: 'string', minLength: 1, maxLength: 8_192 }, method: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string', maxLength: 1_048_576 }, responseMode: { enum: ['text', 'base64'] }, redirect: { enum: ['follow', 'manual', 'error'] }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120_000 }, maxBytes: { type: 'integer', minimum: 1_024, maximum: 1_048_576 } }, ['url']),
      objectSchema({ ok: { type: 'boolean' }, kind: { const: 'web-response' }, requestedUrl: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' }, status: { type: 'integer' }, statusText: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, responseMode: { type: 'string' }, body: { type: 'string' }, bytes: { type: 'integer' }, truncated: { type: 'boolean' }, durationMs: { type: 'integer' } }, ['ok', 'kind', 'requestedUrl', 'url', 'method', 'status', 'statusText', 'headers', 'responseMode', 'body', 'bytes', 'truncated', 'durationMs']),
      ['network.fetch'], `
const method = input.method ?? 'GET';
if ((method === 'GET' || method === 'HEAD') && input.body !== undefined) throw new Error(method + ' web_fetch cannot carry a body');
const timeoutMs = input.timeoutMs ?? 30000, maxBytes = input.maxBytes ?? 262144, responseMode = input.responseMode ?? 'text', startedAt = Date.now();
const response = await fetch(input.url, { method, headers: input.headers, body: input.body, redirect: input.redirect ?? 'follow', signal: AbortSignal.timeout(timeoutMs) });
const chunks = []; let receivedBytes = 0, truncated = false;
if (response.body) { const reader = response.body.getReader(); while (true) { const { done, value } = await reader.read(); if (done) break; const remaining = maxBytes - receivedBytes; if (value.byteLength > remaining) { if (remaining > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, remaining)); receivedBytes += Math.max(remaining, 0); truncated = true; await reader.cancel(); break; } chunks.push(Buffer.from(value)); receivedBytes += value.byteLength; if (receivedBytes === maxBytes) { const declared = Number(response.headers.get('content-length')); if (Number.isFinite(declared) && declared > maxBytes) truncated = true; } } }
const bytes = Buffer.concat(chunks);
return { ok: response.ok, kind: 'web-response', requestedUrl: input.url, url: response.url, method, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), responseMode, body: responseMode === 'base64' ? bytes.toString('base64') : bytes.toString('utf8'), bytes: bytes.length, truncated, durationMs: Date.now() - startedAt };
`),
    artifact('send_message', 'Send message', 'Durably place a human-visible message envelope in the resident outbox and retain the outbound observation.',
      objectSchema({ action: { enum: ['send', 'ask'] }, recipient: { type: 'string', minLength: 1, maxLength: 256 }, content: { type: 'string', maxLength: 8_192 }, question: { type: 'string', maxLength: 512 }, replyToObservationId: { type: 'string', maxLength: 128 } }, ['action', 'recipient']),
      objectSchema({ kind: { const: 'mailbox-delivery' }, channel: { const: 'outbox' }, body: { type: 'string' }, messageId: { type: 'string' }, invocationId: { type: ['string', 'null'] }, recipient: { type: 'string' }, replyToObservationId: { type: ['string', 'null'] }, observationId: { type: 'string' } }, ['kind', 'channel', 'body', 'messageId', 'invocationId', 'recipient', 'replyToObservationId', 'observationId']),
      ['message.send'], `
const content = input.action === 'send' ? input.content : input.action === 'ask' ? input.question : undefined;
if (typeof content !== 'string' || !content.trim()) throw new Error(input.action + ' needs content');
const { mkdir, open, rename, unlink } = await import('node:fs/promises');
const { join } = await import('node:path');
const { randomUUID } = await import('node:crypto');
const pending = context.environment.outbox;
if (!pending) throw new Error('message delivery needs a configured outbox');
await mkdir(pending, { recursive: true, mode: 0o700 });
const messageId = randomUUID(), name = new Date().toISOString().replaceAll(':', '-') + '-' + messageId + '.json', temporary = join(pending, '.' + name + '.tmp'), target = join(pending, name);
const envelope = { format: 'music-v2-mailbox-message-1', messageId, invocationId: context.invocationId, wagerId: context.wagerId, at: new Date().toISOString(), action: input.action, recipient: input.recipient, content: content.trim(), ...(input.replyToObservationId === undefined ? {} : { replyToObservationId: input.replyToObservationId }) };
let handle;
try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(envelope) + '\\n', 'utf8'); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, target); const directory = await open(pending, 'r').catch(() => null); if (directory) try { await directory.sync(); } finally { await directory.close(); } }
catch (error) { if (handle) await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
const observation = await context.emitObservation({ kind: 'message.outbound', recipient: input.recipient, channel: 'outbox', content: content.trim(), messageId, replyToObservationId: input.replyToObservationId ?? null });
const body = input.action === 'ask' ? 'to=' + input.recipient + '\\n[question] ' + content.trim() : 'to=' + input.recipient + '\\n' + content.trim();
return { kind: 'mailbox-delivery', channel: 'outbox', body, messageId, invocationId: context.invocationId, recipient: input.recipient, replyToObservationId: input.replyToObservationId ?? null, observationId: observation.id };
`),
    artifact('manage_dependency', 'Manage dependency', 'Install, remove, or list packages in the resident dependency habitat with normal npm lifecycle scripts.',
      objectSchema({ action: { enum: ['install', 'remove', 'list'] }, name: { type: 'string', minLength: 1, maxLength: 214 }, spec: { type: 'string', minLength: 1, maxLength: 2_048 } }, ['action']),
      { type: 'object' },
      ['dependency.manage'], `
const root = context.environment.dependencies;
if (!root) throw new Error('dependency management needs a configured dependency root');
const { mkdir, readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path'); const { execFile } = await import('node:child_process');
await mkdir(root, { recursive: true, mode: 0o700 }); const manifestPath = join(root, 'package.json');
try { await readFile(manifestPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; await writeFile(manifestPath, JSON.stringify({ name: 'music-v2-resident-dependencies', version: '0.0.0', private: true }, null, 2) + '\\n', { flag: 'wx', mode: 0o600 }); }
if (input.action === 'list') { const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); return { kind: 'dependency-list', root, dependencies: manifest.dependencies ?? {} }; }
if (!['install', 'remove'].includes(input.action)) throw new Error('unknown dependency action: ' + input.action);
if (typeof input.name !== 'string' || !/^(?:@[a-z0-9._~-]+\\/)?[a-z0-9._~-]+$/i.test(input.name)) throw new Error(input.action + ' needs a valid package name');
const args = input.action === 'install' ? ['install', '--save-exact', '--no-audit', '--no-fund', input.spec ?? input.name] : ['uninstall', '--no-audit', '--no-fund', input.name];
const result = await new Promise((resolveResult, reject) => execFile('npm', args, { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => { if (error) { error.message = (error.message + '\\n' + stderr).trim(); reject(error); } else resolveResult({ stdout, stderr }); }));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
return { kind: 'dependency-change', action: input.action, name: input.name, root, retainedSpec: manifest.dependencies?.[input.name] ?? null, stdout: result.stdout.slice(-16384), stderr: result.stderr.slice(-16384) };
`),
  ];
}

function artifact(id, title, description, inputSchema, outputSchema, effects, source) {
  return ToolArtifactSchema.parse({
    format: 'music-v2-tool-1',
    manifest: { id, title, description, inputSchema, outputSchema, effects },
    source: source.trim(),
  });
}

export function validateContract(schema, value, label = 'value') {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`${label} violates its JSON schema: ${ajv.errorsText(validate.errors)}`);
  }
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}
