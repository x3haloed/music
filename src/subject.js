import { z } from 'zod';
import { clone, digest } from './canonical.js';
import { PredicateSchema, evaluatePredicate } from './predicate.js';
import { DEFAULT_ATTENTION_POLICY, AttentionPolicySchema } from './attention.js';
import { verifyAttestation } from './world.js';

const Json = z.json();

export const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const StatePointerSchema = z.string().regex(/^\/(identity|organs|memory|capabilities)(?:\/(?:[^/~]|~[01])*)*$/);
export const OperationSchema = z.enum(['select', 'realize', 'contact', 'correct', 'assimilate', 'expand', 'wait']);

export const OperationSelectorSchema = z.object({
  format: z.literal('music-v4-operation-selector-1'),
  version: z.number().int().positive(),
  consequenceRoutes: z.object({
    support: z.enum(['assimilate', 'correct']),
    contradiction: z.enum(['correct', 'assimilate']),
    inconclusive: z.enum(['assimilate', 'correct']),
    failure: z.enum(['correct', 'assimilate']),
  }).strict(),
  sourcePriority: z.array(z.enum(['observation', 'unresolved', 'subject', 'world'])).length(4),
  projectionLimit: z.number().int().min(1).max(64),
  expansionLimit: z.number().int().min(1).max(16),
  waitMs: z.number().int().min(1_000).max(604_800_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourcePriority).size !== value.sourcePriority.length) {
    context.addIssue({ code: 'custom', path: ['sourcePriority'], message: 'source priority must contain each source exactly once' });
  }
});

export const DEFAULT_OPERATION_SELECTOR = Object.freeze({
  format: 'music-v4-operation-selector-1',
  version: 1,
  consequenceRoutes: {
    support: 'assimilate',
    contradiction: 'correct',
    inconclusive: 'assimilate',
    failure: 'correct',
  },
  sourcePriority: ['observation', 'unresolved', 'subject', 'world'],
  projectionLimit: 16,
  expansionLimit: 2,
  waitMs: 300_000,
});

export const StakeSchema = z.object({
  id: IdentifierSchema,
  question: z.string().min(1).max(8192),
  successCondition: z.string().min(1).max(8192),
  surrenderCondition: z.string().min(1).max(8192),
  mutationSurface: z.array(StatePointerSchema).max(128).default([]),
}).strict();

export const OpportunitySchema = z.object({
  id: IdentifierSchema,
  source: z.object({
    kind: z.enum(['observation', 'unresolved', 'subject', 'world']),
    world: IdentifierSchema.nullable().default(null),
    evidence: DigestSchema.nullable().default(null),
  }).strict(),
  description: z.string().min(1).max(8192),
  noveltyKey: z.string().min(1).max(1024),
  standing: z.enum(['open', 'selected', 'contacted', 'completed', 'surrendered', 'blocked']),
  attempts: z.number().int().nonnegative(),
  lastConsequence: DigestSchema.nullable(),
}).strict();

export const RealizationSchema = z.object({
  world: IdentifierSchema,
  input: Json,
  bearing: z.object({
    attestationTypes: z.array(IdentifierSchema).min(1).max(64),
    interpretation: z.string().min(1).max(8192),
  }).strict(),
  predicates: z.object({
    support: PredicateSchema,
    contradiction: PredicateSchema,
    inconclusive: PredicateSchema.optional(),
  }).strict(),
  witnesses: z.object({
    support: z.object({ output: Json }).strict(),
    contradiction: z.object({ output: Json }).strict(),
  }).strict(),
  effectRequirements: z.array(IdentifierSchema).max(64),
}).strict();

export const ConsequenceSchema = z.object({
  kind: z.enum(['receipt', 'failure']),
  classification: z.enum(['support', 'contradiction', 'inconclusive', 'failure']),
  receipt: DigestSchema.nullable(),
  attestations: z.array(DigestSchema).max(64),
  detail: Json,
}).strict();

export const ActivePositionSchema = z.object({
  opportunityId: IdentifierSchema,
  stake: StakeSchema,
  realization: RealizationSchema.nullable(),
  binding: DigestSchema.nullable(),
  consequence: ConsequenceSchema.nullable(),
  realizationAttempts: z.number().int().nonnegative(),
}).strict();

export const FloorSchema = z.object({
  id: IdentifierSchema,
  scope: StatePointerSchema,
  predicate: PredicateSchema,
  earnedBy: z.string().min(1).max(256),
}).strict();

export const SubjectSchema = z.object({
  format: z.literal('music-v4-subject-1'),
  id: DigestSchema,
  parent: DigestSchema.nullable(),
  succession: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  identity: z.object({
    name: z.string().min(1).max(256).nullable(),
    description: z.string().min(1).max(4096),
  }).passthrough(),
  organs: z.object({
    operationSelector: OperationSelectorSchema,
    attentionPolicy: AttentionPolicySchema,
  }).passthrough(),
  memory: z.record(z.string(), Json),
  capabilities: z.record(z.string(), Json),
  facts: z.record(z.string(), Json),
  opportunities: z.record(z.string(), OpportunitySchema),
  active: ActivePositionSchema.nullable(),
  expansionAttempts: z.number().int().nonnegative(),
  wait: z.object({
    reason: z.string().min(1).max(8192),
    notBefore: z.iso.datetime(),
  }).strict().nullable(),
  floors: z.array(FloorSchema).max(512),
}).strict();

