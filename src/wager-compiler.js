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
    supportValue: JsonValueSchema,
    contradictionValue: JsonValueSchema,
  }),
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
  const supportOutput = witness(tool.manifest.outputSchema, intent.discrimination.outputPath, intent.discrimination.supportValue);
  const contradictionOutput = witness(tool.manifest.outputSchema, intent.discrimination.outputPath, intent.discrimination.contradictionValue);
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
  const revisionScope = [...new Set(paths.map(path => `/${path.split('/')[1]}`))].sort();
  const retainedFloorIds = position.floors
    .filter(floor => paths.some(path => pathsOverlap(floor.scope, path)))
    .map(floor => floor.id)
    .sort();
  return WagerSchema.parse({
    id: intent.id,
    stake: intent.stake,
    contact: intent.contact,
    classifiers: {
      support: { op: 'eq', path: `/output${intent.discrimination.outputPath}`, value: intent.discrimination.supportValue },
      contradiction: { op: 'eq', path: `/output${intent.discrimination.outputPath}`, value: intent.discrimination.contradictionValue },
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

function witness(schema, pointer, value) {
  const output = synthesize(schema);
  setPointer(output, pointer, value);
  validateContract(schema, output, 'compiled witness output');
  return output;
}

function synthesize(schema) {
  if (Object.hasOwn(schema, 'const')) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') ?? 'null' : schema.type;
  if (type === 'object') {
    const value = {};
    for (const key of schema.required ?? []) value[key] = synthesize(schema.properties?.[key] ?? {});
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
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) {
      throw new Error(`discrimination path is absent from synthesized output: ${pointer}`);
    }
    cursor = cursor[part];
  }
  if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, parts.at(-1))) {
    throw new Error(`discrimination path is absent from synthesized output: ${pointer}`);
  }
  cursor[parts.at(-1)] = structuredClone(value);
}
