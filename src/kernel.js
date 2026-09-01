import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from './artifacts.js';
import { canonical, digest } from './canonical.js';
import { admitWager } from './constitution.js';
import { Governance } from './governance.js';
import { Ledger } from './ledger.js';
import { applyTransition, initialPosition, withEarnedFloor } from './position.js';
import { affectedPaths, pathsOverlap, TransitionSchema, verifyPosition } from './position.js';
import { reconstruct } from './state.js';
import { executeTool, starterTools, ToolArtifactSchema } from './tools.js';
import { classifyReceipt, evaluatePredicate } from './predicate.js';

export class MusicKernel {
  constructor(habitat, { clock = () => new Date(), id = () => randomUUID() } = {}) {
    this.habitat = habitat;
    this.clock = clock;
    this.id = id;
    this.ledger = new Ledger(join(habitat, 'state', 'ledger.jsonl'), { clock, id });
    this.artifacts = new ArtifactStore(join(habitat, 'state', 'artifacts'));
    this.governance = new Governance(join(habitat, 'governance', 'grants.json'), { clock });
  }

  state() {
    return reconstruct(this.ledger.read());
  }

  recoverInterruptedPerspectives() {
    const state = this.state();
    const interrupted = [...state.perspectives.values()].filter(value => value.status === 'started');
    for (const invocation of interrupted) {
      this.ledger.append('perspective.failed', {
        invocationId: invocation.id,
        failure: {
          name: 'InterruptedPerspective',
          message: 'The process ended before this perspective retained a terminal receipt.',
          quarantined: true,
          failedAt: this.clock().toISOString(),
        },
      });
    }
    return interrupted.map(value => value.id);
  }

  initialize(designation = null) {
    if (this.state().subject) throw new Error('Music subject already exists');
    const at = this.clock().toISOString();
    const mechanisms = {};
    for (const tool of starterTools()) {
      const artifact = this.artifacts.putJson(tool);
      mechanisms[tool.manifest.id] = {
        kind: 'tool',
        artifact,
        manifest: tool.manifest,
        standing: 'available',
      };
    }
    const subject = {
      id: this.id(),
      designation: normalizeDesignation(designation),
      bornAt: at,
    };
    const position = initialPosition(at, {
      mechanisms,
      authority: {
        inference: {
          model: 'z-ai/glm-5.3-flash',
          reasoningEffort: 'low',
          providerOrder: ['z-ai', 'deepinfra', 'baseten'],
          budgets: {
            orientation: 15_000,
            challenge: 15_000,
            election: 15_000,
            assimilation: 15_000,
            disposition: 15_000,
          },
          timeoutMs: 120_000,
        },
      },
    });
    this.ledger.append('subject.born', { subject, position });
    return this.state();
  }

  receiveMessage({ id = null, sender, recipient = 'the entity', channel = 'inbox', content, authentication = null, observedAt = null, delivery = null }) {
    const state = this.state();
    requireSubject(state);
    if (typeof sender !== 'string' || sender.trim() === '') throw new Error('message sender is required');
    if (typeof content !== 'string' || content.length === 0) throw new Error('message content is required');
    const observation = {
      id: id ?? this.id(),
      kind: 'message.received',
      sender: sender.trim(),
      recipient,
      channel,
      observedAt: observedAt ?? this.clock().toISOString(),
      content,
      authentication,
      delivery: delivery ?? { adapter: 'music.cli', transformed: false },
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(observation.id)) throw new Error('invalid message observation id');
    if (state.observations.some(value => value.id === observation.id)) throw new Error(`duplicate observation id: ${observation.id}`);
    canonical(observation);
    this.ledger.append('observation.received', { observation });
    return observation;
  }

  receiveObservation(observationValue) {
    const state = this.state();
    requireSubject(state);
    const observation = {
      ...structuredClone(observationValue),
      id: this.id(),
      observedAt: this.clock().toISOString(),
    };
    canonical(observation);
    this.ledger.append('observation.received', { observation });
    return observation;
  }

