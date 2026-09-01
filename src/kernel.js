import { classify } from './predicate.js';
import { clone, digest, identifier } from './canonical.js';
import { admitWager, validateAssimilation } from './constitution.js';
import { RoleSchemas, RoleTasks, RunSpecSchema } from './protocol.js';
import { applyTransition, createSubject, eraseProjection, pathsOverlap, verifySubject } from './subject.js';
import { RunStore } from './store.js';
import { ResidentLease } from './residency.js';
import { IdentifierSchema } from './subject.js';
import { runtimeProvenance } from './runtime-provenance.js';
import { PURSUIT_SELECTOR_INTERFACE, selectWagers } from './selector.js';
import { deriveAttestations } from './world.js';

export class DevelopmentalKernel {
  constructor(root, { actor, worlds, clock = () => new Date(), id = identifier, provenance = runtimeProvenance } = {}) {
    this.store = new RunStore(root, { clock, id });
    this.actor = actor;
    this.worlds = worlds;
    this.clock = clock;
    this.id = id;
    this.provenance = provenance;
  }

  initialize(specValue, { condition = 'active', inheritedSubject = null, predecessor = null } = {}) {
    if (this.store.readEvents().length > 0) throw new Error('run store is already initialized');
    const spec = RunSpecSchema.parse(specValue);
    if (spec.worlds.some(world => world.attestationTypes.length === 0)) throw new Error('new runs require at least one attestation type for every world');
    const selected = spec.conditions.find(value => value.id === condition);
    if (!selected) throw new Error(`unknown sealed condition: ${condition}`);
    this.requireRuntime(spec);
    const subject = inheritedSubject === null
      ? createSubject(spec.initialSubject, this.clock().toISOString())
      : verifySubject(inheritedSubject);
    if (spec.inheritedSubjectId !== subject.id) {
      if (inheritedSubject !== null || spec.inheritedSubjectId !== null) {
        throw new Error(`inherited subject mismatch: expected ${spec.inheritedSubjectId}, got ${subject.id}`);
      }
    }
    const specRef = this.store.put(spec);
    const subjectRef = this.store.put(subject);
    this.store.append('run.created', {
      runId: this.id('run'),
      spec: specRef,
      condition,
      subject: subjectRef,
      actor: this.actor.describe(),
      runtime: this.provenance(),
      predecessor: predecessor === null ? null : clone(predecessor),
    });
    return this.state();
  }

