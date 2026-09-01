import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { open, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { defineWorld } from './world.js';

export const MAX_FILE_READ_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_PATCH_BYTES = 8 * 1024 * 1024;

export function localWorlds() {
  return [fileRead(), fileWrite(), filePatch(), fileSearch(), shell()];
}

function fileRead() {
  return defineWorld({
    id: 'file-read', version: '4', description: 'Read a bounded-size UTF-8 text file with line numbers and bounded pagination. Relative paths resolve from the run workspace; absolute paths are accepted.', effects: ['local.read'], attestationTypes: ['filesystem.read.result'],
    identityMaterial: { implementation: 'music-v3-file-read-3', maximumSourceBytes: MAX_FILE_READ_BYTES, defaultLines: 500, defaultCharacters: 131_072 },
    publicContract: {
      input: { path: 'nonempty string', offset: 'optional positive line number', limit: 'optional 1..1000', maxChars: 'optional 1024..262144' },
      output: { ok: 'boolean', kind: 'file-read', resolvedPath: 'string', maximumSourceBytes: MAX_FILE_READ_BYTES, content: 'numbered UTF-8 text when ok', hasMore: 'boolean when ok', error: 'string when not ok' },
      witnessOutput: {
        required: { kind: 'literal file-read', ok: 'boolean', resolvedPath: 'string' },
        supportExample: { kind: 'file-read', ok: true, resolvedPath: '/absolute/example.txt' },
        contradictionExample: { kind: 'file-read', ok: false, resolvedPath: '/absolute/missing.txt', error: 'ENOENT' },
        note: 'Both success and failure witnesses require kind, ok, and resolvedPath. Additional real output fields are optional in a witness.',
      },
    },
    conform: input => objectInput(input, ['path']).concat(typeof input?.path === 'string' && input.path.length > 0 ? [] : ['path must be nonempty'], integerRange(input?.offset, 1, Number.MAX_SAFE_INTEGER, 'offset'), integerRange(input?.limit, 1, 1_000, 'limit'), integerRange(input?.maxChars, 1_024, 262_144, 'maxChars')),
    conformOutput: output => requiredOutputFields(output, 'file-read', { ok: 'boolean', resolvedPath: 'string' }),
    attest: (input, output) => [{ type: 'filesystem.read.result', value: { requestedPath: input.path, resolvedPath: output.resolvedPath, ok: output.ok, bytes: output.bytes ?? null, error: output.error ?? null } }],
    async execute(input, context) {
      const file = resolveContactPath(context, input.path);
      let source;
      try { source = await readBoundedRegularFile(file, MAX_FILE_READ_BYTES); }
      catch (error) { return { ok: false, kind: 'file-read', path: input.path, resolvedPath: file, error: error.message }; }
      if (source.refusal) return { ok: false, kind: 'file-read', path: input.path, resolvedPath: file, bytes: source.bytes, maximumSourceBytes: MAX_FILE_READ_BYTES, error: source.refusal };
      const { bytes, metadata } = source;
      if (bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) return { ok: false, kind: 'file-read', path: input.path, resolvedPath: file, bytes: bytes.length, maximumSourceBytes: MAX_FILE_READ_BYTES, error: 'This appears to be a binary file.' };
      const lines = bytes.toString('utf8').split(/\r?\n/);
      const offset = input.offset ?? 1;
      const limit = input.limit ?? 500;
      const maxChars = input.maxChars ?? 131_072;
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected.map((line, index) => `${offset + index}: ${line}`).join('\n');
      const content = numbered.slice(0, maxChars);
      return { ok: true, kind: 'file-read', path: input.path, resolvedPath: file, bytes: bytes.length, maximumSourceBytes: MAX_FILE_READ_BYTES, modifiedAt: metadata.mtime.toISOString(), offset, limit, returnedLines: selected.length, totalLines: lines.length, hasMore: offset - 1 + selected.length < lines.length, truncatedByCharacters: content.length < numbered.length, content };
    },
  });
}

function fileWrite() {
  return defineWorld({
    id: 'file-write', version: '2', description: 'Atomically create a UTF-8 file and missing parents. Existing files are refused unless overwrite is explicitly true; an identical retried result is recognized.', effects: ['local.write'], attestationTypes: ['filesystem.write.result'],
    identityMaterial: { implementation: 'music-v3-file-write-1', maximumCharacters: 1_048_576 },
    publicContract: {
      input: { path: 'nonempty string', content: 'UTF-8 string at most 1048576 characters', overwrite: 'optional boolean' },
      output: { ok: 'boolean', kind: 'file-write', resolvedPath: 'string', sha256: 'digest when ok', overwritten: 'boolean when ok', replayed: 'boolean when identical content already exists', error: 'string when refused' },
    },
    conform(input) {
      const reasons = objectInput(input, ['path', 'content']);
      if (typeof input?.path !== 'string' || input.path.length === 0) reasons.push('path must be nonempty');
      if (typeof input?.content !== 'string' || input.content.length > 1_048_576) reasons.push('content must be a bounded string');
      if (input?.overwrite !== undefined && typeof input.overwrite !== 'boolean') reasons.push('overwrite must be Boolean');
      return reasons;
    },
    conformOutput: output => output?.kind === 'file-write' && typeof output.ok === 'boolean' && typeof output.resolvedPath === 'string' ? [] : ['file-write output is malformed'],
    attest: (input, output) => [{ type: 'filesystem.write.result', value: { requestedPath: input.path, resolvedPath: output.resolvedPath, ok: output.ok, sha256: output.sha256 ?? null, replayed: output.replayed ?? null, overwritten: output.overwritten ?? null, error: output.error ?? null } }],
    async execute(input, context) {
      const file = resolveContactPath(context, input.path);
      await mkdir(dirname(file), { recursive: true });
      const data = Buffer.from(input.content, 'utf8');
      const targetHash = sha256(data);
      let existing = null;
      try { existing = await stat(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (existing && !existing.isFile()) return { ok: false, kind: 'file-write', path: input.path, resolvedPath: file, error: 'Existing path is not a regular file.' };
      if (existing) {
        if (existing.size === data.length) {
          const current = await readBoundedRegularFile(file, data.length);
          if (!current.refusal && sha256(current.bytes) === targetHash) return { ok: true, kind: 'file-write', path: input.path, resolvedPath: file, bytes: data.length, overwritten: true, replayed: true, sha256: targetHash };
        }
        if (input.overwrite !== true) return { ok: false, kind: 'file-write', path: input.path, resolvedPath: file, error: 'File already exists; set overwrite=true to replace it.' };
      }
      await atomicReplace(file, data, existing?.mode ?? 0o600);
      return { ok: true, kind: 'file-write', path: input.path, resolvedPath: file, bytes: data.length, overwritten: Boolean(existing), replayed: false, sha256: targetHash };
    },
  });
}

function filePatch() {
  return defineWorld({
    id: 'file-patch', version: '3', description: 'Atomically apply an exact textual replacement only after bounding source and result size and verifying the expected occurrence count.', effects: ['local.write'], attestationTypes: ['filesystem.patch.result'],
    identityMaterial: { implementation: 'music-v3-file-patch-2', operation: 'exact-global-replacement', maximumSourceBytes: MAX_FILE_PATCH_BYTES, maximumResultBytes: MAX_FILE_PATCH_BYTES },
    publicContract: {
      input: { path: 'nonempty string', oldText: 'nonempty string', newText: 'string', expectedOccurrences: 'optional positive integer, default 1' },
      output: { ok: 'boolean', kind: 'file-patch', resolvedPath: 'string', maximumSourceBytes: MAX_FILE_PATCH_BYTES, maximumResultBytes: MAX_FILE_PATCH_BYTES, occurrences: 'integer', before: 'sha256', after: 'sha256', error: 'string when not applied' },
    },
    conform(input) {
      const reasons = objectInput(input, ['path', 'oldText', 'newText']);
      if (typeof input?.path !== 'string' || input.path.length === 0) reasons.push('path must be nonempty');
      if (typeof input?.oldText !== 'string' || input.oldText.length === 0) reasons.push('oldText must be nonempty');
      if (typeof input?.newText !== 'string') reasons.push('newText must be a string');
      reasons.push(...integerRange(input?.expectedOccurrences, 1, Number.MAX_SAFE_INTEGER, 'expectedOccurrences'));
      return reasons;
    },
    conformOutput: output => output?.kind === 'file-patch' && typeof output.ok === 'boolean' && typeof output.resolvedPath === 'string' ? [] : ['file-patch output is malformed'],
    attest: (input, output) => [{ type: 'filesystem.patch.result', value: { requestedPath: input.path, resolvedPath: output.resolvedPath, ok: output.ok, before: output.before ?? null, after: output.after ?? null, occurrences: output.occurrences ?? null, error: output.error ?? null } }],
    async execute(input, context) {
      const file = resolveContactPath(context, input.path);
      let source;
      try { source = await readBoundedRegularFile(file, MAX_FILE_PATCH_BYTES); }
      catch (error) { return { ok: false, kind: 'file-patch', path: input.path, resolvedPath: file, error: error.message }; }
      if (source.refusal) return { ok: false, kind: 'file-patch', path: input.path, resolvedPath: file, bytes: source.bytes, maximumSourceBytes: MAX_FILE_PATCH_BYTES, maximumResultBytes: MAX_FILE_PATCH_BYTES, error: source.refusal };
      const before = source.bytes.toString('utf8');
      const occurrences = countOccurrences(before, input.oldText);
      const expected = input.expectedOccurrences ?? 1;
      if (occurrences !== expected) return { ok: false, kind: 'file-patch', path: input.path, resolvedPath: file, occurrences, error: `Expected ${expected} occurrence(s), found ${occurrences}.` };
      const resultBytes = Buffer.byteLength(before) + occurrences * (Buffer.byteLength(input.newText) - Buffer.byteLength(input.oldText));
      if (resultBytes > MAX_FILE_PATCH_BYTES) return { ok: false, kind: 'file-patch', path: input.path, resolvedPath: file, occurrences, resultBytes, maximumSourceBytes: MAX_FILE_PATCH_BYTES, maximumResultBytes: MAX_FILE_PATCH_BYTES, error: `Patched result would exceed the ${MAX_FILE_PATCH_BYTES}-byte maximum.` };
      const after = before.split(input.oldText).join(input.newText);
      await atomicReplace(file, Buffer.from(after, 'utf8'), source.metadata.mode);
      return { ok: true, kind: 'file-patch', path: input.path, resolvedPath: file, occurrences, resultBytes, maximumSourceBytes: MAX_FILE_PATCH_BYTES, maximumResultBytes: MAX_FILE_PATCH_BYTES, before: sha256(before), after: sha256(after) };
    },
  });
}

function fileSearch() {
  return defineWorld({
    id: 'file-search', version: '2', description: 'Search UTF-8 contents with ripgrep or discover file paths containing a substring. Results are bounded.', effects: ['local.read'], attestationTypes: ['filesystem.search.result'],
    identityMaterial: { implementation: 'music-v3-file-search-1', engine: 'rg', maximumMatches: 200 },
    publicContract: {
      input: { pattern: 'string', target: 'optional content|files', path: 'optional path', fileGlob: 'optional glob', limit: 'optional 1..200' },
      output: { ok: 'boolean', kind: 'file-search', resolvedPath: 'string', matches: 'bounded string array', truncated: 'boolean' },
    },
    conform(input) {
      const reasons = objectInput(input, ['pattern']);
      if (typeof input?.pattern !== 'string') reasons.push('pattern must be a string');
      if (input?.target !== undefined && !['content', 'files'].includes(input.target)) reasons.push('target must be content or files');
      reasons.push(...integerRange(input?.limit, 1, 200, 'limit'));
      return reasons;
    },
    conformOutput: output => output?.kind === 'file-search' && typeof output.ok === 'boolean' && Array.isArray(output.matches) ? [] : ['file-search output is malformed'],
    attest: (input, output) => [{ type: 'filesystem.search.result', value: { requestedPath: input.path ?? '.', pattern: input.pattern, target: input.target ?? 'content', ok: output.ok, count: output.count, truncated: output.truncated } }],
    async execute(input, context) {
      const workspace = workspaceRoot(context);
      const root = resolveContactPath(context, input.path ?? '.');
      const limit = input.limit ?? 50;
      const target = input.target ?? 'content';
      const args = target === 'files'
        ? ['--files', root]
        : ['--line-number', '--column', '--no-heading', '--color', 'never', ...(input.fileGlob ? ['--glob', input.fileGlob] : []), input.pattern, root];
      try {
        const stdout = await executeFile('rg', args, { cwd: workspace, maxBuffer: 8 * 1024 * 1024, allowNoMatch: true });
        const available = stdout.split('\n').filter(Boolean).filter(value => target !== 'files' || value.includes(input.pattern));
        return { ok: true, kind: 'file-search', target, path: input.path ?? '.', resolvedPath: root, matches: available.slice(0, limit), count: Math.min(available.length, limit), truncated: available.length > limit };
      } catch (error) {
        return { ok: false, kind: 'file-search', target, path: input.path ?? '.', resolvedPath: root, matches: [], count: 0, truncated: false, error: error.message };
      }
    },
  });
}

function shell() {
  return defineWorld({
    id: 'shell', version: '2', description: 'Run an unrestricted foreground shell command with bounded output, process-group timeout handling, and explicit partial-effect uncertainty.', effects: ['local.execute'], attestationTypes: ['local.process.result'],
    identityMaterial: { implementation: 'music-v3-shell-1', maximumCaptureCharacters: 200_000 },
    publicContract: {
      input: { command: 'nonempty string up to 65536 characters', workdir: 'optional path', timeoutMs: 'optional 100..600000', maxOutputChars: 'optional 1024..200000' },
      output: { ok: 'boolean', kind: 'shell-command', status: 'timeout|exited', effect: 'possibly-partial|completed', exitCode: 'integer|null', stdout: 'bounded string', stderr: 'bounded string' },
      idempotency: 'MUSIC_IDEMPOTENCY_KEY is supplied to the process. Arbitrary commands must own deduplication; timeout is retained as possibly-partial rather than thrown.',
    },
    conform(input) {
      const reasons = objectInput(input, ['command']);
      if (typeof input?.command !== 'string' || input.command.length < 1 || input.command.length > 65_536) reasons.push('command must be a bounded nonempty string');
      reasons.push(...integerRange(input?.timeoutMs, 100, 600_000, 'timeoutMs'), ...integerRange(input?.maxOutputChars, 1_024, 200_000, 'maxOutputChars'));
      return reasons;
    },
    conformOutput: output => output?.kind === 'shell-command' && typeof output.ok === 'boolean' && ['timeout', 'exited'].includes(output.status) ? [] : ['shell output is malformed'],
    attest: (input, output) => [{ type: 'local.process.result', value: { command: input.command, cwd: output.cwd, status: output.status, effect: output.effect, exitCode: output.exitCode, signal: output.signal, ok: output.ok } }],
    async execute(input, context) {
      await mkdir(workspaceRoot(context), { recursive: true, mode: 0o700 });
      const cwd = resolveContactPath(context, input.workdir ?? '.');
      const timeoutMs = input.timeoutMs ?? 120_000;
      const maxOutputChars = input.maxOutputChars ?? 20_000;
      const captureLimit = 200_000;
      const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-captureLimit);
      const startedAt = Date.now();
      const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', input.command], { cwd, env: { ...process.env, MUSIC_IDEMPOTENCY_KEY: context.idempotencyKey }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let stdout = '', stderr = '', stdoutDropped = false, stderrDropped = false, timedOut = false;
      child.stdout.on('data', chunk => { if ((stdout + chunk).length > captureLimit) stdoutDropped = true; stdout = append(stdout, chunk); });
      child.stderr.on('data', chunk => { if ((stderr + chunk).length > captureLimit) stderrDropped = true; stderr = append(stderr, chunk); });
      const terminate = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error?.code !== 'ESRCH') stderr = append(stderr, `\nCould not send ${signal}: ${error.message}`); } };
      let forceTimer;
      const timeout = setTimeout(() => { timedOut = true; terminate('SIGTERM'); forceTimer = setTimeout(() => terminate('SIGKILL'), 250); forceTimer.unref?.(); }, timeoutMs);
      timeout.unref?.();
      const result = await new Promise((resolveResult, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal })); }).finally(() => { clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer); });
      const clip = value => value.length > maxOutputChars ? value.slice(-maxOutputChars) : value;
      return { ok: !timedOut && result.exitCode === 0, kind: 'shell-command', command: input.command, cwd, status: timedOut ? 'timeout' : 'exited', effect: timedOut ? 'possibly-partial' : 'completed', exitCode: result.exitCode, signal: result.signal, durationMs: Date.now() - startedAt, stdout: clip(stdout), stderr: clip(stderr), stdoutTruncated: stdoutDropped || stdout.length > maxOutputChars, stderrTruncated: stderrDropped || stderr.length > maxOutputChars };
    },
  });
}

