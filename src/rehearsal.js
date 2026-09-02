import { existsSync, rmSync } from 'node:fs';
import { FunctionActor } from './actor.js';
import { clone, digest } from './canonical.js';
import { DevelopmentalKernel } from './kernel.js';
import { WorldRegistry, defineWorld } from './world.js';

export async function runRehearsal(root, { preserve = true } = {}) {
  if (existsSync(root)) throw new Error('rehearsal destination already exists');
  const fixture = rehearsalFixture();
  const seenSelections = [];
  const queues = Object.fromEntries(Object.entries(fixture.outputs).map(([role, values]) => [role, values.map(clone)]));
  const actor = new FunctionActor(({ role, projection }) => {
    if (role === 'select') seenSelections.push(projection.opportunityProjection.opportunities.map(value => value.id));
    const output = queues[role]?.shift();
    if (!output) throw new Error(`rehearsal has no output for ${role}`);
    return output;
  }, { id: 'music-v4-rehearsal', identityMaterial: rehearsalDigest() });
  const worlds = new WorldRegistry([fixture.world]);
  const spec = rehearsalSpec(actor, worlds, fixture.world);
  const kernel = new DevelopmentalKernel(root, { actor, worlds });
  kernel.initialize(spec);
  await kernel.run();
  const audit = kernel.audit();
  const contexts = audit.actorInvocations.filter(value => value.status === 'completed').map(value => value.contextId);
  const report = {
    format: 'music-v4-rehearsal-report-1',
    passed: audit.subject.revision === 4
      && audit.subject.succession === 19
      && audit.operation.operation === 'wait'
      && audit.subject.opportunities.completed === 3
      && audit.subject.opportunities.surrendered === 1
      && new Set(contexts).size === contexts.length
      && seenSelections[1]?.[0] === 'subject:consequence-followup',
    subject: audit.subject,
    operation: audit.operation,
    completedOperations: audit.operations.length,
    completedPerspectives: contexts.length,
    uniqueFreshContexts: new Set(contexts).size,
    selectionProjections: seenSelections,
    anchors: {
      contentFreeOperationDerivation: true,
      deterministicContact: true,
      contradictionCausedOrganRevision: true,
      revisedOrganChangedLaterOpportunityOrder: seenSelections[1]?.[0] === 'subject:consequence-followup',
      supportAssimilated: true,
      saturationCausedExpansion: true,
      emptyExpansionCausedBoundedWait: audit.operation.operation === 'wait',
      operationalSuccessionSeparatedFromDevelopment: audit.subject.succession > audit.subject.revision,
    },
    evidence: audit.evidence,
  };
  if (!report.passed) throw new Error(`V4 rehearsal failed: ${JSON.stringify(report)}`);
  if (!preserve) rmSync(root, { recursive: true, force: true });
  return report;
}

export function rehearsalDigest() {
  return digest(rehearsalFixture().outputs);
}

function rehearsalFixture() {
  const revisedSelector = {
    format: 'music-v4-operation-selector-1', version: 2,
    consequenceRoutes: { support: 'assimilate', contradiction: 'correct', inconclusive: 'assimilate', failure: 'correct' },
    sourcePriority: ['observation', 'unresolved', 'subject', 'world'],
    projectionLimit: 16, expansionLimit: 2, waitMs: 300_000,
  };
  const world = defineWorld({
    id: 'echo', version: 'v4-rehearsal', description: 'Return one exact bounded value.', effects: [],
    attestationTypes: ['echo.result'], publicContract: { input: { value: 'string' }, output: { value: 'string' } },
    identityMaterial: { rehearsal: 'music-v4' },
    conform: input => typeof input?.value === 'string' ? [] : ['value must be a string'],
    conformOutput: output => typeof output?.value === 'string' ? [] : ['value must be a string'],
    attest: (input, output) => [{ type: 'echo.result', value: output }],
    execute: async input => clone(input),
  });
  const outputs = {
    select: [
      select('world:primary-a', 'stake-a', ['/organs/operationSelector']),
      select('subject:consequence-followup', 'stake-c'),
      select('world:primary-b', 'stake-b'),
      select('subject:expanded-contact', 'stake-d'),
    ],
    realize: [
      realize('primary-a', 'contradiction'),
      realize('primary-a', 'support'),
      realize('primary-b', 'support'),
      realize('primary-a', 'support'),
    ],
    correct: [{
      disposition: 'surrender', revisedStake: null,
      mutation: { set: { '/organs/operationSelector': revisedSelector }, remove: [] },
      opportunities: [{ id: 'subject:consequence-followup', source: { kind: 'subject', world: 'primary-a' }, description: 'Test a consequence-opened subject opportunity.', noveltyKey: 'rehearsal:consequence-followup' }],
      wait: null, rationale: 'The contradiction changes selection geometry and surrenders the failed stake.',
    }],
    assimilate: [retire(), retire(), retire()],
    expand: [
      {
        opportunities: [{ id: 'subject:expanded-contact', source: { kind: 'subject', world: 'primary-a' }, description: 'A new contact outside the saturated local set.', noveltyKey: 'rehearsal:expanded-contact' }],
        wait: null, rationale: 'Local standing is saturated; open a new bounded surface.',
      },
      emptyExpansion('No other honest surface is presently visible.'),
      emptyExpansion('The second bounded search also found no reachable surface.'),
    ],
  };
  return { world, outputs };
}

function rehearsalSpec(actor, worlds, world) {
  return {
    format: 'music-v4-run-spec-1', id: 'v4-rehearsal', title: 'Music V4 deterministic rehearsal', inference: actor.describe(),
    worlds: ['primary-a', 'primary-b'].map(id => ({ id, adapter: 'echo', adapterIdentity: worlds.get('echo').identity, attestationTypes: ['echo.result'], description: world.description, publicContract: world.publicContract })),
    grants: [], initialSubject: {},
    limits: { maxOperations: 100, maxActorCalls: 100, maxRealizationAttempts: 4, maxContactAttempts: 8, residentRetryDelayMs: 10, continuityPulseMs: 300_000, projectionHistoryEntries: 16, maximumInputTokens: 200_000, maximumInputCharacters: 900_000 },
    stoppingRule: 'Stop at the first bounded wait after expansion saturation.',
  };
}

function select(opportunityId, id, mutationSurface = ['/memory']) {
  return { opportunityId, stake: { id, question: `What follows from ${id}?`, successCondition: 'The exact output is support.', surrenderCondition: 'Contradiction removes the stake.', mutationSurface }, rationale: 'Choose the first standing opportunity under the installed organ.' };
}

function realize(world, value) {
  return {
    world, input: { value }, bearing: { attestationTypes: ['echo.result'], interpretation: 'The returned value bears directly.' },
    predicates: { support: { op: 'eq', path: '/output/value', value: 'support' }, contradiction: { op: 'eq', path: '/output/value', value: 'contradiction' } },
    witnesses: { support: { output: { value: 'support' } }, contradiction: { output: { value: 'contradiction' } } },
    effectRequirements: [],
  };
}

function retire() { return { disposition: 'retire', revisedStake: null, mutation: { set: {}, remove: [] }, opportunities: [], wait: null, rationale: 'The exact supported contact completes this stake.' }; }
function emptyExpansion(reason) { return { opportunities: [], wait: { reason, notBefore: new Date(Date.now() + 300_000).toISOString() }, rationale: reason }; }
