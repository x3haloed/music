import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localWorlds } from '../src/local-worlds.js';
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

test('shell retains separate bounded output, idempotency context, and timeout uncertainty', async t => {
  const { contact } = harness(t);
  await contact('file-write', { path: '.keep', content: '' });
  const result = await contact('shell', { command: "printf \"$MUSIC_IDEMPOTENCY_KEY\"; printf 'err' >&2" });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'key-shell');
  assert.equal(result.stderr, 'err');
  const timeout = await contact('shell', { command: 'sleep 2', timeoutMs: 100 });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.effect, 'possibly-partial');
});
