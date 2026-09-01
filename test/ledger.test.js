import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'music-v2-ledger-'));
  let tick = 0;
  const ledger = new Ledger(join(directory, 'ledger.jsonl'), {
    clock: () => new Date(`2026-09-01T00:00:0${tick}.000Z`),
    id: () => `event-${++tick}`,
  });
  return { directory, ledger };
}

test('ledger appends a durable, reconstructable hash chain', t => {
  const { directory, ledger } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = ledger.append('subject.born', { designation: null });
  const second = ledger.append('observation.received', { content: 'hello' });
  assert.equal(second.parent, first.hash);
  assert.deepEqual(ledger.read(), [first, second]);
  assert.equal(readFileSync(ledger.path, 'utf8').split('\n').length, 3);
});

test('ledger rejects tampering and incomplete writes', t => {
  const { directory, ledger } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  ledger.append('subject.born', { designation: null });
  const original = readFileSync(ledger.path, 'utf8');
  writeFileSync(ledger.path, original.replace('null', '"changed"'));
  assert.throws(() => ledger.read(), /broken ancestry|invalid hash/);
  writeFileSync(ledger.path, original.trimEnd());
  assert.throws(() => ledger.read(), /incomplete event/);
});

test('ledger refuses a second writer lock', t => {
  const { directory, ledger } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(ledger.lockPath, 'held');
  assert.throws(() => ledger.append('subject.born', {}), /already active/);
});
