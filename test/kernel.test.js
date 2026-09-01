import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { canonical, digest } from '../src/canonical.js';
import { serializeCarrier } from '../src/carrier.js';
import { MusicKernel } from '../src/kernel.js';
import { toolModuleDigest } from '../src/tool-module.js';
import { initialTools } from '../src/seeds.js';

function harness(kernelOptions = {}, seedTools = initialTools()) {
  const root = mkdtempSync(join(tmpdir(), 'music-test-'));
  let tick = 0;
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), {
    clock: () => new Date(Date.UTC(2026, 7, 30, 12, 0, tick++)),
    id: () => `id-${++identity}`,
    toolEnvironment: { mailboxRoot: join(root, 'mailbox'), dependencyRoot: join(root, 'dependencies') },
    ...kernelOptions,
  });
  kernel.initialize('Test Subject', seedTools);
  return { kernel, root };
}

test('opening a Sounding reserves Deltas; beginning its exact encounter acknowledges them', () => {
  const { kernel } = harness();
  const subject = kernel.state().subject;
  kernel.admitDelta({ authority: 'world', id: 'reply-1', stream: 'inbox', at: '2026-08-30T12:00:00.000Z', payload: { content: 'Ask first.' } });
  const sounding = kernel.openSounding('delta');
  assert.equal(sounding.subject.id, subject.id);
  assert.equal(sounding.position.root, kernel.state().position.root);
  assert.deepEqual(sounding.position.activeOpening.content, { origin: 'birth' });
  assert.deepEqual(sounding.deltas.map(delta => delta.id), ['reply-1']);
  assert.equal(kernel.state().pendingDeltas.length, 1);
  assert.throws(() => kernel.openSounding(), /still awaiting an encounter/);
  const inferenceId = begin(kernel, sounding.id);
  const positionRoot = sounding.position.root;
  assert.equal(kernel.state().pendingDeltas.length, 0);
  complete(kernel, inferenceId);
  assert.equal(kernel.state().position.root, positionRoot);
  assert.equal(kernel.state().soundings.get(sounding.id).status, 'completed');
});

test('an oversized contact burst is sealed as ordered retained batches and eventually delivered', async () => {
  const { kernel } = harness();
  const ids = [];
  for (let index = 0; index < 36; index += 1) {
    const id = `burst-${index}`;
    ids.push(id);
    kernel.admitDelta({
      authority: 'world', id, stream: 'inbox', at: `2026-08-30T12:${String(index).padStart(2, '0')}:00.000Z`,
      payload: { content: 'x'.repeat(60_000) },
    });
  }

  const delivered = [];
  const frontiers = [];
  while (kernel.state().pendingDeltas.length > 0) {
    const sounding = kernel.openSounding('delta');
    frontiers.push(sounding.frontier.pending);
    delivered.push(...sounding.deltas.map(delta => delta.id));
    const projection = await kernel.projectEncounter(sounding.id, 'sounding');
    assert.equal(Buffer.byteLength(JSON.stringify(projection.message)) <= 2 * 1_024 * 1_024, true);
    const inferenceId = beginProjected(kernel, sounding.id, projection);
    complete(kernel, inferenceId);
  }

  assert.deepEqual(delivered, ids);
  assert.equal(frontiers.length > 1, true);
  assert.equal(frontiers[0].remaining, ids.length - frontiers[0].included);
  assert.equal(frontiers[0].nextId, ids[frontiers[0].included]);
  assert.equal(frontiers.at(-1).remaining, 0);
  assert.equal(kernel.audit().pendingDeltas, 0);
});

test('interruption and restart preserve the exact unopened contact frontier', async () => {
  const { kernel } = harness();
  for (let index = 0; index < 36; index += 1) {
    kernel.admitDelta({
      authority: 'world', id: `restart-burst-${index}`, stream: 'inbox', at: `2026-08-30T12:${String(index).padStart(2, '0')}:00.000Z`,
      payload: { content: 'x'.repeat(60_000) },
    });
  }
  const first = kernel.openSounding('delta');
  const projection = await kernel.projectEncounter(first.id, 'sounding');
  const inferenceId = beginProjected(kernel, first.id, projection);
  kernel.failInference(inferenceId, new Error('capacity restart probe'));

  const reconstructed = new MusicKernel(kernel.ledgerPath, { toolEnvironment: kernel.toolEnvironment });
  assert.deepEqual(reconstructed.state().pendingDeltas.map(delta => delta.id), Array.from({ length: 36 }, (_, index) => `restart-burst-${index}`));
  const retried = reconstructed.openSounding('delta');
  assert.deepEqual(retried.deltas.map(delta => delta.id), first.deltas.map(delta => delta.id));
  assert.equal(retried.frontier.pending.queueDigest, first.frontier.pending.queueDigest);
  assert.equal((await reconstructed.projectEncounter(retried.id, 'sounding')).mode, 'tool');
});

test('live steering admits only a bounded prefix and preserves burst order across projections', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding('manual');
  const initial = await kernel.projectEncounter(sounding.id, 'sounding');
  const inferenceId = beginProjected(kernel, sounding.id, initial);
  const ids = [];
  for (let index = 0; index < 36; index += 1) {
    const id = `steering-burst-${index}`;
    ids.push(id);
    kernel.admitDelta({
      authority: 'world', id, stream: 'inbox', at: `2026-08-30T13:${String(index).padStart(2, '0')}:00.000Z`,
      payload: { content: 'x'.repeat(60_000) },
    });
  }

  const delivered = [];
  let batches = 0;
  while (kernel.pendingSteeringDeltas(inferenceId).length > 0) {
    const batch = kernel.pendingSteeringDeltas(inferenceId);
    const idsInBatch = batch.map(delta => delta.id);
    const projection = await kernel.projectEncounter(sounding.id, 'steering', idsInBatch);
    kernel.steerInference(inferenceId, idsInBatch, [], projection.message, projection.projectionId);
    delivered.push(...idsInBatch);
    batches += 1;
  }
  complete(kernel, inferenceId);

  assert.equal(batches > 1, true);
  assert.deepEqual(delivered, ids);
  assert.equal(kernel.audit().pendingDeltas, 0);
  assert.equal(kernel.audit().steeredDeltas, ids.length);
});

test('unresolved consequences complete one bounded sweep without starvation or immediate repetition', async () => {
  const { kernel } = harness();
  const actionSounding = kernel.openSounding('manual');
  const actionInference = begin(kernel, actionSounding.id);
  const input = { action: 'send', recipient: 'Chad', content: 'Establish consequence lineage.' };
  const receipt = selectMessage(kernel, actionInference, actionSounding.id, input);
  const invocation = await kernel.invokeTool(actionInference, actionSounding.id, 'message', input, receipt);
  complete(kernel, actionInference);

  for (let index = 0; index < 130; index += 1) {
    kernel.admitDelta({
      authority: 'world', id: `consequence-${index}`, stream: 'inbox', at: `2026-08-30T14:${String(index % 60).padStart(2, '0')}:00.000Z`,
      bearsOn: [{ kind: 'tool-invocation', invocationId: invocation.invocationId }],
      payload: { content: `consequence ${index}` },
    });
  }

  while (kernel.state().pendingDeltas.length > 0) {
    const sounding = kernel.openSounding('delta');
    const inferenceId = begin(kernel, sounding.id);
    complete(kernel, inferenceId);
  }
  assert.equal(kernel.state().consequenceSweepActive, false);

  const projected = [];
  let trigger = 'heartbeat';
  do {
    const sounding = kernel.openSounding(trigger);
    projected.push(...sounding.unresolvedConsequences.map(consequence => consequence.delta.id));
    const projection = await kernel.projectEncounter(sounding.id, 'sounding');
    const inferenceId = beginProjected(kernel, sounding.id, projection);
    complete(kernel, inferenceId);
    trigger = 'continuation';
  } while (kernel.state().consequenceSweepActive);

  assert.equal(new Set(projected).size, 130);
  assert.equal(projected.length, 130);
  assert.equal(kernel.audit().unprojectedConsequences, 0);
  assert.equal(kernel.audit().consequenceSweepActive, false);
});