  state() {
    const events = this.store.readEvents();
    if (events.length === 0) return { initialized: false };
    const genesis = events[0];
    if (genesis.type !== 'run.created') throw new Error('ledger does not begin with run genesis');
    const spec = RunSpecSchema.parse(this.store.get(genesis.payload.spec));
    let subject = verifySubject(this.store.get(genesis.payload.subject));
    let completed = null;
    let hatched = null;
    const cycles = new Map();
    const invocations = [];
    const observations = [];
    const residentFailures = [];
    const effectiveGrants = new Set(spec.grants);
    const grantHistory = [];
    for (const event of events.slice(1)) {
      const cycleId = event.payload.cycleId;
      if (event.type === 'observation.received') {
        observations.push({ sequence: event.sequence, at: event.at, ...clone(event.payload) });
        continue;
      }
      if (event.type === 'grant.changed') {
        if (!spec.grants.includes(event.payload.effect)) throw new Error(`grant event is outside genesis envelope: ${event.payload.effect}`);
        if (event.payload.active) effectiveGrants.add(event.payload.effect);
        else effectiveGrants.delete(event.payload.effect);
        grantHistory.push({ sequence: event.sequence, at: event.at, ...clone(event.payload) });
        continue;
      }
      if (event.type === 'subject.hatched') {
        if (hatched) throw new Error('duplicate subject hatch event');
        hatched = clone(event.payload);
        continue;
      }
      if (event.type === 'resident.failed') {
        residentFailures.push({ sequence: event.sequence, at: event.at, ...clone(event.payload) });
        continue;
      }
      if (event.type === 'cycle.opened') {
        if (cycles.has(cycleId)) throw new Error(`duplicate cycle: ${cycleId}`);
        cycles.set(cycleId, {
          id: cycleId,
          generation: event.payload.generation,
          openedAt: event.at,
          observedThrough: event.payload.observedThrough ?? 0,
        });
        continue;
      }
      if (event.type.startsWith('actor.')) {
        invocations.push(clone(event.payload));
        if (event.type === 'actor.completed') {
          const cycle = requiredCycle(cycles, cycleId);
          cycle[event.payload.role] = event.payload.output;
        }
        continue;
      }
      const cycle = cycleId ? requiredCycle(cycles, cycleId) : null;
      if (event.type === 'frontier.rejected') {
        cycle.frontierRejections ??= [];
        cycle.frontierRejections.push(event.payload.frontier);
      }
      else if (event.type === 'frontier.admitted') cycle.frontier = event.payload.frontier;
      else if (event.type === 'wager.bound') cycle.binding = event.payload;
      else if (event.type === 'contact.blocked') cycle.contactBlocked = event.payload;
      else if (event.type === 'contact.failed') {
        cycle.contactFailures ??= [];
        cycle.contactFailures.push(event.payload);
      }
      else if (event.type === 'contact.started') cycle.contactStarted = event.payload;
      else if (event.type === 'contact.completed') cycle.contact = event.payload;
      else if (event.type === 'consequence.evaluated') cycle.evaluation = event.payload.evaluation;
      else if (event.type === 'transition.applied') {
        const next = verifySubject(this.store.get(event.payload.subject));
        if (next.parent !== subject.id) throw new Error('transition does not descend from current subject');
        subject = next;
        cycle.transition = event.payload;
      } else if (event.type === 'run.completed') completed = clone(event.payload);
      else throw new Error(`unsupported event type: ${event.type}`);
    }
    const orderedCycles = [...cycles.values()].sort((left, right) => left.generation - right.generation);
    const now = this.clock().getTime();
    const openingAt = subject.continuation.notBefore === null ? null : Date.parse(subject.continuation.notBefore);
    const continuityAt = Date.parse(subject.createdAt) + spec.limits.continuityPulseMs;
    const lastObservedThrough = orderedCycles.filter(cycle => cycle.transition).at(-1)?.observedThrough ?? 0;
    const pendingObservations = observations.filter(value => value.sequence > lastObservedThrough);
    const noContact = pendingObservations.length === 0;
    const scheduledOpeningDue = Number.isFinite(openingAt) && openingAt <= now;
    const continuityPulseDue = !completed && subject.continuation.kind !== 'stop' && noContact && !scheduledOpeningDue
      && now >= continuityAt && (subject.continuation.kind === 'seclusion' || (Number.isFinite(openingAt) && openingAt > now));
    const waitsForSchedule = !completed && noContact && !continuityPulseDue && Number.isFinite(openingAt) && openingAt > now;
    const waitsForSeclusion = !completed && noContact && !continuityPulseDue && subject.continuation.kind === 'seclusion' && !scheduledOpeningDue;
    const nextOpeningAt = waitsForSchedule || waitsForSeclusion
      ? Math.min(Number.isFinite(openingAt) && openingAt > now ? openingAt : Infinity, continuityAt)
      : null;
    return {
      initialized: true,
      runId: genesis.payload.runId,
      condition: genesis.payload.condition,
      predecessor: genesis.payload.predecessor ?? null,
      runtime: genesis.payload.runtime ?? null,
      spec,
      subject,
      cycles: orderedCycles,
      currentCycle: orderedCycles.find(cycle => !cycle.transition) ?? null,
      invocations,
      observations,
      residentFailures,
      pendingObservations,
      effectiveGrants: [...effectiveGrants].sort(),
      grantHistory,
      hatched,
      completed,
      waitingUntil: Number.isFinite(nextOpeningAt) ? new Date(nextOpeningAt).toISOString() : null,
      waitingForObservation: waitsForSeclusion,
      continuityPulseDue,
      head: events.at(-1).hash,
    };
  }

