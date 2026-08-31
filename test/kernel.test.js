import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('world consequence changes real file_patch behavior and later correction restores it', async () => {
  const { kernel, root } = harness();
  const originalDigest = toolModuleDigest(kernel.state().tools.get('file_patch'));
  const firstTarget = join(root, 'first.txt');
  writeFileSync(firstTarget, 'before');
  const firstSounding = kernel.openSounding();
  const firstInference = begin(kernel, firstSounding.id);
  await kernel.invokeTool(firstInference, firstSounding.id, 'file_patch', {
    path: firstTarget, oldText: 'before', newText: 'after',
  });
  complete(kernel, firstInference);
  const firstInvocationId = kernel.state().invocations.at(-1).invocationId;

  kernel.admitDelta({
    authority: 'world', id: 'patch-feedback-1', stream: 'workspace', at: '2026-08-30T13:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId: firstInvocationId }],
    payload: { observation: 'The replacement succeeded, but a backup should exist before future patches.' },
  });
  const learningSounding = kernel.openSounding('delta');
  assert.equal(learningSounding.deltas[0].bearsOn[0].invocationId, firstInvocationId);
  const learningInference = begin(kernel, learningSounding.id);
  const deferred = await kernel.invokeTool(learningInference, learningSounding.id, 'attend_consequence', {
    deltaId: 'patch-feedback-1', action: 'defer',
    interpretation: 'This matters to file_patch, but I want to change the implementation in a later encounter.',
  });
  assert.equal(deferred.action, 'defer');
  complete(kernel, learningInference);

  const revisionSounding = kernel.openSounding();
  assert.equal(revisionSounding.deltas.length, 0);
  assert.equal(revisionSounding.unresolvedConsequences[0].delta.id, 'patch-feedback-1');
  assert.equal(revisionSounding.unresolvedConsequences[0].status, 'deferred');
  const revisionInference = begin(kernel, revisionSounding.id);
  const current = kernel.state().tools.get('file_patch');
  kernel.stageToolRevision(revisionInference, revisionSounding.id, {
    interpretation: 'This consequence bears on file_patch: preserve the prior file beside future patched files.',
    consequenceDeltaIds: ['patch-feedback-1'],
    tool: {
      id: 'file_patch', description: 'Back up a file, then apply an exact textual replacement.', inputSchema: current.inputSchema,
      source: `
const { readFile, writeFile, copyFile } = await import('node:fs/promises');
const before = await readFile(input.path, 'utf8');
const occurrences = before.split(input.oldText).length - 1;
if (occurrences !== (input.expectedOccurrences ?? 1)) throw new Error('unexpected occurrence count');
await copyFile(input.path, input.path + '.music-backup');
await writeFile(input.path, before.split(input.oldText).join(input.newText));
return { kind: 'backing-file-patch', path: input.path, backup: input.path + '.music-backup' };`,
    },
  });
  await kernel.invokeTool(revisionInference, revisionSounding.id, 'attend_consequence', {
    deltaId: 'patch-feedback-1', action: 'settle',
    interpretation: 'I have now embodied what I take this observation to require in the file_patch successor.',
    evidence: ['tool:file_patch@2'],
  });
  complete(kernel, revisionInference);
  const learnedEvent = kernel.events().findLast(event => event.type === 'tool_revision_staged');
  assert.deepEqual(learnedEvent.payload.consequences, [{ deltaId: 'patch-feedback-1', invocationIds: [firstInvocationId] }]);

  const secondTarget = join(root, 'second.txt');
  writeFileSync(secondTarget, 'old');
  const changedSounding = kernel.openSounding();
  const changedInference = begin(kernel, changedSounding.id);
  const learnedTool = kernel.state().tools.get('file_patch');
  assert.equal(changedSounding.unresolvedConsequences.length, 0);
  assert.throws(() => kernel.stageToolRevision(changedInference, changedSounding.id, {
    interpretation: 'This must not claim consequence evidence absent from the current encounter.',
    consequenceDeltaIds: ['patch-feedback-1'],
    tool: {
      id: learnedTool.id, description: learnedTool.description,
      inputSchema: learnedTool.inputSchema, source: learnedTool.source,
    },
  }), /not delivered in this Sounding/);
  const changedOutput = await kernel.invokeTool(changedInference, changedSounding.id, 'file_patch', {
    path: secondTarget, oldText: 'old', newText: 'new',
  });
  complete(kernel, changedInference);
  assert.equal(changedOutput.kind, 'backing-file-patch');
  assert.equal(readFileSync(`${secondTarget}.music-backup`, 'utf8'), 'old');
  const changedInvocationId = kernel.state().invocations.at(-1).invocationId;

  kernel.admitDelta({
    authority: 'world', id: 'patch-correction-1', stream: 'workspace', at: '2026-08-30T14:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId: changedInvocationId }],
    payload: { observation: 'The extra backup file was undesirable; return to the earlier patch behavior.' },
  });
  const correctionSounding = kernel.openSounding('delta');
  const correctionInference = begin(kernel, correctionSounding.id);
  kernel.stageToolRollback(correctionInference, correctionSounding.id, 'file_patch', originalDigest, {
    interpretation: 'The corrective consequence rejects the learned backup behavior.',
    consequenceDeltaIds: ['patch-correction-1'],
  });
  complete(kernel, correctionInference);

  const restoredTarget = join(root, 'restored.txt');
  writeFileSync(restoredTarget, 'left');
  const restoredSounding = kernel.openSounding();
  const restoredInference = begin(kernel, restoredSounding.id);
  const restoredOutput = await kernel.invokeTool(restoredInference, restoredSounding.id, 'file_patch', {
    path: restoredTarget, oldText: 'left', newText: 'right',
  });
  complete(kernel, restoredInference);
  assert.equal(restoredOutput.kind, 'file_patch');
  assert.equal(existsSync(`${restoredTarget}.music-backup`), false);
  const rollbackEvent = kernel.events().findLast(event => event.type === 'tool_revision_staged');
  assert.deepEqual(rollbackEvent.payload.consequences, [{ deltaId: 'patch-correction-1', invocationIds: [changedInvocationId] }]);
});

