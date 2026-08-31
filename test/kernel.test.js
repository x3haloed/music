import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { manifestDigest } from '../src/geometry.js';
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

test('one durable subject receives world Deltas through a Sounding', () => {
  const { kernel } = harness();
  const subject = kernel.state().subject;
  kernel.admitDelta({
    authority: 'world', id: 'reply-1', stream: 'inbox', at: '2026-08-30T12:00:00.000Z',
    payload: { from: 'Chad', content: 'Could you ask first next time?' },
  });
  const sounding = kernel.openSounding('delta');
  assert.equal(sounding.subject.id, subject.id);
  assert.deepEqual(sounding.deltas.map(delta => delta.id), ['reply-1']);
  assert.equal(kernel.state().pendingDeltas.length, 0);
  assert.equal(kernel.audit().valid, true);
});

test('agent-authored consequence changes later executable message geometry', () => {
  const { kernel } = harness();
  const first = kernel.openSounding();
  assert.deepEqual(first.tools.find(tool => tool.id === 'message').actions.map(action => action.id), ['send']);

  const current = kernel.state().tools.get('message');
  kernel.activateToolRevision({
    authority: 'agent',
    parent: kernel.state().head,
    interpretation: 'A reply showed that uncertainty should open a lightweight question before a composed message.',
    evidence: ['delta:reply-1'],
    tool: {
      id: 'message', version: 2, parent: manifestDigest(current),
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

  const later = kernel.openSounding();
  assert.deepEqual(later.tools.find(tool => tool.id === 'message').actions.map(action => action.id), ['send', 'ask']);
  assert.deepEqual(kernel.invokeTool('message', 'ask', { recipient: 'Chad', question: 'Would you like a draft first?' }), {
    kind: 'emission', channel: 'outbox', body: 'to=Chad\n[question] Would you like a draft first?',
  });
  assert.equal(kernel.audit().emissions, 1);
});

test('the subject can invent a new bounded executable tool', () => {
  const { kernel } = harness();
  kernel.activateToolRevision({
    authority: 'agent', parent: kernel.state().head,
    interpretation: 'Repeated comparison work deserves a named action form.',
    tool: {
      id: 'compare', version: 1, parent: null,
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
  assert.equal(kernel.invokeTool('compare', 'render', { left: 'one', right: 'two' }).channel, 'comparison');
  assert.ok(kernel.openSounding().tools.some(tool => tool.id === 'compare'));
});

test('stale or overpowered revisions do not activate', () => {
  const { kernel } = harness();
  const current = kernel.state().tools.get('message');
  const staleParent = kernel.state().head;
  kernel.openSounding();
  assert.throws(() => kernel.activateToolRevision({
    authority: 'agent', parent: staleParent, interpretation: 'stale',
    tool: { ...current, version: 2, parent: manifestDigest(current) },
  }), /current authoritative self/);

  assert.throws(() => kernel.activateToolRevision({
    authority: 'agent', parent: kernel.state().head, interpretation: 'escape',
    tool: {
      id: 'shell', version: 1, parent: null, description: 'Run anything.',
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
