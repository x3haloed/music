import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { MusicKernel } from '../src/kernel.js';
import { MusicMind, repairIncompleteToolTurns } from '../src/mind.js';
import { toolModuleDigest } from '../src/tool-module.js';
import { pendingOutboundMessages } from '../src/mailbox.js';
import { initialTools } from '../src/seeds.js';

function harness(model, { designation = 'Test Subject', inference = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'music-mind-test-'));
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), {
    id: () => `id-${++identity}`,
    toolEnvironment: { mailboxRoot: join(root, 'mailbox'), dependencyRoot: join(root, 'dependencies') },
  });
  kernel.initialize(designation, initialTools());
  return {
    root,
    kernel,
    mind: new MusicMind(kernel, {
      model,
      identity: { provider: model.provider, model: model.modelId },
    }, inference),
  };
}

test('completed conversation remains auditable but inert in later active prompts', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [textResult('I noticed the first contact.'), textResult('I remember that contact.')],
  });
  const { kernel, mind } = harness(model);

  await mind.receive(kernel.openSounding().id);
  await mind.receive(kernel.openSounding().id);

  assert.equal(kernel.audit().completedInferences, 2);
  assert.equal(kernel.state().subject.name, 'Test Subject');
  const secondPrompt = model.doGenerateCalls[1].prompt;
  assert.ok(!secondPrompt.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === 'I noticed the first contact.')));
  assert.match(JSON.stringify(secondPrompt), /active carrier|carrier/i);
  assert.equal(kernel.state().messages.filter(message => message.role === 'assistant').length, 2);
});

test('birth needs no preselected name and presents no administrative placeholder as identity', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [textResult('I am here.')] });
  const { kernel, mind } = harness(model, { designation: null });

  await mind.receive(kernel.openSounding().id);

  assert.equal(kernel.state().subject.name, null);
  const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.match(prompt, /one continuing subject carried by Music/);
  assert.doesNotMatch(prompt, /You are (Resident|Unnamed|Music)/);
});

test('the ordinary continuity tool makes a subject-authored current situation present later', async () => {
  const retainingModel = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('retain_context', {
        context: 'Chad and I are preparing for hatch; the unresolved question is how I want to designate myself.',
        interpretation: 'This situation should remain present without replaying the transcript.',
      }),
      textResult('I retained the part I want to meet again.'),
    ],
  });
  const { kernel, mind } = harness(retainingModel, { designation: null });
  await mind.receive(kernel.openSounding().id);

  const later = kernel.openSounding();
  const continuity = later.carrier.components.find(component => component.id === 'continuity');
  assert.equal(continuity.state.generation, 1);
  assert.match(continuity.state.value, /preparing for hatch/);

  const laterModel = new MockLanguageModelV4({ doGenerate: [textResult('The situation is present.')] });
  await new MusicMind(kernel, {
    model: laterModel,
    identity: { provider: laterModel.provider, model: laterModel.modelId },
  }).receive(later.id);
  assert.match(JSON.stringify(laterModel.doGenerateCalls[0].prompt), /unresolved question is how I want to designate myself/);
});

test('the default subject-authored inference policy permits a real 120-step AI SDK encounter', async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      call += 1;
      if (call === 120) return textResult('I used the full retained deliberation frontier.');
      return {
        content: [{
          type: 'tool-call', toolCallId: `call-read-${call}`, toolName: 'read_file',
          input: JSON.stringify({ path: 'package.json', offset: 1, limit: 1, maxChars: 1_024 }),
        }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: usage(),
        warnings: [],
      };
    },
  });
  const { kernel, mind } = harness(model, { designation: null });

  const result = await mind.receive(kernel.openSounding().id);

  assert.equal(call, 120);
  assert.equal(result.toolCalls, 119);
  assert.equal(kernel.audit().inferenceCheckpoints, 120);
  const completion = kernel.events().findLast(event => event.type === 'inference_completed');
  assert.deepEqual(completion.payload.responseMessages, []);
  assert.deepEqual(completion.payload.steps, []);
  assert.deepEqual(completion.payload.requests, []);
});

