import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FunctionActor, ScriptActor } from '../src/actor.js';
import { admitWager } from '../src/constitution.js';
import { DevelopmentalKernel } from '../src/kernel.js';
import { createSubject } from '../src/subject.js';
import { defineWorld, WorldRegistry } from '../src/world.js';
import { ResidentLease } from '../src/residency.js';
import { defaultSelectionMeasurements } from '../src/selector.js';

function fixture({ execute, plan = null, maxCycles = 1 } = {}) {
  const calls = [];
  const world = defineWorld({
    id: 'probe-world', version: '1', description: 'Independent probe.', effects: [], publicContract: { input: 'object', output: '{value:number}' },
    attestationTypes: ['probe.result'],
    identityMaterial: { fixture: 'probe-world-v1' },
    conform: input => input && typeof input === 'object' ? [] : ['object required'],
    conformOutput: output => output && typeof output.value === 'number' ? [] : ['numeric value required'],
    attest: (_input, output) => [{ type: 'probe.result', value: output }],
    execute: execute ?? (async (input, context) => { calls.push(context.idempotencyKey); return { value: input.value }; }),
  });
  const worlds = new WorldRegistry([world]);
  const transition = { set: { '/memory/result': 'accepted' }, remove: [], continuation: { kind: 'stop', focus: 'Complete.', notBefore: null } };
  const wager = {
    id: 'probe', stake: { id: 'probe-stake', question: 'Is the value positive?' }, contact: { world: 'probe', input: { value: 1 } },
    bearing: { attestationTypes: ['probe.result'], interpretation: 'The independent probe result bears on whether the value is positive.' },
    predicates: { support: { op: 'gt', path: '/output/value', value: 0 }, contradiction: { op: 'lte', path: '/output/value', value: 0 } },
    witnesses: { support: { output: { value: 1 } }, contradiction: { output: { value: 0 } } }, continuations: { support: transition },
    revisionScope: ['/memory'], retainedFloorIds: [], effectRequirements: [],
    selection: { measurements: defaultSelectionMeasurements() },
  };
  const actorPlan = plan ?? {
    '0:orient': { summary: 'Probe.', liveStakes: ['probe-stake'], recommendedNext: 'Probe.' },
    '0:challenge': { wagers: [wager] },
    '0:elect': { wagerId: 'probe', rationale: 'Only wager.' },
  };
  const actor = new ScriptActor(actorPlan, { id: 'test-actor', model: null });
  const spec = {
    format: 'music-v3-run-spec-1', id: 'test-run', title: 'Test run', hypothesis: 'Exact contact changes state.', cheapestFalsifier: 'The bound contact does not change state.',
    inference: actor.describe(),
    worlds: [{ id: 'probe', adapter: world.id, adapterIdentity: worlds.get(world.id).identity, attestationTypes: worlds.get(world.id).attestationTypes, description: world.description, publicContract: world.publicContract }],
    grants: [], initialSubject: {}, conditions: [{ id: 'active', interventions: [] }], limits: { maxCycles, maxActorCalls: 8 }, stoppingRule: 'Stop after the limit.',
  };
  const parent = mkdtempSync(join(tmpdir(), 'music-v3-kernel-'));
  const root = join(parent, 'run');
  return { parent, root, calls, world, worlds, actor, spec, wager };
}

test('bound world contact changes exact state through a direct predicate transition', async t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const result = await kernel.run();
  assert.equal(result.subject.memory.result, 'accepted');
  assert.equal(result.subject.generation, 1);
  assert.equal(result.cycles[0].transition.authority, 'bound-predicate');
  assert.equal(value.calls.length, 1);
  const facts = Object.values(result.subject.facts);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].type, 'probe.result');
  assert.deepEqual(facts[0].value, { value: 1 });
  assert.equal(facts[0].world, 'probe');
  assert.equal(facts[0].receipt.sha256, result.cycles[0].contact.output.sha256);
});

test('a representation receipt cannot bear authoritative weight for a relation its world does not attest', () => {
  const value = fixture();
  const subject = createSubject({}, new Date().toISOString());
  const laundering = structuredClone(value.wager);
  laundering.stake.question = 'Does writing a sentence prove an operator received its claim?';
  laundering.bearing = {
    attestationTypes: ['operator.message.delivery-result'],
    interpretation: 'Treat the probe representation as evidence of operator delivery.',
  };
  const admission = admitWager(laundering, { subject, spec: value.spec, worlds: value.worlds });
  assert.equal(admission.admissible, false);
  assert.match(admission.reasons.join('\n'), /not attested by world probe/);
});

