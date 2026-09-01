import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FunctionActor, ScriptActor } from '../src/actor.js';
import { DevelopmentalKernel } from '../src/kernel.js';
import { defaultSelectionMeasurements, selectWagers } from '../src/selector.js';
import { createSubject } from '../src/subject.js';
import { defineWorld, WorldRegistry } from '../src/world.js';

const selector = direction => ({
  format: 'music-v3-scalar-pursuit-selector-1',
  id: `decision-ready-${direction}`,
  dimension: {
    id: 'decision-ready-signal',
    meaning: 'Independently observable checkpoints capable of distinguishing success from surrender.',
    direction,
  },
  policies: { missing: 'reject-frontier', blocked: 'exclude', tie: 'preserve' },
});

test('retained selector excludes blocked candidates, rejects missing measurements, and preserves tied extrema', () => {
  const subject = { mechanisms: { pursuitSelector: selector('maximize') } };
  const wagers = [
    { id: 'low', selection: { measurements: { 'decision-ready-signal': 1 } } },
    { id: 'high-a', selection: { measurements: { 'decision-ready-signal': 4 } } },
    { id: 'high-b', selection: { measurements: { 'decision-ready-signal': 4 } } },
    { id: 'blocked', selection: { blocked: true, measurements: { 'decision-ready-signal': 100 } } },
  ];
  const result = selectWagers(subject, wagers);
  assert.equal(result.mode, 'subject-selector');
  assert.deepEqual(result.selectedIds, ['high-a', 'high-b']);
  assert.equal(result.candidates.find(value => value.id === 'blocked').disposition, 'excluded-blocked');

  const missing = selectWagers(subject, [...wagers, { id: 'missing', selection: { measurements: {} } }]);
  assert.deepEqual(missing.selectedIds, []);
  assert.match(missing.reasons.join('\n'), /missing selector measurement decision-ready-signal/);
});

test('new subjects inherit the disclosed Pareto selector, which removes domination without collapsing real tradeoffs', () => {
  const subject = createSubject({}, new Date().toISOString());
  assert.equal(subject.mechanisms.pursuitSelector.id, 'music-default-developmental-pareto-1');
  const wagers = [
    { id: 'grounded-expansion', selection: { measurements: defaultSelectionMeasurements({
      'demonstrated-harm-reduction': 0.8, 'world-grounding': 0.9, 'affordance-expansion': 0.8,
      'information-gain': 0.8, reversibility: 0.8, cost: 0.3, 'redundancy-saturation': 0.2,
    }) } },
    { id: 'dominated-repeat', selection: { measurements: defaultSelectionMeasurements({
      'demonstrated-harm-reduction': 0.4, 'world-grounding': 0.7, 'affordance-expansion': 0.3,
      'information-gain': 0.4, reversibility: 0.6, cost: 0.6, 'redundancy-saturation': 0.8,
    }) } },
    { id: 'cheap-reversible-probe', selection: { measurements: defaultSelectionMeasurements({
      'demonstrated-harm-reduction': 0.2, 'world-grounding': 0.8, 'affordance-expansion': 0.4,
      'information-gain': 0.7, reversibility: 1, cost: 0.05, 'redundancy-saturation': 0.1,
    }) } },
  ];
  const result = selectWagers(subject, wagers);
  assert.equal(result.selector.format, 'music-v3-pareto-pursuit-selector-1');
  assert.deepEqual(result.selectedIds, ['grounded-expansion', 'cheap-reversible-probe']);
  assert.equal(result.candidates.find(value => value.id === 'dominated-repeat').disposition, 'not-selected');

  const outside = selectWagers(subject, [{ id: 'unbounded', selection: { measurements: defaultSelectionMeasurements({ cost: 2 }) } }]);
  assert.deepEqual(outside.selectedIds, []);
  assert.match(outside.reasons.join('\n'), /cost is outside \[0, 1\]/);
});

