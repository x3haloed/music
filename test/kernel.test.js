import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MusicKernel } from '../src/kernel.js';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'music-test-'));
  let tick = 0;
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), {
    clock: () => new Date(Date.UTC(2026, 7, 30, 12, 0, tick++)),
    id: () => `id-${++identity}`,
  });
  kernel.initialize('Aster');
  return { kernel, root };
}

test('opening a Sounding reserves Deltas; beginning its exact encounter acknowledges them', () => {
  const { kernel } = harness();
  const subject = kernel.state().subject;
  kernel.admitDelta({
    authority: 'world', id: 'reply-1', stream: 'inbox', at: '2026-08-30T12:00:00.000Z',
    payload: { from: 'Chad', content: 'Could you ask first next time?' },
  });
  const sounding = kernel.openSounding('delta');
  assert.equal(sounding.subject.id, subject.id);
  assert.deepEqual(sounding.deltas.map(delta => delta.id), ['reply-1']);
  assert.equal(kernel.state().pendingDeltas.length, 1);
  assert.equal(kernel.audit().openSoundingId, sounding.id);
  assert.throws(() => kernel.openSounding(), /still awaiting an encounter/);

  const inferenceId = begin(kernel, sounding.id);
  assert.equal(kernel.state().pendingDeltas.length, 0);
  assert.equal(kernel.state().soundings.get(sounding.id).status, 'active');
  complete(kernel, inferenceId);
  assert.equal(kernel.state().soundings.get(sounding.id).status, 'completed');
  assert.equal(kernel.audit().valid, true);
});

test('an inference stages changed geometry, keeps its exact projection executable, and activates on completion', () => {
  const { kernel } = harness();
  const first = kernel.openSounding();
  assert.deepEqual(first.tools.find(tool => tool.id === 'message').actions.map(action => action.id), ['send']);
  const inferenceId = begin(kernel, first.id);

  const current = kernel.state().tools.get('message');
  const staged = kernel.stageToolRevision(inferenceId, first.id, {
    interpretation: 'A reply showed that uncertainty should open a lightweight question before a composed message.',
    evidence: ['delta:reply-1'],
    tool: {
      id: 'message',
      description: 'Contact a person by asking first or sending a composed message.',
      actions: [
        ...current.actions,
        {
          id: 'ask',
          description: 'Ask a short clarifying question before committing to a full response.',
          fields: [
            { name: 'recipient', type: 'string', required: true, maxLength: 256 },
            { name: 'question', type: 'string', required: true, maxLength: 512 },
          ],
          effect: { kind: 'emit', channel: 'outbox', template: 'to={recipient}\n[question] {question}' },
        },
      ],
    },
  });
  assert.equal(staged.version, 2);
  assert.equal(kernel.state().tools.get('message').version, 1);
  assert.deepEqual(kernel.invokeTool(inferenceId, first.id, 'message', 'send', { recipient: 'Chad', content: 'Still exact.' }), {
    kind: 'emission', channel: 'outbox', body: 'to=Chad\nStill exact.',
  });
  complete(kernel, inferenceId);

  const later = kernel.openSounding();
  assert.deepEqual(later.tools.find(tool => tool.id === 'message').actions.map(action => action.id), ['send', 'ask']);
  const laterInference = begin(kernel, later.id);
  assert.deepEqual(kernel.invokeTool(laterInference, later.id, 'message', 'ask', { recipient: 'Chad', question: 'Would you like a draft first?' }), {
    kind: 'emission', channel: 'outbox', body: 'to=Chad\n[question] Would you like a draft first?',
  });
  complete(kernel, laterInference);
  assert.equal(kernel.audit().emissions, 2);
});

test('the subject can invent a new bounded executable tool', () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  kernel.stageToolRevision(inferenceId, sounding.id, {
    interpretation: 'Repeated comparison work deserves a named action form.',
    tool: {
      id: 'compare',
      description: 'Render two alternatives beside each other.',
      actions: [{
        id: 'render', description: 'Emit a side-by-side comparison.',
        fields: [
          { name: 'left', type: 'string', required: true, maxLength: 2_048 },
          { name: 'right', type: 'string', required: true, maxLength: 2_048 },
        ],
        effect: { kind: 'emit', channel: 'comparison', template: 'LEFT\n{left}\n\nRIGHT\n{right}' },
      }],
    },
  });
  assert.throws(() => kernel.invokeTool(inferenceId, sounding.id, 'compare', 'render', { left: 'one', right: 'two' }), /was not projected/);
  complete(kernel, inferenceId);
  const later = kernel.openSounding();
  assert.ok(later.tools.some(tool => tool.id === 'compare'));
  const laterInference = begin(kernel, later.id);
  assert.equal(kernel.invokeTool(laterInference, later.id, 'compare', 'render', { left: 'one', right: 'two' }).channel, 'comparison');
});

test('agent authority cannot be self-asserted outside an active encounter and effects remain bounded', () => {
  const { kernel } = harness();
  assert.equal(kernel.activateToolRevision, undefined);
  assert.throws(() => kernel.invokeTool('invented', 'invented', 'message', 'send', {}), /inference is not active/);
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  assert.throws(() => kernel.stageToolRevision(inferenceId, sounding.id, {
    interpretation: 'escape',
    tool: {
      id: 'shell', description: 'Run anything.',
      actions: [{ id: 'run', description: 'Run shell.', fields: [], effect: { kind: 'shell', channel: 'shell', template: 'rm -rf' } }],
    },
  }), /unsupported effect/);
});

test('tampering with retained history is detected', () => {
  const { kernel } = harness();
  const path = kernel.ledgerPath;
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const event = JSON.parse(lines[0]);
  event.payload.subject.name = 'Someone Else';
  lines[0] = JSON.stringify(event);
  writeFileSync(path, `${lines.join('\n')}\n`);
  assert.throws(() => kernel.audit(), /event digest mismatch/);
});

function begin(kernel, soundingId) {
  return kernel.beginInference(
    soundingId,
    { provider: 'test-provider', model: 'test-model' },
    { role: 'user', content: `Sounding ${soundingId}` },
  );
}

function complete(kernel, inferenceId) {
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    text: 'done', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}
