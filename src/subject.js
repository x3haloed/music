import { z } from 'zod';
import { clone, digest } from './canonical.js';
import { PredicateSchema, evaluatePredicate } from './predicate.js';
import { DEFAULT_PURSUIT_SELECTOR, PURSUIT_SELECTOR_KEY, PursuitSelectorSchema } from './selector.js';
import { verifyAttestation } from './world.js';

const Json = z.json();
const MechanismsSchema = z.record(z.string(), Json).superRefine((value, context) => {
  if (!Object.hasOwn(value, PURSUIT_SELECTOR_KEY)) return;
  const parsed = PursuitSelectorSchema.safeParse(value[PURSUIT_SELECTOR_KEY]);
  if (!parsed.success) context.addIssue({ code: 'custom', message: `invalid ${PURSUIT_SELECTOR_KEY}: ${parsed.error.message}` });
});
export const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const StatePointerSchema = z.string().regex(/^\/(stakes|mechanisms|language|authority|memory)(?:\/(?:[^/~]|~[01])*)*$/);

export const ContinuationSchema = z.object({
  kind: z.enum(['continue', 'seclusion', 'stop']),
  focus: z.string().min(1).max(8192),
  notBefore: z.iso.datetime().nullable().default(null),
});

export const FloorSchema = z.object({
  id: IdentifierSchema,
  scope: StatePointerSchema,
  predicate: PredicateSchema,
  earnedBy: z.string().min(1).max(256),
});

export const SubjectSchema = z.object({
  format: z.literal('music-v3-subject-1'),
  id: DigestSchema,
  parent: DigestSchema.nullable(),
  generation: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  stakes: z.record(z.string(), Json),
  mechanisms: MechanismsSchema,
  language: z.record(z.string(), Json),
  authority: z.record(z.string(), Json),
  memory: z.record(z.string(), Json),
  facts: z.record(z.string(), Json).optional(),
  floors: z.array(FloorSchema).max(512),
  continuation: ContinuationSchema,
});

export const SubjectSeedSchema = SubjectSchema.omit({ id: true, parent: true, generation: true, createdAt: true, facts: true }).partial({
  format: true,
  stakes: true,
  mechanisms: true,
  language: true,
  authority: true,
  memory: true,
  floors: true,
  continuation: true,
}).strict();

export const TransitionSchema = z.object({
  set: z.record(StatePointerSchema, Json).default({}),
  remove: z.array(StatePointerSchema).max(128).default([]),
  continuation: ContinuationSchema,
});

export function createSubject(seedValue, at) {
  const seed = SubjectSeedSchema.parse(seedValue);
  return identify({
    format: 'music-v3-subject-1',
    parent: null,
    generation: 0,
    createdAt: at,
    stakes: seed.stakes ?? {},
    mechanisms: { [PURSUIT_SELECTOR_KEY]: clone(DEFAULT_PURSUIT_SELECTOR), ...(seed.mechanisms ?? {}) },
    language: seed.language ?? {},
    authority: seed.authority ?? {},
    memory: seed.memory ?? {},
    facts: seed.facts ?? {},
    floors: seed.floors ?? [],
    continuation: seed.continuation ?? {
      kind: 'continue',
      focus: 'Originate one bounded falsifiable contact with the available world.',
      notBefore: null,
    },
  });
}

export function verifySubject(value) {
  const subject = SubjectSchema.parse(value);
  const { id, ...body } = subject;
  if (digest(body) !== id) throw new Error(`subject identity mismatch: ${id}`);
  return subject;
}

export function applyTransition(subjectValue, transitionValue, at, { attestations = [] } = {}) {
  const subject = verifySubject(subjectValue);
  const transition = TransitionSchema.parse(transitionValue);
  const next = clone(subject);
  delete next.id;
  next.parent = subject.id;
  next.generation += 1;
  next.createdAt = at;
  next.facts ??= {};
  for (const value of attestations) {
    const attestation = verifyAttestation(value);
    next.facts[attestation.id] = clone(attestation);
  }
  for (const [pointer, value] of Object.entries(transition.set)) setPointer(next, pointer, value);
  for (const pointer of transition.remove) removePointer(next, pointer);
  next.continuation = transition.continuation;
  for (const floor of next.floors) {
    if (!evaluatePredicate(next, floor.predicate)) throw new Error(`transition violates retained floor: ${floor.id}`);
  }
  return identify(next);
}

export function affectedPaths(transitionValue) {
  const transition = TransitionSchema.parse(transitionValue);
  return [...Object.keys(transition.set), ...transition.remove];
}

export function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function eraseProjection(value, pointers = [], replacements = {}) {
  const projected = clone(value);
  for (const pointer of pointers) removePointer(projected, pointer);
  for (const [pointer, replacement] of Object.entries(replacements)) setPointer(projected, pointer, replacement);
  return projected;
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
