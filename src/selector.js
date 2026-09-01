import { z } from 'zod';
import { clone, digest } from './canonical.js';

const Identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const PURSUIT_SELECTOR_KEY = 'pursuitSelector';

const DEFAULT_DIMENSIONS = Object.freeze([
  Object.freeze({ id: 'demonstrated-harm-reduction', meaning: 'degree to which the pursuit addresses evidenced harm or urgent unresolved failure', direction: 'maximize' }),
  Object.freeze({ id: 'world-grounding', meaning: 'degree to which independent world contact can discriminate the pursuit from narration', direction: 'maximize' }),
  Object.freeze({ id: 'affordance-expansion', meaning: 'degree to which consequence can open useful later actions, contacts, or representations', direction: 'maximize' }),
  Object.freeze({ id: 'information-gain', meaning: 'degree to which contact can resolve a live uncertainty relevant to later selection', direction: 'maximize' }),
  Object.freeze({ id: 'reversibility', meaning: 'degree to which harmful consequence can be corrected or the pursuit can be surrendered', direction: 'maximize' }),
  Object.freeze({ id: 'cost', meaning: 'bounded expected expenditure of time, tokens, external resources, and foregone alternatives', direction: 'minimize' }),
  Object.freeze({ id: 'redundancy-saturation', meaning: 'degree to which the pursuit repeats already sufficient contact or evidence', direction: 'minimize' }),
]);

export const DEFAULT_PURSUIT_SELECTOR = Object.freeze({
  format: 'music-v3-pareto-pursuit-selector-1',
  id: 'music-default-developmental-pareto-1',
  dimensions: DEFAULT_DIMENSIONS,
  measurementRange: Object.freeze({ minimum: 0, maximum: 1 }),
  policies: Object.freeze({ missing: 'reject-frontier', blocked: 'exclude', tie: 'preserve' }),
});

export function defaultSelectionMeasurements(overrides = {}) {
  return Object.fromEntries(DEFAULT_DIMENSIONS.map(dimension => [dimension.id, overrides[dimension.id] ?? 0.5]));
}

export const PURSUIT_SELECTOR_INTERFACE = Object.freeze({
  format: 'music-v3-developmental-interface-1',
  subjectPath: '/mechanisms/pursuitSelector',
  purpose: 'Subject-owned executable machinery that deterministically restricts later wager frontiers before election. New subjects inherit the disclosed Pareto seed and may revise or surrender it through consequence.',
  selectorFormats: ['music-v3-pareto-pursuit-selector-1', 'music-v3-scalar-pursuit-selector-1'],
  defaultSelector: DEFAULT_PURSUIT_SELECTOR,
  selectorShape: 'Pareto selectors publish bounded directed dimensions; legacy scalar selectors publish one extreme-seeking dimension.',
  wagerSignalShape: { blocked: 'optional boolean', measurements: { 'dimension.id': 'finite number within the active selector range (the seed uses 0 through 1)' } },
  revision: 'Install, replace, or remove only through a prospectively bound wager continuation whose revisionScope includes /mechanisms/pursuitSelector.',
});

const PoliciesSchema = z.object({
  missing: z.literal('reject-frontier'),
  blocked: z.literal('exclude'),
  tie: z.literal('preserve'),
});

const ScalarPursuitSelectorSchema = z.object({
  format: z.literal('music-v3-scalar-pursuit-selector-1'),
  id: Identifier,
  dimension: z.object({
    id: Identifier,
    meaning: z.string().min(1).max(4096),
    direction: z.enum(['maximize', 'minimize']),
  }),
  policies: PoliciesSchema,
});

const ParetoPursuitSelectorSchema = z.object({
  format: z.literal('music-v3-pareto-pursuit-selector-1'),
  id: Identifier,
  dimensions: z.array(z.object({
    id: Identifier,
    meaning: z.string().min(1).max(4096),
    direction: z.enum(['maximize', 'minimize']),
  })).min(2).max(32).superRefine((dimensions, context) => {
    if (new Set(dimensions.map(value => value.id)).size !== dimensions.length) context.addIssue({ code: 'custom', message: 'selector dimensions must be unique' });
  }),
  measurementRange: z.object({ minimum: z.number().finite(), maximum: z.number().finite() }).refine(value => value.minimum < value.maximum, 'measurement range must increase'),
  policies: PoliciesSchema,
});

export const PursuitSelectorSchema = z.discriminatedUnion('format', [ScalarPursuitSelectorSchema, ParetoPursuitSelectorSchema]);

export const SelectionSignalSchema = z.object({
  blocked: z.boolean().default(false),
  measurements: z.record(Identifier, z.number().finite().min(-1_000_000).max(1_000_000)).default({}),
});

export function pursuitSelector(subject) {
  const value = subject?.mechanisms?.[PURSUIT_SELECTOR_KEY];
  return value === undefined ? null : PursuitSelectorSchema.parse(value);
}

