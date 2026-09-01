import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, evaluatePredicate } from '../src/predicate.js';

test('predicate language supports structural set and length contact', () => {
  const input = { output: { selected: ['a', 'c'], available: ['a', 'b', 'c'] } };
  assert.equal(evaluatePredicate(input, { op: 'subset', path: '/output/selected', value: ['a', 'b', 'c'] }), true);
  assert.equal(evaluatePredicate(input, { op: 'set-eq', path: '/output/selected', value: ['c', 'a'] }), true);
  assert.equal(evaluatePredicate(input, { op: 'length', path: '/output/available', comparison: 'gte', value: 3 }), true);
});

test('classifier exposes gaps and conflicts rather than inventing precedence', () => {
  const gap = classify({ output: { value: 5 } }, {
    support: { op: 'gt', path: '/output/value', value: 8 },
    contradiction: { op: 'lt', path: '/output/value', value: 3 },
  });
  assert.equal(gap.kind, 'underdetermined');
  assert.equal(gap.reason, 'predicate-gap');
  const conflict = classify({ output: { value: 5 } }, {
    support: { op: 'gte', path: '/output/value', value: 5 },
    contradiction: { op: 'lte', path: '/output/value', value: 5 },
  });
  assert.equal(conflict.reason, 'predicate-conflict');
});
