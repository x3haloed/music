import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevelopmentalOrgan } from '../src/organ.js';
import { MusicKernel } from '../src/kernel.js';
import { PerspectiveEngine } from '../src/perspective.js';

function transition(result) {
  return {
    kind: 'position.transition',
    set: { [`/memory/${result}`]: true },
    remove: [],
    opening: { kind: 'continue', notBefore: null, focus: `Continue after ${result}.` },
  };
}

function candidate(id, artifact, path, expected) {
  return {
    id,
    stake: { id: `stake-${id}`, description: `Read ${path} for ${expected}.`, costOfDelay: 'low' },
    contact: { tool: artifact, input: { path } },
    discrimination: {
      outputPath: '/text',
      supportValue: expected,
      contradictionValue: 'no',
    },
    continuations: {
      support: { set: transition(id).set, remove: [], opening: transition(id).opening },
      contradiction: { set: transition(`${id}_failed`).set, remove: [], opening: transition(`${id}_failed`).opening },
    },
  };
}

test('fresh typed perspectives elect and realize one exact wager without response chaining', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-organ-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  let sequence = 0;
  const kernel = new MusicKernel(habitat, {
    clock: () => new Date(1_788_220_800_000 + sequence++ * 1_000),
    id: () => `id-${sequence++}`,
  });
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'a.txt'), 'alpha');
  writeFileSync(join(habitat, 'b.txt'), 'beta');
  const artifact = initial.position.mechanisms.read_file.artifact;
  const outputs = {
    orientation: {
      harms: [],
      opportunities: [{ id: 'inspect-local', description: 'Read a bounded local answer.', consequenceSurface: 'file content', evidenceObservationIds: [] }],
      unresolved: [],
      machineryConcerns: [],
    },
    challenge: {
      candidates: [
        candidate('alpha-contact', artifact, 'a.txt', 'alpha'),
        candidate('beta-contact', artifact, 'b.txt', 'beta'),
      ],
    },
    election: {
      selectedWagerId: 'beta-contact',
      assessments: [
        { wagerId: 'alpha-contact', consequenceExposure: 'adequate', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
        { wagerId: 'beta-contact', consequenceExposure: 'strong', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
      ],
    },
  };
  const perspectives = new PerspectiveEngine(kernel, {
    infer: async ({ kind }) => ({ output: outputs[kind], model: 'test/fresh' }),
  });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.realized.receipt.input.path, 'b.txt');
  assert.equal(result.realized.position.memory['beta-contact'], true);
  const invocations = [...kernel.state().perspectives.values()];
  assert.equal(invocations.length, 3);
  assert.equal(invocations.every(value => value.responseChain === null), true);
  assert.equal(new Set(invocations.map(value => value.context)).size, 3);
  assert.equal(invocations.every(value => value.status === 'completed'), true);
});

test('invalid perspective output is quarantined without changing the position', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-quarantine-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  const kernel = new MusicKernel(habitat);
  const initial = kernel.initialize();
  const perspectives = new PerspectiveEngine(kernel, {
    infer: async () => ({ output: { harms: 'not-an-array' }, model: 'test/broken' }),
  });
  await assert.rejects(() => new DevelopmentalOrgan(kernel, perspectives).open());
  const state = kernel.state();
  assert.equal(state.position.id, initial.position.id);
  assert.equal([...state.perspectives.values()].at(-1).status, 'failed');
  assert.equal([...state.perspectives.values()].at(-1).failure.quarantined, true);
});

