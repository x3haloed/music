import { z } from 'zod';
import { PredicateSchema } from './predicate.js';
import {
  IdentifierSchema,
  StatePointerSchema,
  SubjectSeedSchema,
  TransitionSchema,
} from './subject.js';
import { SelectionSignalSchema } from './selector.js';

const Json = z.json();

export const WorldSpecSchema = z.object({
  id: IdentifierSchema,
  adapter: IdentifierSchema,
  adapterIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  description: z.string().min(1).max(4096),
  publicContract: Json,
});

export const ActorConditionSchema = z.object({
  adapter: IdentifierSchema,
  model: z.string().min(1).max(256).nullable(),
  adapterIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  settings: z.record(z.string(), Json).default({}),
});

const ProjectionInterventionSchema = z.object({
  generation: z.number().int().nonnegative(),
  erase: z.array(z.string().regex(/^\/subject\/(stakes|mechanisms|language|authority|memory|continuation)(?:\/.*)?$/)).max(128).default([]),
  replace: z.record(z.string().regex(/^\/subject\/(stakes|mechanisms|language|authority|memory|continuation)(?:\/.*)?$/), Json).default({}),
});

export const ConditionSchema = z.object({
  id: IdentifierSchema,
  interventions: z.array(ProjectionInterventionSchema).max(64).default([]),
});

export const RunSpecSchema = z.object({
  format: z.literal('music-v3-run-spec-1'),
  id: IdentifierSchema,
  title: z.string().min(1).max(512),
  hypothesis: z.string().min(1).max(8192),
  cheapestFalsifier: z.string().min(1).max(8192),
  actor: ActorConditionSchema,
  worlds: z.array(WorldSpecSchema).min(1).max(64),
  grants: z.array(IdentifierSchema).max(64).default([]),
  initialSubject: SubjectSeedSchema.default({}),
  inheritedSubjectId: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  conditions: z.array(ConditionSchema).min(1).max(16).default([{ id: 'active', interventions: [] }]),
  limits: z.object({
    maxCycles: z.number().int().positive().max(10_000),
    maxActorCalls: z.number().int().positive().max(100_000),
    maxChallengeAttempts: z.number().int().positive().max(100).default(3),
    maxContactAttempts: z.number().int().positive().max(1_000).default(8),
    residentRetryDelayMs: z.number().int().min(10).max(3_600_000).default(5_000),
    continuityPulseMs: z.number().int().min(1_000).max(604_800_000).default(300_000),
    projectionHistoryEntries: z.number().int().positive().max(256).default(16),
  }),
  stoppingRule: z.string().min(1).max(4096),
});

export const WagerSchema = z.object({
  id: IdentifierSchema,
  stake: z.object({
    id: IdentifierSchema,
    question: z.string().min(1).max(8192),
  }),
  contact: z.object({
    world: IdentifierSchema,
    input: Json,
    mechanism: z.object({
      subjectPath: StatePointerSchema,
      inputKey: IdentifierSchema,
    }).optional(),
  }),
  predicates: z.object({
    support: PredicateSchema,
    contradiction: PredicateSchema,
    inconclusive: PredicateSchema.optional(),
  }),
  witnesses: z.object({
    support: z.object({ output: Json }),
    contradiction: z.object({ output: Json }),
  }),
  continuations: z.object({
    support: TransitionSchema.optional(),
    contradiction: TransitionSchema.optional(),
    inconclusive: TransitionSchema.optional(),
  }),
  revisionScope: z.array(StatePointerSchema).min(1).max(128),
  retainedFloorIds: z.array(IdentifierSchema).max(512),
  effectRequirements: z.array(IdentifierSchema).max(64),
  selection: SelectionSignalSchema.optional(),
});

export const OrientationSchema = z.object({
  summary: z.string().min(1).max(8192),
  liveStakes: z.array(z.string().min(1).max(4096)).max(128),
  recommendedNext: z.string().min(1).max(4096),
});

export const ChallengeSchema = z.object({ wagers: z.array(WagerSchema).min(1).max(16) });
export const ElectionSchema = z.object({ wagerId: IdentifierSchema, rationale: z.string().min(1).max(4096) });
export const AssimilationSchema = z.object({ transition: TransitionSchema, rationale: z.string().min(1).max(8192) });

export const RoleSchemas = {
  orient: OrientationSchema,
  challenge: ChallengeSchema,
  elect: ElectionSchema,
  assimilate: AssimilationSchema,
};

export const RoleTasks = {
  orient: 'Orient to the exact inherited subject position. Identify live stakes as concise descriptive text and the next consequence-bearing opening. Do not propose world contact yet.',
  challenge: [
    'Author one or more executable falsifiable wagers using an available world.',
    'Predicates are evaluated against a document shaped exactly as {output: WORLD_OUTPUT}; predicate paths for world fields therefore begin with /output.',
    'The support and contradiction witnesses are complete predicate documents shaped exactly as {output: WORLD_OUTPUT} and must each uniquely reach their named predicate branch.',
    'Wrap each complete example world output exactly once in the witness output property.',
    'effectRequirements must exactly equal the selected world adapter effects and every effect must be present in capabilities.effectiveGrants.',
    'retainedFloorIds must exactly name the inherited subject floors whose scopes overlap revisionScope; do not invent floor IDs.',
    'Every continuation mutation must stay within revisionScope.',
    'Omit contact.mechanism unless deliberately binding an existing exact subject value into an otherwise absent contact input key.',
    'Do not include optional inconclusive predicates or continuations unless they are needed.',
    'developmentalInterfaces.pursuitSelector is the exact writable contract for the standard selector organ.',
    'A wager may install, replace, or surrender that organ only through a prospectively bound continuation mutation at /mechanisms/pursuitSelector with revisionScope covering that path.',
    'If subject.mechanisms.pursuitSelector exists, every unblocked wager must publish a finite selection.measurements value for its named dimension. Blocked wagers set selection.blocked true. The kernel applies that retained selector deterministically before election.',
  ].join(' '),
  elect: 'Select exactly one wager whose id appears in frontier.selection.selectedIds. The retained selector has already transformed the frontier; you may break a preserved tie but may not override or rewrite the selection.',
  assimilate: 'The bound predicates left genuine residue. Author one exact scoped transition grounded in the retained receipt and evaluation. Do not claim a determinate branch that the predicates did not establish.',
};
