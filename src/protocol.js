import { z } from 'zod';
import {
  IdentifierSchema,
  RealizationSchema,
  StakeSchema,
  StatePointerSchema,
  SubjectMutationSchema,
  SubjectSeedSchema,
} from './subject.js';

const Json = z.json();

export const WorldSpecSchema = z.object({
  id: IdentifierSchema,
  adapter: IdentifierSchema,
  adapterIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  attestationTypes: z.array(IdentifierSchema).min(1).max(64),
  description: z.string().min(1).max(4096),
  publicContract: Json,
}).strict();

const OpenRouterSettingsSchema = z.object({
  timeoutMs: z.number().int().positive().max(3_600_000),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  temperature: z.number().min(0).max(2),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  maximumInputTokens: z.number().int().min(16_384).max(200_000).default(200_000),
  maximumInputCharacters: z.number().int().min(65_536).max(900_000).default(900_000),
}).strict();

const CodexSettingsSchema = z.object({
  authentication: z.literal('chatgpt-subscription'),
  binaryVersion: z.string().min(1).max(256),
  timeoutMs: z.number().int().positive().max(3_600_000),
  maxOutputBytes: z.number().int().min(1024).max(64 * 1024 * 1024),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  maximumInputTokens: z.number().int().min(16_384).max(200_000).default(200_000),
  maximumInputCharacters: z.number().int().min(65_536).max(900_000).default(900_000),
}).strict();

export const InferenceConditionSchema = z.object({
  format: z.literal('music-v4-inference-1'),
  provider: IdentifierSchema,
  model: z.string().min(1).max(256).nullable(),
  adapterIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  settings: z.record(z.string(), Json),
}).strict().superRefine((value, context) => {
  const schema = value.provider === 'openrouter' ? OpenRouterSettingsSchema : value.provider === 'codex' ? CodexSettingsSchema : null;
  if (!schema) return;
  const result = schema.safeParse(value.settings);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ ...issue, path: ['settings', ...issue.path] });
  }
});

export const RunSpecSchema = z.object({
  format: z.literal('music-v4-run-spec-1'),
  id: IdentifierSchema,
  title: z.string().min(1).max(512),
  inference: InferenceConditionSchema,
  worlds: z.array(WorldSpecSchema).min(1).max(64),
  grants: z.array(IdentifierSchema).max(64).default([]),
  initialSubject: SubjectSeedSchema.default({}),
  limits: z.object({
    maxOperations: z.number().int().positive().max(100_000),
    maxActorCalls: z.number().int().positive().max(100_000),
    maxRealizationAttempts: z.number().int().positive().max(100).default(4),
    maxContactAttempts: z.number().int().positive().max(1_000).default(8),
    residentRetryDelayMs: z.number().int().min(10).max(3_600_000).default(5_000),
    continuityPulseMs: z.number().int().min(1_000).max(604_800_000).default(300_000),
    projectionHistoryEntries: z.number().int().positive().max(256).default(16),
    maximumInputTokens: z.number().int().min(16_384).max(200_000).default(200_000),
    maximumInputCharacters: z.number().int().min(65_536).max(900_000).default(900_000),
  }).strict(),
  stoppingRule: z.string().min(1).max(4096),
}).strict();

export const SelectionSchema = z.object({
  opportunityId: IdentifierSchema,
  stake: StakeSchema,
  rationale: z.string().min(1).max(8192),
}).strict();

const OpportunityProposalSchema = z.object({
  id: IdentifierSchema,
  source: z.object({
    kind: z.enum(['unresolved', 'subject', 'world']),
    world: IdentifierSchema.nullable().default(null),
  }).strict(),
  description: z.string().min(1).max(8192),
  noveltyKey: z.string().min(1).max(1024),
}).strict();

export const ExpansionSchema = z.object({
  opportunities: z.array(OpportunityProposalSchema).max(16),
  wait: z.object({
    reason: z.string().min(1).max(8192),
    notBefore: z.iso.datetime(),
  }).strict().nullable(),
  rationale: z.string().min(1).max(8192),
}).strict().superRefine((value, context) => {
  if (value.opportunities.length === 0 && value.wait === null) {
    context.addIssue({ code: 'custom', message: 'empty expansion must author a bounded wait' });
  }
  if (value.opportunities.length > 0 && value.wait !== null) {
    context.addIssue({ code: 'custom', message: 'expansion cannot both open opportunities and wait' });
  }
});

