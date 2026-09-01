import { z } from 'zod';
import { classifyReceipt, PredicateSchema } from './predicate.js';
import { affectedPaths, pathsOverlap, TransitionSchema } from './position.js';
import { DigestSchema, IdentifierSchema, JsonValueSchema } from './schema.js';

export const WagerSchema = z.object({
  id: IdentifierSchema,
  stake: z.object({
    id: IdentifierSchema,
    description: z.string().min(1).max(4096),
    costOfDelay: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
  }),
  contact: z.object({
    tool: DigestSchema,
    input: JsonValueSchema,
  }),
  classifiers: z.object({
    support: PredicateSchema,
    contradiction: PredicateSchema,
  }),
  witnesses: z.object({
    support: JsonValueSchema,
    contradiction: JsonValueSchema,
  }),
  continuations: z.object({
    support: TransitionSchema,
    contradiction: TransitionSchema,
  }),
  retainedFloorIds: z.array(IdentifierSchema).max(128),
  revisionScope: z.array(z.string().regex(/^\/(stakes|mechanisms|authority|memory)(?:\/|$)/)).min(1).max(64),
  effectRequirements: z.array(IdentifierSchema).max(32),
});

export function admitWager(wagerValue, { position, grants = [], artifactExists, toolEffects = () => [] }) {
  const wager = WagerSchema.parse(wagerValue);
  const reasons = [];
  if (!artifactExists(wager.contact.tool)) reasons.push('contact tool artifact is absent');
  else {
    const requiredByTool = [...new Set(toolEffects(wager.contact.tool))].sort();
    const declaredByWager = [...new Set(wager.effectRequirements)].sort();
    if (JSON.stringify(requiredByTool) !== JSON.stringify(declaredByWager)) {
      reasons.push(`effect requirements must exactly match the contact tool: ${requiredByTool.join(', ')}`);
    }
  }

  const supportWitness = classifyReceipt(wager.witnesses.support, wager.classifiers);
  const contradictionWitness = classifyReceipt(wager.witnesses.contradiction, wager.classifiers);
  if (supportWitness.kind !== 'support') reasons.push('support witness does not uniquely reach support');
  if (contradictionWitness.kind !== 'contradiction') reasons.push('contradiction witness does not uniquely reach contradiction');

  const changed = [
    ...affectedPaths(wager.continuations.support),
    ...affectedPaths(wager.continuations.contradiction),
  ];
  for (const path of changed) {
    if (!wager.revisionScope.some(scope => pathsOverlap(scope.replace(/\/$/, ''), path))) {
      reasons.push(`transition path is outside revision scope: ${path}`);
    }
  }

  const derivedFloors = position.floors
    .filter(floor => changed.some(path => pathsOverlap(floor.scope, path)))
    .map(floor => floor.id)
    .sort();
  const declaredFloors = [...new Set(wager.retainedFloorIds)].sort();
  if (JSON.stringify(derivedFloors) !== JSON.stringify(declaredFloors)) {
    reasons.push(`retained floors must equal constitutionally derived floors: ${derivedFloors.join(', ')}`);
  }

  const granted = new Set(grants.filter(grant => grant.active).map(grant => grant.capability));
  for (const capability of wager.effectRequirements) {
    if (!granted.has(capability)) reasons.push(`missing effect grant: ${capability}`);
  }

  return {
    admissible: reasons.length === 0,
    reasons,
    derivedFloors,
    wager,
  };
}