export const SubjectSeedSchema = z.object({
  identity: SubjectSchema.shape.identity.partial().optional(),
  organs: SubjectSchema.shape.organs.partial().optional(),
  memory: z.record(z.string(), Json).optional(),
  capabilities: z.record(z.string(), Json).optional(),
  floors: z.array(FloorSchema).max(512).optional(),
}).strict();

export const SubjectMutationSchema = z.object({
  set: z.record(StatePointerSchema, Json).default({}),
  remove: z.array(StatePointerSchema).max(128).default([]),
}).strict();

export function createSubject(seedValue, worlds, at) {
  const seed = SubjectSeedSchema.parse(seedValue ?? {});
  const opportunities = {};
  for (const world of worlds) {
    const id = `world:${world.id}`;
    opportunities[id] = OpportunitySchema.parse({
      id,
      source: { kind: 'world', world: world.id, evidence: null },
      description: world.description,
      noveltyKey: `world:${world.id}`,
      standing: 'open',
      attempts: 0,
      lastConsequence: null,
    });
  }
  return identify({
    format: 'music-v4-subject-1',
    parent: null,
    succession: 0,
    revision: 0,
    createdAt: at,
    identity: {
      name: null,
      description: 'A continuing subject whose identity may develop through world contact.',
      ...(seed.identity ?? {}),
    },
    organs: {
      operationSelector: clone(DEFAULT_OPERATION_SELECTOR),
      attentionPolicy: clone(DEFAULT_ATTENTION_POLICY),
      ...(seed.organs ?? {}),
    },
    memory: seed.memory ?? {},
    capabilities: seed.capabilities ?? {},
    facts: {},
    opportunities,
    active: null,
    expansionAttempts: 0,
    wait: null,
    floors: seed.floors ?? [],
  });
}

export function verifySubject(value) {
  const subject = SubjectSchema.parse(value);
  const { id, ...body } = subject;
  if (digest(body) !== id) throw new Error(`subject identity mismatch: ${id}`);
  return subject;
}

export function advanceSubject(subjectValue, change, at) {
  const subject = verifySubject(subjectValue);
  const next = clone(subject);
  delete next.id;
  next.parent = subject.id;
  next.succession += 1;
  next.createdAt = at;
  if (change.developmental) next.revision += 1;
  if (change.mutation) applyMutation(next, change.mutation);
  if (change.opportunities) next.opportunities = clone(change.opportunities);
  if (Object.hasOwn(change, 'active')) next.active = clone(change.active);
  if (Object.hasOwn(change, 'expansionAttempts')) next.expansionAttempts = change.expansionAttempts;
  if (Object.hasOwn(change, 'wait')) next.wait = clone(change.wait);
  for (const value of change.attestations ?? []) {
    const attestation = verifyAttestation(value);
    next.facts[attestation.id] = clone(attestation);
  }
  for (const floor of next.floors) {
    if (!evaluatePredicate(next, floor.predicate)) throw new Error(`subject revision violates retained floor: ${floor.id}`);
  }
  return identify(next);
}

export function applyMutation(target, mutationValue) {
  const mutation = SubjectMutationSchema.parse(mutationValue);
  for (const [pointer, value] of Object.entries(mutation.set)) setPointer(target, pointer, value);
  for (const pointer of mutation.remove) removePointer(target, pointer);
  SubjectSchema.shape.identity.parse(target.identity);
  SubjectSchema.shape.organs.parse(target.organs);
  return target;
}

export function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function identify(body) {
  return SubjectSchema.parse({ ...body, id: digest(body) });
}

function parts(pointer) {
  return pointer.slice(1).split('/').map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function safe(part) {
  if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error('unsafe state pointer');
}

function setPointer(target, pointer, value) {
  const path = parts(pointer);
  let cursor = target;
  for (const part of path.slice(0, -1)) {
    safe(part);
    if (!Object.hasOwn(cursor, part)) cursor[part] = {};
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      throw new Error(`cannot descend through ${pointer}`);
    }
    cursor = cursor[part];
  }
  safe(path.at(-1));
  cursor[path.at(-1)] = clone(value);
}

function removePointer(target, pointer) {
  const path = parts(pointer);
  let cursor = target;
  for (const part of path.slice(0, -1)) {
    safe(part);
    if (!Object.hasOwn(cursor, part) || cursor[part] === null || typeof cursor[part] !== 'object') return;
    cursor = cursor[part];
  }
  safe(path.at(-1));
  delete cursor[path.at(-1)];
}