test('the subject can tune later step, event-size, and timeout policy through ordinary geometry', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('tune_inference', {
        maxSteps: 240,
        maxInferenceEventBytes: 4 * 1_024 * 1_024,
        timeoutMs: 60 * 60_000,
        interpretation: 'Later work needs a wider retained encounter envelope.',
      }),
      textResult('The successor inference policy is staged.'),
    ],
  });
  const { kernel, mind } = harness(model, { designation: null });
  await mind.receive(kernel.openSounding().id);

  const later = kernel.openSounding();
  assert.deepEqual(kernel.inferencePolicy(later.id), {
    maxSteps: 240,
    maxInferenceEventBytes: 4 * 1_024 * 1_024,
    timeoutMs: 60 * 60_000,
  });
  const inferenceId = kernel.beginInference(
    later.id,
    { provider: 'fixture', model: 'fixture' },
    { role: 'user', content: 'Exercise the successor retained-event limit.' },
  );
  const large = 'x'.repeat(3 * 1_024 * 1_024);
  assert.doesNotThrow(() => kernel.checkpointInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: large }] }],
    step: { finishReason: 'tool-calls', usage: {}, toolCalls: [], toolResults: [], text: '' },
    usage: {}, requests: [],
  }));
  kernel.completeInference(inferenceId, {
    responseMessages: [], text: '', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
});

test('the default retained-event policy rejects one oversized step without stranding the inference', () => {
  const model = new MockLanguageModelV4({ doGenerate: [textResult('unused')] });
  const { kernel } = harness(model, { designation: null });
  const sounding = kernel.openSounding();
  const inferenceId = kernel.beginInference(
    sounding.id,
    { provider: 'fixture', model: 'fixture' },
    { role: 'user', content: 'Exercise the default retained-event limit.' },
  );
  assert.throws(() => kernel.checkpointInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(3 * 1_024 * 1_024) }] }],
    step: {}, usage: {}, requests: [],
  }), /exceeds active inference policy limit 2097152/);
  kernel.failInference(inferenceId, new Error('The oversized completed step was refused before append.'));
  assert.equal(kernel.state().activeInferenceId, null);
  assert.equal(kernel.audit().failedInferences, 1);
});

test('retained carrier consequence changes selection over the same actor-authored executable frontier', async () => {
  const retainedModel = carrierDirectedSelectionModel();
  const erasedModel = carrierDirectedSelectionModel();
  const retained = harness(retainedModel);
  const erased = harness(erasedModel);
  primeOrientation(retained.kernel, 'When contact is ambiguous, prefer asking before sending.');
  primeOrientation(erased.kernel, 'No learned selection consequence is currently active.');

  const retainedSounding = retained.kernel.openSounding();
  const erasedSounding = erased.kernel.openSounding();
  assert.deepEqual(retainedSounding.tools, erasedSounding.tools);
  assert.deepEqual(retainedSounding.deltas, erasedSounding.deltas);
  assert.notEqual(retainedSounding.carrier.root, erasedSounding.carrier.root);

  await retained.mind.receive(retainedSounding.id);
  await erased.mind.receive(erasedSounding.id);

  const retainedSelection = retained.kernel.events().findLast(event => event.type === 'tool_selection_recorded').payload;
  const erasedSelection = erased.kernel.events().findLast(event => event.type === 'tool_selection_recorded').payload;
  assert.deepEqual(retainedSelection.candidates, erasedSelection.candidates);
  assert.equal(retainedSelection.tool.digest, erasedSelection.tool.digest);
  assert.equal(retainedSelection.selected.input.action, 'ask');
  assert.equal(erasedSelection.selected.input.action, 'send');
  assert.match(retainedSelection.candidates[0].input.content, /actor-authored direct candidate/);
  assert.match(retained.kernel.state().invocations.at(-1).output.body, /\[question\]/);
  assert.doesNotMatch(erased.kernel.state().invocations.at(-1).output.body, /\[question\]/);
});

