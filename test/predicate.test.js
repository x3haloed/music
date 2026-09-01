import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReceipt, evaluatePredicate } from '../src/predicate.js';

test('predicate evaluator reads exact JSON pointers and composes operations', () => {
  const receipt = { output: { status: 0, text: 'green' } };
  assert.equal(evaluatePredicate(receipt, {
    op: 'all',
    clauses: [
      { op: 'eq', path: '/output/status', value: 0 },
      { op: 'contains', path: '/output/text', value: 'green' },
    ],
  }), true);
});

test('classifier exposes conflicts and gaps as underdetermined', () => {
  assert.equal(classifyReceipt({ value: 1 }, {
    support: { op: 'exists', path: '/value' },
    contradiction: { op: 'eq', path: '/value', value: 1 },
  }).reason, 'predicate-conflict');
  assert.equal(classifyReceipt({}, {
    support: { op: 'exists', path: '/value' },
    contradiction: { op: 'eq', path: '/value', value: 1 },
  }).reason, 'predicate-gap');
});
