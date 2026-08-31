import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { submitWorldDelta } from '../src/ingress.js';
import { MusicKernel } from '../src/kernel.js';
import { MusicMind } from '../src/mind.js';
import { MusicResident } from '../src/resident.js';
import { initialTools } from '../src/seeds.js';

test('durable world ingress wakes the one mind and a deferred consequence survives restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-resident-test-'));
  const ledger = join(root, 'events.jsonl');
  const ingress = join(root, 'ingress');
  const kernel = new MusicKernel(ledger);
  kernel.initialize('Aster', initialTools());
  const target = join(root, 'contact.txt');
  writeFileSync(target, 'before');
  const actionSounding = kernel.openSounding();
  const actionInference = begin(kernel, actionSounding.id);
  await kernel.invokeTool(actionInference, actionSounding.id, 'file_patch', {
    path: target, oldText: 'before', newText: 'after',
  });
  complete(kernel, actionInference);
  const invocationId = kernel.state().invocations.at(-1).invocationId;
  const delta = {
    authority: 'world', id: 'durable-feedback', stream: 'workspace', at: '2026-08-30T15:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId }],
    payload: { observation: 'Keep this consequence available while considering what it means.' },
  };
  submitWorldDelta(ingress, delta, { id: () => 'arrival-1', clock: () => new Date('2026-08-30T15:00:01.000Z') });

  const deferModel = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('attend_consequence', {
        deltaId: delta.id, action: 'defer',
        interpretation: 'I want this observation to remain available in a later encounter.',
      }),
      textResult('I am leaving this consequence open.'),
    ],
  });
  const errors = [];
  const resident = new MusicResident(kernel, mind(kernel, deferModel), { ingress, onError: error => errors.push(error) });
  assert.deepEqual(await resident.pump(), { admitted: 1, started: true });
  await resident.whenIdle();

  assert.equal(errors.length, 0);
  assert.equal(kernel.audit().deferredConsequences, 1);
  assert.equal(readdirSync(join(ingress, 'pending')).length, 0);
  assert.equal(readdirSync(join(ingress, 'accepted')).length, 1);

  submitWorldDelta(ingress, delta, { id: () => 'arrival-after-crash-window', clock: () => new Date('2026-08-30T15:00:02.000Z') });
  const restartedKernel = new MusicKernel(ledger);
  const settleModel = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('attend_consequence', {
        deltaId: delta.id, action: 'settle',
        interpretation: 'I have revisited the observation and no further active attention is needed.',
      }),
      textResult('I settled it after revisiting it.'),
    ],
  });
  const lastSoundingAt = Date.parse(restartedKernel.events().findLast(event => event.type === 'sounding_opened').at);
  const restarted = new MusicResident(restartedKernel, mind(restartedKernel, settleModel), {
    ingress, heartbeatMs: 1_000, clock: () => lastSoundingAt + 1_001, onError: error => errors.push(error),
  });
  assert.equal(restarted.drainIngress(), 0, 'replayed ingress delivery is archived without duplicating its Delta');
  assert.deepEqual(await restarted.pump(), { admitted: 0, started: true });
  await restarted.whenIdle();

  assert.equal(restartedKernel.audit().unresolvedConsequences, 0);
  assert.equal(restartedKernel.events().filter(event => event.type === 'delta_admitted' && event.payload.delta.id === delta.id).length, 1);
  assert.match(JSON.stringify(settleModel.doGenerateCalls[0].prompt), /I want this observation to remain available/);
  assert.equal([...restartedKernel.state().soundings.values()].at(-1).sounding.trigger, 'heartbeat');
  assert.equal(readdirSync(join(ingress, 'accepted')).length, 2);
});

test('a Delta arriving during inference is durably queued and wakes the next Sounding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-resident-steering-test-'));
  const ledger = join(root, 'events.jsonl');
  const ingress = join(root, 'ingress');
  const kernel = new MusicKernel(ledger);
  kernel.initialize('Aster', initialTools());
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise(resolve => { markStarted = resolve; });
  const firstRelease = new Promise(resolve => { releaseFirst = resolve; });
  const received = [];
  const controlledMind = {
    async receive(soundingId) {
      const sounding = kernel.getSounding(soundingId);
      received.push(sounding.deltas.map(delta => delta.id));
      const inferenceId = begin(kernel, soundingId);
      if (received.length === 1) {
        markStarted();
        await firstRelease;
      }
      complete(kernel, inferenceId);
    },
  };
  const resident = new MusicResident(kernel, controlledMind, { ingress });
  submitWorldDelta(ingress, worldDelta('first-arrival'), { id: () => 'first-file' });
  await resident.pump();
  await firstStarted;

  submitWorldDelta(ingress, worldDelta('arrival-during-inference'), { id: () => 'second-file' });
  const during = await resident.pump();
  assert.deepEqual(during, { admitted: 1, started: false });
  assert.deepEqual(kernel.state().pendingDeltas.map(delta => delta.id), ['arrival-during-inference']);
  releaseFirst();
  await resident.whenIdle();

  assert.deepEqual(received, [['first-arrival'], ['arrival-during-inference']]);
  assert.equal(kernel.audit().completedInferences, 2);
  assert.equal(kernel.audit().pendingDeltas, 0);
});

