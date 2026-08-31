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

test('completed AI SDK response messages carry one subject across later Soundings', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [textResult('I noticed the first contact.'), textResult('I remember that contact.')],
  });
  const { kernel, mind } = harness(model);

  await mind.receive(kernel.openSounding().id);
  await mind.receive(kernel.openSounding().id);

  assert.equal(kernel.audit().completedInferences, 2);
  assert.equal(kernel.state().subject.name, 'Aster');
  const secondPrompt = model.doGenerateCalls[1].prompt;
  assert.ok(secondPrompt.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === 'I noticed the first contact.')));
  assert.equal(kernel.state().messages.filter(message => message.role === 'assistant').length, 2);
});

test('AI SDK tool loop invokes active Music geometry and retains the complete protocol', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('message', { recipient: 'Chad', content: 'The loop is connected.' }),
      textResult('I sent the message.'),
    ],
  });
  const { kernel, mind } = harness(model);

  const result = await mind.receive(kernel.openSounding().id);

  assert.equal(result.toolCalls, 1);
  assert.equal(kernel.state().emissions.at(-1).output.body, 'to=Chad\nThe loop is connected.');
  assert.ok(kernel.state().messages.some(message => message.role === 'tool'));
  assert.equal(model.doGenerateCalls.length, 2);
  assert.ok(model.doGenerateCalls[1].prompt.some(message => message.role === 'tool'));
});

test('the one mind can embody a new tool and encounter it on the next Sounding', async () => {
  const revision = {
    interpretation: 'Repeated contrast should become an explicit affordance.',
    evidence: ['sounding:comparison-request'],
    tool: {
      id: 'compare',
      description: 'Place two alternatives beside each other.',
      actions: [{
        id: 'render',
        description: 'Render a bounded comparison.',
        fields: [
          { name: 'left', type: 'string', required: true, maxLength: 2_048 },
          { name: 'right', type: 'string', required: true, maxLength: 2_048 },
        ],
        effect: { kind: 'emit', channel: 'comparison', template: 'LEFT\n{left}\n\nRIGHT\n{right}' },
      }],
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

test('a provider failure retains completed tool turns and closes the inference cleanly', async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) return toolCallResult('message', { recipient: 'Chad', content: 'This completed before failure.' });
      throw new Error('provider connection disappeared');
    },
  });
  const { kernel, mind } = harness(model);

  await assert.rejects(() => mind.receive(kernel.openSounding().id), /provider connection disappeared/);

  assert.equal(kernel.audit().failedInferences, 1);
  assert.equal(kernel.audit().activeInferenceId, null);
  assert.ok(kernel.state().messages.some(message => message.role === 'tool'));
  assert.match(kernel.state().messages.at(-1).content, /inference_interrupted/);
  assert.equal(kernel.state().emissions.length, 1);
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
      actions: [{
        id: 'ask', description: 'Ask a question.',
        fields: [{ name: 'question', type: 'string', required: true, maxLength: 512 }],
        effect: { kind: 'emit', channel: 'outbox', template: '[question] {question}' },
      }],
    },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCallResult('revise_tool', revision),
      toolCallResult('message', { recipient: 'Chad', content: 'The old projection remains executable.' }),
      textResult('The revision is staged for later.'),
    ],
  });
  const { kernel, mind } = harness(model);

  await mind.receive(kernel.openSounding().id);

  assert.equal(kernel.state().emissions.at(-1).output.body, 'to=Chad\nThe old projection remains executable.');
  assert.deepEqual(kernel.state().tools.get('message').actions.map(action => action.id), ['ask']);
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
          actions: [{
            id: 'render', description: 'Render a comparison.',
            fields: [{ name: 'value', type: 'string', required: true, maxLength: 512 }],
            effect: { kind: 'emit', channel: 'comparison', template: '{value}' },
          }],
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

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}