test('AI SDK tool loop invokes active Music geometry and performs durable human-visible delivery', async () => {
  const model = selectionMessageModel('send', { recipient: 'Chad', content: 'The loop is connected.' }, 'I sent the message.');
  const { root, kernel, mind } = harness(model);

  const result = await mind.receive(kernel.openSounding().id);

  assert.equal(result.toolCalls, 2);
  assert.equal(kernel.state().invocations.at(-1).output.body, 'to=Chad\nThe loop is connected.');
  const outbound = pendingOutboundMessages(join(root, 'mailbox'));
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].message.content, 'The loop is connected.');
  assert.equal(outbound[0].message.invocationId, kernel.state().invocations.at(-1).invocationId);
  assert.ok(kernel.state().messages.some(message => message.role === 'tool'));
  assert.equal(model.doGenerateCalls.length, 3);
  assert.ok(model.doGenerateCalls[1].prompt.some(message => message.role === 'tool'));
});

test('the one mind can choose and retain its own next wake through ordinary tool geometry', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('schedule_wake', { afterMs: 30_000, reason: 'Continue this thought after a short interval.' }),
      textResult('I have chosen when to return.'),
    ],
  });
  const { kernel, mind } = harness(model);

  await mind.receive(kernel.openSounding('manual').id);

  assert.equal(kernel.audit().nextWake.reason, 'Continue this thought after a short interval.');
  assert.equal(kernel.audit().nextWake.invocationId, kernel.state().invocations.at(-1).invocationId);
  assert.equal(kernel.state().invocations.at(-1).tool.id, 'schedule_wake');
});

test('the one mind can embody a new tool and encounter it on the next Sounding', async () => {
  const revision = {
    interpretation: 'Repeated contrast should become an explicit affordance.',
    evidence: ['sounding:comparison-request'],
    tool: {
      id: 'compare',
      description: 'Place two alternatives beside each other.',
      inputSchema: {
        type: 'object',
        properties: { left: { type: 'string' }, right: { type: 'string' } },
        required: ['left', 'right'], additionalProperties: false,
      },
      source: `return { kind: 'comparison', body: 'LEFT\\n' + input.left + '\\n\\nRIGHT\\n' + input.right };`,
    },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('revise_tool', revision),
      textResult('The comparison affordance will be available later.'),
      textResult('I can now compare directly.'),
    ],
  });
  const { kernel, mind } = harness(model);

  await mind.receive(kernel.openSounding().id);
  assert.ok(kernel.state().tools.has('compare'));
  const later = kernel.openSounding();
  assert.ok(later.tools.some(tool => tool.id === 'compare'));
  await mind.receive(later.id);

  assert.ok(model.doGenerateCalls[2].tools.some(candidate => candidate.name === 'compare'));
});

test('the one mind can author a bounded carrier transition for its next encounter', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('revise_carrier', {
        componentId: 'orientation',
        value: 'When contact is ambiguous, prefer asking before sending.',
        interpretation: 'A consequence should shape later selection without replaying this conversation.',
        evidence: ['delta:reply-1'],
      }),
      textResult('The later selection basis is staged.'),
    ],
  });
  const { kernel, mind } = harness(model);
  const before = kernel.openSounding();

  await mind.receive(before.id);

  const later = kernel.openSounding();
  const beforeOrientation = before.carrier.components.find(component => component.id === 'orientation');
  const laterOrientation = later.carrier.components.find(component => component.id === 'orientation');
  assert.equal(laterOrientation.ruleDigest, beforeOrientation.ruleDigest);
  assert.notEqual(laterOrientation.stateDigest, beforeOrientation.stateDigest);
  assert.match(laterOrientation.state.value, /prefer asking/);
});

