import { clone, digest, identifier } from './canonical.js';
import { classify } from './predicate.js';
import { attachAttentionManifest, attentionPolicy, ATTENTION_INTERFACE, compactCausalTrail } from './attention.js';
import { addOpportunities, deriveOperation, materializeObservation, OPERATION_INTERFACE, projectOpportunities } from './operation.js';
import { assertJudgmentForRole, mutationPaths, RoleSchemas, RoleTasks, RunSpecSchema } from './protocol.js';
import {
  advanceSubject,
  createSubject,
  IdentifierSchema,
  pathsOverlap,
  verifySubject,
} from './subject.js';
import { RunStore } from './store.js';
import { ResidentLease } from './residency.js';
import { runtimeProvenance } from './runtime-provenance.js';
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

  initialize(specValue) {
    if (this.store.readEvents().length > 0) throw new Error('run store is already initialized');
    const spec = RunSpecSchema.parse(specValue);
    this.requireRuntime(spec);
    const subject = createSubject(spec.initialSubject, spec.worlds, this.clock().toISOString());
    this.store.append('run.created', {
      runId: this.id('run'),
      spec: this.store.put(spec),
      subject: this.store.put(subject),
      inference: this.actor.describe(),
      runtime: this.provenance(),
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
    const observations = [];
    const invocations = [];
    const residentFailures = [];
    const operationEvents = [];
    const effectiveGrants = new Set(spec.grants);
    let completed = null;
    let hatched = null;
    for (const event of events.slice(1)) {
      if (event.type === 'subject.advanced') {
        const next = verifySubject(this.store.get(event.payload.subject));
        if (next.parent !== subject.id) throw new Error(`broken subject ancestry at event ${event.sequence}`);
        subject = next;
      } else if (event.type === 'observation.received') {
        observations.push({ sequence: event.sequence, at: event.at, ...clone(event.payload) });
      } else if (event.type.startsWith('actor.')) {
        invocations.push(clone(event.payload));
      } else if (event.type === 'resident.failed') {
        residentFailures.push({ sequence: event.sequence, at: event.at, ...clone(event.payload) });
      } else if (event.type === 'grant.changed') {
        if (!spec.grants.includes(event.payload.effect)) throw new Error('grant event exceeds genesis envelope');
        if (event.payload.active) effectiveGrants.add(event.payload.effect);
        else effectiveGrants.delete(event.payload.effect);
      } else if (event.type === 'operation.completed') {
        operationEvents.push({ sequence: event.sequence, at: event.at, ...clone(event.payload) });
      } else if (event.type === 'subject.hatched') {
        hatched = clone(event.payload);
      } else if (event.type === 'run.completed') {
        completed = clone(event.payload);
      }
    }
    const pendingObservations = observations.filter(value => !Object.hasOwn(subject.opportunities, `observation:${value.sequence}`));
    const decision = deriveOperation(subject, { now: this.clock() });
    const lastContactAt = [observations.at(-1)?.at, subject.createdAt].filter(Boolean).sort().at(-1);
    const continuityPulseDue = new Date(Date.parse(lastContactAt) + spec.limits.continuityPulseMs).toISOString();
    const waitingUntil = decision.operation === 'wait'
      ? earliest(subject.wait?.notBefore ?? null, continuityPulseDue)
      : null;
    return {
      initialized: true,
      runId: genesis.payload.runId,
      runtime: clone(genesis.payload.runtime),
      spec,
      subject,
      observations,
      pendingObservations,
      invocations,
      residentFailures,
      effectiveGrants: [...effectiveGrants].sort(),
      operationEvents,
      operation: decision,
      waitingUntil,
      continuityPulseDue,
      hatched,
      completed,
      head: events.at(-1).hash,
      events,
    };
  }

  async advance({ lease = true } = {}) {
    const residentLease = lease ? new ResidentLease(this.store.root, { clock: this.clock }).acquire() : null;
    try {
      let state = this.state();
      if (!state.initialized) throw new Error('run is not initialized');
      if (state.completed) return state;
      this.requireRuntime(state.spec, state.runtime);
      if (state.operationEvents.length >= state.spec.limits.maxOperations) {
        this.complete('operation-limit', state);
        return this.state();
      }

      if (state.pendingObservations.length === 0 && state.operation.operation === 'wait' && Date.parse(state.continuityPulseDue) <= this.clock().getTime()) {
        this.receiveObservation({
          id: this.id('continuity'),
          channel: 'continuity',
          from: 'music',
          content: { kind: 'continuity-pulse', instructions: [] },
        });
        state = this.state();
      }

      if (state.pendingObservations.length > 0) {
        this.materializeObservations(state);
        state = this.state();
      }

      const decision = deriveOperation(state.subject, { now: this.clock() });
      if (decision.operation === 'wait' && state.subject.wait && Date.parse(state.subject.wait.notBefore) > this.clock().getTime()) {
        return state;
      }
      const operationId = this.id('operation');
      this.store.append('operation.derived', {
        operationId,
        subjectId: state.subject.id,
        decision,
        opportunityProjection: this.store.put(projectOpportunities(state.subject)),
      });

      if (decision.operation === 'select') await this.select(state, operationId);
      else if (decision.operation === 'realize') await this.realize(state, operationId);
      else if (decision.operation === 'contact') await this.contact(state, operationId);
      else if (decision.operation === 'correct' || decision.operation === 'assimilate') await this.judge(state, operationId, decision.operation);
      else if (decision.operation === 'expand') await this.expand(state, operationId);
      else this.wait(state, operationId);

      state = this.state();
      this.markHatched(state);
      return this.state();
    } finally {
      residentLease?.release();
    }
  }

  async select(state, operationId) {
    const output = await this.invoke('select', operationId, this.projection(state, 'select'));
    const opportunity = state.subject.opportunities[output.opportunityId];
    if (!opportunity || opportunity.standing !== 'open') throw new Error(`selection is outside active opportunity standing: ${output.opportunityId}`);
    const opportunities = clone(state.subject.opportunities);
    opportunities[opportunity.id].standing = 'selected';
    opportunities[opportunity.id].attempts += 1;
    const active = {
      opportunityId: opportunity.id,
      stake: output.stake,
      realization: null,
      binding: null,
      consequence: null,
      realizationAttempts: 0,
    };
    this.advanceAndComplete(state, operationId, 'select', {
      developmental: false,
      opportunities,
      active,
      wait: null,
      expansionAttempts: 0,
    }, { output: this.store.put(output), opportunityId: opportunity.id, stakeId: output.stake.id });
  }

  async realize(state, operationId) {
    if (state.subject.active.realizationAttempts >= state.spec.limits.maxRealizationAttempts) {
      const active = {
        ...clone(state.subject.active),
        consequence: {
          kind: 'failure', classification: 'failure', receipt: null, attestations: [],
          detail: { kind: 'realization-attempt-limit', attempts: state.subject.active.realizationAttempts },
        },
      };
      this.advanceAndComplete(state, operationId, 'realize', { developmental: false, active }, {
        classification: 'failure', evidence: null, rejected: 'realization-attempt-limit',
      });
      return;
    }
    const output = await this.invoke('realize', operationId, this.projection(state, 'realize'));
    try {
      this.validateRealization(state, output);
    } catch (error) {
      const rejection = this.store.put({
        format: 'music-v4-realization-rejection-1',
        output,
        failure: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 16_384) },
      });
      this.store.append('realization.rejected', { operationId, subjectId: state.subject.id, rejection });
      const active = {
        ...clone(state.subject.active),
        consequence: {
          kind: 'failure', classification: 'failure', receipt: null, attestations: [],
          detail: { kind: 'realization-rejected', rejection },
        },
        realizationAttempts: state.subject.active.realizationAttempts + 1,
      };
      this.advanceAndComplete(state, operationId, 'realize', { developmental: false, active }, {
        classification: 'failure', evidence: rejection, rejected: 'world-contract',
      });
      return;
    }
    const binding = this.store.put({
      format: 'music-v4-contact-binding-1',
      subjectId: state.subject.id,
      opportunityId: state.subject.active.opportunityId,
      stake: state.subject.active.stake,
      realization: output,
    });
    const active = {
      ...clone(state.subject.active), realization: output, binding: binding.sha256, consequence: null,
      realizationAttempts: state.subject.active.realizationAttempts + 1,
    };
    this.advanceAndComplete(state, operationId, 'realize', {
      developmental: false,
      active,
    }, { binding, world: output.world });
  }

  async contact(state, operationId) {
    const active = state.subject.active;
    const realization = active.realization;
    const declared = state.spec.worlds.find(value => value.id === realization.world);
    const adapter = this.worlds.get(declared.adapter);
    const missing = realization.effectRequirements.filter(effect => !state.effectiveGrants.includes(effect));
    if (missing.length > 0) {
      const consequence = {
        kind: 'failure', classification: 'failure', receipt: null, attestations: [],
        detail: { kind: 'missing-grants', missing },
      };
      this.finishContact(state, operationId, consequence, [], null);
      return;
    }
    const existing = findOpenContact(state.events, active.binding);
    const inputRef = existing?.payload.input ?? this.store.put(realization.input);
    const idempotencyKey = existing?.payload.idempotencyKey ?? digest({
      runId: state.runId,
      binding: active.binding,
      opportunityId: active.opportunityId,
    });
    if (!existing) {
      this.store.append('contact.started', {
        operationId,
        binding: active.binding,
        world: declared.id,
        adapter: declared.adapter,
        adapterIdentity: declared.adapterIdentity,
        input: inputRef,
        idempotencyKey,
      });
    }
    let output;
    try {
      output = await adapter.execute(clone(realization.input), Object.freeze({
        idempotencyKey,
        runId: state.runId,
        operationId,
        subjectId: state.subject.id,
        runRoot: this.store.root,
        store: this.store,
      }));
      const errors = adapter.conformOutput(output);
      if (errors.length > 0) throw new Error(`world output violates its contract: ${errors.join('; ')}`);
    } catch (error) {
      const failure = {
        name: error?.name ?? 'Error',
        message: String(error?.message ?? error).slice(0, 16_384),
        effectCertainty: 'unknown',
      };
      this.store.append('contact.failed', { operationId, binding: active.binding, idempotencyKey, failure });
      this.finishContact(state, operationId, {
        kind: 'failure', classification: 'failure', receipt: null, attestations: [], detail: failure,
      }, [], null);
      return;
    }
    const receipt = this.store.put(output);
    const attestations = deriveAttestations(adapter, realization.input, output, {
      world: declared.id,
      input: inputRef,
      receipt,
    });
    const attestationRef = this.store.put(attestations);
    const evaluation = classify({ output, attestations }, realization.predicates);
    const classification = evaluation.kind === 'underdetermined' ? 'inconclusive' : evaluation.kind;
    this.store.append('contact.completed', {
      operationId, binding: active.binding, idempotencyKey, world: declared.id,
      adapterIdentity: adapter.identity, output: receipt, attestations: attestationRef, evaluation,
    });
    this.finishContact(state, operationId, {
      kind: 'receipt', classification, receipt: receipt.sha256,
      attestations: attestations.map(value => value.id),
      detail: { evaluation, attestationReference: attestationRef },
    }, attestations, receipt);
  }

  finishContact(state, operationId, consequence, attestations, receipt) {
    const opportunities = clone(state.subject.opportunities);
    const opportunity = opportunities[state.subject.active.opportunityId];
    opportunity.standing = 'contacted';
    opportunity.lastConsequence = receipt?.sha256 ?? state.subject.active.binding;
    const active = { ...clone(state.subject.active), consequence };
    this.advanceAndComplete(state, operationId, 'contact', {
      developmental: false,
      opportunities,
      active,
      attestations,
    }, { classification: consequence.classification, evidence: receipt ?? null });
  }

  async judge(state, operationId, role) {
    const output = await this.invoke(role, operationId, this.projection(state, role));
    assertJudgmentForRole(role, output);
    this.validateJudgment(state, output);
    const evidence = state.subject.active.consequence.receipt;
    const added = addOpportunities(state.subject, output.opportunities, { evidence });
    const opportunities = added.opportunities;
    const current = opportunities[state.subject.active.opportunityId];
    let active = clone(state.subject.active);
    if (['retry', 'retain', 'revise'].includes(output.disposition)) {
      current.standing = 'selected';
      active.stake = output.revisedStake ?? active.stake;
      active.realization = null;
      active.binding = null;
      active.consequence = null;
      if (output.disposition !== 'retry') active.realizationAttempts = 0;
    } else {
      current.standing = output.disposition === 'retire' ? 'completed' : 'surrendered';
      active = null;
    }
    const wait = active || added.admitted.length > 0 ? null : output.wait;
    this.advanceAndComplete(state, operationId, role, {
      developmental: true,
      mutation: output.mutation,
      opportunities,
      active,
      wait,
      expansionAttempts: added.admitted.length > 0 ? 0 : state.subject.expansionAttempts,
    }, {
      output: this.store.put(output),
      disposition: output.disposition,
      classification: state.subject.active.consequence.classification,
      admittedOpportunities: added.admitted,
      rejectedOpportunities: added.rejected,
      evidence,
    });
  }

  async expand(state, operationId) {
    const output = await this.invoke('expand', operationId, this.projection(state, 'expand'));
    this.validateOpportunityWorlds(state, output.opportunities);
    const added = addOpportunities(state.subject, output.opportunities);
    this.advanceAndComplete(state, operationId, 'expand', {
      developmental: false,
      opportunities: added.opportunities,
      expansionAttempts: added.admitted.length > 0 ? 0 : state.subject.expansionAttempts + 1,
      wait: added.admitted.length > 0 ? null : output.wait,
    }, {
      output: this.store.put(output),
      admittedOpportunities: added.admitted,
      rejectedOpportunities: added.rejected,
    });
  }

  wait(state, operationId) {
    const selector = state.subject.organs.operationSelector;
    const retained = state.subject.wait;
    if (retained && Date.parse(retained.notBefore) > this.clock().getTime()) return;
    const wait = retained && Date.parse(retained.notBefore) <= this.clock().getTime()
      ? { reason: retained.reason, notBefore: new Date(this.clock().getTime() + selector.waitMs).toISOString() }
      : { reason: 'No reachable opportunity currently has standing.', notBefore: new Date(this.clock().getTime() + selector.waitMs).toISOString() };
    this.advanceAndComplete(state, operationId, 'wait', {
      developmental: false,
      wait,
    }, { wait });
  }

  materializeObservations(state) {
    let subject = state.subject;
    for (const observation of state.pendingObservations) {
      const result = materializeObservation(subject, observation, observation.evidence.sha256);
      const next = advanceSubject(subject, {
        developmental: false,
        opportunities: result.opportunities,
        expansionAttempts: 0,
        wait: null,
      }, this.clock().toISOString());
      this.store.append('subject.advanced', {
        operationId: null,
        operation: 'observation',
        developmental: false,
        priorSubjectId: subject.id,
        subject: this.store.put(next),
        evidence: observation.evidence,
      });
      subject = next;
    }
  }

  advanceAndComplete(state, operationId, operation, change, result) {
    const next = advanceSubject(state.subject, change, this.clock().toISOString());
    const subjectRef = this.store.put(next);
    this.store.append('subject.advanced', {
      operationId,
      operation,
      developmental: Boolean(change.developmental),
      priorSubjectId: state.subject.id,
      subject: subjectRef,
      classification: result.classification ?? null,
      disposition: result.disposition ?? null,
      evidence: result.evidence ?? null,
    });
    this.store.append('operation.completed', {
      operationId,
      operation,
      priorSubjectId: state.subject.id,
      subjectId: next.id,
      succession: next.succession,
      revision: next.revision,
      ...clone(result),
    });
  }

  validateRealization(state, realization) {
    const declared = state.spec.worlds.find(value => value.id === realization.world);
    if (!declared) throw new Error(`world is outside sealed envelope: ${realization.world}`);
    const opportunity = state.subject.opportunities[state.subject.active.opportunityId];
    if (opportunity.source.world && opportunity.source.world !== realization.world) {
      throw new Error(`realization changed the opportunity world: ${opportunity.source.world}`);
    }
    const adapter = this.worlds.get(declared.adapter);
    const reasons = adapter.conform(realization.input);
    for (const [kind, witness] of Object.entries(realization.witnesses)) {
      reasons.push(...adapter.conformOutput(witness.output).map(value => `${kind} witness: ${value}`));
    }
    const published = new Set(adapter.attestationTypes);
    for (const type of realization.bearing.attestationTypes) if (!published.has(type)) reasons.push(`unpublished attestation type: ${type}`);
    const expectedEffects = [...adapter.effects].sort();
    const declaredEffects = [...new Set(realization.effectRequirements)].sort();
    if (JSON.stringify(expectedEffects) !== JSON.stringify(declaredEffects)) reasons.push(`effect requirements must equal: ${expectedEffects.join(', ')}`);
    const support = classify(realization.witnesses.support, realization.predicates);
    const contradiction = classify(realization.witnesses.contradiction, realization.predicates);
    if (support.kind !== 'support') reasons.push('support witness does not uniquely reach support');
    if (contradiction.kind !== 'contradiction') reasons.push('contradiction witness does not uniquely reach contradiction');
    if (reasons.length > 0) throw new Error(`realization rejected: ${reasons.join('; ')}`);
  }

  validateJudgment(state, judgment) {
    const surface = state.subject.active.stake.mutationSurface;
    for (const path of mutationPaths(judgment.mutation)) {
      if (!surface.some(allowed => pathsOverlap(allowed, path))) throw new Error(`judgment mutation exceeds stake surface: ${path}`);
    }
    if (judgment.revisedStake) {
      for (const path of judgment.revisedStake.mutationSurface) {
        if (!surface.some(allowed => pathsOverlap(allowed, path))) throw new Error(`revised stake expands mutation authority: ${path}`);
      }
    }
    if (judgment.disposition === 'retry' && state.subject.active.realizationAttempts >= state.spec.limits.maxRealizationAttempts) {
      throw new Error('retry exceeds the sealed realization-attempt limit; revise, retire, or surrender');
    }
    this.validateOpportunityWorlds(state, judgment.opportunities);
  }

  validateOpportunityWorlds(state, opportunities) {
    const worlds = new Set(state.spec.worlds.map(value => value.id));
    for (const opportunity of opportunities) {
      if (opportunity.source.world && !worlds.has(opportunity.source.world)) {
        throw new Error(`opportunity world is outside sealed envelope: ${opportunity.source.world}`);
      }
    }
  }

  projection(state, role) {
    const subjectRef = this.store.put(state.subject);
    const opportunityProjection = projectOpportunities(state.subject);
    const trail = state.events
      .filter(event => event.type === 'subject.advanced')
      .slice(-state.spec.limits.projectionHistoryEntries)
      .map(event => ({
        succession: this.store.get(event.payload.subject).succession,
        revision: this.store.get(event.payload.subject).revision,
        operation: event.payload.operation,
        classification: event.payload.classification ?? null,
        disposition: event.payload.disposition ?? null,
        subjectId: this.store.get(event.payload.subject).id,
        evidence: event.payload.evidence,
      }));
    const activeEvidence = this.activeEvidence(state.subject);
    let projection = {
      format: 'music-v4-fresh-projection-1',
      role,
      run: { id: state.runId, specId: state.spec.id, limits: state.spec.limits },
      epistemicContract: {
        authoritative: 'Only exact world receipts, mechanically derived effects, and retained world attestations establish world facts.',
        interpretive: 'Identity, stakes, memory, descriptions, rationales, opportunity cards, and files containing claims remain interpretations.',
      },
      worlds: state.spec.worlds.map(world => {
        const adapter = this.worlds.get(world.adapter);
        return {
          id: world.id,
          description: world.description,
          publicContract: world.publicContract,
          attestationTypes: world.attestationTypes,
          effects: adapter.effects,
        };
      }),
      developmentalInterfaces: {
        operationSelector: clone(OPERATION_INTERFACE),
        attention: clone(ATTENTION_INTERFACE),
      },
      capabilities: { effectiveGrants: state.effectiveGrants },
      subject: clone(state.subject),
      subjectEvidence: subjectRef,
      operation: deriveOperation(state.subject, { now: this.clock() }),
      opportunityProjection,
      opportunityEvidence: this.opportunityEvidence(opportunityProjection),
      activeEvidence,
      causalTrail: trail,
    };
    const policy = attentionPolicy(state.subject, state.spec.limits);
    projection.causalTrail = compactCausalTrail(projection.causalTrail, policy);
    projection = attachAttentionManifest(projection, policy);
    return projection;
  }

  activeEvidence(subject) {
    if (!subject.active) return null;
    const opportunity = subject.opportunities[subject.active.opportunityId];
    const result = {};
    if (opportunity?.source.evidence) result.opportunity = this.evidenceView(opportunity.source.evidence);
    if (subject.active.consequence?.receipt) result.receipt = this.evidenceView(subject.active.consequence.receipt);
    const rejection = subject.active.consequence?.detail?.rejection;
    if (rejection?.format === 'music-v4-object-1') result.rejection = this.evidenceView(rejection.sha256);
    return Object.keys(result).length > 0 ? result : null;
  }

  opportunityEvidence(projection) {
    return Object.fromEntries(projection.opportunities
      .filter(value => value.source.evidence)
      .map(value => [value.id, this.evidenceView(value.source.evidence)]));
  }

  evidenceView(sha256, maximumCharacters = 65_536) {
    const reference = referenceFor(this.store, sha256);
    const value = this.store.get(reference);
    const text = JSON.stringify(value);
    if (text.length <= maximumCharacters) return { reference, complete: true, value };
    const half = Math.floor(maximumCharacters / 2);
    return {
      reference,
      complete: false,
      totalCharacters: text.length,
      head: text.slice(0, half),
      tail: text.slice(-half),
      retrieval: { world: 'evidence-read', input: { reference, offset: 0, maxCharacters: 65_536 } },
    };
  }

  async invoke(role, operationId, projection) {
    const state = this.state();
    const calls = state.invocations.filter(value => value.status === 'started').length;
    if (calls >= state.spec.limits.maxActorCalls) throw nonRetryable('sealed actor-call limit reached');
    const terminal = new Set(state.invocations.filter(value => ['completed', 'failed', 'abandoned'].includes(value.status)).map(value => value.invocationId));
    for (const pending of state.invocations.filter(value => value.status === 'started' && value.operationId === operationId && !terminal.has(value.invocationId))) {
      this.store.append('actor.abandoned', { ...pending, reason: 'no terminal receipt survived process boundary', status: 'abandoned' });
    }
    const schema = RoleSchemas[role];
    const invocationId = this.id('actor');
    const contextId = this.id('context');
    const projectionRef = this.store.put(projection);
    this.store.append('actor.started', {
      operationId, invocationId, role, contextId, projection: projectionRef,
      responseChain: null, workspaceContinuity: null, status: 'started',
    });
    try {
      const result = await this.actor.invoke({ role, projection: clone(projection), schema, task: RoleTasks[role] });
      const output = schema.parse(result.output);
      const outputRef = this.store.put(output);
      this.store.append('actor.completed', {
        operationId, invocationId, role, contextId, projection: projectionRef, output: outputRef,
        model: result.model ?? null, responseId: result.responseId ?? null, usage: jsonData(result.usage ?? null),
        responseChain: null, workspaceContinuity: null, status: 'completed',
      });
      return output;
    } catch (error) {
      const raw = typeof error?.rawOutput === 'string' ? this.store.put({ raw: error.rawOutput }) : null;
      this.store.append('actor.failed', {
        operationId, invocationId, role, contextId, projection: projectionRef,
        failure: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 16_384), raw, retryable: error?.retryable !== false },
        responseChain: null, workspaceContinuity: null, status: 'failed',
      });
      throw error;
    }
  }

  async run() {
    const lease = new ResidentLease(this.store.root, { clock: this.clock }).acquire();
    try {
      let state = this.state();
      while (!state.completed && !state.waitingUntil) {
        const head = state.head;
        state = await this.advance({ lease: false });
        if (state.head === head) break;
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
      while (!state.completed && !signal?.aborted) {
        if (state.waitingUntil) {
          const remaining = Date.parse(state.waitingUntil) - this.clock().getTime();
          await delay(Math.max(1, Math.min(remaining, maximumSleepMs)), signal);
        }
        const head = state.head;
        try {
          state = await this.advance({ lease: false });
        } catch (error) {
          state = this.state();
          if (error?.retryable === false || state.head === head) {
            this.store.append('resident.failed', { failure: failureValue(error) });
            throw error;
          }
          this.store.append('resident.failed', { failure: failureValue(error) });
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
    const observation = {
      id: IdentifierSchema.parse(id),
      channel: IdentifierSchema.parse(channel),
      from: String(from).slice(0, 256),
      content: jsonData(content),
    };
    if (state.observations.some(value => value.id === observation.id)) throw new Error(`duplicate observation: ${observation.id}`);
    const evidence = this.store.put(observation);
    this.store.append('observation.received', { ...observation, evidence });
    return this.state();
  }

  setGrant(effectValue, active, { reason = 'operator decision' } = {}) {
    const state = this.state();
    const effect = IdentifierSchema.parse(effectValue);
    if (!state.spec.grants.includes(effect)) throw new Error(`effect is outside genesis grant envelope: ${effect}`);
    if (state.effectiveGrants.includes(effect) === Boolean(active)) return state;
    this.store.append('grant.changed', { effect, active: Boolean(active), reason: String(reason).slice(0, 4096), authority: 'machine-owner' });
    return this.state();
  }

  audit() {
    const state = this.state();
    if (!state.initialized) return state;
    return {
      format: 'music-v4-audit-1',
      runId: state.runId,
      specId: state.spec.id,
      runtime: state.runtime,
      head: state.head,
      subject: {
        id: state.subject.id,
        parent: state.subject.parent,
        succession: state.subject.succession,
        revision: state.subject.revision,
        activeStake: state.subject.active?.stake.id ?? null,
        opportunities: standingCounts(state.subject.opportunities),
      },
      operation: state.operation,
      waitingUntil: state.waitingUntil,
      continuityPulseDue: state.continuityPulseDue,
      pendingObservations: state.pendingObservations.length,
      effectiveGrants: state.effectiveGrants,
      hatched: state.hatched,
      completed: state.completed,
      residentFailures: state.residentFailures,
      operations: state.operationEvents,
      inference: clone(state.spec.inference),
      inferenceUsage: summarizeInferenceUsage(state.invocations),
      actorInvocations: state.invocations.filter(value => value.invocationId).map(value => ({
        invocationId: value.invocationId, operationId: value.operationId, role: value.role,
        contextId: value.contextId, responseChain: value.responseChain,
        workspaceContinuity: value.workspaceContinuity, status: value.status,
        usage: clone(value.usage ?? null),
      })),
      evidence: this.store.verifyObjectGraph(),
    };
  }

  snapshot(destination) {
    if (!this.state().initialized) throw new Error('run is not initialized');
    return this.store.snapshot(destination);
  }

  requireRuntime(spec, expectedProvenance = null) {
    if (!this.actor || !this.worlds) throw new Error('actor and world registry are required');
    if (digest(this.actor.describe()) !== digest(spec.inference)) throw new Error('inference condition differs from sealed genesis');
    if (expectedProvenance && this.provenance().implementationSha256 !== expectedProvenance.implementationSha256) {
      throw new Error('runtime implementation differs from sealed genesis provenance');
    }
    this.worlds.verifySpec(spec);
  }

  markHatched(state) {
    if (state.hatched || state.subject.revision < 1 || !['openrouter', 'codex'].includes(state.spec.inference.provider)) return;
    const completed = state.invocations.filter(value => value.status === 'completed');
    const roles = new Set(completed.map(value => value.role));
    if (!roles.has('select') || !roles.has('realize') || (!roles.has('assimilate') && !roles.has('correct'))) return;
    this.store.append('subject.hatched', {
      subjectId: state.subject.id,
      succession: state.subject.succession,
      revision: state.subject.revision,
      inference: clone(state.spec.inference),
      criterion: 'first hosted select-realize-contact-consequence-judgment lineage',
    });
  }

  complete(reason, state) {
    if (this.state().completed) return;
    this.store.append('run.completed', {
      reason,
      observerDisposition: 'completed',
      subjectDisposition: 'open',
      finalSubjectId: state.subject.id,
      completedOperations: state.operationEvents.length,
    });
  }
}

export function summarizeInferenceUsage(invocations) {
  const completed = invocations.filter(value => value.status === 'completed');
  const totals = emptyUsageSummary();
  const byRole = {};
  for (const invocation of completed) {
    const usage = normalizedInferenceUsage(invocation.usage);
    const role = invocation.role ?? 'unknown';
    byRole[role] ??= emptyUsageSummary();
    addUsage(totals, usage);
    addUsage(byRole[role], usage);
  }
  return {
    format: 'music-v4-inference-usage-summary-1',
    ...finishUsage(totals),
    byRole: Object.fromEntries(Object.entries(byRole).sort(([a], [b]) => a.localeCompare(b)).map(([role, value]) => [role, finishUsage(value)])),
  };
}

function normalizedInferenceUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = firstNumber(value.input_tokens, value.prompt_tokens, value.inputTokens?.total, value.inputTokens, value.promptTokens);
  const outputTokens = firstNumber(value.output_tokens, value.completion_tokens, value.outputTokens?.total, value.outputTokens, value.completionTokens);
  const cacheReadTokens = firstNumber(value.cached_input_tokens, value.input_tokens_details?.cached_tokens, value.prompt_tokens_details?.cached_tokens, value.inputTokenDetails?.cacheReadTokens, value.inputTokens?.cacheRead);
  const cacheWriteTokens = firstNumber(value.cache_write_input_tokens, value.input_tokens_details?.cache_write_tokens, value.prompt_tokens_details?.cache_write_tokens, value.inputTokenDetails?.cacheWriteTokens, value.inputTokens?.cacheWrite);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheMetricsReported: cacheReadTokens !== null || cacheWriteTokens !== null };
}

function firstNumber(...values) { return values.find(value => typeof value === 'number' && Number.isFinite(value)) ?? null; }
function emptyUsageSummary() { return { completedCalls: 0, reportedCalls: 0, cacheReportedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }; }
function addUsage(summary, usage) {
  summary.completedCalls += 1;
  if (!usage || usage.inputTokens === null) return;
  summary.reportedCalls += 1;
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens ?? 0;
  if (usage.cacheMetricsReported) summary.cacheReportedCalls += 1;
  summary.cacheReadTokens += usage.cacheReadTokens ?? 0;
  summary.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
}
function finishUsage(summary) {
  return { ...summary, unreportedCalls: summary.completedCalls - summary.reportedCalls, uncachedInputTokens: Math.max(0, summary.inputTokens - summary.cacheReadTokens), cacheReadFraction: summary.inputTokens > 0 ? summary.cacheReadTokens / summary.inputTokens : null };
}

function findOpenContact(events, binding) {
  const completed = new Set(events.filter(event => ['contact.completed', 'contact.failed'].includes(event.type)).map(event => event.payload.binding));
  return events.findLast(event => event.type === 'contact.started' && event.payload.binding === binding && !completed.has(binding)) ?? null;
}

function referenceFor(store, sha256) {
  const path = store.readEvents().flatMap(event => findReferences(event.payload)).find(value => value.sha256 === sha256);
  if (!path) throw new Error(`evidence reference is not reachable: ${sha256}`);
  return path;
}

function findReferences(value, found = []) {
  if (Array.isArray(value)) { for (const item of value) findReferences(item, found); return found; }
  if (!value || typeof value !== 'object') return found;
  if (value.format === 'music-v4-object-1' && typeof value.sha256 === 'string') { found.push(value); return found; }
  for (const item of Object.values(value)) findReferences(item, found);
  return found;
}

function earliest(...values) {
  const dates = values.filter(Boolean).sort();
  return dates[0] ?? null;
}

function standingCounts(opportunities) {
  const counts = {};
  for (const value of Object.values(opportunities)) counts[value.standing] = (counts[value.standing] ?? 0) + 1;
  return counts;
}

function jsonData(value) { return JSON.parse(JSON.stringify(value)); }
function failureValue(error) { return { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 16_384), retryable: error?.retryable !== false }; }
function nonRetryable(message) { const error = new Error(message); error.retryable = false; return error; }

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let abort = null;
    const timer = setTimeout(() => { if (abort) signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (!signal) return;
    abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('resident loop stopped')); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