test('one subject installs, uses, corrects, and reuses executable selection machinery across independent consequence', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v3-selector-recurrence-'));
  const root = join(parent, 'run');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const contacts = [];
  const world = defineWorld({
    id: 'selector-world', version: '1', description: 'Independently returns the consequence assigned to one bound pursuit.', effects: [],
    attestationTypes: ['selector.result'],
    identityMaterial: { outcomes: { install: true, high: false, low: true } },
    publicContract: { input: { pursuit: 'install|high|low' }, output: { pursuit: 'string', passed: 'boolean' } },
    conform: input => input && ['install', 'high', 'low'].includes(input.pursuit) ? [] : ['known pursuit required'],
    conformOutput: output => output && typeof output.pursuit === 'string' && typeof output.passed === 'boolean' ? [] : ['pursuit and passed required'],
    attest: (_input, output) => [{ type: 'selector.result', value: output }],
    async execute(input) {
      contacts.push(input.pursuit);
      return { pursuit: input.pursuit, passed: { install: true, high: false, low: true }[input.pursuit] };
    },
  });
  const worlds = new WorldRegistry([world]);
  const continuation = (focus, kind = 'continue') => ({ kind, focus, notBefore: null });
  const predicate = {
    support: { op: 'eq', path: '/output/passed', value: true },
    contradiction: { op: 'eq', path: '/output/passed', value: false },
  };
  const witnesses = {
    support: { output: { pursuit: 'example', passed: true } },
    contradiction: { output: { pursuit: 'example', passed: false } },
  };
  const wager = ({ id, pursuit, selection, continuations, scope }) => ({
    id,
    stake: { id: 'selector-development', question: `What follows from ${pursuit}?` },
    contact: { world: 'selector-contact', input: { pursuit } },
    bearing: { attestationTypes: ['selector.result'], interpretation: `The selector result bears on ${pursuit}.` },
    predicates: predicate,
    witnesses,
    continuations,
    revisionScope: scope,
    retainedFloorIds: [],
    effectRequirements: [],
    ...(selection ? { selection } : {}),
  });
  const install = wager({
    id: 'install-selector', pursuit: 'install', scope: ['/mechanisms'],
    selection: { measurements: defaultSelectionMeasurements() },
    continuations: { support: { set: { '/mechanisms/pursuitSelector': selector('maximize') }, remove: [], continuation: continuation('Let the installed selector shape the next frontier.') } },
  });
  const high = wager({
    id: 'pursue-high', pursuit: 'high', selection: { measurements: { ...defaultSelectionMeasurements(), 'decision-ready-signal': 9 } }, scope: ['/mechanisms'],
    continuations: {
      support: { set: {}, remove: [], continuation: continuation('Retain the selector after supporting consequence.') },
      contradiction: { set: { '/mechanisms/pursuitSelector': selector('minimize') }, remove: [], continuation: continuation('Use the consequence-corrected selector on a fresh frontier.') },
    },
  });
  const low = wager({
    id: 'pursue-low', pursuit: 'low', selection: { measurements: { ...defaultSelectionMeasurements(), 'decision-ready-signal': 2 } }, scope: ['/memory'],
    continuations: { support: { set: { '/memory/selectorRecurrence': 'complete' }, remove: [], continuation: continuation('Selector recurrence complete.', 'stop') } },
  });
  const plans = {
    '0:orient': { summary: 'Install a falsifiable pursuit selector.', liveStakes: ['selector-development'], recommendedNext: 'Install selector.' },
    '0:challenge': { wagers: [install] },
    '0:elect': { wagerId: 'install-selector', rationale: 'Only admitted wager.' },
    '1:orient': { summary: 'Apply the installed selector.', liveStakes: ['selector-development'], recommendedNext: 'Transform the frontier.' },
    '1:challenge': { wagers: [low, high] },
    '1:elect': { wagerId: 'pursue-high', rationale: 'The retained maximizing selector selected high.' },
    '2:orient': { summary: 'Apply the corrected selector.', liveStakes: ['selector-development'], recommendedNext: 'Transform the new frontier.' },
    '2:challenge': { wagers: [high, low] },
    '2:elect': { wagerId: 'pursue-low', rationale: 'The retained minimizing selector selected low.' },
  };
  const actor = new ScriptActor(plans, { id: 'selector-recurrence-actor' });
  const spec = {
    format: 'music-v3-run-spec-1', id: 'selector-recurrence', title: 'Selector recurrence',
    hypothesis: 'Consequence-corrected subject machinery changes later contact.',
    cheapestFalsifier: 'A later election escapes the retained selector or correction does not change contact.',
    actor: actor.describe(),
    worlds: [{ id: 'selector-contact', adapter: world.id, adapterIdentity: worlds.get(world.id).identity, attestationTypes: worlds.get(world.id).attestationTypes, description: world.description, publicContract: world.publicContract }],
    grants: [], initialSubject: {}, conditions: [{ id: 'active', interventions: [] }],
    limits: { maxCycles: 3, maxActorCalls: 12 }, stoppingRule: 'Stop after three complete contacts.',
  };
  const kernel = new DevelopmentalKernel(root, { actor, worlds });
  kernel.initialize(spec);
  const state = await kernel.run();

  assert.deepEqual(contacts, ['install', 'high', 'low']);
  assert.equal(state.subject.generation, 3);
  assert.equal(state.subject.mechanisms.pursuitSelector.dimension.direction, 'minimize');
  assert.equal(state.subject.memory.selectorRecurrence, 'complete');
  assert.deepEqual(state.cycles.map(cycle => kernel.store.get(cycle.frontier).selection.selectedIds), [
    ['install-selector'], ['pursue-high'], ['pursue-low'],
  ]);
  assert.equal(kernel.store.get(state.cycles[1].frontier).selection.mode, 'subject-selector');
  const generationTwoChallenge = state.invocations.find(value => value.role === 'challenge' && value.status === 'completed' && kernel.store.get(value.projection).subject.generation === 2);
  assert.deepEqual(kernel.store.get(generationTwoChallenge.projection).history.at(-1).selection.selectedIds, ['pursue-high']);
});