test('genesis cannot seed authoritative facts outside world contact', () => {
  assert.throws(
    () => createSubject({ facts: { invented: { type: 'operator.message.delivery-result' } } }, new Date().toISOString()),
    /unrecognized key|facts/i,
  );
});

test('new runs require explicit inference even though legacy ledgers remain readable', t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const legacy = structuredClone(value.spec);
  legacy.actor = {
    adapter: legacy.inference.provider,
    model: legacy.inference.model,
    adapterIdentity: legacy.inference.adapterIdentity,
    settings: legacy.inference.settings,
  };
  delete legacy.inference;
  const kernel = new DevelopmentalKernel(value.root, value);
  assert.throws(() => kernel.initialize(legacy), /explicit inference block/);
});

test('legacy world specs remain replay-readable but cannot initialize a new run without attestations', t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const legacy = structuredClone(value.spec);
  delete legacy.worlds[0].attestationTypes;
  const kernel = new DevelopmentalKernel(value.root, value);
  assert.throws(() => kernel.initialize(legacy), /new runs require at least one attestation type/);
});

test('restart after uncertain adapter failure reuses the retained idempotency key', async t => {
  const durable = new Map();
  let invocations = 0;
  let physicalEffects = 0;
  const value = fixture({
    execute: async (input, context) => {
      invocations += 1;
      if (!durable.has(context.idempotencyKey)) {
        physicalEffects += 1;
        durable.set(context.idempotencyKey, { value: input.value });
        throw new Error('process lost contact after the external effect committed');
      }
      return durable.get(context.idempotencyKey);
    },
  });
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const first = new DevelopmentalKernel(value.root, value);
  first.initialize(value.spec);
  await assert.rejects(() => first.advance(), /external effect committed/);
  const started = first.state().currentCycle.contactStarted;
  assert.ok(started.idempotencyKey);
  const restarted = new DevelopmentalKernel(value.root, value);
  const result = await restarted.run();
  assert.equal(result.subject.memory.result, 'accepted');
  assert.equal(invocations, 2);
  assert.equal(physicalEffects, 1);
  assert.equal(restarted.state().currentCycle, null);
});

test('constitution derives floor retention from the entire declared mutation surface', () => {
  const value = fixture();
  const subject = createSubject({
    mechanisms: { stable: true },
    floors: [{ id: 'stable-floor', scope: '/mechanisms', predicate: { op: 'eq', path: '/mechanisms/stable', value: true }, earnedBy: 'test' }],
  }, new Date().toISOString());
  const candidate = { ...value.wager, revisionScope: ['/mechanisms'], retainedFloorIds: [] };
  const admission = admitWager(candidate, { subject, spec: value.spec, worlds: value.worlds });
  assert.equal(admission.admissible, false);
  assert.match(admission.reasons.join('\n'), /retained floors must equal derived floors: stable-floor/);
});

test('constitution rejects predicate witnesses outside the sealed world output contract', () => {
  const value = fixture();
  const subject = createSubject({}, new Date().toISOString());
  const candidate = structuredClone(value.wager);
  candidate.witnesses.support = { output: { value: 'not-a-number' } };
  const admission = admitWager(candidate, { subject, spec: value.spec, worlds: value.worlds });
  assert.equal(admission.admissible, false);
  assert.match(admission.reasons.join('\n'), /support witness: numeric value required/);
});

test('adapter identity is part of the sealed run envelope', () => {
  const value = fixture();
  value.spec.worlds[0].adapterIdentity = '0'.repeat(64);
  const kernel = new DevelopmentalKernel(value.root, value);
  assert.throws(() => kernel.initialize(value.spec), /world adapter identity changed/);
  rmSync(value.parent, { recursive: true, force: true });
});

test('canonical actor identity ignores object-key insertion order after replay', async t => {
  const value = fixture();
  const delegate = value.actor;
  value.actor = {
    describe: () => ({ format: 'music-v3-inference-1', provider: 'ordered-test-actor', model: null, adapterIdentity: 'a'.repeat(64), settings: { zeta: 2, alpha: 1 } }),
    invoke: request => delegate.invoke(request),
  };
  value.spec.inference = value.actor.describe();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const state = await kernel.run();
  assert.equal(state.subject.generation, 1);
});

