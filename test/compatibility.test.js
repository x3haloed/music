import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MUSIC_EVENT_FORMAT, MusicKernel } from '../src/kernel.js';

const fixture = join(import.meta.dirname, 'fixtures', 'music-event-10.jsonl');
const fixtureSha256 = 'fbcbbf784b25e89a230afc617fe76a08e2fe80e8f4a1853d86f589f740e35e2e';

test('the current runtime reconstructs the retained pre-hatch compatibility ledger', () => {
  const bytes = readFileSync(fixture);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), fixtureSha256);
  assert.equal(MUSIC_EVENT_FORMAT, 'music-event-10');

  const audit = new MusicKernel(fixture).audit();
  assert.equal(audit.valid, true);
  assert.equal(audit.events, 8);
  assert.equal(audit.subject.name, 'Compatibility Witness');
  assert.equal(audit.runtimeStarts, 1);
  assert.equal(audit.runtime.eventFormat, 'music-event-10');
  assert.equal(audit.pendingDeltas, 0);
  assert.equal(audit.completedInferences, 1);
  assert.equal(audit.failedInferences, 0);
});