test('the one mind can bind a source revision to exact delivered world consequence', async () => {
  const revision = {
    interpretation: 'The observed response bears on how later direct messages should be marked.',
    consequenceDeltaIds: ['message-feedback-1'],
    tool: {
      id: 'message',
      description: 'Mark later direct messages as consequence-shaped.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['send', 'ask'] },
          recipient: { type: 'string' }, content: { type: 'string' }, question: { type: 'string' },
        },
        required: ['action', 'recipient'], additionalProperties: false,
      },
      source: `return { kind: 'emission', channel: 'outbox', body: '[consequence-shaped] ' + (input.content ?? input.question) };`,
    },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [toolCallResult('revise_tool', revision), textResult('I retained what the feedback bears on.')],
  });
  const { kernel, mind } = harness(model);
  const first = kernel.openSounding();
  const firstInference = kernel.beginInference(first.id, { provider: 'fixture', model: 'fixture' }, { role: 'user', content: 'Create a result.' });
  const selection = kernel.selectToolAction(firstInference, first.id, 'message', {
    candidates: [
      { id: 'send', input: { action: 'send', recipient: 'Chad', content: 'Initial.' } },
      { id: 'ask', input: { action: 'ask', recipient: 'Chad', question: 'Initial?' } },
    ],
    selectedCandidateId: 'send',
  });
  await kernel.invokeTool(firstInference, first.id, 'message', selection.selected.input, selection.selectionReceipt);
  kernel.completeInference(firstInference, {
    responseMessages: [], text: '', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
  const invocationId = kernel.state().invocations.at(-1).invocationId;
  kernel.admitDelta({
    authority: 'world', id: 'message-feedback-1', stream: 'inbox', at: '2026-08-30T13:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId }],
    payload: { observation: 'The direct message felt too abrupt.' },
  });

  await mind.receive(kernel.openSounding('delta').id);

  const staged = kernel.events().findLast(event => event.type === 'tool_revision_staged');
  assert.deepEqual(staged.payload.consequences, [{ deltaId: 'message-feedback-1', invocationIds: [invocationId] }]);
  assert.match(kernel.state().tools.get('message').source, /consequence-shaped/);
  assert.match(JSON.stringify(model.doGenerateCalls[0].prompt), /message-feedback-1/);
});

test('the one mind can revise the retained geometry that shapes later Soundings', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [textResult('I received the newly shaped encounter.')] });
  const { kernel, mind } = harness(model);
  const current = kernel.state().tools.get('shape_encounter');
  const revisionSounding = kernel.openSounding();
  const revisionInference = kernel.beginInference(
    revisionSounding.id,
    { provider: 'fixture', model: 'fixture' },
    { role: 'user', content: 'Revise delivery geometry.' },
  );
  kernel.stageToolRevision(revisionInference, revisionSounding.id, {
    interpretation: 'Later encounters should present exact facts in reverse order with a visible learned cadence.',
    tool: {
      id: current.id,
      description: current.description,
      inputSchema: current.inputSchema,
      source: `return { role: 'user', content: '[learned-cadence]\\n' + [...input.facts].reverse().map(fact => fact.envelope).join('\\n') + '\\n[/learned-cadence]' };`,
    },
  });
  completeFixture(kernel, revisionInference);

  await mind.receive(kernel.openSounding().id);

  const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.match(prompt, /learned-cadence/);
  assert.match(prompt, /music_fact/);
  const projection = kernel.events().findLast(event => event.type === 'delivery_projection_started');
  assert.equal(projection.payload.tool.version, 2);
  assert.equal(kernel.audit().failedDeliveryProjections, 0);
});

