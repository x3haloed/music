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
      outputPath: '/content',
      support: { operator: 'contains', value: expected },
      contradiction: { operator: 'contains', value: 'no' },
    },
    developmentScope: ['/memory'],
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
      proposedDevelopment: {
        kind: 'position',
        transition: {
          kind: 'position.transition',
          set: { '/memory/novel_contact': 'blue' },
          remove: [],
          opening: { kind: 'continue', notBefore: null, focus: 'Construct contact that distinguishes blue.' },
        },
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
      proposedDevelopment: {
        kind: 'position',
        transition: {
          kind: 'position.transition', set: { '/memory/resumed': true }, remove: [],
          opening: { kind: 'continue', notBefore: null, focus: 'Continue.' },
        },
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

test('a tool development is provisionally executed before its exact artifact becomes active', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-tool-development-'));
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
  const intent = candidate('tool-gap', artifact, 'a.txt', 'alpha');
  intent.developmentScope = ['/memory', '/mechanisms'];
  const outputs = {
    orientation: { harms: [], opportunities: [], unresolved: [], machineryConcerns: [{ target: 'text normalization', concern: 'No exact normalizer exists.', severity: 'medium' }] },
    challenge: { candidates: [intent, candidate('other-gap', artifact, 'a.txt', 'red')] },
    election: {
      selectedWagerId: 'tool-gap',
      assessments: [
        { wagerId: 'tool-gap', consequenceExposure: 'strong', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
        { wagerId: 'other-gap', consequenceExposure: 'adequate', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
      ],
    },
    assimilation: {
      consequenceClass: 'novel', bearsOn: ['text normalization'], harm: 'low', urgency: 'soon', disposition: 'revise',
      proposedDevelopment: {
        kind: 'tool',
        tool: {
          format: 'music-v2-tool-1',
          manifest: {
            id: 'uppercase_text', title: 'Uppercase text', description: 'Convert a string to uppercase.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            effects: [],
          },
          source: 'return { text: input.text.toUpperCase() };',
        },
        probes: [{ input: { text: 'hello' }, expectation: { op: 'eq', path: '/output/text', value: 'HELLO' } }],
        opening: { kind: 'continue', notBefore: null, focus: 'Use the exercised text normalizer where it bears on contact.' },
      },
      evidence: [],
    },
    disposition: {
      choice: 'admit', opening: { kind: 'continue', notBefore: null, focus: 'Unused.' },
      basis: { trialEligible: true, floorsPreserved: true, consequenceBearing: 'adequate' },
    },
  };
  const perspectives = new PerspectiveEngine(kernel, { infer: async ({ kind }) => ({ output: outputs[kind], model: 'test/fresh' }) });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.trial.runtime, 'music-v2-tool-trial-1');
  assert.equal(result.trial.probeReceipts[0].passed, true);
  assert.equal(result.position.mechanisms.uppercase_text.manifest.id, 'uppercase_text');
  assert.equal(kernel.artifacts.has(result.position.mechanisms.uppercase_text.artifact), true);
  assert.equal(result.position.floors.length, 1);
  assert.equal(result.position.floors[0].kind, 'tool.behavior');
  assert.equal(result.position.floors[0].toolId, 'uppercase_text');

  const { compileWager } = await import('../src/wager-compiler.js');
  const current = kernel.state().position;
  const revisionContact = candidate('revise-uppercase', current.mechanisms.read_file.artifact, 'a.txt', 'alpha');
  revisionContact.developmentScope = ['/memory', '/mechanisms'];
  const bound = compileWager(revisionContact, { position: current, readTool: id => kernel.artifacts.readJson(id) });
  kernel.bindWager(bound); await kernel.realize(bound.id);
  const revisionId = kernel.proposeDevelopment({
    wagerId: bound.id, invocationId: 'regressive-revision',
    proposal: { proposedDevelopment: {
      kind: 'tool',
      tool: {
        format: 'music-v2-tool-1',
        manifest: result.position.mechanisms.uppercase_text.manifest,
        source: 'return { text: input.text };',
      },
      probes: [{ input: { text: 'hello' }, expectation: { op: 'eq', path: '/output/text', value: 'hello' } }],
      opening: { kind: 'continue', notBefore: null, focus: 'Continue.' },
    } },
  });
  const regressive = await kernel.trialDevelopment(revisionId);
  assert.equal(regressive.eligible, false);
  assert.deepEqual(regressive.requiredFloorIds, [result.position.floors[0].id]);
  assert.deepEqual(regressive.passedFloorIds, []);
  assert.equal(regressive.probeReceipts.some(receipt => receipt.source === 'retained-floor' && !receipt.passed), true);
});

test('a restart resumes a trialed development at disposition without repeating its probe', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-development-resume-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  let sequence = 0;
  const kernel = new MusicKernel(habitat, {
    clock: () => new Date(1_788_220_800_000 + sequence++ * 1_000),
    id: () => `id-${sequence++}`,
  });
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'a.txt'), 'blue');
  const { compileWager } = await import('../src/wager-compiler.js');
  const compiled = compileWager(candidate('resume-development', initial.position.mechanisms.read_file.artifact, 'a.txt', 'alpha'), {
    position: initial.position, readTool: id => kernel.artifacts.readJson(id),
  });
  kernel.bindWager(compiled);
  await kernel.realize(compiled.id);
  const proposal = {
    consequenceClass: 'novel', bearsOn: ['blue'], harm: 'low', urgency: 'soon', disposition: 'revise',
    proposedDevelopment: {
      kind: 'position',
      transition: { kind: 'position.transition', set: { '/memory/recovered': true }, remove: [], opening: { kind: 'continue', notBefore: null, focus: 'Continue.' } },
    },
    evidence: [],
  };
  const developmentId = kernel.proposeDevelopment({ wagerId: compiled.id, invocationId: 'assimilation-before-crash', proposal });
  await kernel.trialDevelopment(developmentId);
  const before = kernel.ledger.read().filter(event => event.type === 'development.trialed').length;
  const perspectives = new PerspectiveEngine(kernel, { infer: async ({ kind }) => {
    assert.equal(kind, 'disposition');
    return { output: {
      choice: 'admit', opening: { kind: 'continue', notBefore: null, focus: 'Continue.' },
      basis: { trialEligible: true, floorsPreserved: true, consequenceBearing: 'adequate' },
    }, model: 'test/fresh' };
  } });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.assimilation, null);
  assert.equal(result.position.memory.recovered, true);
  assert.equal(kernel.ledger.read().filter(event => event.type === 'development.trialed').length, before);
});

