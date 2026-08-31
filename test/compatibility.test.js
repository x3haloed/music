import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MUSIC_EVENT_FORMAT, MusicKernel } from '../src/kernel.js';

const legacyFixture = join(import.meta.dirname, 'fixtures', 'music-event-10.jsonl');
const legacyFixtureSha256 = 'fbcbbf784b25e89a230afc617fe76a08e2fe80e8f4a1853d86f589f740e35e2e';
const currentFixture = join(import.meta.dirname, 'fixtures', 'music-event-11.jsonl');
const currentFixtureSha256 = '806a28cf4e790b748b1d0d50d537b6b9e63d0297d6ef396df19d307d3ffe3eb7';

test('the current runtime reconstructs the retained pre-hatch compatibility ledger', () => {
  const bytes = readFileSync(legacyFixture);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), legacyFixtureSha256);
  assert.equal(MUSIC_EVENT_FORMAT, 'music-event-12');

  const audit = new MusicKernel(legacyFixture).audit();
  assert.equal(audit.valid, true);
  assert.equal(audit.events, 8);
  assert.equal(audit.subject.name, 'Compatibility Witness');
  assert.equal(audit.runtimeStarts, 1);
  assert.equal(audit.runtime.eventFormat, 'music-event-10');
  assert.equal(audit.pendingDeltas, 0);
  assert.equal(audit.completedInferences, 1);
  assert.equal(audit.failedInferences, 0);
  assert.throws(
    () => new MusicKernel(legacyFixture).admitDelta({
      authority: 'world', id: 'legacy-write-refused', stream: 'compatibility',
      at: '2026-08-30T13:00:00.000Z', payload: { content: 'Do not mix event formats.' },
    }),
    /legacy music-event-10 ledger is read-only/,
  );
});

test('the current runtime reconstructs the frozen unnamed checkpointed format-11 ledger', () => {
  const bytes = readFileSync(currentFixture);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), currentFixtureSha256);

  const audit = new MusicKernel(currentFixture).audit();
  assert.equal(audit.valid, true);
  assert.equal(audit.events, 9);
  assert.equal(audit.subject.name, null);
  assert.equal(audit.runtime.eventFormat, 'music-event-11');
  assert.equal(audit.inferenceCheckpoints, 1);
  assert.equal(audit.completedInferences, 1);
  assert.equal(audit.failedInferences, 0);
  assert.equal(audit.tools.some(tool => tool.id === 'retain_context'), true);
  assert.equal(audit.tools.some(tool => tool.id === 'tune_inference'), true);
});