test('real ingress during an AI SDK step steers the same encounter and can be interpreted there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-resident-live-steering-test-'));
  const ledger = join(root, 'events.jsonl');
  const ingress = join(root, 'ingress');
  const kernel = new MusicKernel(ledger);
  kernel.initialize('Aster', initialTools());
  const target = join(root, 'steered.txt');
  writeFileSync(target, 'before');
  const actionSounding = kernel.openSounding();
  const actionInference = begin(kernel, actionSounding.id);
  await kernel.invokeTool(actionInference, actionSounding.id, 'file_patch', {
    path: target, oldText: 'before', newText: 'after',
  });
  complete(kernel, actionInference);
  const invocationId = kernel.state().invocations.at(-1).invocationId;

  let resident;
  let call = 0;
  let ingestionDuringStep;
  const model = new MockLanguageModelV4({
    doGenerate: async options => {
      call += 1;
      if (call === 1) {
        submitWorldDelta(ingress, {
          authority: 'world', id: 'arrived-mid-step', stream: 'workspace', at: '2026-08-30T16:01:00.000Z',
          bearsOn: [{ kind: 'tool-invocation', invocationId }],
          payload: { observation: 'This arrived while the same encounter was already thinking.' },
        }, { id: () => 'mid-step-file' });
        ingestionDuringStep = await resident.pump();
        return textResult('I have completed my response to the opening contact.');
      }
      if (call === 2) {
        assert.match(JSON.stringify(options.prompt), /arrived-mid-step/);
        assert.match(JSON.stringify(options.prompt), /same encounter was already thinking/);
        return toolCallResult('attend_consequence', {
          deltaId: 'arrived-mid-step', action: 'defer',
          interpretation: 'I received this during the same encounter and want it present again later.',
        });
      }
      return textResult('I incorporated the waking contact without becoming a second mind.');
    },
  });
  resident = new MusicResident(kernel, mind(kernel, model), { ingress });
  submitWorldDelta(ingress, worldDelta('opening-contact'), { id: () => 'opening-file' });
  const inferenceCountBefore = kernel.events().filter(event => event.type === 'inference_started').length;
  await resident.pump();
  await resident.whenIdle();

  assert.deepEqual(ingestionDuringStep, { admitted: 1, started: false });
  assert.equal(kernel.events().filter(event => event.type === 'inference_started').length, inferenceCountBefore + 1);
  const steering = kernel.events().findLast(event => event.type === 'inference_steered');
  assert.deepEqual(steering.payload.deliveredDeltaIds, ['arrived-mid-step']);
  assert.match(JSON.stringify(steering.payload.checkpointMessages), /completed my response to the opening contact/);
  assert.equal(kernel.audit().deferredConsequences, 1);
  assert.equal(kernel.audit().steeringEvents, 1);
  assert.equal(kernel.audit().pendingDeltas, 0);
});

test('deterministic inference failure enters retained exponential backoff instead of hot-looping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-resident-backoff-test-'));
  const ledger = join(root, 'events.jsonl');
  const ingress = join(root, 'ingress');
  let now = Date.parse('2026-08-30T17:00:00.000Z');
  const kernel = new MusicKernel(ledger, { clock: () => new Date(now) });
  kernel.initialize('Aster', initialTools());
  let attempts = 0;
  const failingMind = {
    async receive(soundingId) {
      attempts += 1;
      const inferenceId = begin(kernel, soundingId);
      const error = new Error('deterministic provider configuration rejection');
      kernel.failInference(inferenceId, error);
      throw error;
    },
  };
  const errors = [];
  const resident = new MusicResident(kernel, failingMind, {
    ingress, clock: () => now, failureBackoffMs: 1_000, maxFailureBackoffMs: 8_000,
    onError: error => errors.push(error),
  });
  submitWorldDelta(ingress, worldDelta('contact-that-must-wait'), { id: () => 'backoff-file' });
  assert.deepEqual(await resident.pump(), { admitted: 1, started: true });
  await resident.whenIdle();
  assert.equal(attempts, 1);
  assert.equal(kernel.audit().failedInferences, 1);
  assert.deepEqual(kernel.state().pendingDeltas.map(delta => delta.id), ['contact-that-must-wait']);

  for (let count = 0; count < 100; count += 1) await resident.pump();
  assert.equal(attempts, 1, 'polling during backoff never reopens inference');
  const delayed = await resident.pump();
  assert.equal(delayed.backoff.consecutiveFailures, 1);
  assert.equal(delayed.backoff.remainingMs, 1_000);

  const restarted = new MusicResident(new MusicKernel(ledger), failingMind, {
    ingress, clock: () => now, failureBackoffMs: 1_000, maxFailureBackoffMs: 8_000,
  });
  assert.equal((await restarted.pump()).backoff.remainingMs, 1_000, 'restart does not erase the retry floor');

  now += 1_000;
  assert.deepEqual(await resident.pump(), { admitted: 0, started: true });
  await resident.whenIdle();
  assert.equal(attempts, 2);
  assert.equal(errors.length, 2);
  const secondDelay = await resident.pump();
  assert.equal(secondDelay.backoff.consecutiveFailures, 2);
  assert.equal(secondDelay.backoff.remainingMs, 2_000);
});

function mind(kernel, model) {
  return new MusicMind(kernel, {
    model,
    identity: { provider: model.provider, model: model.modelId },
  });
}

function worldDelta(id) {
  return { authority: 'world', id, stream: 'inbox', at: '2026-08-30T15:00:00.000Z', payload: { content: id } };
}

function begin(kernel, soundingId) {
  return kernel.beginInference(soundingId, { provider: 'fixture', model: 'fixture' }, { role: 'user', content: `Sounding ${soundingId}` });
}

function complete(kernel, inferenceId) {
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    text: 'done', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}

function textResult(text) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage(), warnings: [],
  };
}

function toolCallResult(toolName, input) {
  return {
    content: [{ type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: usage(), warnings: [],
  };
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}