test('observer cycle limit leaves an otherwise open subject open', async t => {
  const value = fixture({ maxCycles: 1 });
  value.wager.continuations.support.continuation = { kind: 'continue', focus: 'Remain open.', notBefore: null };
  value.actor.plan['0:challenge'] = { wagers: [value.wager] };
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const state = await kernel.run();
  assert.equal(state.completed.reason, 'observer-cycle-limit');
  assert.equal(state.completed.subjectDisposition, 'open');
  assert.equal(state.subject.continuation.kind, 'continue');
});

test('invalid actor output is quarantined without advancing the subject', async t => {
  const value = fixture({ plan: { '0:orient': { malformed: true } } });
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  await assert.rejects(() => kernel.advance());
  const state = kernel.state();
  assert.equal(state.subject.generation, 0);
  const failure = state.invocations.find(event => event.status === 'failed');
  assert.equal(failure.failure.quarantined, true);
});

test('a dead writer lock is recovered but a live writer lock fails closed', () => {
  const dead = fixture();
  mkdirSync(dead.root, { recursive: true });
  writeFileSync(join(dead.root, 'writer.lock'), `${JSON.stringify({ pid: 999_999_999, createdAt: new Date().toISOString() })}\n`);
  const recovered = new DevelopmentalKernel(dead.root, dead);
  recovered.initialize(dead.spec);
  assert.equal(recovered.state().initialized, true);
  rmSync(dead.parent, { recursive: true, force: true });

  const live = fixture();
  mkdirSync(live.root, { recursive: true });
  writeFileSync(join(live.root, 'writer.lock'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  const blocked = new DevelopmentalKernel(live.root, live);
  assert.throws(() => blocked.initialize(live.spec), /another live writer/);
  rmSync(live.parent, { recursive: true, force: true });
});

test('a future subject opening is bounded by the continuity floor without early inference', async t => {
  const value = fixture();
  value.spec.initialSubject.continuation = { kind: 'continue', focus: 'Wait for contact.', notBefore: '2099-01-01T00:00:00.000Z' };
  const now = new Date('2026-09-01T00:00:00.000Z');
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, { ...value, clock: () => now });
  kernel.initialize(value.spec);
  const state = await kernel.run();
  assert.equal(state.waitingUntil, '2026-09-01T00:05:00.000Z');
  assert.equal(state.invocations.length, 0);
  assert.equal(state.completed, null);
});

test('a retained observation wakes seclusion and is projected exactly once', async t => {
  const value = fixture();
  value.spec.initialSubject.continuation = { kind: 'seclusion', focus: 'Wait for a machine-owner message.', notBefore: '2099-01-01T00:00:00.000Z' };
  const seen = [];
  const plan = value.actor.plan;
  value.actor = new FunctionActor(async ({ role, projection }) => {
    seen.push({ role, observations: projection.observations });
    return plan[`${projection.subject.generation}:${role}`];
  }, { id: 'test-actor', model: null });
  value.spec.inference = value.actor.describe();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  assert.equal((await kernel.run()).waitingForObservation, true);
  kernel.receiveObservation({ id: 'message-1', channel: 'operator', from: 'owner', content: { request: 'probe now' } });
  const state = await kernel.run();
  assert.equal(state.subject.generation, 1);
  assert.deepEqual(seen[0].observations.map(observation => observation.id), ['message-1']);
  assert.equal(state.pendingObservations.length, 0);
});

test('maximum quietness delivers an instruction-free continuity pulse through the observation path', async t => {
  const value = fixture();
  value.spec.initialSubject.continuation = { kind: 'seclusion', focus: 'Remain secluded.', notBefore: null };
  value.spec.limits.continuityPulseMs = 1_000;
  let now = Date.parse('2026-09-01T00:00:00.000Z');
  const seen = [];
  const plan = value.actor.plan;
  value.actor = new FunctionActor(async ({ role, projection }) => {
    seen.push({ role, observations: projection.observations });
    return plan[`${projection.subject.generation}:${role}`];
  }, { id: 'continuity-pulse-actor', model: null });
  value.spec.inference = value.actor.describe();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, { ...value, clock: () => new Date(now) });
  kernel.initialize(value.spec);
  let state = await kernel.run();
  assert.equal(state.waitingUntil, '2026-09-01T00:00:01.000Z');
  assert.equal(state.waitingForObservation, true);
  now += 1_000;
  state = await kernel.run();
  assert.equal(state.subject.generation, 1);
  assert.equal(state.observations.length, 1);
  assert.equal(seen[0].observations[0].channel, 'continuity');
  assert.equal(seen[0].observations[0].from, 'music');
  assert.deepEqual(seen[0].observations[0].content, { kind: 'continuity-pulse', instructions: [] });
  assert.equal(state.pendingObservations.length, 0);
});

