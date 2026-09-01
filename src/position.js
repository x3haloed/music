import { z } from 'zod';
import { digest } from './canonical.js';
import { IdentifierSchema, IsoDateSchema, JsonValueSchema } from './schema.js';
import { PredicateSchema } from './predicate.js';

const PointerSchema = z.string().regex(/^\/(stakes|mechanisms|authority|memory)(?:\/(?:[^/~]|~[01])*)*$/);

export const OpeningSchema = z.object({
  kind: z.enum(['continue', 'contact', 'seclusion']),
  notBefore: IsoDateSchema.nullable(),
  focus: z.string().min(1).max(4096),
});

export const TransitionSchema = z.object({
  kind: z.literal('position.transition'),
  set: z.record(PointerSchema, JsonValueSchema).default({}),
  remove: z.array(PointerSchema).max(64).default([]),
  opening: OpeningSchema,
});

const PositionFloorSchema = z.object({
  kind: z.literal('position').optional(),
  id: IdentifierSchema,
  scope: PointerSchema,
  predicate: PredicateSchema,
  earnedBy: z.string().min(1),
});

const ToolBehaviorFloorSchema = z.object({
  kind: z.literal('tool.behavior'),
  id: IdentifierSchema,
  scope: PointerSchema,
  toolId: IdentifierSchema,
  probes: z.array(z.object({ input: JsonValueSchema, expectation: PredicateSchema })).min(1).max(8),
  earnedBy: z.string().min(1),
});

export const FloorSchema = z.union([PositionFloorSchema, ToolBehaviorFloorSchema]);

export const PositionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  parent: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  generation: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  stakes: z.record(z.string(), JsonValueSchema),
  mechanisms: z.record(z.string(), JsonValueSchema),
  authority: z.record(z.string(), JsonValueSchema),
  memory: z.record(z.string(), JsonValueSchema),
  floors: z.array(FloorSchema),
  activeOpening: OpeningSchema,
});

export function initialPosition(at, initial = {}) {
  return identify({
    parent: null,
    generation: 0,
    createdAt: at,
    stakes: initial.stakes ?? {},
    mechanisms: initial.mechanisms ?? {},
    authority: initial.authority ?? {},
    memory: initial.memory ?? {},
    floors: initial.floors ?? [],
    activeOpening: {
      kind: 'continue',
      notBefore: null,
      focus: 'Encounter the available world and originate the first bounded developmental wager.',
    },
  });
}

export function verifyPosition(value) {
  const position = PositionSchema.parse(value);
  const { id, ...body } = position;
  if (digest(body) !== id) throw new Error(`position digest mismatch: ${id}`);
  return position;
}

export function applyTransition(positionValue, transitionValue, at) {
  const position = PositionSchema.parse(positionValue);
  const transition = TransitionSchema.parse(transitionValue);
  const next = structuredClone(position);
  delete next.id;
  next.parent = position.id;
  next.generation = position.generation + 1;
  next.createdAt = at;
  for (const [pointer, value] of Object.entries(transition.set)) setPointer(next, pointer, value);
  for (const pointer of transition.remove) removePointer(next, pointer);
  next.activeOpening = transition.opening;
  return identify(next);
}

export function withEarnedFloor(positionValue, floorValue) {
  const position = PositionSchema.parse(positionValue);
  const floor = FloorSchema.parse(floorValue);
  if (position.floors.some(value => value.id === floor.id)) throw new Error(`duplicate floor id: ${floor.id}`);
  const { id: _, ...body } = position;
  body.floors = [...body.floors, floor];
  return identify(body);
}

export function affectedPaths(transitionValue) {
  const transition = TransitionSchema.parse(transitionValue);
  return [...Object.keys(transition.set), ...transition.remove];
}

export function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function identify(body) {
  const id = digest(body);
  return PositionSchema.parse({ ...body, id });
}

function segments(pointer) {
  return pointer.slice(1).split('/').map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function setPointer(target, pointer, value) {
  const parts = segments(pointer);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') throw new Error('unsafe pointer');
    if (!Object.hasOwn(cursor, part)) cursor[part] = {};
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      throw new Error(`cannot descend through ${pointer}`);
    }
    cursor = cursor[part];
  }
  const leaf = parts.at(-1);
  if (leaf === '__proto__' || leaf === 'prototype' || leaf === 'constructor') throw new Error('unsafe pointer');
  cursor[leaf] = structuredClone(value);
}

function removePointer(target, pointer) {
  const parts = segments(pointer);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(cursor, part) || cursor[part] === null || typeof cursor[part] !== 'object') return;
    cursor = cursor[part];
  }
  delete cursor[parts.at(-1)];
}