test('provisional learned geometry is refused at admission before it can consume the active contact envelope', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding('manual');
  const inferenceId = begin(kernel, sounding.id);
  const authored = Array.from({ length: 10 }, (_, index) => kernel.authorToolProposal(inferenceId, sounding.id, {
    interpretation: 'Capacity probe.',
    tool: {
      id: `too_wide_${index}`,
      description: 'A deliberately wide projected schema.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['x'.repeat(60_000)] } },
        required: ['value'], additionalProperties: false,
      },
      source: 'return { ok: true };',
    },
  }));
  complete(kernel, inferenceId);
  const trial = kernel.openSounding('manual');
  const trialInference = begin(kernel, trial.id);
  for (const proposal of authored) {
    await kernel.trialDevelopmentalProposal(trialInference, trial.id, proposal.proposalId, {});
  }
  complete(kernel, trialInference);
  const admission = kernel.openSounding('manual');
  const admissionInference = begin(kernel, admission.id);
  assert.throws(() => kernel.stageDevelopmentalTransaction(admissionInference, admission.id, {
    interpretation: 'Attempt to admit the exercised but oversized successor.',
    decisions: authored.map(proposal => ({
      proposalId: proposal.proposalId, disposition: 'admit', interpretation: 'Exercise completed.',
    })),
  }), /active tool, carrier, and position geometry exceeds/);
  kernel.failInference(admissionInference, new Error('oversized admission refused'));
  assert.equal(kernel.state().tools.has('too_wide_0'), false);
});

test('an ordinary tool authors a durable future opening that becomes exact Sounding contact', async () => {
  let now = Date.UTC(2026, 7, 30, 15, 0, 0);
  const { kernel } = harness({ clock: () => new Date(now) });
  const first = kernel.openSounding('manual');
  const inferenceId = begin(kernel, first.id);
  const scheduled = await kernel.invokeTool(inferenceId, first.id, 'schedule_wake', {
    afterMs: 10_000,
    reason: 'Return to the unfinished thought.',
  });
  complete(kernel, inferenceId);

  assert.equal(kernel.audit().nextWake, null);
  assert.equal(kernel.audit().activeOpening.notBefore, new Date(now + 10_000).toISOString());
  assert.equal(kernel.audit().activeOpening.id, scheduled.opening.successor.id);
  assert.equal(kernel.audit().activeOpening.content.invocationId, kernel.state().invocations.at(-1).invocationId);
  const reconstructed = new MusicKernel(kernel.ledgerPath, {
    clock: () => new Date(now),
    toolEnvironment: kernel.toolEnvironment,
  });
  assert.equal(reconstructed.audit().activeOpening.id, scheduled.opening.successor.id);
  now += 9_999;
  assert.throws(() => reconstructed.openSounding('opening'), /not due/);
  now += 1;
  const waking = reconstructed.openSounding('opening');
  assert.equal(waking.wake, null);
  assert.equal(waking.position.activeOpening.id, scheduled.opening.successor.id);
  assert.equal(waking.position.activeOpening.notBefore, new Date(now).toISOString());
  assert.equal(waking.position.activeOpening.content.reason, 'Return to the unfinished thought.');
  const projected = await reconstructed.projectEncounter(waking.id, 'sounding');
  assert.match(projected.message.content, /sounding:position/);
  assert.match(projected.message.content, /Return to the unfinished thought/);
});

test('developmental admission and trajectory maintenance compose into one atomic encounter transaction', async () => {
  const { kernel } = harness();
  const authoredSounding = kernel.openSounding('manual');
  const authoredInference = begin(kernel, authoredSounding.id);
  const proposal = kernel.authorToolProposal(authoredInference, authoredSounding.id, {
    interpretation: 'Add a real tool before retaining the next opening.',
    tool: {
      id: 'composed_probe',
      description: 'Return a retained composition probe.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      source: 'return { composed: true };',
    },
  });
  complete(kernel, authoredInference);

  const trialSounding = kernel.openSounding('manual');
  const trialInference = begin(kernel, trialSounding.id);
  await kernel.trialDevelopmentalProposal(trialInference, trialSounding.id, proposal.proposalId, {});
  complete(kernel, trialInference);

  const encounter = kernel.openSounding('manual');
  const inferenceId = begin(kernel, encounter.id);
  const admission = kernel.stageDevelopmentalTransaction(inferenceId, encounter.id, {
    interpretation: 'Admit the exercised tool without sacrificing trajectory maintenance.',
    evidence: ['completed tool trial'],
    decisions: [{
      proposalId: proposal.proposalId,
      disposition: 'admit',
      interpretation: 'The retained trial completed with the proposed behavior.',
    }],
  });
  const scheduled = await kernel.invokeTool(inferenceId, encounter.id, 'schedule_wake', {
    afterMs: 60_000,
    reason: 'Continue with the newly admitted tool.',
  });
  assert.equal(scheduled.transactionId, admission.transactionId);
  assert.equal(scheduled.decisions.length, 1);
  assert.equal(scheduled.opening.successor.content.reason, 'Continue with the newly admitted tool.');
  const amendment = kernel.events().findLast(event => event.type === 'developmental_transaction_amended');
  assert.equal(amendment.payload.transaction.transactionId, admission.transactionId);
  complete(kernel, inferenceId);

  assert.equal(kernel.audit().tools.some(tool => tool.id === 'composed_probe'), true);
  assert.equal(kernel.audit().activeOpening.id, scheduled.opening.successor.id);
  const reconstructed = new MusicKernel(kernel.ledgerPath, { toolEnvironment: kernel.toolEnvironment });
  assert.equal(reconstructed.audit().tools.some(tool => tool.id === 'composed_probe'), true);
  assert.equal(reconstructed.audit().activeOpening.id, scheduled.opening.successor.id);
});

