import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FunctionActor } from '../src/actor.js';
import { DevelopmentalKernel } from '../src/kernel.js';
import { deriveOperation, projectOpportunities } from '../src/operation.js';
import { advanceSubject } from '../src/subject.js';
import { WorldRegistry, defineWorld } from '../src/world.js';

test('one exact subject traverses select, realize, deterministic contact, and consequence assimilation', async () => {
  const fixture = harness({
    outputs: {
      select: [selection()],
      realize: [realization('support')],
      assimilate: [judgment('retire', { set: { '/memory/echo': 'established' } })],
    },
  });
  const genesis = fixture.kernel.initialize(fixture.spec).subject;

  await fixture.kernel.advance();
  assert.equal(fixture.kernel.state().subject.succession, 1);
  assert.equal(fixture.kernel.state().subject.revision, 0);
  assert.equal(fixture.kernel.state().operation.operation, 'realize');

  await fixture.kernel.advance();
  assert.equal(fixture.kernel.state().operation.operation, 'contact');
  await fixture.kernel.advance();
  assert.equal(fixture.calls.execute, 1);
  assert.equal(fixture.kernel.state().operation.operation, 'assimilate');
  assert.equal(fixture.kernel.state().subject.revision, 0);

  await fixture.kernel.advance();
  const state = fixture.kernel.state();
  assert.equal(state.subject.revision, 1);
  assert.equal(state.subject.memory.echo, 'established');
  assert.equal(state.subject.opportunities['world:primary'].standing, 'completed');
  assert.equal(state.operation.operation, 'expand');
  assert.equal(state.subject.parent === genesis.id, false);
  assert.deepEqual(state.invocations.filter(value => value.status === 'completed').map(value => value.role), ['select', 'realize', 'assimilate']);
  assert.equal(new Set(state.invocations.map(value => value.contextId).filter(Boolean)).size, 3);
  assert.ok(state.invocations.every(value => value.responseChain === null && value.workspaceContinuity === null));
});

test('contradiction can revise the operation selector and changes a later route', async () => {
  const revised = {
    format: 'music-v4-operation-selector-1', version: 2,
    consequenceRoutes: { support: 'assimilate', contradiction: 'assimilate', inconclusive: 'assimilate', failure: 'correct' },
    sourcePriority: ['observation', 'unresolved', 'subject', 'world'],
    projectionLimit: 16, expansionLimit: 2, waitMs: 300_000,
  };
  const fixture = harness({ outputs: {
    select: [selection(['/organs/operationSelector'])],
    realize: [realization('contradiction'), realization('contradiction')],
    correct: [judgment('retry', { set: { '/organs/operationSelector': revised } })],
    assimilate: [judgment('surrender')],
  } });
  fixture.kernel.initialize(fixture.spec);

  await steps(fixture.kernel, 3);
  assert.equal(fixture.kernel.state().operation.operation, 'correct');
  await fixture.kernel.advance();
  assert.equal(fixture.kernel.state().subject.organs.operationSelector.version, 2);
  assert.equal(fixture.kernel.state().subject.revision, 1);
  await steps(fixture.kernel, 2);
  assert.equal(fixture.kernel.state().subject.active.consequence.classification, 'contradiction');
  assert.equal(fixture.kernel.state().operation.operation, 'assimilate');
  await fixture.kernel.advance();
  assert.equal(fixture.kernel.state().subject.revision, 2);
  assert.equal(fixture.kernel.state().subject.opportunities['world:primary'].standing, 'surrendered');
});

test('opportunity projection is compact, deterministic, and explicitly non-authoritative', () => {
  const fixture = harness();
  const subject = fixture.kernel.initialize(fixture.spec).subject;
  const projection = projectOpportunities(subject);
  assert.equal(deriveOperation(subject).operation, 'select');
  assert.equal(projection.totalOpen, 1);
  assert.deepEqual(projection.authority, { target: false, contact: false, outcome: false, admission: false });
  assert.equal(projection.opportunities[0].id, 'world:primary');
});

test('ordinary observations become world-data opportunities and preempt waiting', async () => {
  const fixture = harness({ outputs: { expand: [{ opportunities: [], wait: futureWait(), rationale: 'No honest expansion yet.' }] } });
  fixture.kernel.initialize({ ...fixture.spec, initialSubject: {}, worlds: fixture.spec.worlds });
  const subject = fixture.kernel.state().subject;
  const opportunities = structuredClone(subject.opportunities);
  opportunities['world:primary'].standing = 'completed';
  const closed = advanceSubject(subject, { developmental: false, opportunities }, new Date().toISOString());
  // Reach the same position through a valid expansion path rather than mutating retained state.
  fixture.kernel.store.append('subject.advanced', {
    operationId: 'fixture', operation: 'fixture', developmental: false, priorSubjectId: subject.id,
    subject: fixture.kernel.store.put(closed), classification: null, disposition: null, evidence: null,
  });
  await fixture.kernel.advance();
  assert.equal(fixture.kernel.state().operation.operation, 'expand');
  fixture.kernel.receiveObservation({ id: 'hello', channel: 'operator', from: 'Chad', content: { message: 'Hello.' } });
  fixture.kernel.materializeObservations(fixture.kernel.state());
  const state = fixture.kernel.state();
  const opportunity = Object.values(state.subject.opportunities).find(value => value.source.kind === 'observation');
  assert.ok(opportunity);
  assert.match(opportunity.description, /Chad.*Hello/);
  assert.equal(state.operation.operation, 'select');
});