export const JudgmentSchema = z.object({
  disposition: z.enum(['retry', 'retain', 'revise', 'redirect', 'retire', 'surrender']),
  revisedStake: StakeSchema.nullable(),
  mutation: SubjectMutationSchema,
  opportunities: z.array(OpportunityProposalSchema).max(16),
  wait: z.object({
    reason: z.string().min(1).max(8192),
    notBefore: z.iso.datetime(),
  }).strict().nullable(),
  rationale: z.string().min(1).max(8192),
}).strict();

export const RoleSchemas = {
  select: SelectionSchema,
  realize: RealizationSchema,
  correct: JudgmentSchema,
  assimilate: JudgmentSchema,
  expand: ExpansionSchema,
};

export const RoleTasks = {
  select: [
    'Choose exactly one opportunity from opportunityProjection.opportunities and formulate one bounded developmental stake.',
    'Selection establishes what bears on later choice; it does not execute a tool, invent consequence, or choose the operation class.',
    'Name concrete success and surrender conditions. mutationSurface lists the only durable identity, organ, memory, or capability paths that consequence may later revise.',
  ].join(' '),
  realize: [
    'Design exactly one executable contact for the active stake using an available world.',
    'The kernel will execute this exact call later. Do not claim that it ran.',
    'Predicates are evaluated against {output, attestations}; world output paths begin with /output.',
    'Support and contradiction witnesses each contain a complete example world output wrapped exactly once in {output: ...}.',
    'bearing.attestationTypes may name only types published by the selected world.',
    'effectRequirements must exactly equal the selected world effects.',
  ].join(' '),
  correct: [
    'The exact bound contact failed or contradicted the active stake. Return a structured correction.',
    'Choose retry, revise, redirect, retire, or surrender. revise requires revisedStake; other dispositions require null.',
    'retry or revise continues only the currently selected opportunity and cannot change its world. To open a differently sourced route, choose redirect and propose at least one replacement opportunity; the kernel will release this route and return ordinary choice to selection.',
    'Realization attempts belong to the active route and survive correction. When the sealed attempt limit is reached, the kernel releases retry or revise rather than refilling the budget.',
    'Durable mutation is allowed only inside the active stake mutationSurface. Receipts and lifecycle are not writable.',
    'A correction may revise the installed operation selector or attention organ when the consequence bears on that machinery.',
  ].join(' '),
  assimilate: [
    'Assimilate the exact completed consequence. Return retain, revise, retire, or surrender in structured form.',
    'retain continues the same stake into fresh contact; revise requires revisedStake; retire or surrender releases it.',
    'Durable mutation is allowed only inside the active stake mutationSurface. Do not restate lifecycle in prose.',
    'Add only genuinely opened opportunities grounded in the consequence; parameter-only renaming of completed contact is not expansion.',
  ].join(' '),
  expand: [
    'Current reachable opportunity standing is saturated. Inspect the exact subject and available world contracts and formulate bounded new opportunity geometry.',
    'Do not repeat an existing noveltyKey. An opportunity is attention content, not target or admission authority.',
    'If no honest reachable opportunity exists, return an empty list and a bounded wait. Waiting does not close the subject.',
  ].join(' '),
};

export function mutationPaths(mutation) {
  return [...Object.keys(mutation.set), ...mutation.remove];
}

export function assertJudgmentForRole(role, judgment) {
  if (role === 'correct' && judgment.disposition === 'retain') throw new Error('correction cannot retain without action');
  if (role === 'assimilate' && ['retry', 'redirect'].includes(judgment.disposition)) throw new Error('assimilation cannot retry or redirect a non-contradictory contact');
  if ((judgment.disposition === 'revise') !== (judgment.revisedStake !== null)) {
    throw new Error('revisedStake must be present exactly when disposition is revise');
  }
  if (judgment.disposition === 'redirect' && judgment.opportunities.length === 0) {
    throw new Error('redirect requires at least one proposed replacement opportunity');
  }
  if (judgment.disposition === 'redirect' && judgment.wait !== null) {
    throw new Error('redirect cannot wait while returning replacement opportunities to selection');
  }
}