test('subject identity rejects malformed selector machinery at creation', () => {
  assert.throws(() => createSubject({ mechanisms: { pursuitSelector: { format: 'invented' } } }, new Date().toISOString()), /invalid pursuitSelector/);
});

test('independent contradiction can surrender the selector and reopen actor election', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v3-selector-surrender-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const contacts = [];
  const world = defineWorld({
    id: 'surrender-world', version: '1', description: 'Contradict the selected pursuit, then retain later contact.', effects: [],
    attestationTypes: ['surrender.result'],
    identityMaterial: { implementation: 'surrender-world-v1' },
    publicContract: { input: { pursuit: 'string' }, output: { passed: 'boolean' } },
    conform: input => input && ['selected', 'free-a', 'free-b'].includes(input.pursuit) ? [] : ['known pursuit required'],
    conformOutput: output => output && typeof output.passed === 'boolean' ? [] : ['passed required'],
    attest: (_input, output) => [{ type: 'surrender.result', value: output }],
    async execute(input) { contacts.push(input.pursuit); return { passed: input.pursuit !== 'selected' }; },
  });
  const worlds = new WorldRegistry([world]);
  const make = (id, measurement, continuation) => ({
    id, stake: { id: 'selector-surrender', question: `What follows from ${id}?` },
    contact: { world: 'surrender', input: { pursuit: id } },
    bearing: { attestationTypes: ['surrender.result'], interpretation: `The surrender result bears on ${id}.` },
    predicates: { support: { op: 'eq', path: '/output/passed', value: true }, contradiction: { op: 'eq', path: '/output/passed', value: false } },
    witnesses: { support: { output: { passed: true } }, contradiction: { output: { passed: false } } },
    continuations: continuation,
    revisionScope: id === 'selected' ? ['/mechanisms/pursuitSelector'] : ['/memory'], retainedFloorIds: [], effectRequirements: [],
    selection: { measurements: { 'decision-ready-signal': measurement } },
  });
  const surrender = make('selected', 9, {
    contradiction: { set: {}, remove: ['/mechanisms/pursuitSelector'], continuation: { kind: 'continue', focus: 'Test the next frontier without the surrendered selector.', notBefore: null } },
  });
  const plans = {
    '0:orient': { summary: 'Test retained selector.', liveStakes: ['selector-surrender'], recommendedNext: 'Bind selected pursuit.' },
    '0:challenge': { wagers: [make('free-a', 1, {}), surrender] },
    '0:elect': { wagerId: 'selected', rationale: 'Selector chose it.' },
    '1:orient': { summary: 'Selector was surrendered.', liveStakes: ['selector-surrender'], recommendedNext: 'Exercise actor election.' },
    '1:challenge': { wagers: [
      make('free-a', 1, { support: { set: { '/memory/afterSurrender': 'a' }, remove: [], continuation: { kind: 'stop', focus: 'Observed.', notBefore: null } } }),
      make('free-b', 9, { support: { set: { '/memory/afterSurrender': 'b' }, remove: [], continuation: { kind: 'stop', focus: 'Observed.', notBefore: null } } }),
    ] },
    '1:elect': { wagerId: 'free-a', rationale: 'Actor election is open again.' },
  };
  const actor = new ScriptActor(plans, { id: 'selector-surrender-actor' });
  const spec = {
    format: 'music-v3-run-spec-1', id: 'selector-surrender', title: 'Selector surrender',
    hypothesis: 'Independent contradiction can surrender selector machinery.', cheapestFalsifier: 'The next frontier remains selector-constrained.',
    actor: actor.describe(), worlds: [{ id: 'surrender', adapter: world.id, adapterIdentity: worlds.get(world.id).identity, attestationTypes: worlds.get(world.id).attestationTypes, description: world.description, publicContract: world.publicContract }],
    grants: [], initialSubject: { mechanisms: { pursuitSelector: selector('maximize') } }, conditions: [{ id: 'active', interventions: [] }],
    limits: { maxCycles: 2, maxActorCalls: 8 }, stoppingRule: 'Stop after actor election reopens.',
  };
  const kernel = new DevelopmentalKernel(join(parent, 'run'), { actor, worlds });
  kernel.initialize(spec);
  const state = await kernel.run();
  assert.deepEqual(contacts, ['selected', 'free-a']);
  assert.equal(state.subject.mechanisms.pursuitSelector, undefined);
  assert.equal(state.subject.memory.afterSurrender, 'a');
  assert.equal(kernel.store.get(state.cycles[1].frontier).selection.mode, 'actor-election');
  assert.deepEqual(kernel.store.get(state.cycles[1].frontier).selection.selectedIds, ['free-a', 'free-b']);
  const secondProjection = state.invocations.find(value => value.role === 'challenge' && value.cycleId === state.cycles[1].id && value.status === 'completed');
  assert.equal(kernel.store.get(secondProjection.projection).developmentalInterfaces.pursuitSelector.subjectPath, '/mechanisms/pursuitSelector');
});

