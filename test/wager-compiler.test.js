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
      outputPath: '/content',
      support: { operator: 'contains', value: 'green' },
      contradiction: { operator: 'contains', value: 'red' },
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
  assert.equal(wager.witnesses.support.output.content, 'green');
  assert.equal(wager.witnesses.support.output.path, '');
  assert.equal(wager.classifiers.support.path, '/output/content');
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

test('compiler constructs public witnesses permitted by an unconstrained tool output contract', () => {
  const position = initialPosition('2026-09-01T00:00:00.000Z');
  const tool = {
    format: 'music-v2-tool-1',
    manifest: {
      id: 'foreign', title: 'Foreign tool',
      description: 'Migrated tool with an honest unrestricted output contract.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      outputSchema: {}, effects: [],
    },
    source: 'return input;',
  };
  const wager = compileWager({
    id: 'foreign-status',
    stake: { id: 'status', description: 'Learn whether the foreign contact succeeds.', costOfDelay: 'low' },
    contact: { tool: 'a'.repeat(64), input: {} },
    discrimination: {
      outputPath: '/status',
      support: { operator: 'eq', value: 200 },
      contradiction: { operator: 'eq', value: 404 },
    },
    developmentScope: ['/memory'],
    continuations: {
      support: { set: { '/memory/status': 200 }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Continue.' } },
      contradiction: { set: { '/memory/status': 404 }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Revise.' } },
    },
  }, { position, readTool: () => tool });

  assert.deepEqual(wager.witnesses.support.output, { status: 200 });
  assert.deepEqual(wager.witnesses.contradiction.output, { status: 404 });
});
