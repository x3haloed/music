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

export function retainedFailureBackoff(events, now, baseMs, maximumMs) {
  if (!Number.isFinite(now)) throw new Error('now must be finite');
  if (!Number.isInteger(baseMs) || baseMs < 100) throw new Error('failure backoff base must be at least 100ms');
  if (!Number.isInteger(maximumMs) || maximumMs < baseMs) throw new Error('maximum failure backoff must be at least the base');
  let failures = 0;
  let latestAt = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'perspective.completed') break;
    if (event.type !== 'perspective.failed') continue;
    latestAt ??= Date.parse(event.at);
    failures += 1;
  }
  if (failures === 0 || !Number.isFinite(latestAt)) return null;
  const delayMs = Math.min(maximumMs, baseMs * (2 ** Math.min(failures - 1, 30)));
  const retryAt = latestAt + delayMs;
  if (now >= retryAt) return null;
  return { failures, delayMs, retryAt, remainingMs: retryAt - now };
}