test('a restart resumes a bound wager without rerunning orientation, challenge, or election', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-bound-resume-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  const kernel = new MusicKernel(habitat);
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'a.txt'), 'alpha');
  const { compileWager } = await import('../src/wager-compiler.js');
  const wager = compileWager(candidate('bound-before-restart', initial.position.mechanisms.read_file.artifact, 'a.txt', 'alpha'), {
    position: initial.position, readTool: id => kernel.artifacts.readJson(id),
  });
  kernel.bindWager(wager);
  const perspectives = new PerspectiveEngine(kernel, { infer: async () => { throw new Error('no perspective should run'); } });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.realized.evaluation.kind, 'support');
  assert.equal(result.realized.position.memory['bound-before-restart'], true);
  assert.equal(kernel.state().perspectives.size, 0);
});

test('a provisional tool-authority policy must shape a fresh frontier and election before admission', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-authority-trial-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  let sequence = 0;
  const kernel = new MusicKernel(habitat, {
    clock: () => new Date(1_788_220_800_000 + sequence++ * 1_000), id: () => `id-${sequence++}`,
  });
  kernel.governance.set('local.read', true, 'test operator');
  kernel.governance.set('local.execute', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'blue.txt'), 'blue');
  writeFileSync(join(habitat, 'alpha.txt'), 'alpha');
  writeFileSync(join(habitat, 'beta.txt'), 'beta');
  const { compileWager } = await import('../src/wager-compiler.js');
  const originatingIntent = candidate('authority-origin', initial.position.mechanisms.read_file.artifact, 'blue.txt', 'alpha');
  originatingIntent.developmentScope = ['/memory', '/authority'];
  const originating = compileWager(originatingIntent, { position: initial.position, readTool: id => kernel.artifacts.readJson(id) });
  kernel.bindWager(originating);
  await kernel.realize(originating.id);
  const developmentId = kernel.proposeDevelopment({
    wagerId: originating.id,
    invocationId: 'authority-assimilation',
    proposal: {
      proposedDevelopment: {
        kind: 'tool-authority', allowedToolIds: ['read_file'],
        opening: { kind: 'continue', notBefore: null, focus: 'Exercise the bounded read-only tool frontier.' },
      },
    },
  });
  const outputs = {
    orientation: { harms: [], opportunities: [], unresolved: [], machineryConcerns: [] },
    challenge: { candidates: [
      candidate('authority-alpha', initial.position.mechanisms.read_file.artifact, 'alpha.txt', 'alpha'),
      candidate('authority-beta', initial.position.mechanisms.read_file.artifact, 'beta.txt', 'beta'),
    ] },
    election: {
      selectedWagerId: 'authority-alpha',
      assessments: [
        { wagerId: 'authority-alpha', consequenceExposure: 'strong', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
        { wagerId: 'authority-beta', consequenceExposure: 'adequate', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
      ],
    },
    disposition: {
      choice: 'admit', opening: { kind: 'continue', notBefore: null, focus: 'Unused.' },
      basis: { trialEligible: true, floorsPreserved: true, consequenceBearing: 'strong' },
    },
  };
  let challengeProjection;
  const perspectives = new PerspectiveEngine(kernel, { infer: async ({ kind, projection }) => {
    if (kind === 'challenge') challengeProjection = projection;
    return { output: outputs[kind], model: 'test/fresh' };
  } });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.trial.runtime, 'music-v2-tool-authority-trial-1');
  assert.equal(result.trial.authorityExercise.selectedTool, 'read_file');
  assert.deepEqual(challengeProjection.tools.map(tool => tool.manifest.id), ['read_file']);
  assert.deepEqual(result.position.authority.toolSelection.allowedToolIds, ['read_file']);
  assert.equal(result.realized.evaluation.kind, 'support');
  assert.deepEqual(kernel.state().position.authority.toolSelection.allowedToolIds, ['read_file']);
  assert.equal(kernel.state().development.get(developmentId).status, 'admit');
});