test('machine-owner revocation blocks a bound effect and restoration resumes it', async t => {
  const value = fixture();
  value.world.effects = ['probe.execute'];
  value.worlds = new WorldRegistry([value.world]);
  value.spec.worlds[0].adapterIdentity = value.worlds.get(value.world.id).identity;
  value.spec.grants = ['probe.execute'];
  value.wager.effectRequirements = ['probe.execute'];
  let kernel;
  const plan = value.actor.plan;
  plan['0:challenge'] = { wagers: [value.wager] };
  value.actor = new FunctionActor(async ({ role, projection }) => {
    if (role === 'elect') kernel.setGrant('probe.execute', false, { reason: 'test revocation' });
    return plan[`${projection.subject.generation}:${role}`];
  }, { id: 'test-actor', model: null });
  value.spec.inference = value.actor.describe();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  let state = await kernel.run();
  assert.deepEqual(state.currentCycle.contactBlocked.missing, ['probe.execute']);
  assert.equal(value.calls.length, 0);
  kernel.setGrant('probe.execute', true, { reason: 'test restoration' });
  state = await kernel.run();
  assert.equal(state.subject.generation, 1);
  assert.equal(value.calls.length, 1);
  assert.equal(state.grantHistory.length, 2);
});

test('only one resident lease may own a run and a dead lease is recoverable', t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  mkdirSync(value.root, { recursive: true });
  const first = new ResidentLease(value.root).acquire();
  assert.throws(() => new ResidentLease(value.root).acquire(), /another live resident/);
  first.release();
  writeFileSync(join(value.root, 'resident.lock'), `${JSON.stringify({ pid: 999_999_999, acquiredAt: new Date().toISOString() })}\n`);
  const recovered = new ResidentLease(value.root).acquire();
  recovered.release();
});

test('a successor run retains exact subject identity and cross-run evidence ancestry', async t => {
  const value = fixture();
  value.wager.continuations.support.continuation = { kind: 'continue', focus: 'Continue in another sealed episode.', notBefore: null };
  value.actor.plan['0:challenge'] = { wagers: [value.wager] };
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const prior = new DevelopmentalKernel(value.root, value);
  prior.initialize(value.spec);
  const priorState = await prior.run();
  assert.equal(priorState.completed.subjectDisposition, 'open');

  const successorRoot = join(value.parent, 'successor');
  const successorSpec = structuredClone(value.spec);
  successorSpec.id = 'test-successor';
  const successorActor = new ScriptActor({}, { id: 'successor-provider', model: 'successor-model' });
  successorSpec.inference = successorActor.describe();
  successorSpec.inheritedSubjectId = priorState.subject.id;
  const successor = new DevelopmentalKernel(successorRoot, { ...value, actor: successorActor });
  const state = successor.initialize(successorSpec, {
    inheritedSubject: priorState.subject,
    predecessor: { runId: priorState.runId, head: priorState.head, subjectId: priorState.subject.id },
    predecessorStore: prior.store,
  });
  assert.equal(state.subject.id, priorState.subject.id);
  assert.equal(state.subject.generation, 1);
  assert.deepEqual(state.predecessor, { runId: priorState.runId, head: priorState.head, subjectId: priorState.subject.id });
  assert.equal(state.spec.inference.provider, 'successor-provider');
  assert.notEqual(state.spec.inference.provider, priorState.spec.inference.provider);
  assert.doesNotThrow(() => successor.store.verifyObjectGraph());
});