test('an interrupted bound contact reuses its exact idempotency identity after restart', async () => {
  const seen = [];
  const fixture = harness({
    outputs: { select: [selection()], realize: [realization('support')] },
    execute: async (input, context) => { seen.push(context.idempotencyKey); return input; },
  });
  fixture.kernel.initialize(fixture.spec);
  await steps(fixture.kernel, 2);
  const state = fixture.kernel.state();
  const active = state.subject.active;
  const input = fixture.kernel.store.put(active.realization.input);
  fixture.kernel.store.append('contact.started', {
    operationId: 'interrupted', binding: active.binding, world: 'primary', adapter: 'echo',
    adapterIdentity: fixture.worlds.get('echo').identity, input, idempotencyKey: 'retained-key',
  });
  const restarted = new DevelopmentalKernel(fixture.root, { actor: fixture.actor, worlds: fixture.worlds });
  await restarted.advance();
  assert.deepEqual(seen, ['retained-key']);
  assert.equal(restarted.state().subject.active.consequence.classification, 'support');
});

test('snapshots retain and identify subject-authored workspace embodiment', t => {
  const fixture = harness();
  fixture.kernel.initialize(fixture.spec);
  mkdirSync(join(fixture.root, 'workspace', 'tools'), { recursive: true });
  writeFileSync(join(fixture.root, 'workspace', 'tools', 'learned-tool.js'), 'export default 42;\n');
  const destination = join(mkdtempSync(join(tmpdir(), 'music-v4-snapshot-')), 'snapshot');
  const manifest = fixture.kernel.snapshot(destination);
  assert.equal(existsSync(join(destination, 'workspace', 'tools', 'learned-tool.js')), true);
  assert.equal(readFileSync(join(destination, 'workspace', 'tools', 'learned-tool.js'), 'utf8'), 'export default 42;\n');
  assert.match(manifest.workspace.identity, /^[a-f0-9]{64}$/);
  assert.ok(manifest.workspace.entries.some(value => value.path === 'tools/learned-tool.js' && /^[a-f0-9]{64}$/.test(value.sha256)));
});

function harness({ outputs = {}, execute = async input => input } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'music-v4-kernel-')), 'run');
  const calls = { execute: 0 };
  const world = defineWorld({
    id: 'echo', version: '1', description: 'Return a bounded value.', effects: [],
    attestationTypes: ['echo.result'], publicContract: { input: { value: 'string' }, output: { value: 'string' } },
    identityMaterial: { fixture: 'v4' },
    conform: input => typeof input?.value === 'string' ? [] : ['value must be a string'],
    conformOutput: output => typeof output?.value === 'string' ? [] : ['value must be a string'],
    attest: (input, output) => [{ type: 'echo.result', value: output }],
    execute: async (input, context) => { calls.execute += 1; return execute(input, context); },
  });
  const worlds = new WorldRegistry([world]);
  const queues = Object.fromEntries(Object.entries(outputs).map(([role, values]) => [role, [...values]]));
  const actor = new FunctionActor(({ role }) => {
    const output = queues[role]?.shift();
    if (!output) throw new Error(`no fixture output for ${role}`);
    return output;
  }, { identityMaterial: Object.keys(outputs).sort() });
  const spec = {
    format: 'music-v4-run-spec-1', id: 'fixture', title: 'V4 fixture', inference: actor.describe(),
    worlds: [{ id: 'primary', adapter: 'echo', adapterIdentity: worlds.get('echo').identity, attestationTypes: ['echo.result'], description: 'Return a bounded value.', publicContract: world.publicContract }],
    grants: [], initialSubject: {},
    limits: { maxOperations: 100, maxActorCalls: 100, maxRealizationAttempts: 4, maxContactAttempts: 8, residentRetryDelayMs: 10, continuityPulseMs: 300_000, projectionHistoryEntries: 16, maximumInputTokens: 200_000, maximumInputCharacters: 900_000 },
    stoppingRule: 'Fixture controls stopping.',
  };
  const kernel = new DevelopmentalKernel(root, { actor, worlds });
  return { root, kernel, actor, worlds, spec, calls };
}

function selection(mutationSurface = ['/memory']) {
  return {
    opportunityId: 'world:primary',
    stake: { id: 'echo-stake', question: 'What does this contact establish?', successCondition: 'The value is support.', surrenderCondition: 'The contact cannot distinguish the question.', mutationSurface },
    rationale: 'This is the current standing contact.',
  };
}

function realization(value) {
  return {
    world: 'primary', input: { value },
    bearing: { attestationTypes: ['echo.result'], interpretation: 'The exact returned value bears on the stake.' },
    predicates: { support: { op: 'eq', path: '/output/value', value: 'support' }, contradiction: { op: 'eq', path: '/output/value', value: 'contradiction' } },
    witnesses: { support: { output: { value: 'support' } }, contradiction: { output: { value: 'contradiction' } } },
    effectRequirements: [],
  };
}

function judgment(disposition, mutation = { set: {}, remove: [] }) {
  return { disposition, revisedStake: null, mutation: { remove: [], ...mutation }, opportunities: [], wait: null, rationale: 'Grounded in exact consequence.' };
}

function futureWait() {
  return { reason: 'No reachable opportunity.', notBefore: new Date(Date.now() + 60_000).toISOString() };
}

async function steps(kernel, count) { for (let index = 0; index < count; index += 1) await kernel.advance(); }
