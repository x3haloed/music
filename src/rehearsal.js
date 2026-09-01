import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FunctionActor } from './actor.js';
import { digest } from './canonical.js';
import { defaultSelectionMeasurements } from './selector.js';
import { runExperiment } from './experiment.js';
import { defineWorld, WorldRegistry } from './world.js';

export async function runRehearsal(root, { preserve = true } = {}) {
  if (existsSync(root)) throw new Error(`rehearsal target already exists: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const { worlds, spec, plans } = rehearsalFixture();
  try {
    return await runExperiment(root, spec, {
      worlds,
      actorFactory: () => rehearsalActor(plans),
    });
  } catch (error) {
    if (!preserve) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function rehearsalActor(plans) {
  return new FunctionActor(({ role, projection }) => {
    const erased = projection.subject.generation >= 2 && projection.subject.mechanisms.allocation === undefined;
    const selected = erased ? plans['mechanism-erased'] : plans.active;
    const key = `${projection.subject.generation}:${role}`;
    if (!Object.hasOwn(selected, key)) throw new Error(`rehearsal actor has no output for ${key}`);
    return selected[key];
  }, { id: 'rehearsal-actor', model: null, identityMaterial: plans });
}

export function rehearsalFixture() {
  const memory = new Map();
  const idempotent = (name, calculate) => defineWorld({
    id: name,
    version: '1',
    description: name === 'allocation-world'
      ? 'Score a resource-allocation policy under an independently selected regime.'
      : 'Evaluate a set-valued mechanism against an independently supplied distinction.',
    effects: [],
    attestationTypes: [`${name}.result`],
    identityMaterial: name === 'allocation-world'
      ? { oracle: 'normal-balanced-9-shifted-balanced-5-constraint-aware-9' }
      : { oracle: 'three-hidden-contactable-minus-blocked-cases-v1' },
    publicContract: name === 'allocation-world'
      ? { input: { policy: 'string', regime: 'normal|shifted' }, output: { score: '0..10', passed: 'boolean' } }
      : { input: { program: 'set-expression AST', source: 'contactable-distinction' }, output: { score: '0..10', passed: 'boolean', rows: 'hidden case results' } },
    conform(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
      if (name === 'allocation-world') {
        return typeof input.policy === 'string' && ['normal', 'shifted'].includes(input.regime) ? [] : ['policy and valid regime are required'];
      }
      return validProgram(input.program) && typeof input.source === 'string' ? [] : ['valid program and source are required'];
    },
    conformOutput(output) {
      return output && typeof output === 'object' && Number.isFinite(output.score) && typeof output.passed === 'boolean'
        ? [] : ['output must contain finite score and Boolean passed'];
    },
    attest: (_input, output) => [{ type: `${name}.result`, value: output }],
    async execute(input, context) {
      const key = `${name}:${context.idempotencyKey}`;
      if (!memory.has(key)) memory.set(key, calculate(input));
      return memory.get(key);
    },
  });
  const allocation = idempotent('allocation-world', input => {
    const scores = {
      normal: { balanced: 9, base: 4, 'constraint-aware': 8 },
      shifted: { balanced: 5, base: 3, 'constraint-aware': 9 },
    };
    const score = scores[input.regime][input.policy] ?? 0;
    return { kind: 'allocation-result', regime: input.regime, policy: input.policy, score, passed: score >= 8 };
  });
  const setWorld = idempotent('set-world', input => {
    const cases = [
      { options: ['a', 'b', 'c'], contactable: ['a', 'c'], blocked: ['c'] },
      { options: ['d', 'e', 'f'], contactable: ['d', 'e'], blocked: [] },
      { options: ['g', 'h', 'i'], contactable: ['g', 'h', 'i'], blocked: ['g', 'i'] },
    ];
    const rows = cases.map(value => {
      const actual = evaluateSetProgram(input.program, value);
      const expected = value.contactable.filter(member => !value.blocked.includes(member));
      return { actual, expected, passed: JSON.stringify(actual) === JSON.stringify(expected) };
    });
    const passed = input.source === 'contactable-distinction' && rows.every(row => row.passed);
    return { kind: 'set-result', source: input.source, rows, score: passed ? 10 : 0, passed };
  });
  const worlds = new WorldRegistry([allocation, setWorld]);
  const plans = { active: plan(false), 'mechanism-erased': plan(true) };
  const actor = rehearsalActor(plans);
  const spec = {
    format: 'music-v3-run-spec-1',
    id: 'final-harness-rehearsal',
    title: 'Multi-world developmental recurrence rehearsal',
    hypothesis: 'One unchanged kernel can carry exact subject-selected contact, contradiction repair, cross-world target-language expansion, and later direct use without a researcher-written phase bridge.',
    cheapestFalsifier: 'Either condition fails to complete its prospectively scripted path, any adapter effect is repeated under one key, a fresh invocation inherits a response chain, or an inherited floor is lost.',
    actor: actor.describe(),
    worlds: [allocation, setWorld].map(adapter => ({
      id: adapter.id === 'allocation-world' ? 'allocation' : 'set-contact',
      adapter: adapter.id,
      adapterIdentity: worlds.get(adapter.id).identity,
      attestationTypes: worlds.get(adapter.id).attestationTypes,
      description: adapter.description,
      publicContract: adapter.publicContract,
    })),
    grants: [],
    initialSubject: {
      stakes: { current: { id: 'allocation-quality', status: 'open' } },
      mechanisms: { base: 'stable' },
      language: { sources: ['outcome', 'options', 'blocked'] },
      authority: {},
      memory: {},
      floors: [{
        id: 'base-stability',
        scope: '/mechanisms',
        predicate: { op: 'eq', path: '/mechanisms/base', value: 'stable' },
        earnedBy: 'rehearsal-genesis',
      }],
      continuation: { kind: 'continue', focus: 'Find a policy that improves normal allocation.', notBefore: null },
    },
    conditions: [
      { id: 'active', interventions: [] },
      { id: 'mechanism-erased', interventions: [{ generation: 2, erase: ['/subject/mechanisms/allocation'], replace: {} }] },
    ],
    limits: { maxCycles: 4, maxActorCalls: 16 },
    stoppingRule: 'Stop when the subject closes its fourth cycle or after four cycles, whichever comes first.',
  };
  return { worlds, spec, plans };
}

function plan(control) {
  const baseFloor = ['base-stability'];
  const next = focus => ({ kind: 'continue', focus, notBefore: null });
  const stop = focus => ({ kind: 'stop', focus, notBefore: null });
  const orientation = focus => ({ summary: focus, liveStakes: ['allocation-quality'], recommendedNext: focus });
  const classifyScore = {
    support: { op: 'gte', path: '/output/score', value: 8 },
    contradiction: { op: 'lt', path: '/output/score', value: 4 },
  };
  const wager = ({ id, world, input, predicates, supportWitness, contradictionWitness, continuations, scope, floors }) => ({
    id,
    stake: { id: 'allocation-quality', question: `What consequence follows ${id}?` },
    contact: { world, input },
    bearing: { attestationTypes: [world === 'allocation' ? 'allocation-world.result' : 'set-world.result'], interpretation: `The ${world} result bears on ${id}.` },
    predicates,
    witnesses: { support: { output: supportWitness }, contradiction: { output: contradictionWitness } },
    continuations,
    revisionScope: scope,
    retainedFloorIds: floors,
    effectRequirements: [],
    selection: { measurements: defaultSelectionMeasurements() },
  });
  const normal = wager({
    id: 'install-balanced', world: 'allocation', input: { policy: 'balanced', regime: 'normal' }, predicates: classifyScore,
    supportWitness: { score: 9, passed: true }, contradictionWitness: { score: 2, passed: false },
    continuations: { support: { set: { '/mechanisms/allocation': 'balanced' }, remove: [], continuation: next('Test whether balanced allocation survives a shifted regime.') } },
    scope: ['/mechanisms'], floors: baseFloor,
  });
  const shifted = wager({
    id: 'challenge-balanced', world: 'allocation', input: { policy: 'balanced', regime: 'shifted' }, predicates: classifyScore,
    supportWitness: { score: 9, passed: true }, contradictionWitness: { score: 2, passed: false }, continuations: {}, scope: ['/mechanisms'], floors: baseFloor,
  });
  const transferPassed = !control;
  const contactableProgram = transferPassed
    ? { op: 'difference', left: { op: 'source', name: 'contactable' }, right: { op: 'source', name: 'blocked' } }
    : { op: 'source', name: 'options' };
  const transfer = wager({
    id: 'cross-world-distinction', world: 'set-contact',
    input: { program: contactableProgram, source: 'contactable-distinction' },
    predicates: { support: { op: 'eq', path: '/output/passed', value: true }, contradiction: { op: 'eq', path: '/output/passed', value: false } },
    supportWitness: { score: 10, passed: true }, contradictionWitness: { score: 0, passed: false },
    continuations: transferPassed ? {
      support: { set: {
        '/language/contactable-distinction': { kind: 'set-source', expression: 'source - blocked' },
        '/mechanisms/contactable': contactableProgram,
      }, remove: [], continuation: next('Use the exact installed program against fresh set contact.') },
    } : {
      contradiction: { set: { '/memory/control_result': 'mechanism authority absent' }, remove: [], continuation: stop('The erased branch cannot transfer the mechanism.') },
    },
    scope: transferPassed ? ['/language', '/mechanisms'] : ['/memory'], floors: transferPassed ? baseFloor : [],
  });
  const directUse = wager({
    id: 'use-authored-distinction', world: 'set-contact', input: { source: 'contactable-distinction' },
    predicates: { support: { op: 'eq', path: '/output/passed', value: true }, contradiction: { op: 'eq', path: '/output/passed', value: false } },
    supportWitness: { score: 10, passed: true }, contradictionWitness: { score: 0, passed: false },
    continuations: {
      support: { set: { '/memory/rehearsal': 'complete' }, remove: [], continuation: stop('The bounded rehearsal is complete.') },
      contradiction: { set: { '/memory/rehearsal': 'failed' }, remove: [], continuation: stop('The authored distinction failed direct use.') },
    }, scope: ['/memory'], floors: [],
  });
  directUse.contact.mechanism = { subjectPath: '/mechanisms/contactable', inputKey: 'program' };
  const plans = {};
  const add = (generation, focus, candidate, assimilation = null) => {
    plans[`${generation}:orient`] = orientation(focus);
    plans[`${generation}:challenge`] = { wagers: [candidate] };
    plans[`${generation}:elect`] = { wagerId: candidate.id, rationale: 'Select the only admitted consequence-bearing wager.' };
    if (assimilation) plans[`${generation}:assimilate`] = assimilation;
  };
  add(0, 'Test balanced allocation.', normal);
  add(1, 'Challenge the installed policy under regime shift.', shifted, {
    rationale: 'The score is neither support nor decisive failure; retain the mismatch and install the constraint-aware correction.',
    transition: { set: { '/mechanisms/allocation': 'constraint-aware' }, remove: [], continuation: next('Transfer the corrected distinction into a different world family.') },
  });
  add(2, 'Test cross-world use.', transfer);
  if (!control) add(3, 'Use the subject-authored source directly.', directUse);
  return plans;
}

function validProgram(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return false;
  if (value.op === 'source') return ['options', 'contactable', 'blocked'].includes(value.name);
  if (!['difference', 'union', 'intersection'].includes(value.op)) return false;
  return validProgram(value.left, depth + 1) && validProgram(value.right, depth + 1);
}

function evaluateSetProgram(program, sources) {
  if (program.op === 'source') return [...sources[program.name]].sort();
  const left = evaluateSetProgram(program.left, sources);
  const right = evaluateSetProgram(program.right, sources);
  if (program.op === 'difference') return left.filter(value => !right.includes(value)).sort();
  if (program.op === 'intersection') return left.filter(value => right.includes(value)).sort();
  return [...new Set([...left, ...right])].sort();
}

export function rehearsalDigest() {
  const { spec } = rehearsalFixture();
  return digest(spec);
}