  bindWager(wagerValue, electionReceipt = null) {
    const state = this.state();
    requireSubject(state);
    if (state.election) throw new Error(`wager is already active: ${state.election.wagerId}`);
    if (state.wagers.has(wagerValue?.id)) throw new Error(`duplicate wager id: ${wagerValue.id}`);
    const grants = this.governance.read();
    const admission = admitWager(wagerValue, {
      position: state.position,
      grants,
      artifactExists: id => this.artifacts.has(id),
      toolContract: id => {
        const manifest = ToolArtifactSchema.parse(this.artifacts.readJson(id)).manifest;
        return { effects: manifest.effects, outputSchema: manifest.outputSchema };
      },
    });
    if (!admission.admissible) throw new Error(`wager is inadmissible:\n- ${admission.reasons.join('\n- ')}`);
    this.ledger.append('wager.bound', {
      wager: admission.wager,
      position: state.position.id,
      electionReceipt,
      admission: {
        constitution: 'music-v2-constitution-1',
        derivedFloors: admission.derivedFloors,
      },
    });
    return admission.wager;
  }

  async realize(wagerId) {
    let state = this.state();
    requireSubject(state);
    const bound = state.wagers.get(wagerId);
    if (!bound) throw new Error(`unknown wager: ${wagerId}`);
    if (bound.position !== state.position.id) throw new Error('wager parent position is no longer active');
    const wager = bound.wager;
    let receipt = state.realizations.get(wagerId);
    if (!receipt) {
      const tool = ToolArtifactSchema.parse(this.artifacts.readJson(wager.contact.tool));
      const startedAt = this.clock().toISOString();
      const realizationId = this.id();
      let output;
      let failure = null;
      try {
        output = await executeTool(tool, wager.contact.input, {
          grants: this.governance.read(),
          habitat: this.habitat,
          invocationId: realizationId,
          wagerId,
          environment: this.toolEnvironment(),
          emitObservation: value => this.receiveObservation(value),
        });
      } catch (error) {
        failure = {
          name: error?.name ?? 'Error',
          message: String(error?.message ?? error).slice(0, 16_384),
        };
      }
      receipt = {
        id: realizationId,
        kind: failure ? 'tool.failure' : 'tool.result',
        tool: { artifact: wager.contact.tool, id: tool.manifest.id },
        input: structuredClone(wager.contact.input),
        ...(failure ? { failure } : { output }),
        startedAt,
        completedAt: this.clock().toISOString(),
        capture: { runtime: 'music-v2-tool-runtime-1', transformed: false },
      };
      this.ledger.append('realization.completed', { wagerId, receipt });
      state = this.state();
    }
    let evaluationReceipt = state.evaluations.get(wagerId);
    if (!evaluationReceipt) {
      const evaluation = classifyReceipt(receipt, wager.classifiers);
      evaluationReceipt = {
        ...evaluation,
        evaluator: 'music-v2-predicate-1',
        receipt: digest(receipt),
        evaluatedAt: this.clock().toISOString(),
      };
      this.ledger.append('predicate.evaluated', { wagerId, evaluation: evaluationReceipt });
    }
    if (evaluationReceipt.kind === 'support' || evaluationReceipt.kind === 'contradiction') {
      const operation = wager.continuations[evaluationReceipt.kind];
      const position = applyTransition(state.position, operation, this.clock().toISOString());
      this.ledger.append('transition.applied', {
        wagerId,
        outcome: evaluationReceipt.kind,
        operation,
        position,
      });
      return { receipt, evaluation: evaluationReceipt, position };
    }
    if (!this.state().pendingAssimilation) {
      this.ledger.append('consequence.underdetermined', {
        wagerId,
        evaluation: evaluationReceipt,
        position: state.position.id,
      });
    }
    return { receipt, evaluation: evaluationReceipt, position: null };
  }

