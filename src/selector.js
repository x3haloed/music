import { z } from 'zod';
import { clone, digest } from './canonical.js';

const Identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const PURSUIT_SELECTOR_KEY = 'pursuitSelector';

export const PursuitSelectorSchema = z.object({
  format: z.literal('music-v3-scalar-pursuit-selector-1'),
  id: Identifier,
  dimension: z.object({
    id: Identifier,
    meaning: z.string().min(1).max(4096),
    direction: z.enum(['maximize', 'minimize']),
  }),
  policies: z.object({
    missing: z.literal('reject-frontier'),
    blocked: z.literal('exclude'),
    tie: z.literal('preserve'),
  }),
});

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
  const dimension = selector.dimension.id;
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
      candidates.push({ id: wager.id, blocked: true, measurement: signal.measurements[dimension] ?? null, disposition: 'excluded-blocked' });
      continue;
    }
    const measurement = signal.measurements[dimension];
    if (measurement === undefined) {
      reasons.push(`${wager.id} is missing selector measurement ${dimension}`);
      candidates.push({ id: wager.id, blocked: false, measurement: null, disposition: 'invalid' });
      continue;
    }
    candidates.push({ id: wager.id, blocked: false, measurement, disposition: 'eligible' });
  }
  if (reasons.length > 0) return rejected(selector, wagers, reasons, candidates);
  const eligible = candidates.filter(value => value.disposition === 'eligible');
  if (eligible.length === 0) return rejected(selector, wagers, ['selector left no eligible wagers'], candidates);
  const measurements = eligible.map(value => value.measurement);
  const extreme = selector.dimension.direction === 'maximize' ? Math.max(...measurements) : Math.min(...measurements);
  const selectedIds = eligible.filter(value => value.measurement === extreme).map(value => value.id);
  return {
    format: 'music-v3-selection-1', mode: 'subject-selector',
    selector: { id: selector.id, digest: digest(selector), dimension: clone(selector.dimension), policies: clone(selector.policies) },
    candidates: candidates.map(value => ({ ...value, disposition: selectedIds.includes(value.id) ? 'selected' : value.disposition === 'eligible' ? 'not-selected' : value.disposition })),
    selectedIds, reasons: [],
  };
}

function rejected(selector, wagers, reasons, candidates = null) {
  return {
    format: 'music-v3-selection-1', mode: selector ? 'subject-selector' : 'actor-election',
    selector: selector ? { id: selector.id, digest: digest(selector), dimension: clone(selector.dimension), policies: clone(selector.policies) } : null,
    candidates: candidates ?? wagers.map(value => ({ id: value.id, blocked: false, measurement: null, disposition: 'invalid' })),
    selectedIds: [], reasons: [...reasons],
  };
}