test('a restart after authority election resumes at disposition and preserves the elected wager', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-authority-resume-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  const kernel = new MusicKernel(habitat);
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'origin.txt'), 'blue');
  writeFileSync(join(habitat, 'selected.txt'), 'alpha');
  const { compileWager } = await import('../src/wager-compiler.js');
  const originIntent = candidate('authority-resume-origin', initial.position.mechanisms.read_file.artifact, 'origin.txt', 'alpha');
  originIntent.developmentScope = ['/memory', '/authority'];
  const origin = compileWager(originIntent, { position: initial.position, readTool: id => kernel.artifacts.readJson(id) });
  kernel.bindWager(origin); await kernel.realize(origin.id);
  const developmentId = kernel.proposeDevelopment({
    wagerId: origin.id, invocationId: 'assimilation',
    proposal: { proposedDevelopment: { kind: 'tool-authority', allowedToolIds: ['read_file'], opening: { kind: 'continue', notBefore: null, focus: 'Exercise.' } } },
  });
  const candidatePosition = kernel.developmentCandidate(developmentId);
  const selected = compileWager(candidate('authority-resumed-selection', initial.position.mechanisms.read_file.artifact, 'selected.txt', 'alpha'), {
    position: candidatePosition, readTool: id => kernel.artifacts.readJson(id),
  });
  kernel.trialAuthorityDevelopment(developmentId, {
    candidatePosition: candidatePosition.id, selectedWager: selected,
    perspectiveReceipts: {
      orientation: { invocation: 'orientation-invocation', output: 'a'.repeat(64) },
      challenge: { invocation: 'challenge-invocation', output: 'b'.repeat(64) },
      election: { invocation: 'election-invocation', output: 'c'.repeat(64) },
    },
  });
  const perspectives = new PerspectiveEngine(kernel, { infer: async ({ kind }) => {
    assert.equal(kind, 'disposition');
    return { output: {
      choice: 'admit', opening: { kind: 'continue', notBefore: null, focus: 'Unused.' },
      basis: { trialEligible: true, floorsPreserved: true, consequenceBearing: 'strong' },
    }, model: 'test/fresh' };
  } });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.realized.evaluation.kind, 'support');
  assert.equal(kernel.state().position.memory['authority-resumed-selection'], true);
  assert.equal([...kernel.state().perspectives.values()].length, 1);
});

