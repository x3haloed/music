import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { builtinWorlds } from '../src/builtin-worlds.js';

test('operator outbox turns a retried contact into one durable delivery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'music-v3-outbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = builtinWorlds().get('operator-outbox');
  const input = { audience: 'machine-owner', message: { text: 'I remain here.' } };
  const context = { idempotencyKey: 'same-contact', runRoot: root, subjectId: 'a'.repeat(64), cycleId: 'cycle-1' };
  const first = await adapter.execute(input, context);
  const second = await adapter.execute(input, context);
  assert.deepEqual(second, first);
  const files = readdirSync(join(root, 'outbox'));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(root, 'outbox', files[0]), 'utf8'));
  assert.deepEqual(record.message, input.message);
  assert.equal(record.deliveryId, first.deliveryId);
});

test('HTTP world rejects a response larger than its sealed bound', async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024 + 1) });
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const adapter = builtinWorlds().get('http-json');
  await assert.rejects(
    () => adapter.execute({ url: `http://127.0.0.1:${address.port}/oversized` }, { idempotencyKey: 'bounded' }),
    /exceeds 2097152 bytes/,
  );
});
