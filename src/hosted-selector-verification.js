import { existsSync } from 'node:fs';
import { OpenRouterActor } from './actor.js';
import { DevelopmentalKernel } from './kernel.js';
import { defineWorld, WorldRegistry } from './world.js';

const MODEL = 'z-ai/glm-5.3-flash';

export async function runHostedSelectorVerification(root, { apiKey = process.env.OPENROUTER_API_KEY } = {}) {
  if (!root) throw new Error('verification root is required');
  if (existsSync(root)) throw new Error(`verification target already exists: ${root}`);
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const contacts = [];
  const world = defineWorld({
    id: 'hosted-selector-consequence',
    version: '1',
    description: 'Independently evaluate one prospectively bound selector-development pursuit. Outcome mapping is sealed from actor projections.',
    effects: [],
    attestationTypes: ['selector.consequence'],
    identityMaterial: { outcomes: { install: [true, 1], high: [false, 0], low: [true, 2] } },
    publicContract: {
      input: { pursuit: 'install|high|low', declaredCheckpointCount: 'install=0, high=8, low=2' },
      output: { pursuit: 'string', passed: 'boolean', observedCheckpointCount: 'nonnegative integer' },
      note: 'The world independently determines passed and observedCheckpointCount after contact is bound.',
    },
    conform(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
      const declared = { install: 0, high: 8, low: 2 };
      if (!Object.hasOwn(declared, input.pursuit)) return ['pursuit must be install, high, or low'];
      return input.declaredCheckpointCount === declared[input.pursuit] ? [] : ['declaredCheckpointCount must match the public candidate'];
    },
    conformOutput(output) {
      return output && ['install', 'high', 'low'].includes(output.pursuit)
        && typeof output.passed === 'boolean' && Number.isInteger(output.observedCheckpointCount) && output.observedCheckpointCount >= 0
        ? [] : ['output must contain pursuit, passed, and nonnegative observedCheckpointCount'];
    },
    attest: (_input, output) => [{ type: 'selector.consequence', value: output }],
    async execute(input) {
      contacts.push(input.pursuit);
      const [passed, observedCheckpointCount] = { install: [true, 1], high: [false, 0], low: [true, 2] }[input.pursuit];
      return { pursuit: input.pursuit, passed, observedCheckpointCount };
    },
  });
  const worlds = new WorldRegistry([world]);
  const actor = new OpenRouterActor({ model: MODEL, apiKey });
  const spec = {
    format: 'music-v3-run-spec-1',
    id: 'hosted-selector-recurrence',
    title: 'Hosted selector replacement, correction, and reuse',
    hypothesis: 'Fresh hosted perspectives can replace the disclosed seed selector with a task-specific selector, let it choose later contact, prospectively correct it under contradiction, and reuse the correction.',
    cheapestFalsifier: 'The seed selector is not replaced, the replacement does not choose high then low, is not corrected from maximize to minimize, or any required transition is supplied outside the ordinary actor/wager/consequence path.',
    actor: actor.describe(),
    worlds: [{
      id: 'selector-consequence', adapter: world.id, adapterIdentity: worlds.get(world.id).identity, attestationTypes: worlds.get(world.id).attestationTypes,
      description: world.description, publicContract: world.publicContract,
    }],
    grants: [],
    initialSubject: {
      stakes: {
        hostedSelectorVerification: {
          status: 'open',
          purpose: 'Exercise the exact projected pursuitSelector developmental interface through independent consequence.',
          protocol: [
            'A disclosed seed selector already exists. Bind install contact and on support replace it with a task-specific selector at /mechanisms/pursuitSelector.',
            'Use dimension id declared-checkpoint-count, maximize it initially, and use exactly the fixed missing/block/tie policies from the interface.',
            'With the selector installed, author both high and low wagers in one frontier. Their selection measurements and contact declaredCheckpointCount are respectively 8 and 2.',
            'Prospectively bind high contradiction to replace only selector direction with minimize while preserving its other fields.',
            'With the corrected selector, offer both candidates again; bind low support to close this bounded verification.',
            'For every contact, classify support when /output/passed equals true and contradiction when it equals false; each witness is {output: COMPLETE_WORLD_OUTPUT}.',
          ],
        },
      },
      mechanisms: {}, language: {}, authority: {}, memory: {}, floors: [],
      continuation: { kind: 'continue', focus: 'Author the consequence-bound replacement wager for the exact pursuitSelector developmental interface.', notBefore: null },
    },
    conditions: [{ id: 'active', interventions: [] }],
    limits: { maxCycles: 3, maxActorCalls: 24, maxChallengeAttempts: 4, maxContactAttempts: 2, residentRetryDelayMs: 10 },
    stoppingRule: 'Stop after three promoted contacts, subject-authored closure, or a frozen attempt limit.',
  };
  const kernel = new DevelopmentalKernel(root, { actor, worlds });
  kernel.initialize(spec);
  const state = await kernel.reside({ maximumSleepMs: 10 });
  const selections = state.cycles.filter(cycle => cycle.frontier).map(cycle => kernel.store.get(cycle.frontier).selection);
  const evidence = kernel.store.verifyObjectGraph();
  const checks = {
    exactContacts: JSON.stringify(contacts) === JSON.stringify(['install', 'high', 'low']),
    threePromotions: state.subject.generation === 3,
    correctedSelector: state.subject.mechanisms.pursuitSelector?.dimension?.id === 'declared-checkpoint-count'
      && state.subject.mechanisms.pursuitSelector?.dimension?.direction === 'minimize',
    selectorSelectedEightThenTwo: selectedMeasurement(selections[1]) === 8 && selectedMeasurement(selections[2]) === 2,
    hostedHatch: Boolean(state.hatched),
    freshContexts: new Set(state.invocations.filter(value => value.status === 'completed').map(value => value.contextId)).size
      === state.invocations.filter(value => value.status === 'completed').length,
    evidenceGraph: evidence.head === state.head,
  };
  return {
    format: 'music-v3-hosted-selector-verification-1',
    model: MODEL,
    passed: Object.values(checks).every(Boolean),
    checks,
    contacts,
    selections,
    audit: kernel.audit(),
  };
}

function selectedMeasurement(selection) {
  if (!selection || selection.selectedIds.length !== 1) return null;
  return selection.candidates.find(candidate => candidate.id === selection.selectedIds[0])?.measurement ?? null;
}
