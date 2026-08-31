import assert from 'node:assert/strict';
import test from 'node:test';
import { initialCarrier } from '../src/carrier.js';
import {
  initialDevelopmentalPosition, projectDevelopmentalPosition, readDevelopmentalPosition, toolsetRoot,
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