test('underdetermined residue crosses candidate execution and fresh disposition before admission', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-assimilation-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  let sequence = 0;
  const kernel = new MusicKernel(habitat, {
    clock: () => new Date(1_788_220_800_000 + sequence++ * 1_000),
    id: () => `id-${sequence++}`,
  });
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'a.txt'), 'blue');
  writeFileSync(join(habitat, 'b.txt'), 'also-blue');
  const artifact = initial.position.mechanisms.read_file.artifact;
  const outputs = {
    orientation: { harms: [], opportunities: [], unresolved: [], machineryConcerns: [] },
    challenge: {
      candidates: [
        candidate('alpha-contact', artifact, 'a.txt', 'alpha'),
        candidate('beta-contact', artifact, 'b.txt', 'beta'),
      ],
    },
    election: {
      selectedWagerId: 'alpha-contact',
      assessments: [
        { wagerId: 'alpha-contact', consequenceExposure: 'strong', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
        { wagerId: 'beta-contact', consequenceExposure: 'adequate', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
      ],
    },
    assimilation: {
      consequenceClass: 'novel',
      bearsOn: ['The contact returned a third value.'],
      harm: 'low',
      urgency: 'soon',
      disposition: 'revise',
      proposedTransition: {
        kind: 'position.transition',
        set: { '/memory/novel_contact': 'blue' },
        remove: [],
        opening: { kind: 'continue', notBefore: null, focus: 'Construct contact that distinguishes blue.' },
      },
      evidence: [],
    },
    disposition: {
      choice: 'admit',
      opening: { kind: 'continue', notBefore: null, focus: 'Unused for admission.' },
      basis: { trialEligible: true, floorsPreserved: true, consequenceBearing: 'adequate' },
    },
  };
  const perspectives = new PerspectiveEngine(kernel, {
    infer: async ({ kind }) => ({ output: outputs[kind], model: 'test/fresh' }),
  });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.realized.evaluation.kind, 'underdetermined');
  assert.equal(result.trial.eligible, true);
  assert.equal(result.position.memory.novel_contact, 'blue');
  assert.equal(kernel.state().position.id, result.position.id);
  assert.equal([...kernel.state().perspectives.values()].length, 5);
});

test('restart quarantines a perspective that never retained a terminal receipt', t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-interrupted-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  const kernel = new MusicKernel(habitat);
  kernel.initialize();
  kernel.ledger.append('perspective.started', {
    invocation: {
      id: 'interrupted-1',
      kind: 'orientation',
      schema: 'music.orientation-1',
      projection: 'a'.repeat(64),
      context: 'context-1',
      responseChain: null,
      workspaceContinuity: null,
      authority: ['subject.perspective'],
      tools: [],
      model: 'test/model',
      timeoutMs: 120_000,
      startedAt: new Date().toISOString(),
    },
  });
  assert.deepEqual(kernel.recoverInterruptedPerspectives(), ['interrupted-1']);
  const recovered = kernel.state().perspectives.get('interrupted-1');
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.failure.name, 'InterruptedPerspective');
});

test('a failed assimilator leaves consequence warm for a fresh assimilation without replaying contact', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-resume-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  let sequence = 0;
  const kernel = new MusicKernel(habitat, {
    clock: () => new Date(1_788_220_800_000 + sequence++ * 1_000),
    id: () => `id-${sequence++}`,
  });
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'a.txt'), 'blue');
  const artifact = initial.position.mechanisms.read_file.artifact;
  const wager = candidate('resume-contact', artifact, 'a.txt', 'alpha');
  const { compileWager } = await import('../src/wager-compiler.js');
  const compiled = compileWager(wager, {
    position: initial.position,
    readTool: id => kernel.artifacts.readJson(id),
  });
  kernel.bindWager(compiled);
  await kernel.realize(compiled.id);
  assert.equal(kernel.state().pendingAssimilation.wagerId, compiled.id);

  const outputs = {
    assimilation: {
      consequenceClass: 'novel', bearsOn: ['blue'], harm: 'low', urgency: 'soon', disposition: 'revise',
      proposedTransition: {
        kind: 'position.transition', set: { '/memory/resumed': true }, remove: [],
        opening: { kind: 'continue', notBefore: null, focus: 'Continue.' },
      },
      evidence: [],
    },
    disposition: {
      choice: 'admit', opening: { kind: 'continue', notBefore: null, focus: 'Continue.' },
      basis: { trialEligible: true, floorsPreserved: true, consequenceBearing: 'adequate' },
    },
  };
  const perspectives = new PerspectiveEngine(kernel, {
    infer: async ({ kind }) => ({ output: outputs[kind], model: 'test/fresh' }),
  });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.orientation, null);
  assert.equal(result.challenge, null);
  assert.equal(result.position.memory.resumed, true);
  assert.equal([...kernel.state().perspectives.values()].length, 2);
});