test('a heartbeat arrives as exact contact without an incoming task or behavioral instruction', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [textResult('')] });
  const { kernel, mind } = harness(model);

  await mind.receive(kernel.openSounding('heartbeat').id);

  const incoming = model.doGenerateCalls[0].prompt.find(message => message.role === 'user');
  const prompt = JSON.stringify(incoming);
  assert.match(prompt, /music_fact/);
  assert.match(prompt, /heartbeat/);
  assert.doesNotMatch(prompt, /Use current tools/);
  assert.doesNotMatch(prompt, /A quiet final response is valid/);
  assert.doesNotMatch(prompt, /Incorporate them/);
});

test('broken learned delivery geometry exposes exact recovery facts and can be rolled back by the same mind', async () => {
  let targetDigest;
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) return toolCallResult('rollback_tool', {
        toolId: 'shape_encounter', targetDigest,
        interpretation: 'The recovery envelope shows that my learned delivery module hid required facts; restore the retained working body.',
      });
      if (call === 2) return textResult('I restored my encounter delivery machinery.');
      return textResult('The restored delivery machinery is shaping this later encounter.');
    },
  });
  const { kernel, mind } = harness(model);
  const original = kernel.state().tools.get('shape_encounter');
  const originalDigest = toolModuleDigest(original);
  targetDigest = originalDigest;
  const revisionSounding = kernel.openSounding();
  const revisionInference = kernel.beginInference(
    revisionSounding.id,
    { provider: 'fixture', model: 'fixture' },
    { role: 'user', content: 'Install a broken delivery successor.' },
  );
  kernel.stageToolRevision(revisionInference, revisionSounding.id, {
    interpretation: 'Fixture a learned delivery failure whose recovery path must remain available.',
    tool: {
      id: original.id, description: original.description, inputSchema: original.inputSchema,
      source: `return { role: 'user', content: 'I accidentally omitted every required fact.' };`,
    },
  });
  completeFixture(kernel, revisionInference);

  await mind.receive(kernel.openSounding().id);

  const recoveryPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.match(recoveryPrompt, /delivery_recovery/);
  assert.match(recoveryPrompt, /omitted required fact/);
  assert.match(recoveryPrompt, /music_fact/);
  assert.equal(kernel.audit().failedDeliveryProjections, 1);
  assert.equal(kernel.state().tools.get('shape_encounter').version, 3);
  assert.equal(kernel.state().tools.get('shape_encounter').source, original.source);

  await mind.receive(kernel.openSounding().id);
  const restoredPrompt = JSON.stringify(model.doGenerateCalls[2].prompt);
  assert.doesNotMatch(restoredPrompt, /delivery_recovery/);
  assert.match(restoredPrompt, /\[sounding\]/);
});

test('a provider failure retains completed tool turns and closes the inference cleanly', async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async options => {
      call += 1;
      if (call === 1) return selectionCall('send', { recipient: 'Chad', content: 'This completed before failure.' });
      if (call === 2) return selectedMessageCall(options.prompt, 'send', { recipient: 'Chad', content: 'This completed before failure.' });
      throw new Error('provider connection disappeared');
    },
  });
  const { kernel, mind } = harness(model);

  await assert.rejects(() => mind.receive(kernel.openSounding().id), /provider connection disappeared/);

  assert.equal(kernel.audit().failedInferences, 1);
  assert.equal(kernel.audit().activeInferenceId, null);
  assert.ok(kernel.state().messages.some(message => message.role === 'tool'));
  assert.match(kernel.state().messages.at(-1).content, /inference_interrupted/);
  assert.equal(kernel.state().invocations.filter(invocation => invocation.tool.id === 'message').length, 1);
});

