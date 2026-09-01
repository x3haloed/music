import { z } from 'zod';
import { JsonValueSchema } from './schema.js';

const PathSchema = z.string().regex(/^\/(?:[^/~]|~[01])*(?:\/(?:[^/~]|~[01])*)*$/);

export const PredicateSchema = z.lazy(() => z.discriminatedUnion('op', [
  z.object({ op: z.literal('exists'), path: PathSchema }),
  z.object({ op: z.literal('eq'), path: PathSchema, value: JsonValueSchema }),
  z.object({ op: z.literal('neq'), path: PathSchema, value: JsonValueSchema }),
  z.object({ op: z.literal('contains'), path: PathSchema, value: z.string() }),
  z.object({ op: z.enum(['gt', 'gte', 'lt', 'lte']), path: PathSchema, value: z.number().finite() }),
  z.object({ op: z.literal('all'), clauses: z.array(PredicateSchema).min(1).max(32) }),
  z.object({ op: z.literal('any'), clauses: z.array(PredicateSchema).min(1).max(32) }),
  z.object({ op: z.literal('not'), clause: PredicateSchema }),
]));

export function evaluatePredicate(input, candidate) {
  const predicate = PredicateSchema.parse(candidate);
  return evaluate(input, predicate);
}

export function classifyReceipt(receipt, classifiers) {
  const support = evaluatePredicate(receipt, classifiers.support);
  const contradiction = evaluatePredicate(receipt, classifiers.contradiction);
  if (support === contradiction) {
    return {
      kind: 'underdetermined',
      reason: support ? 'predicate-conflict' : 'predicate-gap',
      support,
      contradiction,
    };
  }
  return { kind: support ? 'support' : 'contradiction', support, contradiction };
}

function evaluate(input, predicate) {
  if (predicate.op === 'all') return predicate.clauses.every(clause => evaluate(input, clause));
  if (predicate.op === 'any') return predicate.clauses.some(clause => evaluate(input, clause));
  if (predicate.op === 'not') return !evaluate(input, predicate.clause);
  const { found, value } = resolvePointer(input, predicate.path);
  if (predicate.op === 'exists') return found;
  if (!found) return false;
  if (predicate.op === 'eq') return deepEqual(value, predicate.value);
  if (predicate.op === 'neq') return !deepEqual(value, predicate.value);
  if (predicate.op === 'contains') {
    return typeof value === 'string' && value.includes(predicate.value);
  }
  if (typeof value !== 'number') return false;
  if (predicate.op === 'gt') return value > predicate.value;
  if (predicate.op === 'gte') return value >= predicate.value;
  if (predicate.op === 'lt') return value < predicate.value;
  return value <= predicate.value;
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

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
