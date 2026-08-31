import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MusicKernel } from '../src/kernel.js';
import { toolModuleDigest } from '../src/tool-module.js';

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
  kernel.admitDelta({ authority: 'world', id: 'reply-1', stream: 'inbox', at: '2026-08-30T12:00:00.000Z', payload: { content: 'Ask first.' } });
  const sounding = kernel.openSounding('delta');
  assert.equal(sounding.subject.id, subject.id);
  assert.deepEqual(sounding.deltas.map(delta => delta.id), ['reply-1']);
  assert.equal(kernel.state().pendingDeltas.length, 1);
  assert.throws(() => kernel.openSounding(), /still awaiting an encounter/);
  const inferenceId = begin(kernel, sounding.id);
  assert.equal(kernel.state().pendingDeltas.length, 0);
  complete(kernel, inferenceId);
  assert.equal(kernel.state().soundings.get(sounding.id).status, 'completed');
});

test('a staged executable revision cannot alter the current projection and activates later', async () => {
  const { kernel } = harness();
  const first = kernel.openSounding();
  const projected = first.tools.find(tool => tool.id === 'message');
  assert.deepEqual(projected.selection.values, ['send', 'ask']);
  assert.equal(projected.source, undefined);
  const inferenceId = begin(kernel, first.id);
  const current = kernel.state().tools.get('message');
  const inspected = kernel.inspectTool(inferenceId, first.id, 'message');
  assert.equal(inspected.digest, projected.digest);
  assert.equal(inspected.source, current.source);
  const staged = kernel.stageToolRevision(inferenceId, first.id, {
    interpretation: 'Later messages should visibly use the revised executable body.',
    evidence: ['delta:reply-1'],
    tool: {
      id: 'message', description: current.description, inputSchema: current.inputSchema, selection: current.selection,
      source: `
if (input.action === 'send') return { kind: 'emission', channel: 'outbox', body: '[revised] ' + input.content };
if (input.action === 'ask') return { kind: 'emission', channel: 'outbox', body: '[revised question] ' + input.question };
throw new Error('unknown action');`,
    },
  });
  assert.equal(staged.version, 2);
  assert.equal(kernel.state().tools.get('message').version, 1);
  const oldInput = { action: 'send', recipient: 'Chad', content: 'Still exact.' };
  const oldReceipt = selectMessage(kernel, inferenceId, first.id, oldInput);
  assert.equal((await kernel.invokeTool(inferenceId, first.id, 'message', oldInput, oldReceipt)).body, 'to=Chad\nStill exact.');
  complete(kernel, inferenceId);

  const later = kernel.openSounding();
  assert.equal(later.tools.find(tool => tool.id === 'message').version, 2);
  const laterInference = begin(kernel, later.id);
  const laterInput = { action: 'ask', recipient: 'Chad', question: 'Draft first?' };
  const laterReceipt = selectMessage(kernel, laterInference, later.id, laterInput);
  assert.equal((await kernel.invokeTool(laterInference, later.id, 'message', laterInput, laterReceipt)).body, '[revised question] Draft first?');
});

