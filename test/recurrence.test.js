import test from 'node:test';
import assert from 'node:assert/strict';
import { nextEncounterAt, retainedFailureBackoff } from '../src/recurrence.js';

test('a far-future subject opening cannot suppress the continuity ceiling', () => {
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  assert.equal(nextEncounterAt({
    now,
    notBefore: '2036-09-01T00:00:00.000Z',
    minimumCycleMs: 60_000,
    continuityMs: 30 * 60_000,
  }), now + 30 * 60_000);
});

test('resource floor prevents an immediate opening from creating an inference spin loop', () => {
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  assert.equal(nextEncounterAt({
    now,
    notBefore: null,
    lastEncounterAt: now - 1_000,
    minimumCycleMs: 60_000,
    continuityMs: 30 * 60_000,
  }), now + 59_000);
});

test('retained perspective failures create exponential restart-safe backoff until success', () => {
  const now = Date.parse('2026-09-01T17:00:00.000Z');
  const events = [
    { type: 'perspective.completed', at: '2026-09-01T16:00:00.000Z' },
    { type: 'perspective.failed', at: '2026-09-01T16:59:58.000Z' },
    { type: 'perspective.failed', at: '2026-09-01T16:59:59.000Z' },
  ];
  assert.deepEqual(retainedFailureBackoff(events, now, 1_000, 8_000), {
    failures: 2, delayMs: 2_000, retryAt: now + 1_000, remainingMs: 1_000,
  });
  assert.equal(retainedFailureBackoff(events, now + 1_000, 1_000, 8_000), null);
  assert.equal(retainedFailureBackoff([...events, { type: 'perspective.completed', at: '2026-09-01T17:00:00.000Z' }], now, 1_000, 8_000), null);
});