  proposeDevelopment({ wagerId, invocationId, proposal }) {
    const state = this.state();
    const bound = state.wagers.get(wagerId);
    if (!bound) throw new Error(`unknown wager: ${wagerId}`);
    const transition = this.developmentTransition(proposal);
    if (proposal.proposedDevelopment?.kind === 'position') {
      for (const path of affectedPaths(transition)) {
        if (pathsOverlap('/mechanisms', path) || pathsOverlap('/authority', path)) {
          throw new Error('position development cannot bypass an exercised mechanism or authority trial');
        }
      }
    }
    for (const path of affectedPaths(transition)) {
      if (!bound.wager.revisionScope.some(scope => pathsOverlap(scope.replace(/\/$/, ''), path))) {
        throw new Error(`development path is outside the bound wager scope: ${path}`);
      }
    }
    const id = digest({ parentPosition: state.position.id, wagerId, invocationId, proposal });
    this.ledger.append('development.proposed', {
      id,
      parentPosition: state.position.id,
      wagerId,
      invocationId,
      proposal,
      proposedAt: this.clock().toISOString(),
    });
    return id;
  }

  async trialDevelopment(id) {
    const state = this.state();
    const development = state.development.get(id);
    if (!development || development.status !== 'proposed') throw new Error(`development is not proposed: ${id}`);
    if (development.parentPosition !== state.position.id) throw new Error('development parent is no longer active');
    if (development.proposal.proposedDevelopment.kind === 'tool-authority') {
      throw new Error('tool authority requires a later selection exercise');
    }
    const transition = this.developmentTransition(development.proposal);
    let candidate = this.developmentCandidate(id);
    const requiredFloorIds = state.position.floors
      .filter(floor => affectedPaths(transition).some(path => pathsOverlap(floor.scope, path)))
      .map(floor => floor.id);
    const passedFloorIds = [];
    const probeReceipts = [];
    for (const floor of state.position.floors.filter(value => requiredFloorIds.includes(value.id))) {
      if (floor.kind !== 'tool.behavior') {
        if (evaluatePredicate(candidate, floor.predicate)) passedFloorIds.push(floor.id);
        continue;
      }
      const mechanism = candidate.mechanisms[floor.toolId];
      if (!mechanism?.artifact) continue;
      const tool = ToolArtifactSchema.parse(this.artifacts.readJson(mechanism.artifact));
      let passed = true;
      for (const probe of floor.probes) {
        const receipt = await this.executeDevelopmentProbe({ tool, probe, id, wagerId: development.wagerId, index: probeReceipts.length, floorId: floor.id });
        probeReceipts.push(receipt);
        if (!receipt.passed) passed = false;
      }
      if (passed) passedFloorIds.push(floor.id);
    }
    if (development.proposal.proposedDevelopment.kind === 'tool') {
      const tool = development.proposal.proposedDevelopment.tool;
      for (const probe of development.proposal.proposedDevelopment.probes) {
        probeReceipts.push(await this.executeDevelopmentProbe({
          tool, probe, id, wagerId: development.wagerId, index: probeReceipts.length, floorId: null,
        }));
      }
    }
    const eligible = requiredFloorIds.length === passedFloorIds.length && probeReceipts.every(value => value.passed);
    if (eligible && development.proposal.proposedDevelopment.kind === 'tool') {
      const toolId = development.proposal.proposedDevelopment.tool.manifest.id;
      candidate = withEarnedFloor(candidate, {
        kind: 'tool.behavior',
        id: `tool-floor:${digest({ development: id, toolId, probes: development.proposal.proposedDevelopment.probes }).slice(0, 32)}`,
        scope: `/mechanisms/${escapePointer(toolId)}`,
        toolId,
        probes: development.proposal.proposedDevelopment.probes,
        earnedBy: id,
      });
    }
    const trial = {
      candidate,
      transition,
      requiredFloorIds,
      passedFloorIds,
      probeReceipts,
      eligible,
      runtime: development.proposal.proposedDevelopment.kind === 'tool'
        ? 'music-v2-tool-trial-1'
        : 'music-v2-transition-trial-1',
      completedAt: this.clock().toISOString(),
    };
    this.ledger.append('development.trialed', { id, trial });
    return trial;
  }

