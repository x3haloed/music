import test from 'node:test';
import assert from 'node:assert/strict';
import { admitWager } from '../src/constitution.js';
import { applyTransition, initialPosition } from '../src/position.js';

const opening = { kind: 'continue', notBefore: null, focus: 'Continue.' };
const support = {
  kind: 'position.transition',
  set: { '/memory/result': 'supported' },
  remove: [],
  opening,
};
const contradiction = {
  kind: 'position.transition',
  set: { '/memory/result': 'contradicted' },
  remove: [],
  opening,
};

function wager(overrides = {}) {
  return {
    id: 'wager-1',
    stake: { id: 'stake-1', description: 'Does contact answer green?', costOfDelay: 'low' },
    contact: { tool: 'a'.repeat(64), input: {} },
    classifiers: {
      support: { op: 'eq', path: '/output/text', value: 'green' },
      contradiction: { op: 'eq', path: '/output/text', value: 'red' },
    },
    witnesses: {
      support: { output: { text: 'green' } },
      contradiction: { output: { text: 'red' } },
    },
    continuations: { support, contradiction },
    retainedFloorIds: [],
    revisionScope: ['/memory'],
    effectRequirements: ['local.read'],
    ...overrides,
  };
}

test('constitution admits a non-vacuous, closed, authorized wager', () => {
  const result = admitWager(wager(), {
    position: initialPosition('2026-09-01T00:00:00.000Z'),
    grants: [{ capability: 'local.read', active: true }],
    artifactExists: () => true,
    toolContract: () => ({
      effects: ['local.read'],
      outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    }),
  });
  assert.equal(result.admissible, true);
  const next = applyTransition(initialPosition('2026-09-01T00:00:00.000Z'), support, '2026-09-01T00:01:00.000Z');
  assert.equal(next.memory.result, 'supported');
});

test('constitution rejects vacuous witnesses, scope escape, omitted floors, and missing grants', () => {
  const position = initialPosition('2026-09-01T00:00:00.000Z');
  position.floors.push({
    id: 'floor-1',
    scope: '/memory',
    predicate: { op: 'exists', path: '/memory/result' },
    earnedBy: 'prior-trial',
  });
  const result = admitWager(wager({
    witnesses: { support: { output: { text: 'red' } }, contradiction: { output: { text: 'red' } } },
    revisionScope: ['/stakes'],
  }), {
    position,
    grants: [],
    artifactExists: () => false,
  });
  assert.equal(result.admissible, false);
  assert.match(result.reasons.join('\n'), /artifact is absent/);
  assert.match(result.reasons.join('\n'), /support witness/);
  assert.match(result.reasons.join('\n'), /outside revision scope/);
  assert.match(result.reasons.join('\n'), /derived floors/);
  assert.match(result.reasons.join('\n'), /missing effect grant/);
});