  async advance({ lease = true } = {}) {
    if (lease) {
      const resident = new ResidentLease(this.store.root, { clock: this.clock }).acquire();
      try { return await this.advance({ lease: false }); }
      finally { resident.release(); }
    }
    let state = this.state();
    if (!state.initialized) throw new Error('run is not initialized');
    if (state.completed) return state;
    if (!state.hatched) {
      const firstCompleted = state.cycles.find(value => value.transition);
      if (firstCompleted) {
        this.markHatched(state, firstCompleted);
        state = this.state();
      }
    }
    this.requireRuntime(state.spec, state.runtime);
    if (state.continuityPulseDue) {
      this.store.append('observation.received', {
        id: this.id('continuity'),
        channel: 'continuity',
        from: 'music',
        content: { kind: 'continuity-pulse', instructions: [] },
      });
      state = this.state();
    }
    if (state.waitingUntil || state.waitingForObservation) return state;
    if (state.subject.continuation.kind === 'stop') {
      this.complete('subject-stop', state);
      return this.state();
    }
    if (state.cycles.filter(cycle => cycle.transition).length >= state.spec.limits.maxCycles) {
      this.complete('observer-cycle-limit', state);
      return this.state();
    }
    if (!state.currentCycle) {
      this.store.append('cycle.opened', {
        cycleId: this.id('cycle'),
        generation: state.subject.generation,
        subjectId: state.subject.id,
        observedThrough: this.store.readEvents().at(-1)?.sequence ?? 0,
      });
      state = this.state();
    }
    const cycle = state.currentCycle;
    if (!cycle.orient) {
      await this.invoke('orient', cycle.id, this.projection(state, 'orient'));
      state = this.state();
    }
    if (!state.currentCycle.frontier) {
      const projection = this.projection(state, 'challenge', {
        orientation: this.readOutput(state.currentCycle.orient),
        priorRejections: (state.currentCycle.frontierRejections ?? []).map(reference => this.store.get(reference)),
      });
      const challenge = await this.invoke('challenge', cycle.id, projection);
      const decisionSubject = this.subjectForCondition(state);
      const admissions = challenge.wagers.map(value => admitWager(value, {
        subject: decisionSubject,
        spec: state.spec,
        worlds: this.worlds,
        grants: state.effectiveGrants,
      }));
      const admitted = admissions.filter(value => value.admissible).map(value => value.wager);
      const selection = selectWagers(decisionSubject, admitted);
      const frontier = this.store.put({
        wagers: admitted,
        admissions: admissions.map(value => ({ id: value.wager.id, admissible: value.admissible, reasons: value.reasons, derivedFloors: value.derivedFloors })),
        selection,
      });
      if (admitted.length === 0 || selection.selectedIds.length === 0) {
        this.store.append('frontier.rejected', { cycleId: cycle.id, frontier });
        const attempts = (state.currentCycle.frontierRejections?.length ?? 0) + 1;
        if (attempts >= state.spec.limits.maxChallengeAttempts) {
          this.complete('challenge-attempt-limit', this.state(), { observerDisposition: 'rejected', subjectDisposition: 'open' });
        }
        return this.state();
      }
      this.store.append('frontier.admitted', { cycleId: cycle.id, frontier });
      state = this.state();
    }
    if (!state.currentCycle.binding) {
      const frontier = this.store.get(state.currentCycle.frontier);
      const election = await this.invoke('elect', cycle.id, this.projection(state, 'elect', { frontier }));
      const wager = frontier.wagers.find(value => value.id === election.wagerId && frontier.selection.selectedIds.includes(value.id));
      if (!wager) throw new Error(`election selected outside transformed frontier: ${election.wagerId}`);
      this.store.append('wager.bound', {
        cycleId: cycle.id,
        wager: this.store.put(wager),
        election: this.store.put(election),
        subjectId: state.subject.id,
      });
      state = this.state();
    }
    const wager = this.store.get(state.currentCycle.binding.wager);
    if (!state.currentCycle.contactStarted) {
      const declared = state.spec.worlds.find(value => value.id === wager.contact.world);
      const missing = wager.effectRequirements.filter(effect => !state.effectiveGrants.includes(effect));
      if (missing.length > 0) {
        const last = state.currentCycle.contactBlocked;
        if (!last || JSON.stringify(last.missing) !== JSON.stringify(missing)) {
          this.store.append('contact.blocked', { cycleId: cycle.id, wagerId: wager.id, missing });
        }
        return this.state();
      }
      this.store.append('contact.started', {
        cycleId: cycle.id,
        wagerId: wager.id,
        world: declared.id,
        adapter: declared.adapter,
        adapterIdentity: declared.adapterIdentity,
        input: this.store.put(wager.contact.input),
        idempotencyKey: digest({ runId: state.runId, cycleId: cycle.id, wagerId: wager.id, subjectId: state.subject.id }),
      });
      state = this.state();
    }
    if (!state.currentCycle.contact) {
      const started = state.currentCycle.contactStarted;
      const adapter = this.worlds.get(started.adapter);
      if (!adapter || adapter.identity !== started.adapterIdentity) throw new Error('bound world adapter is unavailable or changed');
      const input = this.store.get(started.input);
      const errors = adapter.conform(input);
      if (errors.length > 0) throw new Error(`bound contact no longer conforms: ${errors.join('; ')}`);
      let output;
      try {
        output = await adapter.execute(clone(input), Object.freeze({
          idempotencyKey: started.idempotencyKey,
          runId: state.runId,
          cycleId: cycle.id,
          subjectId: state.subject.id,
          runRoot: this.store.root,
        }));
        const outputErrors = adapter.conformOutput(output);
        if (outputErrors.length > 0) throw new Error(`world output violates its sealed contract: ${outputErrors.join('; ')}`);
      } catch (error) {
        const attempts = (state.currentCycle.contactFailures?.length ?? 0) + 1;
        this.store.append('contact.failed', {
          cycleId: cycle.id,
          wagerId: wager.id,
          idempotencyKey: started.idempotencyKey,
          attempt: attempts,
          effectCertainty: 'unknown',
          failure: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 16_384), quarantined: true },
        });
        if (attempts >= state.spec.limits.maxContactAttempts) {
          this.complete('contact-attempt-limit', this.state(), { observerDisposition: 'rejected', subjectDisposition: 'open' });
        }
        throw error;
      }
      const outputRef = this.store.put(output);
      this.store.append('contact.completed', {
        cycleId: cycle.id,
        wagerId: wager.id,
        idempotencyKey: started.idempotencyKey,
        world: started.world,
        adapterIdentity: started.adapterIdentity,
        output: outputRef,
        attestations: this.store.put(deriveAttestations(adapter, input, output, {
          world: started.world,
          input: started.input,
          receipt: outputRef,
        })),
      });
      state = this.state();
    }
    if (!state.currentCycle.evaluation) {
      const output = this.store.get(state.currentCycle.contact.output);
      const attestations = this.store.get(state.currentCycle.contact.attestations);
      const evaluation = classify({ output, attestations }, wager.predicates);
      this.store.append('consequence.evaluated', {
        cycleId: cycle.id,
        wagerId: wager.id,
        receipt: state.currentCycle.contact.output,
        evaluation,
      });
      state = this.state();
    }
    if (!state.currentCycle.transition) {
      const kind = state.currentCycle.evaluation.kind;
      let transition = kind === 'underdetermined' ? null : wager.continuations[kind];
      let authority = 'bound-predicate';
      if (!transition) {
        const receipt = this.store.get(state.currentCycle.contact.output);
        const result = await this.invoke('assimilate', cycle.id, this.projection(state, 'assimilate', {
          wager,
          receipt,
          evaluation: state.currentCycle.evaluation,
        }));
        transition = validateAssimilation(result.transition, wager, state.subject);
        authority = 'fresh-assimilation';
      }
      const attestations = this.store.get(state.currentCycle.contact.attestations)
        .filter(value => wager.bearing.attestationTypes.includes(value.type));
      if (attestations.length === 0) throw new Error('bound contact emitted no attestation matching the wager bearing');
      const next = applyTransition(state.subject, transition, this.clock().toISOString(), { attestations });
      this.store.append('transition.applied', {
        cycleId: cycle.id,
        wagerId: wager.id,
        classification: state.currentCycle.evaluation.kind,
        authority,
        applied: this.store.put(transition),
        priorSubjectId: state.subject.id,
        subject: this.store.put(next),
        floors: next.floors.map(floor => ({ id: floor.id, passed: true })),
      });
    }
    state = this.state();
    if (!state.hatched) {
      this.markHatched(state, state.cycles.find(value => value.id === cycle.id));
      state = this.state();
    }
    if (state.subject.continuation.kind === 'stop') this.complete('subject-stop', state);
    else if (state.cycles.filter(value => value.transition).length >= state.spec.limits.maxCycles) this.complete('observer-cycle-limit', state);
    return this.state();
  }

  async run() {
    const lease = new ResidentLease(this.store.root, { clock: this.clock }).acquire();
    try {
      let state = this.state();
      while (!state.completed && !state.waitingUntil && !state.waitingForObservation) {
        const priorHead = state.head;
        state = await this.advance({ lease: false });
        if (state.head === priorHead) break;
      }
      return state;
    } finally {
      lease.release();
    }
  }

  async reside({ signal = null, maximumSleepMs = 60_000 } = {}) {
    const lease = new ResidentLease(this.store.root, { clock: this.clock }).acquire();
    try {
      let state = this.state();
      while (!state.completed) {
        if (signal?.aborted) return state;
        if (state.waitingUntil || state.waitingForObservation) {
          const remaining = state.waitingUntil ? Date.parse(state.waitingUntil) - this.clock().getTime() : maximumSleepMs;
          await delay(Math.max(1, Math.min(remaining, maximumSleepMs)), signal);
        }
        const priorHead = state.head;
        try { state = await this.advance({ lease: false }); }
        catch (error) {
          state = this.state();
          if (state.completed || signal?.aborted) continue;
          if (state.head === priorHead) {
            this.store.append('resident.failed', {
              failure: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 16_384), retryable: false },
            });
            throw error;
          }
          await delay(Math.min(state.spec.limits.residentRetryDelayMs, maximumSleepMs), signal);
        }
      }
      return state;
    } finally {
      lease.release();
    }
  }

  receiveObservation({ channel = 'operator', from = 'operator', content, id = this.id('observation') }) {
    const state = this.state();
    if (!state.initialized) throw new Error('run is not initialized');
    if (state.completed?.subjectDisposition === 'closed') throw new Error('subject is closed');
    const observation = {
      id: IdentifierSchema.parse(id),
      channel: IdentifierSchema.parse(channel),
      from: String(from).slice(0, 256),
      content: jsonData(content),
    };
    if (state.observations.some(value => value.id === observation.id)) throw new Error(`duplicate observation: ${observation.id}`);
    this.store.append('observation.received', observation);
    return this.state();
  }

  setGrant(effectValue, active, { reason = 'operator decision' } = {}) {
    const state = this.state();
    if (!state.initialized) throw new Error('run is not initialized');
    const effect = IdentifierSchema.parse(effectValue);
    if (!state.spec.grants.includes(effect)) throw new Error(`effect is outside genesis grant envelope: ${effect}`);
    if (state.effectiveGrants.includes(effect) === Boolean(active)) return state;
    this.store.append('grant.changed', {
      effect,
      active: Boolean(active),
      reason: String(reason).slice(0, 4096),
      authority: 'machine-owner',
    });
    return this.state();
  }

  audit() {
    const state = this.state();
    if (!state.initialized) return state;
    return {
      format: 'music-v3-audit-1',
      runId: state.runId,
      specId: state.spec.id,
      condition: state.condition,
      predecessor: state.predecessor,
      runtime: state.runtime,
      head: state.head,
      subject: { id: state.subject.id, generation: state.subject.generation, continuation: state.subject.continuation },
      waitingUntil: state.waitingUntil,
      waitingForObservation: state.waitingForObservation,
      continuityPulseDue: state.continuityPulseDue,
      pendingObservations: state.pendingObservations.length,
      residentFailures: state.residentFailures,
      effectiveGrants: state.effectiveGrants,
      hatched: state.hatched,
      cycles: state.cycles.map(cycle => ({
        id: cycle.id,
        generation: cycle.generation,
        wagerId: cycle.binding ? this.store.get(cycle.binding.wager).id : null,
        world: cycle.contactStarted?.world ?? null,
        classification: cycle.evaluation?.kind ?? null,
        transitionAuthority: cycle.transition?.authority ?? null,
        complete: Boolean(cycle.transition),
        rejectedFrontiers: cycle.frontierRejections?.length ?? 0,
        selection: cycle.frontier ? this.store.get(cycle.frontier).selection : null,
      })),
      actorInvocations: state.invocations.filter(value => value.invocationId).map(value => ({
        invocationId: value.invocationId,
        role: value.role,
        contextId: value.contextId,
        responseChain: value.responseChain,
        workspaceContinuity: value.workspaceContinuity,
        status: value.status,
      })),
      completed: state.completed,
      evidence: this.store.verifyObjectGraph(),
    };
  }

  snapshot(destination) {
    const state = this.state();
    if (!state.initialized) throw new Error('run is not initialized');
    return this.store.snapshot(destination);
  }

  requireRuntime(spec, expectedProvenance = null) {
    if (!this.actor || !this.worlds) throw new Error('actor and world registry are required');
    const actual = this.actor.describe();
    if (digest(actual) !== digest(spec.actor)) {
      throw new Error(`actor condition mismatch: expected ${JSON.stringify(spec.actor)}, got ${JSON.stringify(actual)}`);
    }
    if (expectedProvenance && this.provenance().implementationSha256 !== expectedProvenance.implementationSha256) {
      throw new Error('runtime implementation differs from sealed genesis provenance');
    }
    this.worlds.verifySpec(spec);
  }

  projection(state, role, additions = {}) {
    const history = state.cycles
      .filter(cycle => cycle.transition)
      .slice(-state.spec.limits.projectionHistoryEntries)
      .map(cycle => {
        const successor = this.store.get(cycle.transition.subject);
        return {
          generation: cycle.generation,
          wager: this.store.get(cycle.binding.wager),
          world: cycle.contactStarted.world,
          receipt: this.store.get(cycle.contact.output),
          attestations: this.store.get(cycle.contact.attestations),
          evaluation: cycle.evaluation,
          transition: this.appliedTransition(cycle),
          transitionAuthority: cycle.transition.authority,
          successor: {
            id: successor.id,
            parent: successor.parent,
            generation: successor.generation,
            createdAt: successor.createdAt,
          },
          selection: this.store.get(cycle.frontier).selection,
        };
      });
    let projection = {
      format: 'music-v3-fresh-projection-1',
      role,
      run: {
        id: state.runId,
        specId: state.spec.id,
        hypothesis: state.spec.hypothesis,
        cheapestFalsifier: state.spec.cheapestFalsifier,
        limits: state.spec.limits,
      },
      subject: this.subjectForCondition(state),
      epistemicContract: {
        authoritative: 'Only world attestations retained in subject.facts or supplied with the current receipt are established facts.',
        interpretive: 'Subject memory, stakes, language, continuation prose, and file contents are interpretations unless they cite an exact attestation; copying or rereading prose does not strengthen it.',
      },
      worlds: state.spec.worlds.map(({ id, description, publicContract, attestationTypes }) => ({ id, description, publicContract, attestationTypes })),
      capabilities: { effectiveGrants: state.effectiveGrants },
      developmentalInterfaces: { pursuitSelector: clone(PURSUIT_SELECTOR_INTERFACE) },
      observations: this.observationsFor(state),
      history,
      ...additions,
    };
    const condition = state.spec.conditions.find(value => value.id === state.condition);
    for (const intervention of condition.interventions.filter(value => value.generation === state.subject.generation)) {
      const stateErase = intervention.erase.map(pointer => pointer.replace(/^\/subject/, '')).filter(Boolean);
      const stateReplace = Object.keys(intervention.replace).map(pointer => pointer.replace(/^\/subject/, '')).filter(Boolean);
      projection.history = projection.history.map(entry => ({
        ...entry,
        transition: maskTransition(entry.transition, [...stateErase, ...stateReplace]),
      }));
    }
    return projection;
  }

  appliedTransition(cycle) {
    if (cycle.transition.applied) return this.store.get(cycle.transition.applied);
    const wager = this.store.get(cycle.binding.wager);
    if (cycle.transition.authority === 'bound-predicate') return wager.continuations[cycle.transition.classification];
    if (cycle.assimilate) return this.store.get(cycle.assimilate).transition;
    throw new Error(`completed cycle has no recoverable applied transition: ${cycle.id}`);
  }

  subjectForCondition(state) {
    let subject = clone(state.subject);
    const condition = state.spec.conditions.find(value => value.id === state.condition);
    for (const intervention of condition.interventions.filter(value => value.generation === state.subject.generation)) {
      const erase = intervention.erase.map(pointer => pointer.replace(/^\/subject/, '')).filter(Boolean);
      const replace = Object.fromEntries(Object.entries(intervention.replace).map(([pointer, value]) => [pointer.replace(/^\/subject/, ''), value]).filter(([pointer]) => pointer));
      subject = eraseProjection(subject, erase, replace);
    }
    return subject;
  }

  observationsFor(state) {
    const cycle = state.currentCycle;
    if (!cycle) return [];
    const prior = state.cycles.filter(value => value.transition && value.generation < cycle.generation).at(-1)?.observedThrough ?? 0;
    return state.observations
      .filter(value => value.sequence > prior && value.sequence <= cycle.observedThrough)
      .map(({ sequence, ...value }) => value);
  }

  markHatched(state, cycle) {
    if (!cycle?.transition || state.hatched || state.predecessor) return;
    const completed = state.invocations.filter(value => value.cycleId === cycle.id && value.status === 'completed');
    if (!['openrouter', 'codex-exec'].includes(state.spec.actor.adapter) || completed.length < 3 || completed.some(value => typeof value.model !== 'string' || value.model.length === 0)) return;
    this.store.append('subject.hatched', {
      cycleId: cycle.id,
      generation: state.subject.generation,
      subjectId: state.subject.id,
      actor: clone(state.spec.actor),
      criterion: 'first independently completed consequence transition through fresh hosted-model perspectives',
    });
  }

  async invoke(role, cycleId, projection) {
    const state = this.state();
    const startedCalls = state.invocations.filter(value => value.status === 'started').length;
    if (startedCalls >= state.spec.limits.maxActorCalls) {
      this.complete('actor-call-limit', state, { observerDisposition: 'rejected', subjectDisposition: 'open' });
      throw new Error('frozen actor-call limit reached');
    }
    const terminal = new Set(state.invocations.filter(value => ['completed', 'failed', 'abandoned'].includes(value.status)).map(value => value.invocationId));
    for (const pending of state.invocations.filter(value => value.status === 'started' && value.role === role && value.cycleId === cycleId && !terminal.has(value.invocationId))) {
      this.store.append('actor.abandoned', {
        cycleId,
        invocationId: pending.invocationId,
        role,
        contextId: pending.contextId,
        projection: pending.projection,
        reason: 'no terminal receipt survived process boundary',
        responseChain: null,
        workspaceContinuity: null,
        status: 'abandoned',
      });
    }
    const schema = RoleSchemas[role];
    const invocationId = this.id('actor');
    const contextId = this.id('context');
    const projectionRef = this.store.put(projection);
    this.store.append('actor.started', {
      cycleId,
      invocationId,
      role,
      contextId,
      projection: projectionRef,
      responseChain: null,
      workspaceContinuity: null,
      status: 'started',
    });
    try {
      const result = await this.actor.invoke({ role, projection: clone(projection), schema, task: RoleTasks[role] });
      const output = schema.parse(result.output);
      const outputRef = this.store.put(output);
      this.store.append('actor.completed', {
        cycleId,
        invocationId,
        role,
        contextId,
        projection: projectionRef,
        output: outputRef,
        model: result.model ?? null,
        responseId: result.responseId ?? null,
        usage: jsonData(result.usage ?? null),
        responseChain: null,
        workspaceContinuity: null,
        status: 'completed',
      });
      return output;
    } catch (error) {
      const raw = typeof error?.rawOutput === 'string' ? this.store.put({ raw: error.rawOutput }) : null;
      this.store.append('actor.failed', {
        cycleId,
        invocationId,
        role,
        contextId,
        projection: projectionRef,
        failure: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 16_384), raw, quarantined: true },
        responseChain: null,
        workspaceContinuity: null,
        status: 'failed',
      });
      throw error;
    }
  }

  readOutput(reference) { return this.store.get(reference); }

  complete(reason, state, overrides = {}) {
    if (this.state().completed) return;
    this.store.append('run.completed', {
      reason,
      observerDisposition: overrides.observerDisposition ?? 'completed',
      subjectDisposition: overrides.subjectDisposition ?? (state.subject.continuation.kind === 'stop' ? 'closed' : 'open'),
      finalSubjectId: state.subject.id,
      completedCycles: state.cycles.filter(cycle => cycle.transition).length,
    });
  }
}

function requiredCycle(cycles, id) {
  const cycle = cycles.get(id);
  if (!cycle) throw new Error(`event references unknown cycle: ${id}`);
  return cycle;
}

function maskTransition(value, erasedPointers) {
  const transition = clone(value);
  transition.set = Object.fromEntries(Object.entries(transition.set).filter(([pointer]) => !erasedPointers.some(erased => pathsOverlap(pointer, erased))));
  transition.remove = transition.remove.filter(pointer => !erasedPointers.some(erased => pathsOverlap(pointer, erased)));
  return transition;
}

function jsonData(value) {
  return JSON.parse(JSON.stringify(value));
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let abort = null;
    const timer = setTimeout(() => {
      if (abort) signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (!signal) return;
    abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('resident loop aborted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