test('an inference policy governs fresh selection perspectives before admission', async t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-inference-authority-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  const kernel = new MusicKernel(habitat);
  kernel.governance.set('local.read', true, 'test operator');
  const initial = kernel.initialize();
  writeFileSync(join(habitat, 'origin.txt'), 'blue');
  writeFileSync(join(habitat, 'selected.txt'), 'alpha');
  const { compileWager } = await import('../src/wager-compiler.js');
  const originIntent = candidate('inference-origin', initial.position.mechanisms.read_file.artifact, 'origin.txt', 'alpha');
  originIntent.developmentScope = ['/memory', '/authority'];
  const origin = compileWager(originIntent, { position: initial.position, readTool: id => kernel.artifacts.readJson(id) });
  kernel.bindWager(origin);
  await kernel.realize(origin.id);
  const developmentId = kernel.proposeDevelopment({
    wagerId: origin.id,
    invocationId: 'inference-assimilation',
    proposal: {
      proposedDevelopment: {
        kind: 'inference-policy',
        selectionBudgets: { orientation: 1_111, challenge: 2_222, election: 3_333 },
        reasoningEffort: 'high',
        providerOrder: ['z-ai'],
        opening: { kind: 'continue', notBefore: null, focus: 'Exercise a bounded selection policy.' },
      },
    },
  });
  const seen = [];
  const outputs = {
    orientation: { harms: [], opportunities: [], unresolved: [], machineryConcerns: [] },
    challenge: { candidates: [
      candidate('inference-alpha', initial.position.mechanisms.read_file.artifact, 'selected.txt', 'alpha'),
      candidate('inference-beta', initial.position.mechanisms.read_file.artifact, 'origin.txt', 'blue'),
    ] },
    election: {
      selectedWagerId: 'inference-alpha',
      assessments: [
        { wagerId: 'inference-alpha', consequenceExposure: 'strong', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
        { wagerId: 'inference-beta', consequenceExposure: 'adequate', cost: 'low', delayHarm: 'low', admissibilityRisk: 'low' },
      ],
    },
    disposition: {
      choice: 'admit', opening: { kind: 'continue', notBefore: null, focus: 'Unused.' },
      basis: { trialEligible: true, floorsPreserved: true, consequenceBearing: 'strong' },
    },
  };
  const perspectives = new PerspectiveEngine(kernel, { infer: async input => {
    seen.push(input);
    return { output: outputs[input.kind], model: 'test/fresh' };
  } });
  const result = await new DevelopmentalOrgan(kernel, perspectives).open();
  assert.equal(result.trial.runtime, 'music-v2-inference-policy-trial-1');
  assert.equal(result.trial.eligible, true);
  assert.deepEqual(seen.slice(0, 3).map(value => ({
    kind: value.kind,
    maxOutputTokens: value.maxOutputTokens,
    reasoningEffort: value.reasoningEffort,
    providerOrder: value.providerOrder,
  })), [
    { kind: 'orientation', maxOutputTokens: 1_111, reasoningEffort: 'high', providerOrder: ['z-ai'] },
    { kind: 'challenge', maxOutputTokens: 2_222, reasoningEffort: 'high', providerOrder: ['z-ai'] },
    { kind: 'election', maxOutputTokens: 3_333, reasoningEffort: 'high', providerOrder: ['z-ai'] },
  ]);
  assert.equal(result.realized.evaluation.kind, 'support');
  assert.equal(kernel.state().development.get(developmentId).status, 'admit');
  assert.equal(kernel.state().position.authority.inference.reasoningEffort, 'high');
  assert.deepEqual(kernel.state().position.authority.inference.providerOrder, ['z-ai']);
});