test('successor cycle limits count the current episode rather than lifetime generation', async t => {
  const value = fixture();
  value.wager.continuations.support.continuation = { kind: 'continue', focus: 'Continue.', notBefore: null };
  value.actor.plan['0:challenge'] = { wagers: [value.wager] };
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const prior = new DevelopmentalKernel(value.root, value);
  prior.initialize(value.spec);
  const inherited = (await prior.run()).subject;

  const successorRoot = join(value.parent, 'successor-cycle');
  const nextWager = structuredClone(value.wager);
  nextWager.continuations.support.continuation = { kind: 'seclusion', focus: 'Wait.', notBefore: null };
  const actor = new ScriptActor({
    '1:orient': { summary: 'Continue.', liveStakes: ['probe-stake'], recommendedNext: 'Probe.' },
    '1:challenge': { wagers: [nextWager] },
    '1:elect': { wagerId: 'probe', rationale: 'Only wager.' },
  }, { id: 'successor-actor' });
  const spec = structuredClone(value.spec);
  spec.id = 'successor-cycle-limit';
  spec.inference = actor.describe();
  spec.inheritedSubjectId = inherited.id;
  spec.limits.maxCycles = 1;
  const successor = new DevelopmentalKernel(successorRoot, { ...value, actor });
  successor.initialize(spec, { inheritedSubject: inherited, predecessor: { runId: 'prior', head: 'head', subjectId: inherited.id }, predecessorStore: prior.store });
  const state = await successor.run();
  assert.equal(state.subject.generation, 2);
  assert.equal(state.cycles.filter(cycle => cycle.transition).length, 1);
  assert.equal(state.completed.reason, 'observer-cycle-limit');
  assert.equal(state.hatched, null);
});

test('resident inference retries are bounded by started calls and release the lease', async t => {
  const value = fixture();
  value.spec.limits.maxActorCalls = 2;
  value.spec.limits.residentRetryDelayMs = 10;
  value.actor = new FunctionActor(async () => { throw new Error('provider unavailable'); }, { id: 'test-actor', model: null });
  value.spec.inference = value.actor.describe();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const state = await kernel.reside({ maximumSleepMs: 10 });
  assert.equal(state.completed.reason, 'actor-call-limit');
  assert.equal(state.completed.subjectDisposition, 'open');
  assert.equal(state.invocations.filter(invocation => invocation.status === 'started').length, 2);
  assert.equal(existsSync(join(value.root, 'resident.lock')), false);
});

test('resident contact retries preserve one key and stop at the frozen attempt limit', async t => {
  const keys = [];
  const value = fixture({ execute: async (_input, context) => { keys.push(context.idempotencyKey); throw new Error('uncertain transport'); } });
  value.spec.limits.maxContactAttempts = 2;
  value.spec.limits.residentRetryDelayMs = 10;
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const state = await kernel.reside({ maximumSleepMs: 10 });
  assert.equal(state.completed.reason, 'contact-attempt-limit');
  assert.equal(state.completed.subjectDisposition, 'open');
  assert.equal(state.currentCycle.contactFailures.length, 2);
  assert.equal(new Set(keys).size, 1);
});

test('an invalid world result is quarantined before consequence evaluation', async t => {
  const value = fixture({ execute: async () => ({ value: 'fabricated-shape' }) });
  value.spec.limits.maxContactAttempts = 1;
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  await assert.rejects(() => kernel.run(), /sealed contract/);
  const state = kernel.state();
  assert.equal(state.currentCycle.contact, undefined);
  assert.equal(state.currentCycle.evaluation, undefined);
  assert.equal(state.currentCycle.contactFailures[0].failure.quarantined, true);
  assert.equal(state.completed.reason, 'contact-attempt-limit');
});

test('restart explicitly abandons an inference with no terminal receipt', async t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  kernel.store.append('cycle.opened', { cycleId: 'cycle-crash', generation: 0, subjectId: kernel.state().subject.id, observedThrough: 1 });
  const projection = kernel.store.put({ interrupted: true });
  kernel.store.append('actor.started', {
    cycleId: 'cycle-crash', invocationId: 'actor-crash', role: 'orient', contextId: 'context-crash', projection,
    responseChain: null, workspaceContinuity: null, status: 'started',
  });
  await kernel.run();
  const abandoned = kernel.state().invocations.find(invocation => invocation.invocationId === 'actor-crash' && invocation.status === 'abandoned');
  assert.equal(abandoned.reason, 'no terminal receipt survived process boundary');
});