function workspaceRoot(context) { return join(context.runRoot, 'workspace'); }
function resolveContactPath(context, path) { return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot(context), path); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function readBoundedRegularFile(file, maximumBytes) {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { refusal: 'Path is not a regular file.', bytes: metadata.size };
    if (metadata.size > maximumBytes) return { refusal: `File size ${metadata.size} exceeds the ${maximumBytes}-byte maximum.`, bytes: metadata.size };
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const growth = await handle.read(extra, 0, 1, offset);
    if (growth.bytesRead > 0) return { refusal: `File grew beyond its checked ${metadata.size}-byte size during reading.`, bytes: metadata.size + growth.bytesRead };
    return { bytes: bytes.subarray(0, offset), metadata };
  } finally {
    await handle.close();
  }
}

function countOccurrences(content, search) {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}

async function atomicReplace(file, data, mode) {
  const temporary = `${file}.music-${process.pid}-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(data); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r').catch(() => null);
    if (directory) try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function objectInput(value, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['input must be an object'];
  return required.filter(key => !Object.hasOwn(value, key)).map(key => `${key} is required`);
}

function integerRange(value, minimum, maximum, name) {
  if (value === undefined) return [];
  return Number.isInteger(value) && value >= minimum && value <= maximum ? [] : [`${name} must be an integer from ${minimum} through ${maximum}`];
}

function requiredOutputFields(output, kind, fields) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ['output must be an object'];
  const reasons = [];
  if (output.kind !== kind) reasons.push(`output.kind must equal ${kind}`);
  for (const [field, type] of Object.entries(fields)) {
    if (typeof output[field] !== type) reasons.push(`output.${field} must be a ${type}`);
  }
  return reasons;
}

function executeFile(file, args, { cwd, maxBuffer, allowNoMatch = false }) {
  return new Promise((resolveResult, reject) => execFile(file, args, { cwd, maxBuffer }, (error, stdout, stderr) => {
    if (error && !(allowNoMatch && error.code === 1)) { error.message = `${error.message}\n${stderr}`.trim(); reject(error); }
    else resolveResult(stdout);
  }));
}
