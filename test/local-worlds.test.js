import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localWorlds, MAX_FILE_PATCH_BYTES, MAX_FILE_READ_BYTES, resolveRipgrepBinary } from '../src/local-worlds.js';
import { WorldRegistry } from '../src/world.js';

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'music-v3-local-worlds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worlds = new WorldRegistry(localWorlds());
  const contact = (id, input) => worlds.get(id).execute(input, { runRoot: root, idempotencyKey: `key-${id}` });
  return { root, worlds, contact };
}

test('file worlds retain pagination, refusal, exact patching, and bounded search', async t => {
  const { root, contact } = harness(t);
  const written = await contact('file-write', { path: 'notes/example.txt', content: 'alpha\nbeta\ngamma\n' });
  assert.equal(written.ok, true);
  assert.equal(existsSync(join(root, 'workspace', 'notes', 'example.txt')), true);
  const refused = await contact('file-write', { path: 'notes/example.txt', content: 'replace' });
  assert.equal(refused.ok, false);
  const replayed = await contact('file-write', { path: 'notes/example.txt', content: 'alpha\nbeta\ngamma\n' });
  assert.equal(replayed.replayed, true);

  const page = await contact('file-read', { path: 'notes/example.txt', offset: 2, limit: 1 });
  assert.equal(page.content, '2: beta');
  assert.equal(page.hasMore, true);

  const mismatch = await contact('file-patch', { path: 'notes/example.txt', oldText: 'missing', newText: 'x' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.occurrences, 0);
  const patched = await contact('file-patch', { path: 'notes/example.txt', oldText: 'beta', newText: 'delta' });
  assert.equal(patched.ok, true);
  assert.notEqual(patched.before, patched.after);
  assert.match(readFileSync(join(root, 'workspace', 'notes', 'example.txt'), 'utf8'), /delta/);

  const searched = await contact('file-search', { pattern: 'delta', path: 'notes' });
  assert.equal(searched.ok, true);
  assert.equal(searched.count, 1);
});

test('file search finds Homebrew ripgrep when a LaunchAgent PATH is sparse', () => {
  assert.equal(resolveRipgrepBinary({
    path: '/usr/bin:/bin:/usr/sbin:/sbin',
    platform: 'darwin',
    exists: candidate => candidate === '/opt/homebrew/bin/rg',
  }), '/opt/homebrew/bin/rg');
});

test('file-read publishes and enforces the exact minimum witness shape with actionable correction', t => {
  const { worlds } = harness(t);
  const adapter = worlds.get('file-read');
  assert.deepEqual(adapter.publicContract.witnessOutput.required, {
    kind: 'literal file-read', ok: 'boolean', resolvedPath: 'string',
  });
  assert.deepEqual(
    adapter.conformOutput({ kind: 'file-read', ok: false, error: 'not found' }),
    ['output.resolvedPath must be a string'],
  );
  assert.deepEqual(adapter.conformOutput(adapter.publicContract.witnessOutput.contradictionExample), []);
});

test('shell retains separate bounded output, idempotency context, and timeout uncertainty', async t => {
  const { contact } = harness(t);
  const result = await contact('shell', { command: "printf \"$MUSIC_IDEMPOTENCY_KEY\"; printf 'err' >&2" });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'key-shell');
  assert.equal(result.stderr, 'err');
  const timeout = await contact('shell', { command: 'sleep 2', timeoutMs: 100 });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.effect, 'possibly-partial');
});

test('file reads and patches refuse oversized sparse inputs before body allocation', async t => {
  const { root, contact } = harness(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const sparse = join(workspace, 'oversized-sparse.txt');
  const descriptor = openSync(sparse, 'w');
  closeSync(descriptor);
  truncateSync(sparse, MAX_FILE_READ_BYTES + 1);

  const read = await contact('file-read', { path: 'oversized-sparse.txt' });
  assert.equal(read.ok, false);
  assert.equal(read.bytes, MAX_FILE_READ_BYTES + 1);
  assert.match(read.error, /exceeds the .*byte maximum/);

  const patch = await contact('file-patch', { path: 'oversized-sparse.txt', oldText: 'x', newText: 'y' });
  assert.equal(patch.ok, false);
  assert.equal(patch.maximumSourceBytes, MAX_FILE_PATCH_BYTES);
  assert.match(patch.error, /exceeds the .*byte maximum/);

  const refusedWrite = await contact('file-write', { path: 'oversized-sparse.txt', content: 'small' });
  assert.equal(refusedWrite.ok, false);
  assert.match(refusedWrite.error, /already exists/);
  const replaced = await contact('file-write', { path: 'oversized-sparse.txt', content: 'small', overwrite: true });
  assert.equal(replaced.ok, true);
  assert.equal(readFileSync(sparse, 'utf8'), 'small');
});

test('file patch refuses replacement amplification before constructing the result', async t => {
  const { root, contact } = harness(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const path = join(workspace, 'amplify.txt');
  writeFileSync(path, 'x'.repeat(9));
  const replacement = 'y'.repeat(1024 * 1024);
  const patch = await contact('file-patch', { path: 'amplify.txt', oldText: 'x', newText: replacement, expectedOccurrences: 9 });
  assert.equal(patch.ok, false);
  assert.ok(patch.resultBytes > MAX_FILE_PATCH_BYTES);
  assert.equal(readFileSync(path, 'utf8'), 'x'.repeat(9));
});