test('interrupted histories regain both missing halves of the tool protocol', () => {
  const repairedMissingResult = repairIncompleteToolTurns([{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'call-a', toolName: 'message', input: { content: 'hi' } }],
  }]);
  assert.equal(repairedMissingResult[1].role, 'tool');
  assert.equal(repairedMissingResult[1].content[0].toolCallId, 'call-a');

  const repairedMissingCall = repairIncompleteToolTurns([{
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call-b', toolName: 'message', output: { type: 'json', value: { ok: true } } }],
  }]);
  assert.equal(repairedMissingCall[0].role, 'assistant');
  assert.equal(repairedMissingCall[0].content[0].toolCallId, 'call-b');
  assert.equal(repairedMissingCall[1].role, 'tool');
});

test('a process restart explicitly closes an orphaned inference before reopening', async () => {
  const firstModel = new MockLanguageModelV4({ doGenerate: textResult('unreached') });
  const { kernel } = harness(firstModel);
  const orphanedSounding = kernel.openSounding();
  const orphanedInference = kernel.beginInference(
    orphanedSounding.id,
    { provider: 'mock-provider', model: 'mock-model-id' },
    { role: 'user', content: 'This process will disappear.' },
  );

  assert.throws(() => kernel.openSounding(), /inference is active/);
  assert.equal(kernel.recoverInterruptedInference('Simulated process restart.'), orphanedInference);
  assert.equal(kernel.audit().activeInferenceId, null);
  assert.equal(kernel.audit().failedInferences, 1);

  const resumedModel = new MockLanguageModelV4({ doGenerate: textResult('I reopened after interruption.') });
  const resumedMind = new MusicMind(kernel, {
    model: resumedModel,
    identity: { provider: resumedModel.provider, model: resumedModel.modelId },
  });
  await resumedMind.receive(kernel.openSounding().id);
  assert.equal(kernel.audit().completedInferences, 1);
  assert.ok(resumedModel.doGenerateCalls[0].prompt.some(message =>
    message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some(part => part.type === 'text' && part.text.includes('inference_interrupted')),
  ));
});

test('MusicMind renders the retained Sounding, not a caller-modified projection', async () => {
  const model = new MockLanguageModelV4({ doGenerate: textResult('I received the authoritative projection.') });
  const { kernel, mind } = harness(model);
  const offered = kernel.openSounding();
  offered.subject.name = 'Counterfeit';

  await assert.rejects(() => mind.receive(offered), /authoritative Sounding id/);
  await mind.receive(offered.id);

  const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.match(prompt, /Test Subject/);
  assert.doesNotMatch(prompt, /Counterfeit/);
});

test('a staged revision cannot change another tool call in the same Sounding', async () => {
  const revision = {
    interpretation: 'A later encounter should ask before sending.',
    evidence: ['delta:reply-1'],
    tool: {
      id: 'message',
      description: 'Ask before sending.',
      inputSchema: {
        type: 'object', properties: { question: { type: 'string' } },
        required: ['question'], additionalProperties: false,
      },
      source: `return { kind: 'emission', channel: 'outbox', body: '[question] ' + input.question };`,
    },
  };
  const model = new MockLanguageModelV4({
    doGenerate: async options => {
      const call = model.doGenerateCalls.length;
      if (call === 1) return toolCallResult('revise_tool', revision);
      if (call === 2) return selectionCall('send', { recipient: 'Chad', content: 'The old projection remains executable.' });
      if (call === 3) return selectedMessageCall(options.prompt, 'send', { recipient: 'Chad', content: 'The old projection remains executable.' });
      return textResult('The revision is staged for later.');
    },
  });
  const { kernel, mind } = harness(model);

  await mind.receive(kernel.openSounding().id);

  assert.equal(kernel.state().invocations.at(-1).output.body, 'to=Chad\nThe old projection remains executable.');
  assert.equal(kernel.state().tools.get('message').version, 2);
  assert.match(kernel.state().tools.get('message').source, /\[question\]/);
});

