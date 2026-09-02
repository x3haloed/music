import { clone } from './canonical.js';
import { OperationSelectorSchema, OpportunitySchema, verifySubject } from './subject.js';

export const OPERATION_INTERFACE = Object.freeze({
  format: 'music-v4-operation-interface-1',
  description: 'The installed selector derives operation class from exact position. It does not choose semantic targets.',
  mutableAt: '/organs/operationSelector',
  operations: ['select', 'realize', 'contact', 'correct', 'assimilate', 'expand', 'wait'],
  authority: {
    choosesOperationClass: true,
    choosesTarget: false,
    executesEffects: false,
    admitsDevelopment: false,
  },
});

export function deriveOperation(subjectValue, { now = new Date() } = {}) {
  const subject = verifySubject(subjectValue);
  const selector = OperationSelectorSchema.parse(subject.organs.operationSelector);
  if (subject.active) {
    if (subject.active.consequence) {
      return decision(
        selector.consequenceRoutes[subject.active.consequence.classification],
        `installed selector routes ${subject.active.consequence.classification}`,
      );
    }
    if (!subject.active.realization) return decision('realize', 'selected stake has no bound contact');
    return decision('contact', 'bound contact has no consequence');
  }
  const open = projectOpportunities(subject).opportunities;
  if (open.length > 0) return decision('select', `${open.length} opportunities have standing`);
  if (subject.expansionAttempts < selector.expansionLimit) {
    return decision('expand', `local standing is saturated; expansion attempt ${subject.expansionAttempts + 1} is available`);
  }
  if (subject.wait && Date.parse(subject.wait.notBefore) > now.getTime()) {
    return decision('wait', `no standing opportunity; retained wait has not elapsed`, subject.wait.notBefore);
  }
  return decision('wait', 'no reachable opportunity currently has standing');
}

export function projectOpportunities(subjectValue) {
  const subject = verifySubject(subjectValue);
  const selector = OperationSelectorSchema.parse(subject.organs.operationSelector);
  const ranks = new Map(selector.sourcePriority.map((kind, index) => [kind, index]));
  const all = Object.values(subject.opportunities)
    .filter(value => value.standing === 'open')
    .sort((left, right) => {
      const source = ranks.get(left.source.kind) - ranks.get(right.source.kind);
      return source || left.attempts - right.attempts || left.id.localeCompare(right.id);
    });
  return {
    format: 'music-v4-opportunity-projection-1',
    authority: {
      target: false,
      contact: false,
      outcome: false,
      admission: false,
    },
    totalOpen: all.length,
    saturated: all.length === 0,
    omitted: Math.max(0, all.length - selector.projectionLimit),
    opportunities: all.slice(0, selector.projectionLimit).map(value => ({
      id: value.id,
      source: clone(value.source),
      description: value.description,
      noveltyKey: value.noveltyKey,
      attempts: value.attempts,
      standing: value.standing,
    })),
  };
}

export function addOpportunities(subjectValue, proposed, { evidence = null } = {}) {
  const subject = verifySubject(subjectValue);
  const opportunities = clone(subject.opportunities);
  const novelty = new Set(Object.values(opportunities).map(value => value.noveltyKey));
  const admitted = [];
  const rejected = [];
  for (const candidate of proposed) {
    const value = OpportunitySchema.parse({
      ...candidate,
      source: { ...candidate.source, evidence: candidate.source.evidence ?? evidence },
      standing: 'open',
      attempts: 0,
      lastConsequence: null,
    });
    if (Object.hasOwn(opportunities, value.id)) {
      rejected.push({ id: value.id, reason: 'duplicate-id' });
      continue;
    }
    if (novelty.has(value.noveltyKey)) {
      rejected.push({ id: value.id, reason: 'duplicate-novelty-key' });
      continue;
    }
    opportunities[value.id] = value;
    novelty.add(value.noveltyKey);
    admitted.push(value.id);
  }
  return { opportunities, admitted, rejected };
}

export function materializeObservation(subjectValue, observation, evidence) {
  const subject = verifySubject(subjectValue);
  const id = `observation:${observation.sequence}`;
  if (Object.hasOwn(subject.opportunities, id)) return { opportunities: clone(subject.opportunities), admitted: [] };
  const result = addOpportunities(subject, [{
    id,
    source: { kind: 'observation', world: null, evidence },
    description: `World contact from ${observation.from} on ${observation.channel}: ${boundedDescription(observation.content)}`,
    noveltyKey: `observation:${observation.sequence}`,
  }], { evidence });
  return result;
}

function decision(operation, reason, notBefore = null) {
  return { format: 'music-v4-operation-decision-1', operation, reason, notBefore };
}

function boundedDescription(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= 4096 ? text : `${text.slice(0, 4096)}…`;
}
