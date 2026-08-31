import { setTimeout as delay } from 'node:timers/promises';
import { archiveIngressFile, pendingIngressFiles, prepareIngress, readIngressDelta } from './ingress.js';

export class MusicResident {
  constructor(kernel, mind, {
    ingress,
    pollMs = 250,
    heartbeatMs = 15 * 60_000,
    clock = () => Date.now(),
    onError = () => {},
  } = {}) {
    if (!ingress) throw new Error('MusicResident needs a durable ingress directory');
    if (!Number.isInteger(pollMs) || pollMs < 10) throw new Error('resident pollMs must be an integer of at least 10');
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000) throw new Error('resident heartbeatMs must be an integer of at least 1000');
    this.kernel = kernel;
    this.mind = mind;
    this.ingress = prepareIngress(ingress).root;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.clock = clock;
    this.onError = onError;
    this.activeEncounter = null;
    this.abortSignal = undefined;
    this.lastEncounterAt = latestEncounterAt(kernel.events()) ?? this.clock();
  }

  async recover() {
    return this.kernel.recoverInterruptedInference('The resident process ended before its active encounter completed.');
  }

  async pump() {
    const admitted = this.drainIngress();
    if (this.activeEncounter || this.kernel.state().activeInferenceId) return { admitted, started: false };
    const state = this.kernel.state();
    if (state.openSoundingId) {
      this.startSounding(state.openSoundingId);
      return { admitted, started: true };
    }
    const trigger = state.pendingDeltas.length > 0
      ? 'delta'
      : (this.clock() - this.lastEncounterAt >= this.heartbeatMs ? 'heartbeat' : null);
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

  async run({ signal } = {}) {
    this.abortSignal = signal;
    await this.recover();
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
  }
}

function latestEncounterAt(events) {
  const event = [...events].reverse().find(candidate => candidate.type === 'sounding_opened');
  return event ? Date.parse(event.at) : null;
}