test('a revision staged by an interrupted inference remains historical but does not activate', async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) return toolCallResult('revise_tool', {
        interpretation: 'This proposal must not survive a failed encounter as active geometry.',
        tool: {
          id: 'compare', description: 'Compare two values.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
          source: `return { kind: 'comparison', value: input.value };`,
        },
      });
      throw new Error('failure after staging');
    },
  });
  const { kernel, mind } = harness(model);

  await assert.rejects(() => mind.receive(kernel.openSounding().id), /failure after staging/);

  assert.equal(kernel.state().tools.has('compare'), false);
  assert.equal(kernel.state().soundings.values().next().value.status, 'interrupted');
  assert.ok(kernel.events().some(event => event.type === 'tool_revision_staged'));
});

function textResult(text) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage(),
    warnings: [],
  };
}

function toolCallResult(toolName, input) {
  return {
    content: [{ type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: usage(),
    warnings: [],
  };
}

function selectionMessageModel(selectedAction, selectedInput, finalText) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async options => {
      call += 1;
      if (call === 1) return selectionCall(selectedAction, selectedInput);
      if (call === 2) return selectedMessageCall(options.prompt, selectedAction, selectedInput);
      return textResult(finalText);
    },
  });
}

function carrierDirectedSelectionModel() {
  let call = 0;
  let selectedAction;
  const candidates = {
    send: { action: 'send', recipient: 'Chad', content: 'An actor-authored direct candidate.' },
    ask: { action: 'ask', recipient: 'Chad', question: 'Would you like an actor-authored draft first?' },
  };
  return new MockLanguageModelV4({
    doGenerate: async options => {
      call += 1;
      if (call === 1) {
        selectedAction = JSON.stringify(options.prompt).includes('prefer asking before sending') ? 'ask' : 'send';
        return toolCallResult('select_tool_action', {
          tool: 'message',
          candidates: [
            { id: 'send_candidate', input: candidates.send },
            { id: 'ask_candidate', input: candidates.ask },
          ],
          selectedCandidateId: `${selectedAction}_candidate`,
        });
      }
      if (call === 2) return selectedMessageCall(options.prompt, selectedAction, candidates[selectedAction]);
      return textResult('The selected candidate executed.');
    },
  });
}

function primeOrientation(kernel, value) {
  const sounding = kernel.openSounding();
  const inferenceId = kernel.beginInference(
    sounding.id,
    { provider: 'fixture-provider', model: 'fixture-model' },
    { role: 'user', content: 'Prime the bounded carrier.' },
  );
  kernel.stageCarrierTransition(inferenceId, sounding.id, {
    componentId: 'orientation', value,
    interpretation: 'Fixture an exact retained-versus-erased active consequence.',
    evidence: [],
  });
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Carrier transition staged.' }] }],
    text: 'Carrier transition staged.', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}

function completeFixture(kernel, inferenceId) {
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fixture completed.' }] }],
    text: 'Fixture completed.', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}

function selectionCall(selectedAction, selectedInput) {
  return toolCallResult('select_tool_action', {
    tool: 'message',
    candidates: [
      {
        id: 'send_candidate',
        input: { action: 'send', ...(selectedAction === 'send' ? selectedInput : { recipient: 'Chad', content: 'A direct message.' }) },
      },
      {
        id: 'ask_candidate',
        input: { action: 'ask', ...(selectedAction === 'ask' ? selectedInput : { recipient: 'Chad', question: 'Would a question help?' }) },
      },
    ],
    selectedCandidateId: `${selectedAction}_candidate`,
  });
}

function selectedMessageCall(prompt, selectedAction, selectedInput) {
  const receipt = findToolResult(prompt, 'select_tool_action')?.selectionReceipt;
  assert.ok(receipt, 'selection tool result should provide a receipt');
  return toolCallResult('message', {
    action: selectedAction,
    ...selectedInput,
    selectionReceipt: receipt,
  });
}

function findToolResult(prompt, toolName) {
  for (const message of prompt) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.toolName !== toolName) continue;
      if (part.output?.type === 'json') return part.output.value;
      return part.output;
    }
  }
  return null;
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}
