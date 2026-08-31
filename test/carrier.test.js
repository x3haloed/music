import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCarrierTransition, createCarrierTransition, initialCarrier, projectCarrier } from '../src/carrier.js';

test('carrier transition preserves stable rule identity while evolving state and root identity', () => {
  const carrier = initialCarrier();
  const before = projectCarrier(carrier);
  const transition = createCarrierTransition(carrier, {
    componentId: 'orientation',
    value: 'When contact is ambiguous, prefer asking before sending.',
  });
  const afterCarrier = applyCarrierTransition(carrier, transition);
  const after = projectCarrier(afterCarrier);
  const beforeOrientation = before.components.find(component => component.id === 'orientation');
  const afterOrientation = after.components.find(component => component.id === 'orientation');

  assert.equal(afterOrientation.ruleDigest, beforeOrientation.ruleDigest);
  assert.notEqual(afterOrientation.stateDigest, beforeOrientation.stateDigest);
  assert.notEqual(after.root, before.root);
  assert.equal(afterOrientation.state.generation, 1);
  assert.equal(transition.parentRoot, before.root);
  assert.equal(transition.successorRoot, after.root);
});

test('an existing carrier component cannot silently change its stable rule', () => {
  assert.throws(() => createCarrierTransition(initialCarrier(), {
    componentId: 'orientation',
    rule: 'A different authority disguised as the same component.',
    value: 'changed',
  }), /rule identity is stable/);
});
