import { setTimeout as delay } from 'node:timers/promises';
import { archiveIngressFile, pendingIngressFiles, prepareIngress, readIngressDelta } from './ingress.js';

export class MusicResident {
  constructor(kernel, mind, {
    ingress,
    pollMs = 250,
    heartbeatMs = 15 * 60_000,
    failureBackoffMs = 5_000,
    maxFailureBackoffMs = 5 * 60_000,
    runtime = null,
    clock = () => Date.now(),
    onError = () => {},
  } = {}) {
    if (!ingress) throw new Error('MusicResident needs a durable ingress directory');
    if (!Number.isInteger(pollMs) || pollMs < 10) throw new Error('resident pollMs must be an integer of at least 10');
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000) throw new Error('resident heartbeatMs must be an integer of at least 1000');
    if (!Number.isInteger(failureBackoffMs) || failureBackoffMs < 100) throw new Error('failureBackoffMs must be an integer of at least 100');
    if (!Number.isInteger(maxFailureBackoffMs) || maxFailureBackoffMs < failureBackoffMs) {
      throw new Error('maxFailureBackoffMs must be an integer at least as large as failureBackoffMs');
    }
    this.kernel = kernel;
    this.mind = mind;
    this.ingress = prepareIngress(ingress).root;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.failureBackoffMs = failureBackoffMs;
    this.maxFailureBackoffMs = maxFailureBackoffMs;
    this.runtime = runtime === null ? null : structuredClone(runtime);
    this.clock = clock;
    this.onError = onError;
    this.activeEncounter = null;
    this.abortSignal = undefined;
    this.lastEncounterAt = null;
  }

  async recover() {
    const ledgerTail = this.kernel.recoverLedgerTail();
    const inferenceId = this.kernel.recoverInterruptedInference('The resident process ended before its active encounter completed.');
    const projectionIds = this.kernel.recoverInterruptedDeliveryProjections('The resident process ended before delivery projection completion was retained.');
    return { ledgerTail, inferenceId, projectionIds };
  }

  async pump() {
    this.lastEncounterAt ??= latestEncounterAt(this.kernel.events()) ?? this.clock();
    const admitted = this.drainIngress();
    if (this.activeEncounter || this.kernel.state().activeInferenceId) return { admitted, started: false };
    const backoff = retainedFailureBackoff(
      this.kernel.events(), this.clock(), this.failureBackoffMs, this.maxFailureBackoffMs,
    );
    if (backoff) return { admitted, started: false, backoff };
    const state = this.kernel.state();
    if (state.openSoundingId) {
      this.startSounding(state.openSoundingId);
      return { admitted, started: true };
    }
    const openingPending = state.position?.activeOpening
      && !state.presentedOpeningIds?.has(state.position.activeOpening.id);
    const openingDue = openingPending
      && (state.position.activeOpening.notBefore === null
        || this.clock() >= Date.parse(state.position.activeOpening.notBefore));
    const trigger = state.pendingDeltas.length > 0
      ? 'delta'
      : (state.consequenceSweepActive && state.consequenceSweepIds.length > 0
        ? 'continuation'
        : (openingDue
          ? 'opening'
          : (openingPending
            ? null
            : (state.nextWake
              ? (this.clock() >= Date.parse(state.nextWake.wakeAt) ? 'scheduled' : null)
              : (this.clock() - this.lastEncounterAt >= this.heartbeatMs ? 'heartbeat' : null)))));
    if (!trigger) return { admitted, started: false };
    this.startEncounter(trigger);
    return { admitted, started: true };
  }

  drainIngress() {
    let admitted = 0;
    for (const path of pendingIngressFiles(this.ingress)) {
      try {
        const delta = readIngressDelta(path);
        if (!this.kernel.state().deltaIds.has(delta?.id)) {
          this.kernel.admitDelta(delta);
          admitted += 1;
        }
        archiveIngressFile(this.ingress, path, 'accepted');
      } catch (error) {
        archiveIngressFile(this.ingress, path, 'rejected', error);
        this.onError(error);
      }
    }
    return admitted;
  }

  startEncounter(trigger = 'manual') {
    if (this.activeEncounter) return this.activeEncounter;
    const sounding = this.kernel.openSounding(trigger);
    return this.startSounding(sounding.id);
  }

  startSounding(soundingId) {
    if (this.activeEncounter) return this.activeEncounter;
    this.lastEncounterAt = this.clock();
    const encounter = Promise.resolve()
      .then(() => this.mind.receive(soundingId, { abortSignal: this.abortSignal }))
      .catch(error => {
        this.onError(error);
        return { ok: false, error };
      })
      .finally(() => {
        if (this.activeEncounter === encounter) this.activeEncounter = null;
      });
    this.activeEncounter = encounter;
    return encounter;
  }

  async whenIdle() {
    while (this.activeEncounter) {
      try { await this.activeEncounter; } catch {}
      await this.pump();
    }
  }

  async run({ signal, encounterSignal } = {}) {
    const releaseWriter = this.kernel.acquireWriter('resident');
    try {
      this.abortSignal = encounterSignal;
      await this.recover();
      if (this.runtime) this.kernel.recordRuntimeStart(this.runtime);
      while (!signal?.aborted) {
        await this.pump();
        try {
          await delay(this.pollMs, undefined, signal ? { signal } : undefined);
        } catch (error) {
          if (signal?.aborted) break;
          throw error;
        }
      }
      if (this.activeEncounter) await this.activeEncounter;
    } finally {
      releaseWriter();
    }
  }
}

function latestEncounterAt(events) {
  const event = [...events].reverse().find(candidate => candidate.type === 'sounding_opened');
  return event ? Date.parse(event.at) : null;
}

function retainedFailureBackoff(events, now, base, maximum) {
  let consecutiveFailures = 0;
  let latestFailureAt = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'inference_completed') break;
    if (event.type !== 'inference_failed') continue;
    latestFailureAt ??= Date.parse(event.at);
    consecutiveFailures += 1;
  }
  if (consecutiveFailures === 0 || !Number.isFinite(latestFailureAt)) return null;
  const delayMs = Math.min(maximum, base * (2 ** Math.min(consecutiveFailures - 1, 30)));
  const retryAt = latestFailureAt + delayMs;
  if (now >= retryAt) return null;
  return { consecutiveFailures, delayMs, retryAt, remainingMs: retryAt - now };
}