export function selectWagers(subject, wagersValue) {
  const wagers = wagersValue.map(value => clone(value));
  const duplicateIds = wagers.map(value => value.id).filter((id, index, values) => values.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    return rejected(null, wagers, [`duplicate wager ids: ${[...new Set(duplicateIds)].sort().join(', ')}`]);
  }
  const selector = pursuitSelector(subject);
  if (!selector) {
    return {
      format: 'music-v3-selection-1', mode: 'actor-election', selector: null,
      candidates: wagers.map(value => ({ id: value.id, blocked: false, measurement: null, disposition: 'eligible' })),
      selectedIds: wagers.map(value => value.id), reasons: [],
    };
  }
  const dimensions = selector.format === 'music-v3-scalar-pursuit-selector-1' ? [selector.dimension] : selector.dimensions;
  const candidates = [];
  const reasons = [];
  for (const wager of wagers) {
    const parsed = SelectionSignalSchema.safeParse(wager.selection);
    if (!parsed.success) {
      reasons.push(`${wager.id} lacks a valid selection signal for selector ${selector.id}`);
      candidates.push({ id: wager.id, blocked: false, measurement: null, disposition: 'invalid' });
      continue;
    }
    const signal = parsed.data;
    if (signal.blocked) {
      const measurements = Object.fromEntries(dimensions.filter(value => signal.measurements[value.id] !== undefined).map(value => [value.id, signal.measurements[value.id]]));
      candidates.push({ id: wager.id, blocked: true, measurement: selector.format === 'music-v3-scalar-pursuit-selector-1' ? measurements[dimensions[0].id] ?? null : null, measurements, disposition: 'excluded-blocked' });
      continue;
    }
    const missing = dimensions.map(value => value.id).filter(id => signal.measurements[id] === undefined);
    if (missing.length > 0) {
      reasons.push(`${wager.id} is missing selector measurement ${missing.join(', ')}`);
      candidates.push({ id: wager.id, blocked: false, measurement: null, disposition: 'invalid' });
      continue;
    }
    const measurements = Object.fromEntries(dimensions.map(value => [value.id, signal.measurements[value.id]]));
    if (selector.format === 'music-v3-pareto-pursuit-selector-1') {
      const { minimum, maximum } = selector.measurementRange;
      const outside = Object.entries(measurements).find(([, value]) => value < minimum || value > maximum);
      if (outside) {
        reasons.push(`${wager.id} selector measurement ${outside[0]} is outside [${minimum}, ${maximum}]`);
        candidates.push({ id: wager.id, blocked: false, measurement: null, measurements, disposition: 'invalid' });
        continue;
      }
    }
    candidates.push({ id: wager.id, blocked: false, measurement: selector.format === 'music-v3-scalar-pursuit-selector-1' ? measurements[dimensions[0].id] : null, measurements, disposition: 'eligible' });
  }
  if (reasons.length > 0) return rejected(selector, wagers, reasons, candidates);
  const eligible = candidates.filter(value => value.disposition === 'eligible');
  if (eligible.length === 0) return rejected(selector, wagers, ['selector left no eligible wagers'], candidates);
  const selectedIds = selector.format === 'music-v3-scalar-pursuit-selector-1'
    ? selectScalar(selector, eligible)
    : eligible.filter(candidate => !eligible.some(other => other.id !== candidate.id && dominates(other, candidate, selector.dimensions))).map(value => value.id);
  return {
    format: 'music-v3-selection-1', mode: 'subject-selector',
    selector: selectorSummary(selector),
    candidates: candidates.map(value => ({ ...value, disposition: selectedIds.includes(value.id) ? 'selected' : value.disposition === 'eligible' ? 'not-selected' : value.disposition })),
    selectedIds, reasons: [],
  };
}

function rejected(selector, wagers, reasons, candidates = null) {
  return {
    format: 'music-v3-selection-1', mode: selector ? 'subject-selector' : 'actor-election',
    selector: selector ? selectorSummary(selector) : null,
    candidates: candidates ?? wagers.map(value => ({ id: value.id, blocked: false, measurement: null, disposition: 'invalid' })),
    selectedIds: [], reasons: [...reasons],
  };
}

function selectScalar(selector, eligible) {
  const measurements = eligible.map(value => value.measurement);
  const extreme = selector.dimension.direction === 'maximize' ? Math.max(...measurements) : Math.min(...measurements);
  return eligible.filter(value => value.measurement === extreme).map(value => value.id);
}

function dominates(left, right, dimensions) {
  let strictlyBetter = false;
  for (const dimension of dimensions) {
    const leftValue = left.measurements[dimension.id];
    const rightValue = right.measurements[dimension.id];
    const comparison = dimension.direction === 'maximize' ? leftValue - rightValue : rightValue - leftValue;
    if (comparison < 0) return false;
    if (comparison > 0) strictlyBetter = true;
  }
  return strictlyBetter;
}

function selectorSummary(selector) {
  return {
    id: selector.id,
    format: selector.format,
    digest: digest(selector),
    ...(selector.format === 'music-v3-scalar-pursuit-selector-1'
      ? { dimension: clone(selector.dimension) }
      : { dimensions: clone(selector.dimensions), measurementRange: clone(selector.measurementRange) }),
    policies: clone(selector.policies),
  };
}
