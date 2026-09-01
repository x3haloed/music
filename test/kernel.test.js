import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicKernel } from '../src/kernel.js';

function fixture() {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-kernel-'));
  let sequence = 0;
  const options = {
    clock: () => new Date(1_788_220_800_000 + sequence++ * 1_000),
    id: () => `id-${sequence++}`,
  };
  return { habitat, options, kernel: new MusicKernel(habitat, options) };
}

function transition(value) {
  return {
    kind: 'position.transition',
    set: { '/memory/contact_result': value },
    remove: [],
    opening: { kind: 'continue', notBefore: null, focus: 'Choose the next bounded contact.' },
  };
}

function readWager(state, path, expected = 'green') {
  const tool = state.position.mechanisms.read_file.artifact;
  return {
    id: 'read-contact',
    stake: { id: 'first-contact', description: 'Can the selected file answer green?', costOfDelay: 'low' },
    contact: { tool, input: { path } },
    classifiers: {
      support: { op: 'eq', path: '/output/text', value: expected },
      contradiction: { op: 'eq', path: '/output/text', value: 'red' },
    },
    witnesses: {
      support: { output: { path, bytes: expected.length, text: expected } },
      contradiction: { output: { path, bytes: 3, text: 'red' } },
    },
    continuations: { support: transition('supported'), contradiction: transition('contradicted') },
    retainedFloorIds: [],
    revisionScope: ['/memory'],
    effectRequirements: ['local.read'],
  };
}

test('exact message observation and elected tool consequence survive restart into a direct transition', async t => {
  const { habitat, options, kernel } = fixture();
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  writeFileSync(join(habitat, 'answer.txt'), 'green');
  kernel.governance.set('local.read', true, 'test operator');
  kernel.initialize();
  const message = kernel.receiveMessage({ sender: 'Chad', content: 'What do you notice?' });
  assert.equal(message.kind, 'message.received');
  assert.equal(message.content, 'What do you notice?');

  const wager = readWager(kernel.state(), 'answer.txt');
  kernel.bindWager(wager, { perspective: 'test-election' });
  const result = await kernel.realize(wager.id);
  assert.equal(result.evaluation.kind, 'support');
  assert.equal(result.position.memory.contact_result, 'supported');

  const restarted = new MusicKernel(habitat, options).state();
  assert.equal(restarted.subject.designation, null);
  assert.equal(restarted.observations[0].sender, 'Chad');
  assert.equal(restarted.position.id, result.position.id);
  assert.equal(restarted.position.parent !== null, true);
});

test('predicate gap retains consequence without inventing a transition', async t => {
  const { habitat, kernel } = fixture();
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  writeFileSync(join(habitat, 'answer.txt'), 'blue');
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  const wager = readWager(initial, 'answer.txt');
  kernel.bindWager(wager);
  const result = await kernel.realize(wager.id);
  assert.equal(result.evaluation.kind, 'underdetermined');
  assert.equal(result.evaluation.reason, 'predicate-gap');
  assert.equal(result.position, null);
  assert.equal(kernel.state().position.id, initial.position.id);
});

test('tool failure is retained as underdetermined consequence instead of escaping the loop', async t => {
  const { habitat, kernel } = fixture();
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  writeFileSync(join(habitat, 'answer.txt'), 'a result larger than four bytes');
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  const wager = readWager(initial, 'answer.txt');
  wager.contact.input.maxBytes = 4;
  kernel.bindWager(wager);
  const result = await kernel.realize(wager.id);
  assert.equal(result.receipt.kind, 'tool.failure');
  assert.match(result.receipt.failure.message, /exceeds maxBytes/);
  assert.equal(result.evaluation.kind, 'underdetermined');
  assert.equal(kernel.state().realizations.get(wager.id).kind, 'tool.failure');
});

test('generic position development cannot smuggle unexercised mechanisms into authority', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-development-boundary-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  const kernel = new MusicKernel(habitat);
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  const intent = {
    id: 'mechanism-bearing-contact',
    stake: { id: 'mechanism-integrity', description: 'Observe a file before bounded development.', costOfDelay: 'low' },
    contact: { tool: initial.position.mechanisms.read_file.artifact, input: { path: 'missing.txt' } },
    discrimination: { outputPath: '/text', support: { operator: 'eq', value: 'yes' }, contradiction: { operator: 'eq', value: 'no' } },
    developmentScope: ['/mechanisms'],
    continuations: {
      support: { set: { '/memory/result': 'yes' }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Continue.' } },
      contradiction: { set: { '/memory/result': 'no' }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Continue.' } },
    },
  };
  const { compileWager } = await import('../src/wager-compiler.js');
  const wager = compileWager(intent, { position: initial.position, readTool: id => kernel.artifacts.readJson(id) });
  kernel.bindWager(wager);
  await kernel.realize(wager.id);
  assert.throws(() => kernel.proposeDevelopment({
    wagerId: wager.id,
    invocationId: 'attempted-bypass',
    proposal: {
      proposedDevelopment: {
        kind: 'position',
        transition: {
          kind: 'position.transition',
          set: { '/mechanisms/untried': { kind: 'tool' } },
          remove: [],
          opening: { kind: 'continue', notBefore: null, focus: 'Continue.' },
        },
      },
    },
  }), /cannot bypass/);
});

test('retained realization receipt resumes at predicate evaluation without repeating world contact', async t => {
  const { habitat, kernel } = fixture();
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'answer.txt'), 'green');
  const wager = readWager(initial, 'answer.txt');
  kernel.bindWager(wager);
  const retained = {
    id: 'receipt-before-restart', kind: 'tool.result',
    tool: { artifact: wager.contact.tool, id: 'read_file' }, input: wager.contact.input,
    output: { path: join(habitat, 'answer.txt'), bytes: 5, text: 'green' },
    startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:01.000Z',
    capture: { runtime: 'music-v2-tool-runtime-1', transformed: false },
  };
  kernel.ledger.append('realization.completed', { wagerId: wager.id, receipt: retained });
  writeFileSync(join(habitat, 'answer.txt'), 'red');
  const result = await kernel.realize(wager.id);
  assert.equal(result.evaluation.kind, 'support');
  assert.equal(result.receipt.output.text, 'green');
  assert.equal(kernel.ledger.read().filter(event => event.type === 'realization.completed').length, 1);
});
