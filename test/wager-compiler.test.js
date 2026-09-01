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
    discrimination: {
      outputPath: '/text',
      support: { operator: 'eq', value: 'green' },
      contradiction: { operator: 'eq', value: 'red' },
    },
    developmentScope: ['/memory'],
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

test('compiler creates valid public witnesses for structural numeric predicates', () => {
  const tool = starterTools().find(value => value.manifest.id === 'read_file');
  const wager = compileWager({
    id: 'nonempty-read',
    stake: { id: 'file-presence', description: 'Distinguish a nonempty file from an empty one.', costOfDelay: 'low' },
    contact: { tool: 'a'.repeat(64), input: { path: 'answer.txt' } },
    discrimination: {
      outputPath: '/bytes',
      support: { operator: 'gt', value: 0 },
      contradiction: { operator: 'eq', value: 0 },
    },
    developmentScope: ['/memory', '/mechanisms'],
    continuations: {
      support: { set: { '/memory/nonempty': true }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Continue.' } },
      contradiction: { set: { '/memory/nonempty': false }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Revise.' } },
    },
  }, {
    position: initialPosition('2026-09-01T00:00:00.000Z'),
    readTool: () => tool,
  });
  assert.equal(wager.classifiers.support.op, 'gt');
  assert.equal(wager.witnesses.support.output.bytes, 1);
  assert.equal(wager.witnesses.contradiction.output.bytes, 0);
});