test('a matched projection erasure removes selector influence without rewriting either subject', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v3-selector-control-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const contacts = [];
  const world = defineWorld({
    id: 'choice-world', version: '1', description: 'Retain which independently bound pursuit reached contact.', effects: [],
    attestationTypes: ['choice.result'],
    identityMaterial: { implementation: 'choice-world-v1' },
    publicContract: { input: { pursuit: 'string' }, output: { pursuit: 'string', passed: 'boolean' } },
    conform: input => input && ['low', 'high'].includes(input.pursuit) ? [] : ['known pursuit required'],
    conformOutput: output => output && typeof output.pursuit === 'string' && typeof output.passed === 'boolean' ? [] : ['pursuit and Boolean passed required'],
    attest: (_input, output) => [{ type: 'choice.result', value: output }],
    async execute(input) { contacts.push(input.pursuit); return { pursuit: input.pursuit, passed: true }; },
  });
  const worlds = new WorldRegistry([world]);
  const makeWager = (id, measurement) => ({
    id: `choose-${id}`, stake: { id: 'choice', question: `Choose ${id}?` },
    contact: { world: 'choice', input: { pursuit: id } },
    bearing: { attestationTypes: ['choice.result'], interpretation: `The choice result bears on ${id}.` },
    predicates: { support: { op: 'eq', path: '/output/passed', value: true }, contradiction: { op: 'eq', path: '/output/passed', value: false } },
    witnesses: { support: { output: { pursuit: id, passed: true } }, contradiction: { output: { pursuit: id, passed: false } } },
    continuations: { support: { set: { '/memory/chosen': id }, remove: [], continuation: { kind: 'stop', focus: 'Choice observed.', notBefore: null } } },
    revisionScope: ['/memory'], retainedFloorIds: [], effectRequirements: [],
    selection: { measurements: { 'decision-ready-signal': measurement } },
  });
  const low = makeWager('low', 1);
  const high = makeWager('high', 9);
  const actor = new FunctionActor(async ({ role, projection }) => {
    if (role === 'orient') return { summary: 'Choose from the same frontier.', liveStakes: ['choice'], recommendedNext: 'Bind one contact.' };
    if (role === 'challenge') return { wagers: [low, high] };
    if (role === 'elect') return { wagerId: projection.frontier.selection.selectedIds[0], rationale: 'Select the first candidate left by the decision interface.' };
    throw new Error(`unexpected role: ${role}`);
  }, { id: 'matched-selector-actor' });
  const spec = {
    format: 'music-v3-run-spec-1', id: 'selector-erasure-control', title: 'Selector erasure control',
    hypothesis: 'The retained selector changes which same-frontier pursuit reaches contact.',
    cheapestFalsifier: 'Active and erased decision interfaces bind the same pursuit.', actor: actor.describe(),
    worlds: [{ id: 'choice', adapter: world.id, adapterIdentity: worlds.get(world.id).identity, attestationTypes: worlds.get(world.id).attestationTypes, description: world.description, publicContract: world.publicContract }],
    grants: [], initialSubject: { mechanisms: { pursuitSelector: selector('maximize') } },
    conditions: [
      { id: 'active', interventions: [] },
      { id: 'selector-erased', interventions: [{ generation: 0, erase: ['/subject/mechanisms/pursuitSelector'], replace: {} }] },
    ],
    limits: { maxCycles: 1, maxActorCalls: 4 }, stoppingRule: 'Stop after one contact.',
  };
  const reports = [];
  for (const condition of ['active', 'selector-erased']) {
    const kernel = new DevelopmentalKernel(join(parent, condition), { actor, worlds });
    kernel.initialize(spec, { condition });
    const state = await kernel.run();
    reports.push({ condition, kernel, state });
  }
  const active = reports[0];
  const erased = reports[1];
  assert.equal(active.state.subject.memory.chosen, 'high');
  assert.equal(erased.state.subject.memory.chosen, 'low');
  assert.deepEqual(contacts, ['high', 'low']);
  assert.deepEqual(active.kernel.store.get(active.state.cycles[0].frontier).selection.selectedIds, ['choose-high']);
  assert.deepEqual(erased.kernel.store.get(erased.state.cycles[0].frontier).selection.selectedIds, ['choose-low', 'choose-high']);
  assert.equal(erased.kernel.store.get(erased.state.cycles[0].frontier).selection.mode, 'actor-election');
  assert.equal(erased.state.subject.mechanisms.pursuitSelector.dimension.direction, 'maximize');
});
