import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { MusicKernel } from '../src/kernel.js';
import { MusicMind, repairIncompleteToolTurns } from '../src/mind.js';

function harness(model) {
  const root = mkdtempSync(join(tmpdir(), 'music-mind-test-'));
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), { id: () => `id-${++identity}` });
  kernel.initialize('Aster');
  return {
    kernel,
    mind: new MusicMind(kernel, {
      model,
      identity: { provider: model.provider, model: model.modelId },
    }),
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
  assert.equal(kernel.state().subject.name, 'Aster');
  const secondPrompt = model.doGenerateCalls[1].prompt;
  assert.ok(!secondPrompt.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === 'I noticed the first contact.')));
  assert.match(JSON.stringify(secondPrompt), /active carrier|carrier/i);
  assert.equal(kernel.state().messages.filter(message => message.role === 'assistant').length, 2);
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

test('AI SDK tool loop invokes active Music geometry and retains the complete protocol', async () => {
  const model = selectionMessageModel('send', { recipient: 'Chad', content: 'The loop is connected.' }, 'I sent the message.');
  const { kernel, mind } = harness(model);

  const result = await mind.receive(kernel.openSounding().id);

  assert.equal(result.toolCalls, 2);
  assert.equal(kernel.state().invocations.at(-1).output.body, 'to=Chad\nThe loop is connected.');
  assert.ok(kernel.state().messages.some(message => message.role === 'tool'));
  assert.equal(model.doGenerateCalls.length, 3);
  assert.ok(model.doGenerateCalls[1].prompt.some(message => message.role === 'tool'));
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
  assert.equal(later.carrier.components[0].ruleDigest, before.carrier.components[0].ruleDigest);
  assert.notEqual(later.carrier.components[0].stateDigest, before.carrier.components[0].stateDigest);
  assert.match(later.carrier.components[0].state.value, /prefer asking/);
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
  assert.match(prompt, /Aster/);
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
