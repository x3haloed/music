export function nextEncounterAt({ now, notBefore, lastEncounterAt = null, minimumCycleMs, continuityMs }) {
  if (!Number.isFinite(now)) throw new Error('now must be finite');
  if (!Number.isInteger(minimumCycleMs) || minimumCycleMs < 0) throw new Error('minimumCycleMs must be nonnegative');
  if (!Number.isInteger(continuityMs) || continuityMs < 1) throw new Error('continuityMs must be positive');
  if (minimumCycleMs > continuityMs) throw new Error('minimumCycleMs cannot exceed continuityMs');
  const requested = notBefore === null ? now : Date.parse(notBefore);
  if (!Number.isFinite(requested)) throw new Error('notBefore must be null or an ISO timestamp');
  const subjectOrContinuity = Math.min(Math.max(requested, now), now + continuityMs);
  const resourceFloor = lastEncounterAt === null ? now : lastEncounterAt + minimumCycleMs;
  return Math.max(subjectOrContinuity, resourceFloor);
}
