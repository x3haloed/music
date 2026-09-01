import { z } from 'zod';
import { JsonValueSchema, IdentifierSchema } from './schema.js';
import { OpeningSchema, pathsOverlap, TransitionSchema } from './position.js';
import { ToolArtifactSchema, validateContract } from './tools.js';
import { WagerSchema } from './constitution.js';

const MutationSetSchema = z.record(
  z.string().regex(/^\/(stakes|memory)(?:\/(?:[^/~]|~[01])*)+$/),
  JsonValueSchema,
);

const ContinuationIntentSchema = z.object({
  set: MutationSetSchema,
  remove: z.array(z.string().regex(/^\/(stakes|memory)(?:\/(?:[^/~]|~[01])*)+$/)).max(32),
  opening: OpeningSchema,
});

const ComparisonSchema = z.object({
  operator: z.enum(['eq', 'contains', 'gt', 'gte', 'lt', 'lte']).default('eq'),
  value: JsonValueSchema,
});

export const WagerIntentSchema = z.object({
  id: IdentifierSchema,
  stake: z.object({
    id: IdentifierSchema,
    description: z.string().min(1).max(4096),
    costOfDelay: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
  }),
  contact: z.object({ tool: z.string().regex(/^[a-f0-9]{64}$/), input: JsonValueSchema }),
  discrimination: z.object({
    outputPath: z.string().regex(/^\/(?:[^/~]|~[01])*(?:\/(?:[^/~]|~[01])*)*$/),
    support: ComparisonSchema,
    contradiction: ComparisonSchema,
  }),
  developmentScope: z.array(z.enum(['/stakes', '/memory', '/mechanisms', '/authority'])).min(1).max(4),
  continuations: z.object({
    support: ContinuationIntentSchema,
    contradiction: ContinuationIntentSchema,
  }),
});

export const ChallengeIntentSchema = z.object({
  candidates: z.array(WagerIntentSchema).length(2),
});

export function compileWager(intentValue, { position, readTool }) {
  const intent = WagerIntentSchema.parse(intentValue);
  const tool = ToolArtifactSchema.parse(readTool(intent.contact.tool));
  validateContract(tool.manifest.inputSchema, intent.contact.input, `${intent.id} contact input`);
  const supportValue = witnessValue(intent.discrimination.support);
  const contradictionValue = witnessValue(intent.discrimination.contradiction);
  const supportOutput = witness(tool.manifest.outputSchema, intent.discrimination.outputPath, supportValue);
  const contradictionOutput = witness(tool.manifest.outputSchema, intent.discrimination.outputPath, contradictionValue);
  if (JSON.stringify(supportOutput) === JSON.stringify(contradictionOutput)) {
    throw new Error(`${intent.id} support and contradiction witnesses are identical`);
  }
  const continuations = {
    support: TransitionSchema.parse({ kind: 'position.transition', ...intent.continuations.support }),
    contradiction: TransitionSchema.parse({ kind: 'position.transition', ...intent.continuations.contradiction }),
  };
  const paths = [
    ...Object.keys(continuations.support.set),
    ...continuations.support.remove,
    ...Object.keys(continuations.contradiction.set),
    ...continuations.contradiction.remove,
  ];
  const continuationScope = paths.map(path => `/${path.split('/')[1]}`);
  const revisionScope = [...new Set([...continuationScope, ...intent.developmentScope])].sort();
  const retainedFloorIds = position.floors
    .filter(floor => paths.some(path => pathsOverlap(floor.scope, path)))
    .map(floor => floor.id)
    .sort();
  return WagerSchema.parse({
    id: intent.id,
    stake: intent.stake,
    contact: intent.contact,
    classifiers: {
      support: predicate(intent.discrimination.outputPath, intent.discrimination.support),
      contradiction: predicate(intent.discrimination.outputPath, intent.discrimination.contradiction),
    },
    witnesses: {
      support: { output: supportOutput },
      contradiction: { output: contradictionOutput },
    },
    continuations,
    retainedFloorIds,
    revisionScope,
    effectRequirements: tool.manifest.effects,
  });
}

function predicate(outputPath, comparison) {
  return { op: comparison.operator, path: `/output${outputPath}`, value: comparison.value };
}

function witnessValue(comparison) {
  const { operator, value } = comparison;
  if (operator === 'eq' || operator === 'gte' || operator === 'lte' || operator === 'contains') {
    return structuredClone(value);
  }
  if (typeof value !== 'number') throw new Error(`${operator} comparison requires a numeric value`);
  if (operator === 'gt') return value + Math.max(1, Math.abs(value) * Number.EPSILON);
  if (operator === 'lt') return value - Math.max(1, Math.abs(value) * Number.EPSILON);
  throw new Error(`unsupported comparison operator: ${operator}`);
}

function witness(schema, pointer, value) {
  const output = synthesize(schema);
  setPointer(output, pointer, value);
  validateContract(schema, output, 'compiled witness output');
  return output;
}

function synthesize(schema) {
  if (Object.keys(schema).length === 0) return {};
  if (Object.hasOwn(schema, 'const')) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') ?? 'null' : schema.type;
  if (type === 'object') {
    const value = {};
    for (const [key, child] of Object.entries(schema.properties ?? {})) value[key] = synthesize(child);
    return value;
  }
  if (type === 'array') return [];
  if (type === 'string') return '';
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  throw new Error('tool output schema cannot produce a public witness');
}

function setPointer(target, pointer, value) {
  const parts = pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (cursor === null || typeof cursor !== 'object') throw new Error(`discrimination path cannot exist in synthesized output: ${pointer}`);
    if (!Object.hasOwn(cursor, part)) cursor[part] = {};
    cursor = cursor[part];
  }
  if (cursor === null || typeof cursor !== 'object') throw new Error(`discrimination path cannot exist in synthesized output: ${pointer}`);
  cursor[parts.at(-1)] = structuredClone(value);
}