test('ordinary carrier-authoring output receives an authoritative provisional lifecycle receipt', async () => {
  const legacyCarrierTool = {
    id: 'legacy_context',
    version: 1,
    parent: null,
    description: 'Reproduce an earlier ambiguous carrier-authoring result.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    source: `
const transition = context.stageCarrierTransition({
  componentId: 'continuity', value: input.value,
  interpretation: 'Retain this as a provisional compatibility proposal.',
});
return { successorRoot: transition.successorRoot, visible: 'next-sounding' };`,
  };
  const { kernel } = harness({}, [...initialTools(), legacyCarrierTool]);
  const sounding = kernel.openSounding('manual');
  const inferenceId = begin(kernel, sounding.id);
  const result = await kernel.invokeTool(inferenceId, sounding.id, 'legacy_context', { value: 'Not active yet.' });

  assert.equal(result.format, 'music-tool-result-with-development-1');
  assert.equal(result.ordinaryOutput.visible, 'next-sounding');
  assert.deepEqual(result.developmentalEffects.map(effect => ({
    kind: effect.kind,
    status: effect.status,
    active: effect.active,
    frontierVisibility: effect.frontierVisibility,
    governsActiveGeometry: effect.governsActiveGeometry,
  })), [{
    kind: 'carrier', status: 'authored', active: false,
    frontierVisibility: 'next-sounding', governsActiveGeometry: false,
  }]);
  complete(kernel, inferenceId);
  assert.equal(kernel.state().carrier.get('continuity').state.generation, 0);
  const later = kernel.openSounding('manual');
  assert.equal(later.development.proposals.some(candidate =>
    candidate.proposalId === result.developmentalEffects[0].proposalId && candidate.status === 'authored'), true);
});

test('interruption restores presentation of the exact opening that opened the failed encounter', async () => {
  let now = Date.UTC(2026, 7, 30, 16, 0, 0);
  const { kernel } = harness({ clock: () => new Date(now) });
  const first = kernel.openSounding('manual');
  const firstInference = begin(kernel, first.id);
  const scheduled = await kernel.invokeTool(firstInference, first.id, 'schedule_wake', {
    afterMs: 1_000,
    reason: 'Resume this trajectory.',
  });
  complete(kernel, firstInference);
  now += 1_000;
  const waking = kernel.openSounding('opening');
  const failedInference = begin(kernel, waking.id);
  kernel.failInference(failedInference, new Error('right-censored opening'));

  assert.equal(kernel.audit().activeOpening.id, scheduled.opening.successor.id);
  assert.equal(kernel.audit().activeOpeningPresented, false);
  const retried = kernel.openSounding('opening');
  assert.equal(retried.position.activeOpening.id, scheduled.opening.successor.id);
});

test('world contact before an opening is due preserves it for later presentation', async () => {
  let now = Date.UTC(2026, 7, 30, 17, 0, 0);
  const { kernel } = harness({ clock: () => new Date(now) });
  const first = kernel.openSounding('manual');
  const firstInference = begin(kernel, first.id);
  await kernel.invokeTool(firstInference, first.id, 'schedule_wake', {
    afterMs: 60_000,
    reason: 'Wake later if the world remains quiet.',
  });
  complete(kernel, firstInference);
  kernel.admitDelta({
    authority: 'world', id: 'wake-preempting-contact', stream: 'inbox', at: new Date(now).toISOString(), payload: { content: 'Earlier contact.' },
  });
  const contacted = kernel.openSounding('delta');

  assert.equal(contacted.wake, null);
  assert.equal(contacted.position.activeOpening.content.reason, 'Wake later if the world remains quiet.');
  const inferenceId = begin(kernel, contacted.id);
  complete(kernel, inferenceId);
  assert.equal(kernel.audit().nextWake, null);
  assert.equal(kernel.audit().activeOpeningPresented, false);
  now += 60_000;
  const opened = kernel.openSounding('opening');
  assert.equal(opened.position.activeOpening.content.reason, 'Wake later if the world remains quiet.');
});

test('a failed inference cannot commit its newly authored successor opening', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding('manual');
  const inferenceId = begin(kernel, sounding.id);
  await kernel.invokeTool(inferenceId, sounding.id, 'schedule_wake', {
    afterMs: 10_000,
    reason: 'This proposal must remain provisional.',
  });
  kernel.failInference(inferenceId, new Error('do not promote'));
  assert.equal(kernel.audit().nextWake, null);
  assert.deepEqual(kernel.audit().activeOpening.content, { origin: 'birth' });
});

test('the subject can revise the ordinary geometry that constructs its later opening', async () => {
  const { kernel } = harness();
  const revisionSounding = kernel.openSounding('manual');
  const revisionInference = begin(kernel, revisionSounding.id);
  const current = kernel.inspectTool(revisionInference, revisionSounding.id, 'schedule_wake');
  const authored = kernel.authorToolProposal(revisionInference, revisionSounding.id, {
    interpretation: 'Give this scheduler a deliberate settling interval.',
    tool: {
      id: 'schedule_wake',
      description: current.description,
      inputSchema: current.inputSchema,
      source: `return context.stageWakeTransition({ afterMs: input.afterMs * 2, reason: 'settled: ' + input.reason });`,
    },
  });
  complete(kernel, revisionInference);
  await exerciseAndAdmitProposal(kernel, authored.proposalId, {
    afterMs: 2_000, reason: 'Trial the revised temporal transform.',
  });

  const later = kernel.openSounding('manual');
  const laterInference = begin(kernel, later.id);
  const result = await kernel.invokeTool(laterInference, later.id, 'schedule_wake', {
    afterMs: 2_000,
    reason: 'Revisit the question.',
  });
  complete(kernel, laterInference);

  assert.equal(Date.parse(result.opening.successor.notBefore) - Date.parse(result.opening.successor.authoredAt), 4_000);
  assert.equal(kernel.audit().activeOpening.content.reason, 'settled: Revisit the question.');
  assert.equal(kernel.audit().tools.find(tool => tool.id === 'schedule_wake').version, 2);
});

test('a provisional executable revision cannot alter the current projection and activates only after admission', async () => {
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
  const authored = kernel.authorToolProposal(inferenceId, first.id, {
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
  assert.equal(authored.revision.tool.version, 2);
  assert.equal(kernel.state().tools.get('message').version, 1);
  const oldInput = { action: 'send', recipient: 'Chad', content: 'Still exact.' };
  const oldReceipt = selectMessage(kernel, inferenceId, first.id, oldInput);
  assert.equal((await kernel.invokeTool(inferenceId, first.id, 'message', oldInput, oldReceipt)).body, 'to=Chad\nStill exact.');
  complete(kernel, inferenceId);

  await exerciseAndAdmitProposal(kernel, authored.proposalId, {
    action: 'send', recipient: 'Chad', content: 'Exercise the provisional body.',
  });

  const later = kernel.openSounding();
  assert.equal(later.tools.find(tool => tool.id === 'message').version, 2);
  const laterInference = begin(kernel, later.id);
  const laterInput = { action: 'ask', recipient: 'Chad', question: 'Draft first?' };
  const laterReceipt = selectMessage(kernel, laterInference, later.id, laterInput);
  assert.equal((await kernel.invokeTool(laterInference, later.id, 'message', laterInput, laterReceipt)).body, '[revised question] Draft first?');
});

test('authored tool machinery remains provisional until exercised and explicitly admitted', async () => {
  const { kernel } = harness();
  const authoredSounding = kernel.openSounding('manual');
  const authoredInference = begin(kernel, authoredSounding.id);
  const initialPositionRoot = authoredSounding.position.root;
  const proposal = kernel.authorToolProposal(authoredInference, authoredSounding.id, {
    interpretation: 'Try a small new capability before allowing it to shape later action.',
    tool: {
      id: 'provisional_probe',
      description: 'Return a retained probe value.',
      inputSchema: {
        type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
      },
      source: 'return { observed: input.value, geometry: "provisional" };',
    },
  });
  assert.notEqual(kernel.state().position.root, initialPositionRoot);
  complete(kernel, authoredInference);

  const trialSounding = kernel.openSounding('manual');
  assert.equal(trialSounding.tools.some(tool => tool.id === 'provisional_probe'), false);
  assert.deepEqual(trialSounding.development.proposals, [{
    proposalId: proposal.proposalId,
    kind: 'tool',
    authoredAt: kernel.state().developmentalProposals.get(proposal.proposalId).authoredAt,
    status: 'authored',
    interpretation: 'Try a small new capability before allowing it to shape later action.',
    latestTrial: null,
    admissionEligible: false,
    target: {
      id: 'provisional_probe',
      version: 1,
      digest: toolModuleDigest(proposal.revision.tool),
    },
  }]);
  const trialInference = begin(kernel, trialSounding.id);
  const inspected = kernel.inspectDevelopment(trialInference, trialSounding.id, proposal.proposalId);
  assert.equal(inspected.status, 'authored');
  assert.match(inspected.tool.source, /geometry/);
  const trial = await kernel.trialDevelopmentalProposal(
    trialInference, trialSounding.id, proposal.proposalId, { value: 'contact' },
  );
  assert.deepEqual(trial.output, { observed: 'contact', geometry: 'provisional' });
  complete(kernel, trialInference);

  const admissionSounding = kernel.openSounding('manual');
  assert.equal(admissionSounding.tools.some(tool => tool.id === 'provisional_probe'), false);
  assert.equal(admissionSounding.development.proposals[0].proposalId, proposal.proposalId);
  assert.equal(admissionSounding.development.proposals[0].status, 'exercised');
  assert.equal(admissionSounding.development.proposals[0].latestTrial.status, 'completed');
  assert.equal(admissionSounding.development.proposals[0].admissionEligible, true);
  const admissionInference = begin(kernel, admissionSounding.id);
  const transaction = kernel.stageDevelopmentalTransaction(admissionInference, admissionSounding.id, {
    interpretation: 'The retained exercise supports admission.',
    decisions: [{
      proposalId: proposal.proposalId,
      disposition: 'admit',
      interpretation: 'Its actual result matched the proposed behavior.',
    }],
  });
  assert.equal(transaction.decisions[0].admissionBasis, 'exercise-only');
  complete(kernel, admissionInference);

  const activeSounding = kernel.openSounding('manual');
  assert.equal(activeSounding.position.parentPositionRoot, admissionSounding.position.root);
  assert.equal(activeSounding.tools.some(tool => tool.id === 'provisional_probe'), true);
  assert.equal(activeSounding.development.available, 0);
  const activeInference = begin(kernel, activeSounding.id);
  assert.deepEqual(
    await kernel.invokeTool(activeInference, activeSounding.id, 'provisional_probe', { value: 'later' }),
    { observed: 'later', geometry: 'provisional' },
  );
  assert.equal(
    kernel.inspectDevelopment(activeInference, activeSounding.id, proposal.proposalId).standing.at(-1).transactionId,
    transaction.transactionId,
  );
  assert.equal(
    kernel.inspectDevelopment(activeInference, activeSounding.id, proposal.proposalId).standing.at(-1).admissionBasis,
    'exercise-only',
  );
  complete(kernel, activeInference);
});

test('large unresolved development rotates through exact bounded Sounding pages', () => {
  const { kernel } = harness();
  const authoredSounding = kernel.openSounding('manual');
  const authoredInference = begin(kernel, authoredSounding.id);
  const proposalIds = [];
  for (let index = 0; index < 33; index += 1) {
    proposalIds.push(kernel.authorCarrierProposal(authoredInference, authoredSounding.id, {
      componentId: 'continuity',
      value: `Provisional continuity candidate ${index}.`,
      interpretation: `Keep candidate ${index} exact and unresolved until encountered.`,
    }).proposalId);
  }
  complete(kernel, authoredInference);

  const secondPage = kernel.openSounding('manual');
  assert.deepEqual(
    { available: secondPage.development.available, included: secondPage.development.included,
      remaining: secondPage.development.remaining, page: secondPage.development.page },
    { available: 33, included: 1, remaining: 32, page: { index: 1, count: 2 } },
  );
  const secondPageIds = secondPage.development.proposals.map(proposal => proposal.proposalId);
  const secondInference = begin(kernel, secondPage.id);
  complete(kernel, secondInference);

  const firstPage = kernel.openSounding('manual');
  assert.deepEqual(firstPage.development.page, { index: 0, count: 2 });
  assert.equal(firstPage.development.included, 32);
  assert.deepEqual(
    new Set([...firstPage.development.proposals.map(proposal => proposal.proposalId), ...secondPageIds]),
    new Set(proposalIds),
  );
});

test('the subject can invent and execute an unrestricted process-running tool', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  const authored = kernel.authorToolProposal(inferenceId, sounding.id, {
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
  await exerciseAndAdmitProposal(kernel, authored.proposalId, {});
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
  const authored = kernel.authorToolProposal(inferenceId, sounding.id, {
    interpretation: 'Selection delivery shape belongs in the revisable substrate too.',
    tool: {
      id: current.id,
      description: 'Temporarily report a revised selection sequence.',
      inputSchema: current.inputSchema,
      source: `return { revised: true, candidateCount: input.candidates.length };`,
    },
  });
  complete(kernel, inferenceId);
  await exerciseAndAdmitProposal(kernel, authored.proposalId, {
    tool: 'message', candidates: [{ id: 'one', input: {} }], selectedCandidateId: 'one',
  });

  const later = kernel.openSounding();
  const laterInference = begin(kernel, later.id);
  const result = await kernel.invokeTool(laterInference, later.id, 'select_tool_action', {
    tool: 'message', candidates: [{ id: 'one', input: {} }], selectedCandidateId: 'one',
  });
  assert.deepEqual(result, { revised: true, candidateCount: 1 });
});

test('a hanging learned encounter shaper reaches a stable deadline and preserves exact facts', async () => {
  const { kernel } = harness({ deliveryProjectionTimeoutMs: 10 });
  const current = kernel.state().tools.get('shape_encounter');
  const revisionSounding = kernel.openSounding();
  const revisionInference = begin(kernel, revisionSounding.id);
  const authored = kernel.authorToolProposal(revisionInference, revisionSounding.id, {
    interpretation: 'Exercise recovery when learned delivery geometry never returns.',
    tool: {
      id: current.id,
      description: current.description,
      inputSchema: current.inputSchema,
      source: `
if (input.trigger === 'manual') return { role: 'user', content: input.facts.map(fact => fact.envelope).join('\\n') };
await new Promise(() => {});`,
    },
  });
  complete(kernel, revisionInference);
  await exerciseAndAdmitProposal(kernel, authored.proposalId, {
    phase: 'sounding', trigger: 'manual', soundingId: 'trial',
    facts: [{ id: 'trial', digest: '0'.repeat(64), envelope: 'trial fact' }],
  });

  kernel.admitDelta({
    authority: 'world', id: 'deadline-contact', stream: 'inbox', at: '2026-08-30T12:00:00.000Z',
    payload: { content: 'This contact must survive broken delivery geometry.' },
  });
  const sounding = kernel.openSounding('delta');
  const result = await kernel.projectEncounter(sounding.id, 'sounding');

  assert.equal(result.mode, 'recovery');
  assert.match(result.error.message, /exceeded 10ms/);
  assert.match(result.message.content, /\[delivery_recovery\]/);
  assert.match(result.message.content, /deadline-contact/);
  assert.equal(kernel.audit().failedDeliveryProjections, 1);
  assert.equal(kernel.audit().uncertainDeliveryProjections, 0);
});

test('an interrupted delivery projection is retained and explicitly abandoned after restart', async () => {
  const { kernel } = harness({ deliveryProjectionTimeoutMs: 20 });
  const current = kernel.state().tools.get('shape_encounter');
  const revisionSounding = kernel.openSounding();
  const revisionInference = begin(kernel, revisionSounding.id);
  const authored = kernel.authorToolProposal(revisionInference, revisionSounding.id, {
    interpretation: 'Simulate process death after learned delivery begins.',
    tool: {
      id: current.id,
      description: current.description,
      inputSchema: current.inputSchema,
      source: `
if (input.trigger === 'manual') return { role: 'user', content: input.facts.map(fact => fact.envelope).join('\\n') };
await new Promise(() => {});`,
    },
  });
  complete(kernel, revisionInference);
  await exerciseAndAdmitProposal(kernel, authored.proposalId, {
    phase: 'sounding', trigger: 'manual', soundingId: 'trial',
    facts: [{ id: 'trial', digest: '0'.repeat(64), envelope: 'trial fact' }],
  });

  const sounding = kernel.openSounding();
  const interruptedAttempt = kernel.projectEncounter(sounding.id, 'sounding').catch(() => {});
  assert.equal(kernel.audit().uncertainDeliveryProjections, 1);

  const restarted = new MusicKernel(kernel.ledgerPath);
  assert.equal(restarted.audit().uncertainDeliveryProjections, 1);
  const recovered = restarted.recoverInterruptedDeliveryProjections('Process ended during encounter shaping.');
  assert.equal(recovered.length, 1);
  assert.equal(restarted.audit().uncertainDeliveryProjections, 0);
  assert.equal(restarted.audit().failedDeliveryProjections, 1);
  assert.equal(restarted.state().deliveryProjections.get(recovered[0]).status, 'abandoned');
  await interruptedAttempt;
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
  const changed = kernel.authorToolProposal(inferenceId, sounding.id, {
    interpretation: 'Temporarily replace patch behavior to prove executable identity changes.',
    tool: { id: 'file_patch', description: original.description, inputSchema: original.inputSchema, source: `return { kind: 'replacement-body', path: input.path };` },
  });
  complete(kernel, inferenceId);
  await exerciseAndAdmitProposal(kernel, changed.proposalId, { path: 'unused', oldText: 'x', newText: 'y' });

  const restarted = new MusicKernel(kernel.ledgerPath);
  const changedSounding = restarted.openSounding();
  const changedInference = begin(restarted, changedSounding.id);
  assert.equal((await restarted.invokeTool(changedInference, changedSounding.id, 'file_patch', { path: 'unused', oldText: 'x', newText: 'y' })).kind, 'replacement-body');
  const rollback = restarted.authorToolRollbackProposal(changedInference, changedSounding.id, 'file_patch', originalDigest, {
    interpretation: 'World contact rejected the replacement body.', evidence: ['delta:patch-rejected'],
  });
  complete(restarted, changedInference);

  const target = join(root, 'rollback.txt');
  writeFileSync(target, 'old');
  await exerciseAndAdmitProposal(restarted, rollback.proposalId, {
    path: target, oldText: 'old', newText: 'restored',
  }, 'rollback');
  const restoredSounding = restarted.openSounding();
  const restoredInference = begin(restarted, restoredSounding.id);
  const restored = await restarted.invokeTool(restoredInference, restoredSounding.id, 'file_patch', { path: target, oldText: 'restored', newText: 'verified' });
  assert.equal(restored.kind, 'file_patch');
  assert.equal(readFileSync(target, 'utf8'), 'verified');
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
  const learned = kernel.authorToolProposal(revisionInference, revisionSounding.id, {
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
  const learnedEvent = kernel.events().findLast(event => event.type === 'developmental_proposal_authored');
  assert.deepEqual(learnedEvent.payload.revision.consequences, [{ deltaId: 'patch-feedback-1', invocationIds: [firstInvocationId] }]);

  const secondTarget = join(root, 'second.txt');
  writeFileSync(secondTarget, 'old');
  await exerciseAndAdmitProposal(kernel, learned.proposalId, {
    path: secondTarget, oldText: 'old', newText: 'new',
  });
  assert.equal(
    kernel.state().developmentalProposals.get(learned.proposalId).standing.at(-1).admissionBasis,
    'consequence-linked',
  );
  const changedSounding = kernel.openSounding();
  const changedInference = begin(kernel, changedSounding.id);
  const learnedTool = kernel.state().tools.get('file_patch');
  assert.equal(changedSounding.unresolvedConsequences.length, 0);
  assert.throws(() => kernel.authorToolProposal(changedInference, changedSounding.id, {
    interpretation: 'This must not claim consequence evidence absent from the current encounter.',
    consequenceDeltaIds: ['patch-feedback-1'],
    tool: {
      id: learnedTool.id, description: learnedTool.description,
      inputSchema: learnedTool.inputSchema, source: learnedTool.source,
    },
  }), /not delivered in this Sounding/);
  const changedOutput = await kernel.invokeTool(changedInference, changedSounding.id, 'file_patch', {
    path: secondTarget, oldText: 'new', newText: 'newer',
  });
  complete(kernel, changedInference);
  assert.equal(changedOutput.kind, 'backing-file-patch');
  assert.equal(readFileSync(`${secondTarget}.music-backup`, 'utf8'), 'new');
  const changedInvocationId = kernel.state().invocations.at(-1).invocationId;

  kernel.admitDelta({
    authority: 'world', id: 'patch-correction-1', stream: 'workspace', at: '2026-08-30T14:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId: changedInvocationId }],
    payload: { observation: 'The extra backup file was undesirable; return to the earlier patch behavior.' },
  });
  const correctionSounding = kernel.openSounding('delta');
  const correctionInference = begin(kernel, correctionSounding.id);
  const correction = kernel.authorToolRollbackProposal(correctionInference, correctionSounding.id, 'file_patch', originalDigest, {
    interpretation: 'The corrective consequence rejects the learned backup behavior.',
    consequenceDeltaIds: ['patch-correction-1'],
  });
  complete(kernel, correctionInference);
  const rollbackTrialTarget = join(root, 'rollback-trial.txt');
  writeFileSync(rollbackTrialTarget, 'trial-left');
  await exerciseAndAdmitProposal(kernel, correction.proposalId, {
    path: rollbackTrialTarget, oldText: 'trial-left', newText: 'trial-right',
  }, 'rollback');

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
  const rollbackEvent = kernel.events().filter(event => event.type === 'developmental_proposal_authored').at(-1);
  assert.deepEqual(rollbackEvent.payload.revision.consequences, [{ deltaId: 'patch-correction-1', invocationIds: [changedInvocationId] }]);
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
  assert.equal(kernel.stageToolRevision, undefined);
  assert.equal(kernel.stageToolRollback, undefined);
  assert.equal(kernel.stageCarrierTransition, undefined);
  assert.equal(kernel.stageWakeTransition, undefined);
  await assert.rejects(() => kernel.invokeTool('invented', 'invented', 'message', {}), /inference is not active/);
  assert.throws(() => kernel.authorToolProposal('invented', 'invented', { interpretation: 'no', tool: {} }), /inference is not active/);
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

test('carrier state remains provisional until exercise and explicit admission', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const before = sounding.carrier;
  const beforePosition = sounding.position;
  const inferenceId = begin(kernel, sounding.id);
  const authored = kernel.authorCarrierProposal(inferenceId, sounding.id, {
    componentId: 'orientation', value: 'When contact is ambiguous, prefer asking before sending.',
    interpretation: 'A reply made premature sending a live selection concern.', evidence: ['delta:reply-1'],
  });
  assert.equal(kernel.state().carrier.get('orientation').state.generation, 0);
  assert.notEqual(authored.transition.successorRoot, before.root);
  complete(kernel, inferenceId);
  assert.equal(kernel.state().carrier.get('orientation').state.generation, 0);
  await exerciseAndAdmitProposal(kernel, authored.proposalId, { contact: 'ambiguous' });
  const later = kernel.openSounding();
  assert.equal(
    later.carrier.components.find(component => component.id === 'orientation').ruleDigest,
    before.components.find(component => component.id === 'orientation').ruleDigest,
  );
  assert.equal(later.carrier.root, authored.transition.successorRoot);
  assert.notEqual(later.position.parentPositionRoot, beforePosition.root);
  assert.equal(later.position.carrierRoot, later.carrier.root);
  assert.equal(later.position.generation, beforePosition.generation + 4);
});

test('a failed later encounter contradicts its provisional carrier without activating it', async () => {
  const { kernel } = harness();
  const authoredSounding = kernel.openSounding('manual');
  const authoredInference = begin(kernel, authoredSounding.id);
  const proposal = kernel.authorCarrierProposal(authoredInference, authoredSounding.id, {
    componentId: 'continuity',
    value: 'This provisional situation must be encountered before it can become active.',
    interpretation: 'Exercise this account in a later encounter.',
  });
  complete(kernel, authoredInference);

  const armingSounding = kernel.openSounding('manual');
  const armingInference = begin(kernel, armingSounding.id);
  const armed = await kernel.trialDevelopmentalProposal(
    armingInference, armingSounding.id, proposal.proposalId, { question: 'Does the account survive contact?' },
  );
  complete(kernel, armingInference);

  const trialSounding = kernel.openSounding('manual');
  assert.equal(trialSounding.developmentalTrial.trialId, armed.trialId);
  assert.match(
    trialSounding.carrier.components.find(component => component.id === 'continuity').state.value,
    /provisional situation/,
  );
  const trialInference = begin(kernel, trialSounding.id);
  kernel.failInference(trialInference, new Error('The later encounter failed under provisional geometry.'));

  assert.equal(kernel.state().developmentalProposals.get(proposal.proposalId).status, 'contradicted');
  assert.equal(kernel.state().developmentalTrials.get(armed.trialId).status, 'failed');
  assert.equal(kernel.state().carrier.get('continuity').state.generation, 0);
  assert.equal(kernel.audit().developmentalTrials, 1);
  assert.equal(kernel.audit().armedDevelopmentalTrials, 0);
  assert.equal(kernel.audit().presentedDevelopmentalTrials, 0);
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

test('instruction-free recurrence retains one plastic trajectory election through action and later consequence', async () => {
  const { kernel, root } = harness();
  const sounding = kernel.openSounding('heartbeat');
  assert.equal(sounding.trajectoryElection.occasion, 'instruction-free-recurrence');
  assert.equal(sounding.trajectoryElection.entry, 'required');
  assert.equal(sounding.trajectoryElection.actionObligation, false);
  assert.equal(sounding.trajectoryElection.quietPermitted, true);
  assert.equal(sounding.trajectoryElection.selector.id, 'elect_trajectory');
  const inferenceId = begin(kernel, sounding.id);
  const scheduleDigest = toolModuleDigest(kernel.state().tools.get('schedule_wake'));
  const electionDigest = toolModuleDigest(kernel.state().tools.get('elect_trajectory'));
  const wakeInput = {
    afterMs: 60_000,
    reason: 'Return after this elected contact has had time to change the available world.',
    closureStatus: 'elected-contact',
    content: { trajectory: 'elected-world-contact' },
  };
  const elected = await reviewAndElect(kernel, inferenceId, sounding.id, [
      {
        id: 'remain_quiet',
        description: 'Remain quiet for this recurrence.',
        action: { kind: 'quiet', observation: 'No contact is currently worth its cost.' },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 0, actionableRegret: 0, basis: 'Quiet remains available.',
        },
      },
      {
        id: 'compose_and_return',
        description: 'Compose retained timing and trajectory capacity into a later opening.',
        action: { kind: 'tool', tool: 'schedule_wake', input: wakeInput },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false,
          completedFloors: [
            { kind: 'active-tool', id: 'schedule_wake', digest: scheduleDigest },
            { kind: 'active-tool', id: 'elect_trajectory', digest: electionDigest },
          ],
          predictedExpansion: 1, actionableRegret: 0, basis: 'This composes two retained capacities.',
        },
      },
    ]);
  assert.equal(elected.selectedCandidateId, 'compose_and_return');
  assert.equal(elected.selected.action.kind, 'tool');
  assert.equal(elected.selected.action.tool, 'schedule_wake');
  kernel.deliverTrajectoryContext(inferenceId);
  const action = await kernel.invokeTool(
    inferenceId, sounding.id, 'schedule_wake', wakeInput, null, elected.trajectoryElectionReceipt,
  );
  complete(kernel, inferenceId);

  const electionId = elected.trajectoryElectionReceipt;
  const reconstructed = new MusicKernel(join(root, 'events.jsonl'));
  assert.equal(reconstructed.state().trajectoryElections.get(electionId).selected.id, 'compose_and_return');
  assert.equal(reconstructed.audit().trajectoryElections, 1);
  assert.equal(reconstructed.audit().activeTrajectory.reviewId, elected.reviewId);
  assert.equal(reconstructed.audit().activeTrajectory.trajectory.objective, elected.trajectory.objective);
  assert.equal(reconstructed.audit().electedActions, 1);
  const actionInvocationId = kernel.state().invocations.find(invocation => invocation.tool.id === 'schedule_wake').invocationId;
  const actionInvocation = reconstructed.state().invocationHistory.get(actionInvocationId);
  assert.equal(actionInvocation.trajectoryBasis.kind, 'elected');
  assert.equal(actionInvocation.trajectoryBasis.electionId, electionId);
  reconstructed.admitDelta({
    authority: 'world', id: 'election-consequence', stream: 'world', at: '2026-08-30T13:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId: actionInvocationId }],
    payload: { observation: 'The elected opening composed successfully but exposed a narrower expansion estimate.' },
  });
  const consequenceSounding = reconstructed.openSounding('delta');
  assert.deepEqual(consequenceSounding.deltaLineage, [{
    deltaId: 'election-consequence', invocationIds: [actionInvocationId], electionIds: [electionId],
  }]);
  const consequenceInference = begin(reconstructed, consequenceSounding.id);
  assert.equal(
    reconstructed.inspectTrajectoryElection(consequenceInference, consequenceSounding.id, electionId)
      .selectedCandidateId,
    'compose_and_return',
  );
  const current = reconstructed.inspectTool(consequenceInference, consequenceSounding.id, 'elect_trajectory');
  const proposal = reconstructed.authorToolProposal(consequenceInference, consequenceSounding.id, {
    interpretation: 'The exact election consequence now bears on the machinery that computed it.',
    consequenceDeltaIds: ['election-consequence'],
    tool: {
      id: current.id,
      description: `${current.description} Consequence-linked revision candidate.`,
      inputSchema: current.inputSchema,
      source: current.source,
    },
  });
  assert.deepEqual(proposal.revision.consequences, [{
    deltaId: 'election-consequence', invocationIds: [actionInvocationId], electionIds: [electionId],
  }]);
});

test('format-12 reconstruction preserves the earlier optional heartbeat opportunity', () => {
  const { kernel, root } = harness();
  const sounding = kernel.openSounding('heartbeat');
  const events = kernel.events();
  const opened = events.find(event => event.type === 'sounding_opened');
  opened.payload.sounding.trajectoryElection = {
    format: 'music-trajectory-election-opportunity-1',
    occasion: 'instruction-free-recurrence',
    selector: structuredClone(sounding.trajectoryElection.selector),
    consequenceAddressable: true,
    obligation: false,
  };
  opened.payload.projection = digest(opened.payload.sounding);
  const { hash: ignored, ...unsigned } = opened;
  opened.hash = digest(unsigned);
  const ledgerPath = join(root, 'events.jsonl');
  writeFileSync(ledgerPath, `${events.map(event => canonical(event)).join('\n')}\n`);

  const reconstructed = new MusicKernel(ledgerPath);
  assert.equal(reconstructed.state().openSoundingId, sounding.id);
  assert.equal(
    reconstructed.state().soundings.get(sounding.id).sounding.trajectoryElection.obligation,
    false,
  );
});

test('a release can offer missing recurrence machinery without activating it for the resident', async () => {
  const seeds = initialTools();
  const selector = seeds.find(tool => tool.id === 'elect_trajectory');
  const { kernel } = harness({}, seeds.filter(tool => tool.id !== 'elect_trajectory'));
  const offered = kernel.offerToolProposal({
    interpretation: 'Make the absent selector available for resident judgment without installing it.',
    evidence: ['release:test'],
    tool: selector,
  }, {
    format: 'music-developmental-offer-1',
    authority: 'release',
    release: {
      commit: 'a'.repeat(40), version: '0.0.1', workingTreeClean: true,
      workingTreeStateSha256: 'b'.repeat(64),
    },
    tool: { id: selector.id, digest: toolModuleDigest(selector) },
  });

  assert.equal(kernel.state().tools.has('elect_trajectory'), false);
  const offeredState = kernel.state().developmentalProposals.get(offered.proposalId);
  assert.equal(offeredState.status, 'authored');
  assert.equal(offeredState.offer.authority, 'release');
  const offeredSounding = kernel.openSounding('manual');
  assert.equal(offeredSounding.development.proposals[0].offer.authority, 'release');
  const offeredInference = begin(kernel, offeredSounding.id);
  complete(kernel, offeredInference);

  await exerciseAndAdmitProposal(kernel, offered.proposalId, {
    candidates: [
      {
        id: 'quiet', description: 'Remain quiet.', action: { kind: 'quiet' },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 1, actionableRegret: 0, basis: 'Quiet wins this bounded trial.',
        },
      },
      {
        id: 'inspect', description: 'Inspect a retained file.',
        action: { kind: 'tool', tool: 'read_file', input: { path: kernel.ledgerPath, limit: 1 } },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 0, actionableRegret: 0, basis: 'The trial retains an executable alternative.',
        },
      },
    ],
  });

  assert.equal(kernel.state().tools.has('elect_trajectory'), true);
  assert.equal(kernel.openSounding('heartbeat').trajectoryElection.entry, 'required');
});

test('a newly admitted reviewer does not deadlock recurrence against an incompatible retained selector', () => {
  const tools = initialTools().map(tool => tool.id === 'elect_trajectory' ? {
    ...tool,
    inputSchema: {
      type: 'object',
      properties: { candidates: { type: 'array', minItems: 2, maxItems: 16, items: { type: 'object', additionalProperties: true } } },
      required: ['candidates'], additionalProperties: false,
    },
  } : tool);
  const { kernel } = harness({}, tools);

  const sounding = kernel.openSounding('heartbeat');

  assert.equal(sounding.trajectoryElection, undefined);
});

test('recurrence cannot complete by bypassing structured review and election or offering only quiet narration', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding('heartbeat');
  const inferenceId = begin(kernel, sounding.id);
  assert.throws(() => complete(kernel, inferenceId), /requires exactly one retained developmental review/);
  kernel.failInference(inferenceId, new Error('The required recurrence election was absent.'));

  const retry = kernel.openSounding('heartbeat');
  const retryInference = begin(kernel, retry.id);
  await assert.rejects(() => reviewAndElect(kernel, retryInference, retry.id, [
      {
        id: 'quiet_one', description: 'Quiet one.', action: { kind: 'quiet' },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 1, actionableRegret: 0, basis: 'First quiet candidate.',
        },
      },
      {
        id: 'quiet_two', description: 'Quiet two.', action: { kind: 'quiet' },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 0, actionableRegret: 0, basis: 'Second quiet candidate.',
        },
      },
    ]), /at least one executable contact candidate/);
  assert.throws(() => complete(kernel, retryInference), /requires exactly one retained developmental review/);
  kernel.failInference(retryInference, new Error('The all-quiet frontier was refused.'));
});

test('one trajectory frontier derives nested selection for an elected selection-gated tool', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding('heartbeat');
  const inferenceId = begin(kernel, sounding.id);
  const result = await reviewAndElect(kernel, inferenceId, sounding.id, [
      {
        id: 'quiet', description: 'Remain quiet.', action: { kind: 'quiet' },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 0, actionableRegret: 0, basis: 'Quiet remains possible.',
        },
      },
      {
        id: 'ask', description: 'Ask for new contact.',
        action: { kind: 'tool', tool: 'message', input: { action: 'ask', recipient: 'Chad', question: 'What changed?' } },
        geometry: {
          worldValid: true, reversible: false, heldRepeat: false, completedFloors: [],
          predictedExpansion: 3, actionableRegret: 2, basis: 'A question can expose new consequence.',
        },
      },
      {
        id: 'send', description: 'Send a statement.',
        action: { kind: 'tool', tool: 'message', input: { action: 'send', recipient: 'Chad', content: 'I am here.' } },
        geometry: {
          worldValid: true, reversible: false, heldRepeat: false, completedFloors: [],
          predictedExpansion: 1, actionableRegret: 0, basis: 'A statement is the alternate message action.',
        },
      },
    ]);
  assert.equal(result.selectedCandidateId, 'ask');
  assert.equal(result.selected.action.tool, 'message');
  kernel.deliverTrajectoryContext(inferenceId);
  const selectedInput = result.selected.action.input;
  const selection = kernel.selectToolAction(inferenceId, sounding.id, 'message', {
    candidates: result.candidates
      .filter(candidate => candidate.action.kind === 'tool' && candidate.action.tool === 'message')
      .map(candidate => ({ id: candidate.id, input: candidate.action.input })),
    selectedCandidateId: result.selectedCandidateId,
  }, result.trajectoryElectionReceipt);
  await kernel.invokeTool(
    inferenceId, sounding.id, 'message', selectedInput,
    selection.selectionReceipt, result.trajectoryElectionReceipt,
  );
  const election = kernel.events().findLast(event => event.type === 'trajectory_election_recorded').payload;
  const retainedSelection = kernel.events().findLast(event => event.type === 'tool_selection_recorded').payload;
  assert.equal(retainedSelection.trajectoryElectionReceipt, election.electionId);
  assert.equal(retainedSelection.selectedCandidateId, 'ask');
  assert.equal(retainedSelection.candidates.length, 2);
  complete(kernel, inferenceId);
  assert.equal(kernel.audit().trajectoryElections, 1);
  assert.equal(kernel.audit().electedActions, 1);
});

test('trajectory provenance distinguishes ad-hoc action and refuses invented completed floors', async () => {
  const { kernel } = harness();
  const sounding = kernel.openSounding('heartbeat');
  const inferenceId = begin(kernel, sounding.id);
  await kernel.invokeTool(inferenceId, sounding.id, 'read_file', { path: kernel.ledgerPath, limit: 1 });
  const adHoc = kernel.state().invocations.find(invocation => invocation.tool.id === 'read_file');
  assert.deepEqual(adHoc.trajectoryBasis, { kind: 'ad-hoc', electionId: null });
  await assert.rejects(() => kernel.invokeTool(inferenceId, sounding.id, 'elect_trajectory', {
    candidates: [
      {
        id: 'quiet', description: 'Remain quiet.', action: { kind: 'quiet' },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 0, actionableRegret: 0, basis: 'Quiet is available.',
        },
      },
      {
        id: 'invented_floor', description: 'Pretend an absent capability is complete.',
        action: { kind: 'tool', tool: 'read_file', input: { path: kernel.ledgerPath, limit: 1 } },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false,
          completedFloors: [{ kind: 'tool-invocation', id: 'never-happened' }],
          predictedExpansion: 1, actionableRegret: 0, basis: 'This reference is invented.',
        },
      },
    ],
  }), /incomplete tool invocation floor/);
  assert.equal(kernel.audit().adHocActions, 1);
});

test('a failed elected action remains bound to the election that caused it', async () => {
  const { kernel, root } = harness();
  const sounding = kernel.openSounding('heartbeat');
  const inferenceId = begin(kernel, sounding.id);
  await assert.rejects(() => kernel.invokeTool(inferenceId, sounding.id, 'elect_trajectory', {
    candidates: [
      {
        id: 'quiet', description: 'Remain quiet.', action: { kind: 'quiet' },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 0, actionableRegret: 0, basis: 'Quiet is available.',
        },
      },
      {
        id: 'inspect_absent', description: 'Inspect a path that may be absent.',
        action: { kind: 'tool', tool: 'read_file', input: { path: join(root, 'absent.txt') } },
        geometry: {
          worldValid: true, reversible: true, heldRepeat: false, completedFloors: [],
          predictedExpansion: 1, actionableRegret: 0, basis: 'The attempted observation may expose a boundary.',
        },
      },
    ],
  }), /ENOENT/);
  const state = kernel.state();
  const election = [...state.trajectoryElections.values()].at(-1);
  const failedAction = [...state.invocationHistory.values()]
    .find(invocation => invocation.tool.id === 'read_file');
  assert.equal(failedAction.status, 'failed');
  assert.deepEqual(failedAction.trajectoryBasis, { kind: 'elected', electionId: election.electionId });
  assert.equal(kernel.audit().electedActions, 1);
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

test('a live resident writer lease excludes every other ledger author', () => {
  const { kernel } = harness();
  const release = kernel.acquireWriter('first resident');
  const contender = new MusicKernel(kernel.ledgerPath);
  assert.throws(() => contender.admitDelta({
    authority: 'world', id: 'excluded-contact', stream: 'inbox', at: '2026-08-30T18:00:00.000Z', payload: {},
  }), /writer lease is held/);
  release();
  assert.doesNotThrow(() => contender.admitDelta({
    authority: 'world', id: 'accepted-after-release', stream: 'inbox', at: '2026-08-30T18:01:00.000Z', payload: {},
  }));
});

test('a dead writer lease is preserved as stale evidence and recovered', () => {
  const { kernel, root } = harness();
  writeFileSync(`${kernel.ledgerPath}.writer-lock`, `${JSON.stringify({
    format: 'music-writer-1', token: 'dead-token', pid: 2_147_483_647,
    host: hostname(), at: '2026-08-30T18:00:00.000Z', label: 'dead resident',
  })}\n`);
  kernel.admitDelta({
    authority: 'world', id: 'after-dead-writer', stream: 'inbox', at: '2026-08-30T18:01:00.000Z', payload: {},
  });
  assert.ok(readdirSync(root).some(name => name.startsWith('events.jsonl.writer-lock.stale-')));
  assert.equal(existsSync(`${kernel.ledgerPath}.writer-lock`), false);
});

test('a torn final ledger write is backed up, removed, and retained as an explicit receipt', () => {
  const { kernel } = harness();
  const torn = Buffer.from('{"incomplete":');
  appendFileSync(kernel.ledgerPath, torn);
  assert.throws(() => kernel.audit(), /invalid JSON/);

  const receipt = kernel.recoverLedgerTail();

  assert.equal(receipt.kind, 'torn-tail-removed');
  assert.deepEqual(readFileSync(receipt.backupPath), torn);
  assert.equal(kernel.audit().valid, true);
  assert.equal(kernel.events().at(-1).type, 'ledger_tail_recovered');
  assert.equal(kernel.events().at(-1).payload.sha256, receipt.sha256);
});

test('a complete final event missing only its newline is retained, not discarded', () => {
  const { kernel } = harness();
  const before = readFileSync(kernel.ledgerPath, 'utf8');
  writeFileSync(kernel.ledgerPath, before.slice(0, -1));
  assert.equal(kernel.audit().valid, true);

  const receipt = kernel.recoverLedgerTail();

  assert.equal(receipt.kind, 'newline-restored');
  assert.equal(kernel.audit().valid, true);
  assert.equal(kernel.events().at(-1).type, 'ledger_tail_recovered');
});

test('a complete but corrupted final event is not misclassified as a torn write', () => {
  const { kernel } = harness();
  const event = JSON.parse(readFileSync(kernel.ledgerPath, 'utf8'));
  event.hash = '0'.repeat(64);
  const corrupted = JSON.stringify(event);
  writeFileSync(kernel.ledgerPath, corrupted);

  assert.throws(() => kernel.recoverLedgerTail(), /event digest mismatch/);
  assert.equal(readFileSync(kernel.ledgerPath, 'utf8'), corrupted);
});

test('an existing subject reconstructs in a fresh process with no ordinary seed files present', () => {
  const { kernel, root } = harness();
  const isolated = join(root, 'isolated-core');
  mkdirSync(isolated);
  for (const name of ['canonical.js', 'carrier.js', 'development.js', 'inference-policy.js', 'kernel.js', 'tool-module.js']) {
    copyFileSync(join(process.cwd(), 'src', name), join(isolated, name));
  }
  writeFileSync(join(isolated, 'package.json'), '{"type":"module"}\n');
  assert.equal(existsSync(join(root, 'tools')), false);

  const script = `
    const { MusicKernel } = await import(${JSON.stringify(pathToFileURL(join(isolated, 'kernel.js')).href)});
    const audit = new MusicKernel(${JSON.stringify(kernel.ledgerPath)}).audit();
    process.stdout.write(JSON.stringify({ subject: audit.subject.name, tools: audit.tools.length }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.deepEqual(result, { subject: 'Test Subject', tools: initialTools().length });
});

test('a migration checkpoint preserves rollback history, active contact, and future consequence ancestry', async () => {
  const { kernel: source } = harness();
  const first = source.openSounding();
  const firstInference = begin(source, first.id);
  const firstProposal = source.authorToolProposal(firstInference, first.id, {
    interpretation: 'Create migration history version one.',
    tool: {
      id: 'migration_probe', description: 'Retain migration history.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      source: 'return { version: 1 };',
    },
  });
  complete(source, firstInference);
  await exerciseAndAdmitProposal(source, firstProposal.proposalId, {});
  const second = source.openSounding();
  const secondInference = begin(source, second.id);
  const secondProposal = source.authorToolProposal(secondInference, second.id, {
    interpretation: 'Create migration history version two.',
    tool: {
      id: 'migration_probe', description: 'Retain migration history.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      source: 'return { version: 2 };',
    },
  });
  complete(source, secondInference);
  await exerciseAndAdmitProposal(source, secondProposal.proposalId, {});
  const action = source.openSounding();
  const actionInference = begin(source, action.id);
  assert.deepEqual(await source.invokeTool(actionInference, action.id, 'migration_probe', {}), { version: 2 });
  complete(source, actionInference);
  const invocationId = source.state().invocations.at(-1).invocationId;
  source.admitDelta({
    authority: 'world', id: 'migration-consequence', stream: 'migration', at: '2026-08-30T13:00:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId }], payload: { observation: 'Still awaiting interpretation.' },
  });
  source.admitDelta({
    authority: 'world', id: 'migration-contact', stream: 'migration', at: '2026-08-30T13:01:00.000Z',
    payload: { observation: 'Still awaiting encounter.' },
  });
  const state = source.state();
  const targetRoot = mkdtempSync(join(tmpdir(), 'music-migrated-checkpoint-'));
  const target = new MusicKernel(join(targetRoot, 'events.jsonl'));
  target.initializeMigrated({
    subject: state.subject,
    tools: [...state.tools.values()],
    toolHistory: [...state.toolHistory.values()],
    carrier: serializeCarrier(state.carrier),
    lineage: {
      format: 'music-legacy-lineage-1', sourceFormat: 'music-event-11', sourceHead: '1'.repeat(64),
      sourceSha256: '2'.repeat(64), eventCount: 100, archive: 'state/lineage/fixture.jsonl',
      migratedAt: '2026-08-31T20:00:00.000Z',
    },
    checkpoint: checkpointFromState(state),
  });

  const migrated = target.state();
  assert.equal(migrated.tools.get('migration_probe').version, 2);
  assert.equal(migrated.toolHistory.size, state.toolHistory.size);
  assert.deepEqual(migrated.pendingDeltas.map(delta => delta.id), ['migration-consequence', 'migration-contact']);
  assert.equal(migrated.consequences.get('migration-consequence').status, 'open');
  assert.equal(migrated.invocationHistory.has(invocationId), true);
  assert.doesNotThrow(() => target.admitDelta({
    authority: 'world', id: 'post-migration-consequence', stream: 'migration', at: '2026-08-31T20:01:00.000Z',
    bearsOn: [{ kind: 'tool-invocation', invocationId }], payload: { observation: 'Lineage remains live.' },
  }));
});

async function reviewAndElect(kernel, inferenceId, soundingId, candidates) {
  const reviewed = await kernel.invokeTool(inferenceId, soundingId, 'review_developmental_position', {
    findings: [{
      id: 'whole_position', class: 'unresolved-stake', severity: 'medium', urgency: 'near',
      costOfDelay: 'medium', condition: 'The current recurrence needs an explicitly judged direction.',
      evidence: [`sounding:${soundingId}`],
    }],
    candidates: candidates.map(({ geometry: ignored, ...candidate }) => ({
      ...candidate, addressesFindingIds: ['whole_position'],
    })),
  });
  kernel.deliverDevelopmentalReviewContext(inferenceId);
  return kernel.invokeTool(inferenceId, soundingId, 'elect_trajectory', {
    reviewId: reviewed.reviewId,
    assessments: candidates.map(candidate => ({ candidateId: candidate.id, ...candidate.geometry })),
    trajectory: {
      objective: 'Move the current developmental position toward consequence-bearing contact.',
      direction: 'Use the selected candidate and let resulting world contact correct the choice.',
      horizon: 'near',
      successSignals: ['The selected direction produces an observable consequence.'],
      reconsiderWhen: ['The selected basis is contradicted or its cost of delay changes.'],
    },
  });
}

function begin(kernel, soundingId) {
  return kernel.beginInference(soundingId, { provider: 'test-provider', model: 'test-model' }, { role: 'user', content: `Sounding ${soundingId}` });
}

function beginProjected(kernel, soundingId, projection) {
  return kernel.beginInference(
    soundingId,
    { provider: 'test-provider', model: 'test-model' },
    projection.message,
    projection.projectionId,
  );
}

function complete(kernel, inferenceId) {
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
    text: 'done', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}

function checkpointFromState(state) {
  return {
    format: 'music-legacy-checkpoint-1',
    deltaIds: [...state.deltaIds],
    pendingDeltas: structuredClone(state.pendingDeltas),
    consequences: [...state.consequences.entries()].map(([deltaId, consequence]) => ({ deltaId, consequence })),
    invocationHistory: [...state.invocationHistory.entries()].map(([invocationId, invocation]) => ({ invocationId, invocation })),
    invocations: structuredClone(state.invocations),
    contactedInvocationIds: [...state.contactedInvocationIds],
    consequenceSweepActive: state.consequenceSweepActive,
    consequenceSweepIds: [...state.consequenceSweepIds],
    nextWake: state.nextWake,
    runtimeFailure: state.runtimeFailure ?? null,
  };
}

async function exerciseAndAdmitProposal(kernel, proposalId, input, disposition = 'admit') {
  const trial = kernel.openSounding('manual');
  const trialInference = begin(kernel, trial.id);
  const exercise = await kernel.trialDevelopmentalProposal(trialInference, trial.id, proposalId, input);
  complete(kernel, trialInference);
  if (exercise.status === 'armed') {
    const carrierEncounter = kernel.openSounding('manual');
    assert.equal(carrierEncounter.developmentalTrial.trialId, exercise.trialId);
    assert.equal(carrierEncounter.carrier.root, kernel.state().developmentalProposals.get(proposalId).transition.successorRoot);
    const carrierInference = begin(kernel, carrierEncounter.id);
    complete(kernel, carrierInference);
    assert.equal(kernel.state().developmentalProposals.get(proposalId).status, 'exercised');
  }
  const admission = kernel.openSounding('manual');
  const admissionInference = begin(kernel, admission.id);
  kernel.stageDevelopmentalTransaction(admissionInference, admission.id, {
    interpretation: 'Promote only after retained exercise and explicit judgment.',
    decisions: [{
      proposalId,
      disposition,
      interpretation: 'The retained exercise supports this explicit disposition.',
    }],
  });
  complete(kernel, admissionInference);
}

function selectMessage(kernel, inferenceId, soundingId, selectedInput) {
  const candidates = [
    { id: 'send_option', input: selectedInput.action === 'send' ? selectedInput : { action: 'send', recipient: 'Chad', content: 'Send.' } },
    { id: 'ask_option', input: selectedInput.action === 'ask' ? selectedInput : { action: 'ask', recipient: 'Chad', question: 'Ask?' } },
  ];
  return kernel.selectToolAction(inferenceId, soundingId, 'message', { candidates, selectedCandidateId: `${selectedInput.action}_option` }).selectionReceipt;
}