test('world consequence cannot cite an invocation Music has never retained', () => {
  const { kernel } = harness();
  assert.throws(() => kernel.admitDelta({
    authority: 'world', id: 'counterfeit-contact', stream: 'workspace', at: '2026-08-30T13:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId: 'missing-invocation' }],
    payload: { observation: 'This reference was invented.' },
  }), /unknown tool invocation/);
});

test('an interrupted encounter cannot settle a deferred consequence', async () => {
  const { kernel, root } = harness();
  const target = join(root, 'deferred.txt');
  writeFileSync(target, 'before');
  const actionSounding = kernel.openSounding();
  const actionInference = begin(kernel, actionSounding.id);
  await kernel.invokeTool(actionInference, actionSounding.id, 'file_patch', {
    path: target, oldText: 'before', newText: 'after',
  });
  complete(kernel, actionInference);
  const invocationId = kernel.state().invocations.at(-1).invocationId;
  kernel.admitDelta({
    authority: 'world', id: 'deferred-through-failure', stream: 'workspace', at: '2026-08-30T13:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId }], payload: { observation: 'Revisit this later.' },
  });
  const first = kernel.openSounding('delta');
  const firstInference = begin(kernel, first.id);
  await kernel.invokeTool(firstInference, first.id, 'attend_consequence', {
    deltaId: 'deferred-through-failure', action: 'defer', interpretation: 'I am deliberately retaining this for later attention.',
  });
  complete(kernel, firstInference);

  const interrupted = kernel.openSounding();
  const interruptedInference = begin(kernel, interrupted.id);
  await kernel.invokeTool(interruptedInference, interrupted.id, 'attend_consequence', {
    deltaId: 'deferred-through-failure', action: 'settle', interpretation: 'This judgment must not activate if the encounter fails.',
  });
  kernel.failInference(interruptedInference, new Error('simulated failure after disposition'));

  assert.equal(kernel.audit().deferredConsequences, 1);
  const recovered = kernel.openSounding();
  assert.equal(recovered.unresolvedConsequences[0].delta.id, 'deferred-through-failure');
  assert.equal(recovered.unresolvedConsequences[0].status, 'deferred');
});

test('initial and live-steered Deltas return without duplication after interrupted inference', () => {
  const { kernel } = harness();
  kernel.admitDelta({
    authority: 'world', id: 'initial-contact', stream: 'inbox', at: '2026-08-30T13:00:00.000Z', payload: { content: 'first' },
  });
  const sounding = kernel.openSounding('delta');
  const inferenceId = begin(kernel, sounding.id);
  kernel.admitDelta({
    authority: 'world', id: 'live-contact', stream: 'inbox', at: '2026-08-30T13:01:00.000Z', payload: { content: 'second' },
  });
  assert.throws(() => kernel.steerInference(
    inferenceId,
    ['invented-contact'],
    [],
    { role: 'user', content: 'counterfeit steering' },
  ), /does not match pending world contact/);
  kernel.steerInference(
    inferenceId,
    ['live-contact'],
    [{ role: 'assistant', content: [{ type: 'text', text: 'I saw the first contact.' }] }],
    { role: 'user', content: '[live_steering]\nsecond\n[/live_steering]' },
  );
  assert.equal(kernel.audit().steeringEvents, 1);
  assert.equal(kernel.audit().steeredDeltas, 1);
  assert.equal(kernel.state().pendingDeltas.length, 0);
  kernel.failInference(inferenceId, new Error('failure after live steering'));

  const restarted = new MusicKernel(kernel.ledgerPath);
  assert.deepEqual(restarted.state().pendingDeltas.map(delta => delta.id), ['initial-contact', 'live-contact']);
  const retry = restarted.openSounding('delta');
  assert.deepEqual(retry.deltas.map(delta => delta.id), ['initial-contact', 'live-contact']);
  const retryInference = begin(restarted, retry.id);
  restarted.failInference(retryInference, new Error('second failure before completion'));
  assert.deepEqual(restarted.state().pendingDeltas.map(delta => delta.id), ['initial-contact', 'live-contact']);
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
  assert.equal(restarted.audit().uncertainInvocationsWithoutWorldContact, 1);
  assert.ok(restarted.events().some(event => event.type === 'tool_invocation_started'));
  restarted.admitDelta({
    authority: 'world', id: 'orphan-reconciliation', stream: 'workspace', at: '2026-08-30T13:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId: 'orphaned-effect' }],
    payload: { observation: 'The target still contains its prior contents.' },
  });
  assert.equal(restarted.audit().uncertainInvocations, 1);
  assert.equal(restarted.audit().uncertainInvocationsWithoutWorldContact, 0);
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
