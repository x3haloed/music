import { z } from 'zod';
import { canonical } from './canonical.js';

const Pointer = z.string().regex(/^\/(?:[^/~]|~[01])*(?:\/(?:[^/~]|~[01])*)*$/);
const Json = z.json();

export const PredicateSchema = z.lazy(() => z.discriminatedUnion('op', [
  z.object({ op: z.literal('exists'), path: Pointer }),
  z.object({ op: z.enum(['eq', 'neq', 'contains', 'set-eq', 'subset']), path: Pointer, value: Json }),
  z.object({ op: z.enum(['gt', 'gte', 'lt', 'lte']), path: Pointer, value: z.number().finite() }),
  z.object({ op: z.literal('length'), path: Pointer, comparison: z.enum(['eq', 'gt', 'gte', 'lt', 'lte']), value: z.number().int().nonnegative() }),
  z.object({ op: z.literal('all'), clauses: z.array(PredicateSchema).min(1).max(64) }),
  z.object({ op: z.literal('any'), clauses: z.array(PredicateSchema).min(1).max(64) }),
  z.object({ op: z.literal('not'), clause: PredicateSchema }),
]));

export function evaluatePredicate(input, candidate) {
  return evaluate(input, PredicateSchema.parse(candidate));
}

export function classify(input, predicates) {
  const outcomes = ['support', 'contradiction', 'inconclusive']
    .filter(kind => predicates[kind] !== undefined)
    .map(kind => ({ kind, matched: evaluatePredicate(input, predicates[kind]) }));
  const matched = outcomes.filter(value => value.matched);
  if (matched.length === 1) return { kind: matched[0].kind, matches: outcomes };
  return {
    kind: 'underdetermined',
    reason: matched.length === 0 ? 'predicate-gap' : 'predicate-conflict',
    matches: outcomes,
  };
}

export function resolvePointer(input, pointer) {
  let value = input;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      return { found: false, value: undefined };
    }
    value = value[key];
  }
  return { found: true, value };
}

function evaluate(input, predicate) {
  if (predicate.op === 'all') return predicate.clauses.every(clause => evaluate(input, clause));
  if (predicate.op === 'any') return predicate.clauses.some(clause => evaluate(input, clause));
  if (predicate.op === 'not') return !evaluate(input, predicate.clause);
  const { found, value } = resolvePointer(input, predicate.path);
  if (predicate.op === 'exists') return found;
  if (!found) return false;
  if (predicate.op === 'eq') return equal(value, predicate.value);
  if (predicate.op === 'neq') return !equal(value, predicate.value);
  if (predicate.op === 'contains') {
    if (typeof value === 'string') return typeof predicate.value === 'string' && value.includes(predicate.value);
    if (Array.isArray(value)) return value.some(entry => equal(entry, predicate.value));
    return false;
  }
  if (predicate.op === 'set-eq') return setEqual(value, predicate.value);
  if (predicate.op === 'subset') return subset(value, predicate.value);
  if (predicate.op === 'length') {
    if (typeof value !== 'string' && !Array.isArray(value) && (value === null || typeof value !== 'object')) return false;
    return compare(Array.isArray(value) || typeof value === 'string' ? value.length : Object.keys(value).length, predicate.comparison, predicate.value);
  }
  return typeof value === 'number' && compare(value, predicate.op, predicate.value);
}

function compare(left, operator, right) {
  if (operator === 'eq') return left === right;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  return left <= right;
}

function equal(left, right) {
  return canonical(left) === canonical(right);
}

function setEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && subset(left, right) && subset(right, left);
}

function subset(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.every(value => right.some(other => equal(value, other)));
}
