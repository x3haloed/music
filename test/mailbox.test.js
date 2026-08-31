import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pendingIngressFiles, readIngressDelta } from '../src/ingress.js';
import { archiveOutboundMessage, pendingOutboundMessages, submitMailboxMessage } from '../src/mailbox.js';
import { MusicKernel } from '../src/kernel.js';
import { initialTools } from '../src/seeds.js';

test('a delivered mailbox message and its human reply retain exact invocation lineage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-mailbox-test-'));
  const mailbox = join(root, 'mailbox');
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), {
    id: () => `id-${++identity}`,
    toolEnvironment: { mailboxRoot: mailbox },
  });
  kernel.initialize('Aster', initialTools());
  const sounding = kernel.openSounding();
  const inferenceId = kernel.beginInference(
    sounding.id,
    { provider: 'fixture', model: 'fixture' },
    { role: 'user', content: 'Fixture mailbox delivery.' },
  );
  const input = {
    action: 'send', recipient: 'Chad', content: 'This crossed the real mailbox boundary.',
    replyToDeltaId: 'opening-message',
  };
  const selection = kernel.selectToolAction(inferenceId, sounding.id, 'message', {
    candidates: [
      { id: 'send', input },
      { id: 'ask', input: { action: 'ask', recipient: 'Chad', question: 'Did this arrive?' } },
    ],
    selectedCandidateId: 'send',
  });
  const output = await kernel.invokeTool(inferenceId, sounding.id, 'message', input, selection.selectionReceipt);
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Delivered.' }] }],
    text: 'Delivered.', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });

  const outbound = pendingOutboundMessages(mailbox);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].message.invocationId, output.invocationId);
  assert.equal(outbound[0].message.replyToDeltaId, 'opening-message');
  assert.equal(outbound[0].message.content, 'This crossed the real mailbox boundary.');
  archiveOutboundMessage(mailbox, outbound[0].path);
  assert.equal(pendingOutboundMessages(mailbox).length, 0);

  submitMailboxMessage(mailbox, {
    from: 'Chad',
    content: 'It arrived; preserve this as consequence-bearing contact.',
    bearsOnInvocationId: output.invocationId,
  }, { id: () => 'reply-1', clock: () => new Date('2026-08-30T20:00:00.000Z') });
  const reply = readIngressDelta(pendingIngressFiles(mailbox)[0]);
  assert.deepEqual(reply.bearsOn, [{ kind: 'tool-invocation', invocationId: output.invocationId }]);
  kernel.admitDelta(reply);
  assert.equal(kernel.state().pendingDeltas[0].payload.content, 'It arrived; preserve this as consequence-bearing contact.');
});

test('a separate talk process crosses the mailbox boundary in both directions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-talk-test-'));
  const mailbox = join(root, 'mailbox');
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), {
    id: () => `talk-id-${++identity}`,
    toolEnvironment: { mailboxRoot: mailbox },
  });
  kernel.initialize('Aster', initialTools());

  const talk = execute(process.execPath, [join(process.cwd(), 'src/cli.js'), 'talk', mailbox, 'Chad', 'Are you there?'], {
    ...process.env,
    MUSIC_TALK_TIMEOUT_MS: '3000',
  });
  const arrivalPath = await waitFor(() => pendingIngressFiles(mailbox)[0]);
  const contact = readIngressDelta(arrivalPath);
  kernel.admitDelta(contact);
  const sounding = kernel.openSounding('delta');
  const inferenceId = kernel.beginInference(
    sounding.id,
    { provider: 'fixture', model: 'fixture' },
    { role: 'user', content: 'Fixture the resident side of terminal contact.' },
  );
  const input = {
    action: 'send', recipient: 'Chad', content: 'Yes. This arrived through the message tool.',
    replyToDeltaId: contact.id,
  };
  const selection = kernel.selectToolAction(inferenceId, sounding.id, 'message', {
    candidates: [
      { id: 'send', input },
      { id: 'ask', input: { action: 'ask', recipient: 'Chad', question: 'Can you hear me?', replyToDeltaId: contact.id } },
    ],
    selectedCandidateId: 'send',
  });
  await kernel.invokeTool(inferenceId, sounding.id, 'message', input, selection.selectionReceipt);

  const result = JSON.parse((await talk).stdout);
  assert.equal(result.contactDeltaId, contact.id);
  assert.equal(result.message.content, 'Yes. This arrived through the message tool.');
  assert.equal(result.message.replyToDeltaId, contact.id);
  assert.equal(pendingOutboundMessages(mailbox).length, 0);
  assert.equal(readdirSync(join(mailbox, 'outbound', 'delivered')).length, 1);
});

function execute(file, args, env) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function waitFor(read, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}