test('a snapshot is a self-contained replayable run with the same evidence head', async t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const original = await kernel.run();
  const destination = join(value.parent, 'snapshot');
  const manifest = kernel.snapshot(destination);
  const restored = new DevelopmentalKernel(destination).state();
  assert.equal(restored.head, original.head);
  assert.equal(restored.subject.id, original.subject.id);
  assert.deepEqual(new DevelopmentalKernel(destination).audit().evidence, {
    events: manifest.events,
    objects: manifest.objects,
    head: manifest.head,
  });
  assert.throws(() => kernel.snapshot(destination), /already exists/);
});

test('the first complete hosted-model consequence transition records one hatch event', async t => {
  const value = fixture();
  const plan = value.actor.plan;
  const delegate = new FunctionActor(async ({ role, projection }) => plan[`${projection.subject.generation}:${role}`], { id: 'hosted-test', model: 'hosted/model' });
  const inference = {
    format: 'music-v3-inference-1', provider: 'openrouter', model: 'hosted/model', adapterIdentity: 'b'.repeat(64),
    settings: { timeoutMs: 120_000, maxOutputTokens: 15_000, temperature: 0.35, reasoningEffort: 'low' },
  };
  value.actor = { describe: () => inference, invoke: request => delegate.invoke(request) };
  value.spec.inference = value.actor.describe();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const state = await kernel.run();
  assert.equal(state.hatched.subjectId, state.subject.id);
  assert.equal(state.hatched.generation, 1);
  assert.match(state.hatched.criterion, /hosted-model/);
  assert.equal(kernel.store.readEvents().filter(event => event.type === 'subject.hatched').length, 1);
});

test('a changed kernel implementation cannot advance and residence surfaces the permanent failure', async t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const first = new DevelopmentalKernel(value.root, { ...value, provenance: () => ({ implementationSha256: 'a'.repeat(64) }) });
  first.initialize(value.spec);
  const changed = new DevelopmentalKernel(value.root, { ...value, provenance: () => ({ implementationSha256: 'b'.repeat(64) }) });
  await assert.rejects(() => changed.advance(), /differs from sealed genesis provenance/);
  assert.equal(changed.state().subject.generation, 0);
  await assert.rejects(() => changed.reside({ maximumSleepMs: 1 }), /differs from sealed genesis provenance/);
  assert.equal(changed.state().residentFailures.length, 1);
  assert.match(changed.state().residentFailures[0].failure.message, /differs from sealed genesis provenance/);
  const recovered = new ResidentLease(value.root).acquire();
  recovered.release();
});

test('run and step cannot advance while another resident owns the subject', async t => {
  const value = fixture();
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const lease = new ResidentLease(value.root).acquire();
  try {
    await assert.rejects(() => kernel.advance(), /another live resident/);
    await assert.rejects(() => kernel.run(), /another live resident/);
    assert.equal(kernel.state().subject.generation, 0);
  } finally {
    lease.release();
  }
});

test('constitutional rejection is retained and a bounded fresh challenge may repair it', async t => {
  const value = fixture();
  const valid = structuredClone(value.wager);
  const invalid = structuredClone(value.wager);
  invalid.witnesses.support = { output: { value: 'wrong-shape' } };
  let challenges = 0;
  const plan = value.actor.plan;
  value.actor = new FunctionActor(async ({ role, projection }) => {
    if (role === 'challenge') {
      challenges += 1;
      if (challenges === 1) return { wagers: [invalid] };
      assert.match(JSON.stringify(projection.priorRejections), /support witness/);
      return { wagers: [valid] };
    }
    return plan[`${projection.subject.generation}:${role}`];
  }, { id: 'repairing-actor', identityMaterial: 'bounded-rejection-repair' });
  value.spec.inference = value.actor.describe();
  value.spec.limits.maxChallengeAttempts = 2;
  t.after(() => rmSync(value.parent, { recursive: true, force: true }));
  const kernel = new DevelopmentalKernel(value.root, value);
  kernel.initialize(value.spec);
  const state = await kernel.run();
  assert.equal(state.subject.generation, 1);
  assert.equal(state.cycles[0].frontierRejections.length, 1);
  assert.equal(challenges, 2);
});