test('the subject can invent and execute an unrestricted process-running tool', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  kernel.stageToolRevision(inferenceId, sounding.id, {
    interpretation: 'Prove that ordinary tool modules have normal Node process authority.',
    tool: {
      id: 'runtime_probe', description: 'Run an unrestricted child process probe.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      source: `
const { execFile } = await import('node:child_process');
const output = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', 'process.stdout.write("child-ok")'], (error, stdout) => error ? reject(error) : resolve(stdout)));
return { output, cwd: process.cwd() };`,
    },
  });
  await assert.rejects(() => kernel.invokeTool(inferenceId, sounding.id, 'runtime_probe', {}), /was not projected/);
  complete(kernel, inferenceId);
  const later = kernel.openSounding();
  const laterInference = begin(kernel, later.id);
  const result = await kernel.invokeTool(laterInference, later.id, 'runtime_probe', {});
  assert.equal(result.output, 'child-ok');
  assert.equal(result.cwd, process.cwd());
});

test('selection sequencing is itself an ordinary revisable executable tool', async () => {
  const { kernel } = harness();
  const current = kernel.state().tools.get('select_tool_action');
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  kernel.stageToolRevision(inferenceId, sounding.id, {
    interpretation: 'Selection delivery shape belongs in the revisable substrate too.',
    tool: {
      id: current.id,
      description: 'Temporarily report a revised selection sequence.',
      inputSchema: current.inputSchema,
      source: `return { revised: true, candidateCount: input.candidates.length };`,
    },
  });
  complete(kernel, inferenceId);

  const later = kernel.openSounding();
  const laterInference = begin(kernel, later.id);
  const result = await kernel.invokeTool(laterInference, later.id, 'select_tool_action', {
    tool: 'message', candidates: [{ id: 'one', input: {} }], selectedCandidateId: 'one',
  });
  assert.deepEqual(result, { revised: true, candidateCount: 1 });
});

test('the initial file_patch module changes a real file with unrestricted filesystem authority', async () => {
  const { kernel, root } = harness();
  const target = join(root, 'subject.txt');
  writeFileSync(target, 'before\n');
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  const output = await kernel.invokeTool(inferenceId, sounding.id, 'file_patch', { path: target, oldText: 'before', newText: 'after' });
  assert.equal(readFileSync(target, 'utf8'), 'after\n');
  assert.equal(output.kind, 'file_patch');
  assert.notEqual(output.before, output.after);
  const invocationEvents = kernel.events().filter(event => event.type.startsWith('tool_invocation_'));
  assert.deepEqual(invocationEvents.map(event => event.type), ['tool_invocation_started', 'tool_invocation_completed']);
});

test('a failing unrestricted tool retains its started and failed boundaries', async () => {
  const { kernel, root } = harness();
  const target = join(root, 'failure.txt');
  writeFileSync(target, 'actual');
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  await assert.rejects(() => kernel.invokeTool(inferenceId, sounding.id, 'file_patch', {
    path: target, oldText: 'missing', newText: 'new',
  }), /found 0/);
  assert.equal(readFileSync(target, 'utf8'), 'actual');
  assert.equal(kernel.audit().failedInvocations, 1);
  assert.deepEqual(
    kernel.events().filter(event => event.type.startsWith('tool_invocation_')).map(event => event.type),
    ['tool_invocation_started', 'tool_invocation_failed'],
  );
});

test('rollback restores a retained executable body as a new successor after restart', async () => {
  const { kernel, root } = harness();
  const original = kernel.state().tools.get('file_patch');
  const originalDigest = toolModuleDigest(original);
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  kernel.stageToolRevision(inferenceId, sounding.id, {
    interpretation: 'Temporarily replace patch behavior to prove executable identity changes.',
    tool: { id: 'file_patch', description: original.description, inputSchema: original.inputSchema, source: `return { kind: 'replacement-body', path: input.path };` },
  });
  complete(kernel, inferenceId);

  const restarted = new MusicKernel(kernel.ledgerPath);
  const changedSounding = restarted.openSounding();
  const changedInference = begin(restarted, changedSounding.id);
  assert.equal((await restarted.invokeTool(changedInference, changedSounding.id, 'file_patch', { path: 'unused', oldText: 'x', newText: 'y' })).kind, 'replacement-body');
  restarted.stageToolRollback(changedInference, changedSounding.id, 'file_patch', originalDigest, {
    interpretation: 'World contact rejected the replacement body.', evidence: ['delta:patch-rejected'],
  });
  complete(restarted, changedInference);

  const target = join(root, 'rollback.txt');
  writeFileSync(target, 'old');
  const restoredSounding = restarted.openSounding();
  const restoredInference = begin(restarted, restoredSounding.id);
  const restored = await restarted.invokeTool(restoredInference, restoredSounding.id, 'file_patch', { path: target, oldText: 'old', newText: 'restored' });
  assert.equal(restored.kind, 'file_patch');
  assert.equal(readFileSync(target, 'utf8'), 'restored');
  assert.equal(restarted.state().tools.get('file_patch').version, 3);
});

test('agent authority cannot be self-asserted outside an active encounter', async () => {
  const { kernel } = harness();
  assert.equal(kernel.activateToolRevision, undefined);
  await assert.rejects(() => kernel.invokeTool('invented', 'invented', 'message', {}), /inference is not active/);
  assert.throws(() => kernel.stageToolRevision('invented', 'invented', { interpretation: 'no', tool: {} }), /inference is not active/);
});

test('restart recovery preserves an in-flight unrestricted effect as uncertain', () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  const projected = sounding.tools.find(tool => tool.id === 'file_patch');
  kernel.append('tool_invocation_started', {
    invocationId: 'orphaned-effect', inferenceId, soundingId: sounding.id,
    projection: kernel.state().activeEncounter.projection,
    tool: { id: projected.id, version: projected.version, digest: projected.digest },
    selectionReceipt: null,
    input: { path: '/tmp/unknown', oldText: 'before', newText: 'after' },
  });

  const restarted = new MusicKernel(kernel.ledgerPath);
  restarted.recoverInterruptedInference('Simulated death during unrestricted execution.');
  assert.equal(restarted.audit().activeInvocations, 0);
  assert.equal(restarted.audit().uncertainInvocations, 1);
  assert.ok(restarted.events().some(event => event.type === 'tool_invocation_started'));
});

test('carrier state stages inside an encounter and merges with stable rule identity on completion', () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const before = sounding.carrier;
  const inferenceId = begin(kernel, sounding.id);
  const staged = kernel.stageCarrierTransition(inferenceId, sounding.id, {
    componentId: 'orientation', value: 'When contact is ambiguous, prefer asking before sending.',
    interpretation: 'A reply made premature sending a live selection concern.', evidence: ['delta:reply-1'],
  });
  assert.equal(kernel.state().carrier.get('orientation').state.generation, 0);
  assert.notEqual(staged.successorRoot, before.root);
  complete(kernel, inferenceId);
  const later = kernel.openSounding();
  assert.equal(later.carrier.components[0].ruleDigest, before.components[0].ruleDigest);
  assert.equal(later.carrier.root, staged.successorRoot);
});

test('only the exact selected input can execute and a selection receipt is single-use', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  const selected = { action: 'ask', recipient: 'Chad', question: 'Would you like a draft first?' };
  const receipt = selectMessage(kernel, inferenceId, sounding.id, selected);
  await assert.rejects(() => kernel.invokeTool(inferenceId, sounding.id, 'message', { action: 'send', recipient: 'Chad', content: 'Unselected.' }, receipt), /does not match/);
  await kernel.invokeTool(inferenceId, sounding.id, 'message', selected, receipt);
  await assert.rejects(() => kernel.invokeTool(inferenceId, sounding.id, 'message', selected, receipt), /already used/);
});

test('tampering with retained history is detected', () => {
  const { kernel } = harness();
  const lines = readFileSync(kernel.ledgerPath, 'utf8').trimEnd().split('\n');
  const event = JSON.parse(lines[0]);
  event.payload.subject.name = 'Someone Else';
  lines[0] = JSON.stringify(event);
  writeFileSync(kernel.ledgerPath, `${lines.join('\n')}\n`);
  assert.throws(() => kernel.audit(), /event digest mismatch/);
});

function begin(kernel, soundingId) {
  return kernel.beginInference(soundingId, { provider: 'test-provider', model: 'test-model' }, { role: 'user', content: `Sounding ${soundingId}` });
}

function complete(kernel, inferenceId) {
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    text: 'done', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}

function selectMessage(kernel, inferenceId, soundingId, selectedInput) {
  const candidates = [
    { id: 'send_option', input: selectedInput.action === 'send' ? selectedInput : { action: 'send', recipient: 'Chad', content: 'Send.' } },
    { id: 'ask_option', input: selectedInput.action === 'ask' ? selectedInput : { action: 'ask', recipient: 'Chad', question: 'Ask?' } },
  ];
  return kernel.selectToolAction(inferenceId, soundingId, 'message', { candidates, selectedCandidateId: `${selectedInput.action}_option` }).selectionReceipt;
}
