import assert from 'node:assert/strict';
import test from 'node:test';
import { initialCarrier } from '../src/carrier.js';
import {
  createDevelopmentalOpening, createDevelopmentalSuccessor, initialDevelopmentalPosition,
  projectDevelopmentalPosition, readDevelopmentalPosition, toolsetRoot,
} from '../src/development.js';
import { initialTools } from '../src/seeds.js';

test('an initial developmental position binds active geometry and one generic opening', () => {
  const tools = initialTools();
  const carrier = initialCarrier();
  const position = initialDevelopmentalPosition({
    tools,
    carrier,
    openingId: 'opening-1',
    at: '2026-08-31T12:00:00.000Z',
  });

  assert.equal(position.generation, 0);
  assert.equal(position.parentPositionRoot, null);
  assert.equal(position.toolsetRoot, toolsetRoot(tools));
  assert.deepEqual(position.activeOpening.content, { origin: 'birth' });
  assert.equal(readDevelopmentalPosition(position, { tools, carrier }).root, position.root);
  assert.deepEqual(projectDevelopmentalPosition(position), position);
});

test('a developmental position refuses altered roots and unbounded openings', () => {
  const tools = initialTools();
  const carrier = initialCarrier();
  const position = initialDevelopmentalPosition({
    tools, carrier, openingId: 'opening-1', at: '2026-08-31T12:00:00.000Z',
  });

  assert.throws(() => readDevelopmentalPosition({ ...position, carrierRoot: '0'.repeat(64) }), /root mismatch/);
  assert.throws(() => readDevelopmentalPosition({
    ...position,
    activeOpening: { ...position.activeOpening, content: 'x'.repeat(33 * 1_024) },
    root: position.root,
  }), /exceeds/);
});

test('opening closure interpretation is bound into developmental ancestry', () => {
  const tools = initialTools();
  const carrier = initialCarrier();
  const position = initialDevelopmentalPosition({
    tools, carrier, openingId: 'opening-1', at: '2026-08-31T12:00:00.000Z',
  });
  const opening = createDevelopmentalOpening({
    id: 'opening-2', parent: 'opening-1', authoredAt: '2026-08-31T12:01:00.000Z',
    notBefore: '2026-08-31T12:02:00.000Z', content: { trajectory: 'originate-contact' },
  });
  const successor = interpretation => createDevelopmentalSuccessor(position, {
    tools, carrier, opening,
    openingTransition: {
      successor: opening,
      closes: { openingId: 'opening-1', status: 'saturated', interpretation },
    },
  });

  const mailboxSaturated = successor('Passive mailbox observation yielded no contact.');
  const inquiryCompleted = successor('The active inquiry reached its answer.');
  assert.notEqual(mailboxSaturated.archiveRoot, inquiryCompleted.archiveRoot);
  assert.notEqual(mailboxSaturated.root, inquiryCompleted.root);
});