  async executeDevelopmentProbe({ tool, probe, id, wagerId, index, floorId }) {
    let output;
    let failure = null;
    try {
      output = await executeTool(tool, probe.input, {
        grants: this.governance.read(), habitat: this.habitat,
        invocationId: `${id}:probe:${index}`, wagerId, environment: this.toolEnvironment(),
        emitObservation: value => this.receiveObservation(value),
      });
    } catch (error) {
      failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 16_384) };
    }
    return {
      kind: failure ? 'tool.failure' : 'tool.result',
      source: floorId === null ? 'proposal' : 'retained-floor',
      floorId,
      input: structuredClone(probe.input),
      ...(failure ? { failure } : { output }),
      expectation: probe.expectation,
      passed: !failure && evaluatePredicate({ output }, probe.expectation),
    };
  }

  developmentTransition(proposal) {
    const development = proposal.proposedDevelopment;
    if (development?.kind === 'position') return TransitionSchema.parse(development.transition);
    if (development?.kind === 'tool-authority') {
      return TransitionSchema.parse({
        kind: 'position.transition',
        set: { '/authority/toolSelection': { kind: 'allow-list', allowedToolIds: [...new Set(development.allowedToolIds)].sort() } },
        remove: [],
        opening: development.opening,
      });
    }
    if (development?.kind === 'inference-policy') {
      return TransitionSchema.parse({
        kind: 'position.transition',
        set: {
          '/authority/inference/budgets/orientation': development.selectionBudgets.orientation,
          '/authority/inference/budgets/challenge': development.selectionBudgets.challenge,
          '/authority/inference/budgets/election': development.selectionBudgets.election,
          '/authority/inference/reasoningEffort': development.reasoningEffort,
          '/authority/inference/providerOrder': [...new Set(development.providerOrder)],
        },
        remove: [],
        opening: development.opening,
      });
    }
    if (development?.kind !== 'tool') throw new Error('unknown proposed development kind');
    const tool = ToolArtifactSchema.parse(development.tool);
    const artifact = this.artifacts.putJson(tool);
    const key = escapePointer(tool.manifest.id);
    return TransitionSchema.parse({
      kind: 'position.transition',
      set: {
        [`/mechanisms/${key}`]: {
          kind: 'tool', artifact, manifest: tool.manifest, standing: 'available',
        },
      },
      remove: [],
      opening: development.opening,
    });
  }

  developmentCandidate(id) {
    const state = this.state();
    const development = state.development.get(id);
    if (!development || development.status !== 'proposed') throw new Error(`development is not proposed: ${id}`);
    if (development.parentPosition !== state.position.id) throw new Error('development parent is no longer active');
    return applyTransition(state.position, this.developmentTransition(development.proposal), development.proposedAt);
  }

  trialAuthorityDevelopment(id, evidence) {
    const state = this.state();
    const development = state.development.get(id);
    if (!development || development.status !== 'proposed') throw new Error(`development is not proposed: ${id}`);
    if (!['tool-authority', 'inference-policy'].includes(development.proposal.proposedDevelopment.kind)) throw new Error('development is not an authority proposal');
    const candidate = this.developmentCandidate(id);
    if (evidence.candidatePosition !== candidate.id) throw new Error('authority exercise used the wrong candidate position');
    const selectedTool = ToolArtifactSchema.parse(this.artifacts.readJson(evidence.selectedWager.contact.tool)).manifest.id;
    const requiredFloorIds = state.position.floors.filter(floor => pathsOverlap(floor.scope, '/authority/toolSelection')).map(floor => floor.id);
    const passedFloorIds = state.position.floors.filter(floor => requiredFloorIds.includes(floor.id) && evaluatePredicate(candidate, floor.predicate)).map(floor => floor.id);
    const proposed = development.proposal.proposedDevelopment;
    let authorityEvidence;
    let authorityEligible;
    if (proposed.kind === 'tool-authority') {
      const allowed = candidate.authority.toolSelection.allowedToolIds;
      authorityEvidence = { allowedToolIds: allowed, selectedTool };
      authorityEligible = allowed.includes(selectedTool);
    } else {
      const phases = ['orientation', 'challenge', 'election'];
      const invocations = {};
      authorityEligible = true;
      for (const phase of phases) {
        const invocation = state.perspectives.get(evidence.perspectiveReceipts[phase].invocation);
        const expectedBudget = candidate.authority.inference.budgets[phase];
        const conforms = invocation?.status === 'completed' && invocation.kind === phase &&
          invocation.maxOutputTokens === expectedBudget &&
          invocation.reasoningEffort === candidate.authority.inference.reasoningEffort &&
          JSON.stringify(invocation.providerOrder) === JSON.stringify(candidate.authority.inference.providerOrder);
        invocations[phase] = { id: invocation?.id ?? null, conforms };
        if (!conforms) authorityEligible = false;
      }
      authorityEvidence = { inferencePolicy: structuredClone(candidate.authority.inference), invocations, selectedTool };
    }
    const trial = {
      candidate,
      transition: this.developmentTransition(development.proposal),
      requiredFloorIds,
      passedFloorIds,
      probeReceipts: [],
      authorityExercise: {
        candidatePosition: candidate.id,
        ...authorityEvidence,
        selectedWager: structuredClone(evidence.selectedWager),
        perspectiveReceipts: structuredClone(evidence.perspectiveReceipts),
      },
      eligible: authorityEligible && requiredFloorIds.length === passedFloorIds.length,
      runtime: proposed.kind === 'tool-authority'
        ? 'music-v2-tool-authority-trial-1'
        : 'music-v2-inference-policy-trial-1',
      completedAt: this.clock().toISOString(),
    };
    this.ledger.append('development.trialed', { id, trial });
    return trial;
  }

  toolEnvironment() {
    const prepared = existsSync(join(this.habitat, 'habitat.json'));
    return {
      home: prepared ? join(this.habitat, 'home') : this.habitat,
      inbox: prepared ? join(this.habitat, 'mailbox', 'inbound') : join(this.habitat, 'inbox'),
      outbox: prepared ? join(this.habitat, 'mailbox', 'outbound', 'pending') : join(this.habitat, 'outbox'),
      dependencies: join(this.habitat, 'dependencies'),
    };
  }

  disposeDevelopment(id, disposition, receipt) {
    const state = this.state();
    const development = state.development.get(id);
    if (!development || development.status !== 'trialed') throw new Error(`development is not trialed: ${id}`);
    if (development.parentPosition !== state.position.id) throw new Error('development parent is no longer active');
    if (!['admit', 'retain-parent', 'surrender'].includes(disposition.choice)) throw new Error('invalid development disposition');
    let position;
    if (disposition.choice === 'admit') {
      if (!development.trial.eligible) throw new Error('ineligible development cannot be admitted');
      position = verifyPosition(development.trial.candidate);
    } else {
      position = applyTransition(state.position, {
        kind: 'position.transition',
        set: {},
        remove: [],
        opening: disposition.opening,
      }, this.clock().toISOString());
    }
    this.ledger.append('development.disposed', {
      id,
      disposition: disposition.choice,
      receipt,
      position,
    });
    return position;
  }
}

function normalizeDesignation(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 128) throw new Error('designation must be at most 128 characters');
  return value;
}

function requireSubject(state) {
  if (!state.subject) throw new Error('Music subject does not exist');
}

function escapePointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
