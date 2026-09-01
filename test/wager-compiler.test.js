import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPosition } from '../src/position.js';
import { starterTools } from '../src/tools.js';
import { compileWager } from '../src/wager-compiler.js';

test('compiler derives executable predicates, witnesses, effects, scope, and floors from compact intent', () => {
  const tool = starterTools().find(value => value.manifest.id === 'read_file');
  const wager = compileWager({
    id: 'read-intent',
    stake: { id: 'understand-file', description: 'Learn whether the file says green.', costOfDelay: 'low' },
    contact: { tool: 'a'.repeat(64), input: { path: 'answer.txt' } },
    discrimination: { outputPath: '/text', supportValue: 'green', contradictionValue: 'red' },
    continuations: {
      support: { set: { '/memory/result': 'green' }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Continue.' } },
      contradiction: { set: { '/memory/result': 'red' }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Revise.' } },
    },
  }, {
    position: initialPosition('2026-09-01T00:00:00.000Z'),
    readTool: () => tool,
  });
  assert.deepEqual(wager.effectRequirements, ['local.read']);
  assert.deepEqual(wager.revisionScope, ['/memory']);
  assert.equal(wager.witnesses.support.output.text, 'green');
  assert.equal(wager.witnesses.support.output.path, '');
  assert.equal(wager.classifiers.support.path, '/output/text');
});
