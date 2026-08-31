import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { canonical, digest } from './canonical.js';
import { applyCarrierTransition, createCarrierTransition, initialCarrier, projectCarrier, readCarrier, serializeCarrier } from './carrier.js';
import { inferencePolicyFromCarrier, inferencePolicyFromProjection } from './inference-policy.js';
import { executeToolModule, toolModuleDigest, validateToolModule } from './tool-module.js';
import {
  createDevelopmentalSuccessor, initialDevelopmentalPosition, openingFromWake,
  projectDevelopmentalPosition, readDevelopmentalPosition,
} from './development.js';

export const MUSIC_EVENT_FORMAT = 'music-event-12';
const FORMAT = MUSIC_EVENT_FORMAT;
const READABLE_FORMATS = new Set(['music-event-10', 'music-event-11', FORMAT]);
const WRITER_FORMAT = 'music-writer-1';
const ENCOUNTER_SHAPE_TOOL_ID = 'shape_encounter';
const MAX_TOOLS = 32;
const MAX_SELECTION_CANDIDATES = 16;
const MAX_SELECTION_BYTES = 64 * 1_024;
const MAX_DELTA_BYTES = 64 * 1_024;
const MAX_PROJECTION_BYTES = 2 * 1_024 * 1_024;
const MAX_ACTIVE_SURFACE_BYTES = 512 * 1_024;
const MAX_PROJECTION_FACTS = 128;
const MAX_DELIVERY_FAILURE_MESSAGE_BYTES = 2_048;
const RESERVED_TOOL_IDS = new Set([
  'inspect_tool', 'revise_tool', 'rollback_tool', 'revise_carrier',
  'inspect_development', 'trial_development', 'advance_development',
]);
const DEVELOPMENTAL_DISPOSITIONS = new Set(['admit', 'deny', 'defer', 'contradict', 'retire', 'rollback']);

export class MusicKernel {
  constructor(ledgerPath, {
    clock = () => new Date(),
    id = () => randomUUID(),
    deliveryProjectionTimeoutMs = 5_000,
    toolEnvironment = {},
  } = {}) {
    if (!Number.isInteger(deliveryProjectionTimeoutMs) || deliveryProjectionTimeoutMs < 10 || deliveryProjectionTimeoutMs > 120_000) {
      throw new Error('deliveryProjectionTimeoutMs must be an integer from 10 to 120000');
    }
    this.ledgerPath = ledgerPath;
    this.clock = clock;
    this.id = id;
    this.deliveryProjectionTimeoutMs = deliveryProjectionTimeoutMs;
    const environment = jsonValue(toolEnvironment, 'tool environment');
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
      throw new Error('tool environment must be an object');
    }
    this.toolEnvironment = Object.freeze(environment);
    this.writerLease = null;
  }

  initialize(name, tools) {
    if (this.state().subject) throw new Error('Music subject already exists');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length > 128) throw new Error('subject designation must be at most 128 characters');
    const initial = validateInitialTools(tools);
    const subject = { id: this.id(), name: trimmed || null, bornAt: this.clock().toISOString() };
    const toolsById = new Map(initial.map(tool => [tool.id, tool]));
    const carrier = initialCarrier();
    const position = initialDevelopmentalPosition({
      tools: toolsById, carrier, openingId: this.id(), at: subject.bornAt,
    });
    assertActiveGeometryFits(toolsById, carrier, {
      id: 'initial-sounding-capacity-check',
      name: subject.name,
      bornAt: this.clock().toISOString(),
    }, position);
    this.append('subject_created', {
      subject,
      tools: initial,
      carrier: serializeCarrier(carrier),
      position,
    });
    return this.state();
  }

  admitDelta(delta) {
    const state = this.state();
    requireSubject(state);
    validateDelta(delta);
    validateConsequenceReferences(delta, state);
    if (state.deltaIds.has(delta.id)) throw new Error(`duplicate delta id: ${delta.id}`);
    this.append('delta_admitted', { delta: structuredClone(delta) });
    return this.state();
  }

  recordRuntimeStart(runtime) {
    const state = this.state();
    requireSubject(state);
    const retained = validateRuntimeProvenance(runtime, FORMAT);
    this.append('runtime_started', { runtime: retained });
    return retained;
  }

  openSounding(trigger = 'manual') {
    const state = this.state();
    requireSubject(state);
    if (state.activeInferenceId) throw new Error(`cannot open a Sounding while inference is active: ${state.activeInferenceId}`);
    if (state.openSoundingId) throw new Error(`an opened Sounding is still awaiting an encounter: ${state.openSoundingId}`);
    if (!['delta', 'continuation', 'scheduled', 'heartbeat', 'manual'].includes(trigger)) throw new Error('invalid Sounding trigger');
    const base = {
      id: this.id(),
      subject: structuredClone(state.subject),
      parent: state.head,
      at: this.clock().toISOString(),
      trigger,
      tools: [...state.tools.values()].sort((a, b) => a.id.localeCompare(b.id)).map(projectTool),
      carrier: projectCarrier(state.carrier),
      ...(state.position ? { position: projectDevelopmentalPosition(state.position) } : {}),
    };
    base.wake = projectOpeningWake(state.nextWake, trigger, base.at);
    const surface = planSoundingSurface(state, base);
    const sounding = { ...base, ...surface.sounding };
    this.append('sounding_opened', {
      sounding,
      projection: digest(sounding),
    });
    return sounding;
  }

  getSounding(soundingId) {
    const state = this.state();
    const record = state.soundings.get(soundingId);
    if (!record) throw new Error(`unknown Sounding: ${soundingId}`);
    return structuredClone(record.sounding);
  }

  async projectEncounter(soundingId, phase, deltaIds = undefined) {
    const state = this.state();
    const encounter = state.soundings.get(soundingId);
    if (!encounter) throw new Error(`unknown Sounding: ${soundingId}`);
    const input = projectionInput(state, encounter, phase, deltaIds);
    const binding = encounter.toolBindings.get(ENCOUNTER_SHAPE_TOOL_ID);
    if (!binding) throw new Error(`Sounding ${soundingId} lacks ${ENCOUNTER_SHAPE_TOOL_ID}`);
    const projectedDeltaIds = phase === 'steering' ? [...deltaIds] : [];
    const projectionId = this.id();
    this.append('delivery_projection_started', {
      projectionId,
      soundingId,
      inferenceId: phase === 'steering' ? state.activeInferenceId : null,
      projection: encounter.projection,
      phase,
      deltaIds: projectedDeltaIds,
      tool: { id: binding.manifest.id, version: binding.manifest.version, digest: binding.digest },
      inputDigest: digest(input),
      factDigests: input.facts.map(fact => ({ id: fact.id, digest: fact.digest })),
    });
    try {
      const output = await withTimeout(executeToolModule(binding.manifest, input, {
        soundingId,
        projection: encounter.projection,
        ledgerPath: this.ledgerPath,
        deliveryPhase: phase,
        environment: structuredClone(this.toolEnvironment),
      }), this.deliveryProjectionTimeoutMs, `delivery projection exceeded ${this.deliveryProjectionTimeoutMs}ms`);
      const message = validateProjectionMessage(output, input);
      this.append('delivery_projection_completed', { projectionId, message });
      return { projectionId, mode: 'tool', message };
    } catch (error) {
      const failure = deliveryProjectionErrorRecord(error);
      const message = emergencyProjection(input, binding, failure.message);
      this.append('delivery_projection_failed', { projectionId, error: failure, fallbackMessage: message });
      return { projectionId, mode: 'recovery', message, error: failure };
    }
  }

  inferenceMessages(inferenceId) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId || !state.activeInputMessage) throw new Error(`inference is not active: ${inferenceId}`);
    return structuredClone([...state.recoveryMessages, state.activeInputMessage, ...state.activeTurnMessages]);
  }

  inferencePolicy(soundingId) {
    const sounding = this.state().soundings.get(soundingId);
    if (!sounding) throw new Error(`unknown Sounding: ${soundingId}`);
    return inferencePolicyFromProjection(sounding.sounding.carrier);
  }

  pendingSteeringDeltas(inferenceId) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    return structuredClone(planSteeringSurface(state, state.activeEncounter).deltas);
  }

  steerInference(inferenceId, deltaIds, checkpointMessages, inputMessage, deliveryProjectionId = null) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId || !state.activeEncounter) throw new Error(`inference is not active: ${inferenceId}`);
    if (!matchesPendingPrefix(state.pendingDeltas, deltaIds)) {
      throw new Error('steering Delta acknowledgement does not match pending world contact');
    }
    const checkpoints = jsonValue(checkpointMessages, 'steering checkpoint messages');
    if (!Array.isArray(checkpoints)) throw new Error('steering checkpoint messages must be an array');
    const message = validateSteeringMessage(inputMessage);
    const payload = {
      inferenceId,
      soundingId: state.activeEncounter.sounding.id,
      projection: state.activeEncounter.projection,
      deliveredDeltaIds: [...deltaIds],
      checkpointMessages: checkpoints,
      inputMessage: message,
      deliveryProjectionId,
    };
    assertInferencePayloadFits(state, payload, 'steering checkpoint');
    this.append('inference_steered', payload);
    return { deltas: this.state().activeEncounter.steeringDeltas.slice(-deltaIds.length), message };
  }

  stageToolRevision(inferenceId, soundingId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('revision needs a bounded interpretation');
    const requested = proposal?.tool;
    const current = state.tools.get(requested?.id);
    const tool = validateToolModule({
      ...requested,
      version: current ? current.version + 1 : 1,
      parent: current ? toolModuleDigest(current) : null,
    });
    if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
    const stagedNewTools = state.stagedRevisions.filter(revision => revision.previousTool === null).length;
    if (!current && state.tools.size + stagedNewTools >= MAX_TOOLS) throw new Error(`tool limit ${MAX_TOOLS} reached`);
    if (state.stagedToolIds.has(tool.id)) throw new Error(`tool ${tool.id} already has a revision staged in this encounter`);
    assertProspectiveGeometryFits(state, { tool });
    this.append('tool_revision_staged', {
      inferenceId,
      soundingId,
      projection: encounter.projection,
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      consequences: retainConsequenceEvidence(proposal.consequenceDeltaIds, encounter),
      previousTool: current ? toolModuleDigest(current) : null,
      tool,
      rollbackOf: null,
    });
    return tool;
  }

  authorToolProposal(inferenceId, soundingId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('proposal needs a bounded interpretation');
    const requested = proposal?.tool;
    const current = state.tools.get(requested?.id);
    const tool = validateToolModule({
      ...requested,
      version: current ? current.version + 1 : 1,
      parent: current ? toolModuleDigest(current) : null,
    });
    if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
    const pendingNewTools = [...state.developmentalProposals.values()]
      .filter(candidate => candidate.kind === 'tool' && candidate.status !== 'denied'
        && candidate.status !== 'contradicted' && candidate.status !== 'retired'
        && candidate.revision.previousTool === null).length;
    if (!current && state.tools.size + pendingNewTools >= MAX_TOOLS) throw new Error(`tool limit ${MAX_TOOLS} reached`);
    const proposalId = this.id();
    const revision = {
      inferenceId,
      soundingId,
      projection: encounter.projection,
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      consequences: retainConsequenceEvidence(proposal.consequenceDeltaIds, encounter),
      previousTool: current ? toolModuleDigest(current) : null,
      tool,
      rollbackOf: proposal.rollbackOf ?? null,
    };
    this.append('developmental_proposal_authored', {
      proposalId,
      kind: 'tool',
      authoredAt: this.clock().toISOString(),
      revision,
      position: developmentalStandingSuccessor(state, {
        kind: 'proposal-authored', proposalId, proposalKind: 'tool', revisionDigest: digest(revision),
      }),
    });
    return { proposalId, kind: 'tool', status: 'authored', revision: structuredClone(revision) };
  }

  authorToolRollbackProposal(inferenceId, soundingId, toolId, targetDigest, proposal = {}) {
    const state = this.state();
    requireActiveEncounter(state, inferenceId, soundingId);
    const current = state.tools.get(toolId);
    if (!current) throw new Error(`unknown tool: ${toolId}`);
    const target = state.toolHistory.get(targetDigest);
    if (!target || target.id !== toolId) throw new Error(`unknown prior version for ${toolId}: ${targetDigest}`);
    return this.authorToolProposal(inferenceId, soundingId, {
      ...proposal,
      rollbackOf: targetDigest,
      tool: {
        id: target.id,
        description: target.description,
        inputSchema: target.inputSchema,
        source: target.source,
        ...(target.selection === undefined ? {} : { selection: target.selection }),
      },
    });
  }

  authorCarrierProposal(inferenceId, soundingId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('carrier proposal needs a bounded interpretation');
    const transition = createCarrierTransition(state.carrier, proposal);
    const proposalId = this.id();
    const retained = {
      inferenceId,
      soundingId,
      projection: encounter.projection,
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      consequences: retainConsequenceEvidence(proposal.consequenceDeltaIds, encounter),
      ...transition,
    };
    this.append('developmental_proposal_authored', {
      proposalId,
      kind: 'carrier',
      authoredAt: this.clock().toISOString(),
      transition: retained,
      position: developmentalStandingSuccessor(state, {
        kind: 'proposal-authored', proposalId, proposalKind: 'carrier',
        transitionDigest: digest(projectCarrierTransition(retained, encounter)),
      }),
    });
    return { proposalId, kind: 'carrier', status: 'authored', transition: structuredClone(retained) };
  }

  inspectDevelopment(inferenceId, soundingId, proposalId = null) {
    const state = this.state();
    requireActiveEncounter(state, inferenceId, soundingId);
    if (proposalId !== null) {
      const proposal = state.developmentalProposals.get(proposalId);
      if (!proposal) throw new Error(`unknown developmental proposal: ${proposalId}`);
      return projectDevelopmentalProposal(proposal, true);
    }
    return {
      positionRoot: state.position?.root ?? null,
      proposals: [...state.developmentalProposals.values()]
        .filter(proposal => proposal.status !== 'retired')
        .map(proposal => projectDevelopmentalProposal(proposal, false)),
    };
  }

  async trialDevelopmentalProposal(inferenceId, soundingId, proposalId, input) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const proposal = state.developmentalProposals.get(proposalId);
    if (!proposal) throw new Error(`unknown developmental proposal: ${proposalId}`);
    if (!['authored', 'exercised', 'deferred', 'contradicted'].includes(proposal.status)) {
      throw new Error(`tool proposal ${proposalId} is ${proposal.status}, not trialable`);
    }
    const trialId = this.id();
    const binding = proposal.kind === 'tool'
      ? { kind: 'tool', id: proposal.revision.tool.id, digest: toolModuleDigest(proposal.revision.tool) }
      : { kind: 'carrier', id: proposal.transition.component.id, digest: proposal.transition.successorRoot };
    this.append('developmental_trial_started', {
      trialId, proposalId, inferenceId, soundingId, projection: encounter.projection,
      binding,
      input: jsonValue(input, 'developmental trial input'),
    });
    try {
      const output = proposal.kind === 'tool'
        ? await executeToolModule(proposal.revision.tool, input, {
          trialId, proposalId, inferenceId, soundingId, projection: encounter.projection,
          ledgerPath: this.ledgerPath,
          environment: structuredClone(this.toolEnvironment),
        })
        : {
          kind: 'provisional-carrier-projection',
          componentId: proposal.transition.component.id,
          carrier: projectCarrier(applyCarrierTransition(state.carrier, proposal.transition)),
          probe: jsonValue(input, 'developmental carrier probe'),
        };
      const current = this.state();
      this.append('developmental_trial_completed', {
        trialId,
        output,
        position: developmentalStandingSuccessor(current, {
          kind: 'proposal-exercised', proposalId, trialId, outcome: 'completed', outputDigest: digest(output),
        }),
      });
      return { trialId, proposalId, output };
    } catch (error) {
      const failure = errorRecord(error);
      const current = this.state();
      this.append('developmental_trial_failed', {
        trialId,
        error: failure,
        position: developmentalStandingSuccessor(current, {
          kind: 'proposal-exercised', proposalId, trialId, outcome: 'failed', error: failure,
        }),
      });
      throw error;
    }
  }

  stageDevelopmentalTransaction(inferenceId, soundingId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    if (state.stagedDevelopmentalTransaction) throw new Error('only one developmental transaction may be staged per encounter');
    const decisions = validateDevelopmentalDecisions(proposal?.decisions, state);
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('developmental transaction needs a bounded interpretation');
    const transaction = {
      transactionId: this.id(), inferenceId, soundingId, projection: encounter.projection,
      positionRoot: state.position?.root ?? null,
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      decisions,
    };
    this.append('developmental_transaction_staged', transaction);
    return structuredClone(transaction);
  }

  inspectTool(inferenceId, soundingId, toolId) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const binding = encounter.toolBindings.get(toolId);
    if (!binding) throw new Error(`tool ${toolId} was not projected in Sounding ${soundingId}`);
    return {
      id: binding.manifest.id,
      version: binding.manifest.version,
      digest: binding.digest,
      description: binding.manifest.description,
      inputSchema: structuredClone(binding.manifest.inputSchema),
      source: binding.manifest.source,
      ...(binding.manifest.selection === undefined ? {} : { selection: structuredClone(binding.manifest.selection) }),
    };
  }

  stageToolRollback(inferenceId, soundingId, toolId, targetDigest, proposal = {}) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const current = state.tools.get(toolId);
    if (!current) throw new Error(`unknown tool: ${toolId}`);
    if (state.stagedToolIds.has(toolId)) throw new Error(`tool ${toolId} already has a revision staged in this encounter`);
    const target = state.toolHistory.get(targetDigest);
    if (!target || target.id !== toolId) throw new Error(`unknown prior version for ${toolId}: ${targetDigest}`);
    const interpretation = typeof proposal.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('rollback needs a bounded interpretation');
    const tool = validateToolModule({
      ...target,
      version: current.version + 1,
      parent: toolModuleDigest(current),
    });
    assertProspectiveGeometryFits(state, { tool });
    this.append('tool_revision_staged', {
      inferenceId,
      soundingId,
      projection: encounter.projection,
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      consequences: retainConsequenceEvidence(proposal.consequenceDeltaIds, encounter),
      previousTool: toolModuleDigest(current),
      tool,
      rollbackOf: targetDigest,
    });
    return tool;
  }

  stageCarrierTransition(inferenceId, soundingId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    if (state.stagedCarrierTransition) throw new Error('only one carrier transition may be staged per encounter');
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('carrier transition needs a bounded interpretation');
    const transition = createCarrierTransition(state.carrier, proposal);
    assertProspectiveGeometryFits(state, { carrierTransition: transition });
    this.append('carrier_transition_staged', {
      inferenceId,
      soundingId,
      projection: encounter.projection,
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      consequences: retainConsequenceEvidence(proposal.consequenceDeltaIds, encounter),
      ...transition,
    });
    return transition;
  }

  stageConsequenceTransition(inferenceId, soundingId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const transition = validateConsequenceTransition(proposal, state, encounter);
    if (state.stagedConsequenceIds.has(transition.deltaId)) {
      throw new Error(`consequence ${transition.deltaId} already has a transition staged in this encounter`);
    }
    this.append('consequence_transition_staged', {
      inferenceId,
      soundingId,
      projection: encounter.projection,
      ...transition,
    });
    return transition;
  }

  stageWakeTransition(inferenceId, soundingId, invocationId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const invocation = state.activeToolInvocations.get(invocationId);
    if (!invocation || invocation.inferenceId !== inferenceId || invocation.soundingId !== soundingId) {
      throw new Error('future wake requires its active tool invocation');
    }
    if (state.stagedWakeTransition) throw new Error('only one future wake may be staged per encounter');
    const afterMs = proposal?.afterMs;
    if (!Number.isSafeInteger(afterMs) || afterMs < 1_000) throw new Error('future wake afterMs must be a safe integer of at least 1000');
    const reason = typeof proposal?.reason === 'string' ? proposal.reason.trim() : '';
    if (!reason || reason.length > 2_048) throw new Error('future wake needs a bounded reason');
    const stagedAt = this.clock().toISOString();
    const wakeAtMs = Date.parse(stagedAt) + afterMs;
    if (!Number.isSafeInteger(wakeAtMs) || !Number.isFinite(wakeAtMs)) throw new Error('future wake exceeds the supported clock range');
    let wakeAt;
    try { wakeAt = new Date(wakeAtMs).toISOString(); } catch { throw new Error('future wake exceeds the supported clock range'); }
    const transition = {
      wakeId: this.id(),
      inferenceId,
      soundingId,
      projection: encounter.projection,
      invocationId,
      tool: structuredClone(invocation.tool),
      stagedAt,
      afterMs,
      wakeAt,
      reason,
    };
    this.append('wake_transition_staged', transition);
    return transition;
  }

  selectToolAction(inferenceId, soundingId, toolId, frontier) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const binding = encounter.toolBindings.get(toolId);
    if (!binding) throw new Error(`tool ${toolId} was not projected in Sounding ${soundingId}`);
    if (!binding.manifest.selection) throw new Error(`tool ${toolId} does not require a selection frontier`);
    const selection = validateSelectionFrontier(binding.manifest, frontier);
    const selectionId = this.id();
    this.append('tool_selection_recorded', {
      selectionId,
      inferenceId,
      soundingId,
      projection: encounter.projection,
      carrierRoot: encounter.sounding.carrier.root,
      tool: { id: binding.manifest.id, version: binding.manifest.version, digest: binding.digest },
      ...selection,
    });
    return {
      selectionReceipt: selectionId,
      selectedCandidateId: selection.selectedCandidateId,
      selected: structuredClone(selection.selected),
    };
  }

  async invokeTool(inferenceId, soundingId, toolId, input, selectionReceipt = null) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const binding = encounter.toolBindings.get(toolId);
    if (!binding) throw new Error(`tool ${toolId} was not projected in Sounding ${soundingId}`);
    const tool = binding.manifest;
    const selection = authorizeSelection(state, encounter, tool, input, selectionReceipt);
    const invocationId = this.id();
    this.append('tool_invocation_started', {
      invocationId,
      inferenceId,
      soundingId,
      projection: encounter.projection,
      tool: { id: tool.id, version: tool.version, digest: toolModuleDigest(tool) },
      selectionReceipt: selection?.selectionId ?? null,
      input: structuredClone(input),
    });
    try {
      const output = await executeToolModule(tool, input, {
        invocationId,
        inferenceId,
        soundingId,
        projection: encounter.projection,
        ledgerPath: this.ledgerPath,
        environment: structuredClone(this.toolEnvironment),
        selectToolAction: (selectedToolId, frontier) => this.selectToolAction(inferenceId, soundingId, selectedToolId, frontier),
        stageConsequenceTransition: proposal => this.stageConsequenceTransition(inferenceId, soundingId, proposal),
        stageCarrierTransition: proposal => {
          const authored = this.authorCarrierProposal(inferenceId, soundingId, proposal);
          return { ...authored.transition, proposalId: authored.proposalId, status: authored.status };
        },
        stageWakeTransition: proposal => this.stageWakeTransition(inferenceId, soundingId, invocationId, proposal),
      });
      this.append('tool_invocation_completed', { invocationId, output });
      return output;
    } catch (error) {
      this.append('tool_invocation_failed', { invocationId, error: errorRecord(error) });
      throw error;
    }
  }

  beginInference(soundingId, model, inputMessage, deliveryProjectionId = null) {
    const state = this.state();
    requireSubject(state);
    if (state.activeInferenceId) throw new Error(`inference already active: ${state.activeInferenceId}`);
    const sounding = state.soundings.get(soundingId);
    if (!sounding) throw new Error(`unknown Sounding: ${soundingId}`);
    if (sounding.status !== 'opened') throw new Error(`Sounding ${soundingId} is ${sounding.status}, not opened`);
    if (typeof model?.provider !== 'string' || typeof model?.model !== 'string') throw new Error('inference needs provider and model identity');
    const message = jsonValue(inputMessage, 'inference input message');
    const inferenceId = this.id();
    this.append('inference_started', {
      inferenceId,
      soundingId,
      projection: sounding.projection,
      deliveredDeltaIds: sounding.sounding.deltas.map(delta => delta.id),
      model: { provider: model.provider, model: model.model },
      inputMessage: message,
      deliveryProjectionId,
    });
    return inferenceId;
  }

  checkpointInference(inferenceId, result) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    const payload = jsonValue({
      inferenceId,
      soundingId: state.activeEncounter.sounding.id,
      projection: state.activeEncounter.projection,
      responseMessages: result.responseMessages ?? [],
      step: result.step,
      usage: result.usage ?? {},
      requests: result.requests ?? [],
    }, 'inference checkpoint');
    if (!Array.isArray(payload.responseMessages)) throw new Error('inference checkpoint responseMessages must be an array');
    if (!Array.isArray(payload.requests)) throw new Error('inference checkpoint requests must be an array');
    assertInferencePayloadFits(state, payload, 'inference checkpoint');
    this.append('inference_checkpointed', payload);
    return payload;
  }

  completeInference(inferenceId, result) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    const stagedRevisions = state.stagedRevisions.map(revision => structuredClone(revision));
    const stagedCarrierTransition = state.stagedCarrierTransition ? structuredClone(state.stagedCarrierTransition) : null;
    const stagedConsequenceTransitions = state.stagedConsequenceTransitions.map(transition => structuredClone(transition));
    const stagedWakeTransition = state.stagedWakeTransition ? structuredClone(state.stagedWakeTransition) : null;
    const stagedDevelopmentalTransaction = state.stagedDevelopmentalTransaction
      ? structuredClone(state.stagedDevelopmentalTransaction) : null;
    const activatedPosition = developmentalSuccessorForCompletion(state, {
      revisions: stagedRevisions,
      carrierTransition: stagedCarrierTransition,
      consequenceTransitions: stagedConsequenceTransitions,
      wakeTransition: stagedWakeTransition,
      developmentalTransaction: stagedDevelopmentalTransaction,
    });
    const payload = jsonValue({
      inferenceId,
      soundingId: state.activeEncounter.sounding.id,
      projection: state.activeEncounter.projection,
      responseMessages: result.responseMessages,
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      steps: result.steps,
      requests: result.requests ?? [],
      activatedRevisions: stagedRevisions,
      activatedCarrierTransition: stagedCarrierTransition,
      activatedConsequenceTransitions: stagedConsequenceTransitions,
      activatedWakeTransition: stagedWakeTransition,
      activatedPosition,
      activatedDevelopmentalTransaction: stagedDevelopmentalTransaction,
    }, 'inference result');
    assertInferencePayloadFits(state, payload, 'inference result');
    this.append('inference_completed', payload);
    return this.state();
  }

  failInference(inferenceId, error, { checkpointMessages = [], requests = [] } = {}) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    const payload = jsonValue({
      inferenceId,
      soundingId: state.activeEncounter.sounding.id,
      projection: state.activeEncounter.projection,
      checkpointMessages,
      error: errorRecord(error),
      requests,
    }, 'inference failure');
    assertInferencePayloadFits(state, payload, 'inference failure');
    this.append('inference_failed', payload);
    return this.state();
  }

  recoverInterruptedInference(reason = 'The prior process ended before inference completion was retained.') {
    const state = this.state();
    if (!state.activeInferenceId) return null;
    const message = typeof reason === 'string' ? reason.trim() : '';
    if (!message || message.length > 2_048) throw new Error('recovery reason must be 1-2048 characters');
    const inferenceId = state.activeInferenceId;
    this.failInference(inferenceId, new Error(message));
    return inferenceId;
  }

  recoverInterruptedDeliveryProjections(reason = 'The prior process ended before delivery projection completion was retained.') {
    const state = this.state();
    const message = typeof reason === 'string' ? reason.trim() : '';
    if (!message || message.length > 2_048) throw new Error('delivery recovery reason must be 1-2048 characters');
    const projectionIds = [...state.activeDeliveryProjections.keys()];
    for (const projectionId of projectionIds) {
      this.append('delivery_projection_abandoned', { projectionId, reason: message });
    }
    return projectionIds;
  }

  acquireWriter(label = 'Music writer') {
    if (this.writerLease) throw new Error(`this kernel already holds the writer lease: ${this.writerLease.label}`);
    const lockPath = `${this.ledgerPath}.writer-lock`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      const lease = {
        format: WRITER_FORMAT,
        token,
        pid: process.pid,
        host: hostname(),
        at: this.clock().toISOString(),
        label: boundedWriterLabel(label),
      };
      let descriptor;
      try {
        descriptor = openSync(lockPath, 'wx', 0o600);
        writeAll(descriptor, `${canonical(lease)}\n`);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        this.writerLease = lease;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseWriterLock(lockPath, lease);
          if (this.writerLease?.token === token) this.writerLease = null;
        };
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (error?.code !== 'EEXIST') throw error;
        const owner = readWriterLock(lockPath);
        if (owner && writerIsAlive(owner)) {
          throw new Error(`Music writer lease is held by pid ${owner.pid} on ${owner.host}: ${owner.label}`);
        }
        if (!owner && Date.now() - statSync(lockPath).mtimeMs < 5_000) {
          throw new Error('Music writer lease is incomplete and too recent for safe stale recovery');
        }
        const stalePath = `${lockPath}.stale-${Date.now()}-${randomUUID()}`;
        try { renameSync(lockPath, stalePath); } catch (renameError) {
          if (renameError?.code === 'ENOENT') continue;
          throw renameError;
        }
      }
    }
    throw new Error('could not acquire Music writer lease after stale recovery');
  }

  recoverLedgerTail() {
    const release = this.writerLease ? null : this.acquireWriter('ledger tail recovery');
    try {
      if (!existsSync(this.ledgerPath)) return null;
      const bytes = readFileSync(this.ledgerPath);
      if (bytes.length === 0 || bytes.at(-1) === 0x0a) return null;
      const lastNewline = bytes.lastIndexOf(0x0a);
      const prefix = bytes.subarray(0, lastNewline + 1);
      const tail = bytes.subarray(lastNewline + 1);
      parseLedgerText(prefix.toString('utf8'));
      let kind;
      let backupPath = null;
      try {
        JSON.parse(tail.toString('utf8'));
        parseLedgerText(bytes.toString('utf8'));
        const descriptor = openSync(this.ledgerPath, 'a', 0o600);
        try { writeAll(descriptor, '\n'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        kind = 'newline-restored';
      } catch (error) {
        try {
          JSON.parse(tail.toString('utf8'));
        } catch {
          backupPath = `${this.ledgerPath}.torn-${Date.now()}-${randomUUID()}.bin`;
          const backup = openSync(backupPath, 'wx', 0o600);
          try { writeAll(backup, tail); fsyncSync(backup); } finally { closeSync(backup); }
          truncateSync(this.ledgerPath, prefix.length);
          const descriptor = openSync(this.ledgerPath, 'r+', 0o600);
          try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
          kind = 'torn-tail-removed';
        }
        if (kind !== 'torn-tail-removed') throw error;
      }
      const receipt = {
        kind,
        bytes: tail.length,
        sha256: createHash('sha256').update(tail).digest('hex'),
        ...(backupPath === null ? {} : { backupPath }),
      };
      this.append('ledger_tail_recovered', receipt);
      return receipt;
    } finally {
      release?.();
    }
  }

  state() {
    return reduceEvents(this.events());
  }

  audit() {
    const events = this.events();
    const state = reduceEvents(events);
    return {
      valid: true,
      events: events.length,
      head: state.head,
      subject: state.subject,
      tools: [...state.tools.values()].map(tool => ({ id: tool.id, version: tool.version, digest: toolModuleDigest(tool) })),
      carrierRoot: projectCarrier(state.carrier).root,
      positionRoot: state.position?.root ?? null,
      developmentalProposals: state.developmentalProposals.size,
      provisionalDevelopmentalProposals: [...state.developmentalProposals.values()]
        .filter(proposal => !['admitted', 'rolled-back', 'denied', 'retired'].includes(proposal.status)).length,
      developmentalTrials: [...state.developmentalTrials.values()].filter(trial => trial.status !== 'started').length,
      uncertainDevelopmentalTrials: [...state.developmentalTrials.values()].filter(trial => trial.status === 'started').length,
      pendingDeltas: state.pendingDeltas.length,
      invocations: state.invocations.length,
      failedInvocations: countInvocationStatus(state, 'failed'),
      uncertainInvocations: countInvocationStatus(state, 'uncertain'),
      activeInvocations: state.activeToolInvocations.size,
      consequenceDeltas: state.consequenceDeltaIds.size,
      steeringEvents: state.steeringEvents,
      steeredDeltas: state.steeredDeltaCount,
      deliveryProjections: state.deliveryProjectionCount,
      failedDeliveryProjections: state.failedDeliveryProjectionCount,
      uncertainDeliveryProjections: state.activeDeliveryProjections.size,
      ledgerTailRecoveries: state.ledgerTailRecoveryCount,
      runtimeStarts: state.runtimeHistory.length,
      runtime: state.runtime ? structuredClone(state.runtime) : null,
      inferenceCheckpoints: state.inferenceCheckpointCount,
      unresolvedConsequences: [...state.consequences.values()].filter(consequence => consequence.status !== 'settled').length,
      deferredConsequences: [...state.consequences.values()].filter(consequence => consequence.status === 'deferred').length,
      consequenceSweepActive: state.consequenceSweepActive,
      unprojectedConsequences: state.consequenceSweepIds.length,
      nextWake: state.nextWake ? {
        wakeId: state.nextWake.wakeId,
        wakeAt: state.nextWake.wakeAt,
        reason: state.nextWake.reason,
        invocationId: state.nextWake.invocationId,
      } : null,
      uncertainInvocationsWithoutWorldContact: [...state.invocationHistory.entries()]
        .filter(([invocationId, invocation]) => invocation.status === 'uncertain' && !state.contactedInvocationIds.has(invocationId)).length,
      selections: state.selectionCount,
      completedInferences: state.completedInferences,
      failedInferences: state.failedInferences,
      activeInferenceId: state.activeInferenceId,
      openSoundingId: state.openSoundingId,
      soundings: [...state.soundings.values()].reduce((counts, sounding) => {
        counts[sounding.status] = (counts[sounding.status] ?? 0) + 1;
        return counts;
      }, {}),
    };
  }

  events() {
    if (!existsSync(this.ledgerPath)) return [];
    return parseLedgerText(readFileSync(this.ledgerPath, 'utf8'));
  }

  append(type, payload) {
    const release = this.writerLease ? null : this.acquireWriter(`append ${type}`);
    try {
      const events = this.events();
      if (events.length > 0 && events[0].format !== FORMAT) {
        throw new Error(`legacy ${events[0].format} ledger is read-only; migrate it before appending ${FORMAT} events`);
      }
      const unsigned = {
        format: FORMAT,
        sequence: events.length,
        parent: events.at(-1)?.hash ?? null,
        at: this.clock().toISOString(),
        type,
        payload,
      };
      const event = { ...unsigned, hash: digest(unsigned) };
      const descriptor = openSync(this.ledgerPath, 'a', 0o600);
      try {
        writeAll(descriptor, `${canonical(event)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return event;
    } finally {
      release?.();
    }
  }
}

function reduceEvents(events) {
  const state = {
    head: null,
    subject: null,
    tools: new Map(),
    toolHistory: new Map(),
    carrier: new Map(),
    position: null,
    deltaIds: new Set(),
    pendingDeltas: [],
    soundings: new Map(),
    openSoundingId: null,
    invocations: [],
    activeToolInvocations: new Map(),
    invocationIds: new Set(),
    invocationHistory: new Map(),
    contactedInvocationIds: new Set(),
    consequenceDeltaIds: new Set(),
    consequences: new Map(),
    consequenceSweepActive: false,
    consequenceSweepIds: [],
    messages: [],
    recoveryMessages: [],
    activeInputMessage: null,
    activeTurnMessages: [],
    activeInferenceId: null,
    activeEncounter: null,
    stagedRevisions: [],
    stagedToolIds: new Set(),
    stagedCarrierTransition: null,
    stagedConsequenceTransitions: [],
    stagedConsequenceIds: new Set(),
    stagedWakeTransition: null,
    stagedDevelopmentalTransaction: null,
    developmentalProposals: new Map(),
    developmentalTrials: new Map(),
    nextWake: null,
    selections: new Map(),
    usedSelectionIds: new Set(),
    selectionCount: 0,
    inferenceIds: new Set(),
    completedInferences: 0,
    failedInferences: 0,
    steeringEvents: 0,
    steeredDeltaCount: 0,
    deliveryProjectionIds: new Set(),
    activeDeliveryProjections: new Map(),
    deliveryProjections: new Map(),
    usedDeliveryProjectionIds: new Set(),
    deliveryProjectionCount: 0,
    failedDeliveryProjectionCount: 0,
    ledgerTailRecoveryCount: 0,
    runtimeHistory: [],
    runtime: null,
    inferenceCheckpointCount: 0,
  };
  for (const event of events) {
    state.head = event.hash;
    switch (event.type) {
      case 'subject_created':
        if (state.subject) throw new Error('ledger contains multiple subjects');
        state.subject = structuredClone(event.payload.subject);
        for (const tool of event.payload.tools) {
          const valid = validateToolModule(tool);
          state.tools.set(valid.id, valid);
          state.toolHistory.set(toolModuleDigest(valid), valid);
        }
        state.carrier = readCarrier(event.payload.carrier);
        state.position = event.format === FORMAT
          ? readDevelopmentalPosition(event.payload.position, { tools: state.tools, carrier: state.carrier })
          : null;
        assertActiveGeometryFits(state.tools, state.carrier, state.subject, state.position);
        break;
      case 'ledger_tail_recovered':
        validateLedgerRecoveryReceipt(event.payload);
        state.ledgerTailRecoveryCount += 1;
        break;
      case 'runtime_started': {
        requireSubject(state);
        const runtime = validateRuntimeProvenance(event.payload.runtime, event.format);
        state.runtimeHistory.push(runtime);
        state.runtime = runtime;
        break;
      }
      case 'delta_admitted': {
        requireSubject(state);
        const delta = event.payload.delta;
        validateDelta(delta);
        validateConsequenceReferences(delta, state);
        if (state.deltaIds.has(delta.id)) throw new Error(`ledger repeats delta id: ${delta.id}`);
        state.deltaIds.add(delta.id);
        if (delta.bearsOn?.length) {
          state.consequenceDeltaIds.add(delta.id);
          state.consequences.set(delta.id, { delta: structuredClone(delta), status: 'open', disposition: null });
        }
        for (const reference of delta.bearsOn ?? []) state.contactedInvocationIds.add(reference.invocationId);
        state.pendingDeltas.push(structuredClone(delta));
        break;
      }
      case 'sounding_opened': {
        requireSubject(state);
        const sounding = event.payload.sounding;
        if (event.payload.projection !== digest(sounding)) throw new Error('Sounding projection digest mismatch');
        if (digest(sounding.carrier) !== digest(projectCarrier(state.carrier))) throw new Error('Sounding carrier projection mismatch');
        if (event.format === FORMAT) {
          if (!state.position || digest(sounding.position) !== digest(projectDevelopmentalPosition(state.position))) {
            throw new Error('Sounding developmental position projection mismatch');
          }
        }
        if (state.openSoundingId || state.activeInferenceId) throw new Error('ledger opens overlapping Soundings');
        if (state.soundings.has(sounding.id)) throw new Error(`ledger repeats Sounding id: ${sounding.id}`);
        const toolBindings = bindProjectedTools(state.tools, sounding.tools);
        validateOpeningWake(sounding.wake ?? null, state.nextWake, sounding.trigger, sounding.at);
        if (sounding.frontier === undefined) {
          if (digest(sounding.unresolvedConsequences) !== digest(projectUnresolvedConsequences(state))) {
            throw new Error('Sounding unresolved consequence projection mismatch');
          }
        } else {
          const planned = planSoundingSurface(state, {
            id: sounding.id,
            subject: sounding.subject,
            parent: sounding.parent,
            at: sounding.at,
            trigger: sounding.trigger,
            tools: sounding.tools,
            carrier: sounding.carrier,
            ...(sounding.position ? { position: sounding.position } : {}),
            wake: sounding.wake ?? null,
          });
          if (digest(sounding.deltas) !== digest(planned.sounding.deltas)
            || digest(sounding.unresolvedConsequences) !== digest(planned.sounding.unresolvedConsequences)
            || digest(sounding.frontier) !== digest(planned.sounding.frontier)) {
            throw new Error('Sounding active-surface admission mismatch');
          }
          if (!state.consequenceSweepActive) {
            state.consequenceSweepActive = true;
            state.consequenceSweepIds = [...planned.sweepIds];
          }
        }
        state.soundings.set(sounding.id, {
          sounding: structuredClone(sounding),
          projection: event.payload.projection,
          toolBindings,
          steeringDeltas: [],
          status: 'opened',
          inferenceId: null,
        });
        state.openSoundingId = sounding.id;
        state.nextWake = null;
        break;
      }
      case 'delivery_projection_started': {
        const projection = validateDeliveryProjectionStart(event.payload, state);
        if (state.deliveryProjectionIds.has(projection.projectionId)) throw new Error('duplicate delivery projection id');
        state.deliveryProjectionIds.add(projection.projectionId);
        state.activeDeliveryProjections.set(projection.projectionId, projection);
        break;
      }
      case 'delivery_projection_completed': {
        const projection = state.activeDeliveryProjections.get(event.payload.projectionId);
        if (!projection) throw new Error('completed delivery projection is not active');
        const message = validateProjectionMessage(event.payload.message, projection.input);
        state.activeDeliveryProjections.delete(projection.projectionId);
        state.deliveryProjections.set(projection.projectionId, { ...projection, status: 'completed', message });
        state.deliveryProjectionCount += 1;
        break;
      }
      case 'delivery_projection_failed': {
        const projection = state.activeDeliveryProjections.get(event.payload.projectionId);
        if (!projection) throw new Error('failed delivery projection is not active');
        const message = validateProjectionMessage(event.payload.fallbackMessage, projection.input);
        state.activeDeliveryProjections.delete(projection.projectionId);
        state.deliveryProjections.set(projection.projectionId, {
          ...projection, status: 'recovery', message, error: structuredClone(event.payload.error),
        });
        state.deliveryProjectionCount += 1;
        state.failedDeliveryProjectionCount += 1;
        break;
      }
      case 'delivery_projection_abandoned': {
        const projection = state.activeDeliveryProjections.get(event.payload.projectionId);
        if (!projection) throw new Error('abandoned delivery projection is not active');
        if (typeof event.payload.reason !== 'string' || !event.payload.reason.trim() || event.payload.reason.length > 2_048) {
          throw new Error('abandoned delivery projection lacks a bounded reason');
        }
        state.activeDeliveryProjections.delete(projection.projectionId);
        state.deliveryProjections.set(projection.projectionId, {
          ...projection, status: 'abandoned', reason: event.payload.reason,
        });
        state.deliveryProjectionCount += 1;
        state.failedDeliveryProjectionCount += 1;
        break;
      }
      case 'tool_revision_staged': {
        requireSubject(state);
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        const revision = validateStagedRevision(event.payload, state);
        if (state.stagedToolIds.has(revision.tool.id)) throw new Error(`ledger stages tool ${revision.tool.id} twice in one encounter`);
        assertProspectiveGeometryFits(state, { tool: revision.tool });
        state.stagedRevisions.push(revision);
        state.stagedToolIds.add(revision.tool.id);
        break;
      }
      case 'carrier_transition_staged': {
        requireSubject(state);
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (state.stagedCarrierTransition) throw new Error('ledger stages more than one carrier transition in an encounter');
        const transition = projectCarrierTransition(event.payload, state.activeEncounter);
        applyCarrierTransition(state.carrier, transition);
        assertProspectiveGeometryFits(state, { carrierTransition: transition });
        state.stagedCarrierTransition = transition;
        break;
      }
      case 'consequence_transition_staged': {
        requireSubject(state);
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        const transition = validateConsequenceTransition(event.payload, state, encounter);
        if (state.stagedConsequenceIds.has(transition.deltaId)) {
          throw new Error(`ledger stages consequence ${transition.deltaId} twice in one encounter`);
        }
        state.stagedConsequenceTransitions.push(transition);
        state.stagedConsequenceIds.add(transition.deltaId);
        break;
      }
      case 'wake_transition_staged': {
        requireSubject(state);
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (state.stagedWakeTransition) throw new Error('ledger stages more than one future wake in an encounter');
        const invocation = state.activeToolInvocations.get(event.payload.invocationId);
        if (!invocation || invocation.inferenceId !== event.payload.inferenceId || invocation.soundingId !== encounter.sounding.id) {
          throw new Error('future wake is not bound to an active tool invocation');
        }
        const transition = validateWakeTransition(event.payload);
        if (digest(transition.tool) !== digest(invocation.tool)) throw new Error('future wake tool binding mismatch');
        state.stagedWakeTransition = transition;
        break;
      }
      case 'developmental_proposal_authored': {
        requireSubject(state);
        const authoredChange = event.payload.kind === 'tool' ? event.payload.revision : event.payload.transition;
        requireActiveEncounter(
          state,
          authoredChange?.inferenceId,
          authoredChange?.soundingId,
          authoredChange?.projection,
        );
        if (state.developmentalProposals.has(event.payload.proposalId)) throw new Error('duplicate developmental proposal id');
        if (!['tool', 'carrier'].includes(event.payload.kind)) throw new Error('unsupported developmental proposal kind');
        const revision = event.payload.kind === 'tool' ? validateStagedRevision(event.payload.revision, state) : null;
        const transition = event.payload.kind === 'carrier'
          ? projectCarrierTransition(event.payload.transition, state.activeEncounter)
          : null;
        if (transition) applyCarrierTransition(state.carrier, transition);
        const expectedPosition = developmentalStandingSuccessor(state, {
          kind: 'proposal-authored', proposalId: event.payload.proposalId,
          proposalKind: event.payload.kind,
          ...(revision ? { revisionDigest: digest(revision) } : { transitionDigest: digest(transition) }),
        });
        if (digest(event.payload.position) !== digest(expectedPosition)) throw new Error('proposal authorship position mismatch');
        state.developmentalProposals.set(event.payload.proposalId, {
          proposalId: event.payload.proposalId,
          kind: event.payload.kind,
          authoredAt: event.payload.authoredAt,
          status: 'authored',
          ...(revision ? { revision } : { transition }),
          trials: [],
          standing: [],
        });
        state.position = expectedPosition;
        break;
      }
      case 'developmental_trial_started': {
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        const proposal = state.developmentalProposals.get(event.payload.proposalId);
        if (!proposal) throw new Error('developmental trial cites unknown proposal');
        if (state.developmentalTrials.has(event.payload.trialId)) throw new Error('duplicate developmental trial id');
        const expectedBinding = proposal.kind === 'tool'
          ? { kind: 'tool', id: proposal.revision.tool.id, digest: toolModuleDigest(proposal.revision.tool) }
          : { kind: 'carrier', id: proposal.transition.component.id, digest: proposal.transition.successorRoot };
        if (digest(event.payload.binding) !== digest(expectedBinding)) throw new Error('developmental trial binding mismatch');
        state.developmentalTrials.set(event.payload.trialId, {
          ...structuredClone(event.payload), encounter: encounter.sounding.id, status: 'started',
        });
        break;
      }
      case 'developmental_trial_completed': {
        const trial = state.developmentalTrials.get(event.payload.trialId);
        if (!trial || trial.status !== 'started') throw new Error('completed developmental trial is not active');
        const output = jsonValue(event.payload.output, 'developmental trial output');
        const expectedPosition = developmentalStandingSuccessor(state, {
          kind: 'proposal-exercised', proposalId: trial.proposalId, trialId: trial.trialId,
          outcome: 'completed', outputDigest: digest(output),
        });
        if (digest(event.payload.position) !== digest(expectedPosition)) throw new Error('completed trial position mismatch');
        trial.status = 'completed';
        trial.output = output;
        const proposal = state.developmentalProposals.get(trial.proposalId);
        proposal.status = 'exercised';
        proposal.trials.push({ trialId: trial.trialId, status: 'completed' });
        state.position = expectedPosition;
        break;
      }
      case 'developmental_trial_failed': {
        const trial = state.developmentalTrials.get(event.payload.trialId);
        if (!trial || trial.status !== 'started') throw new Error('failed developmental trial is not active');
        const expectedPosition = developmentalStandingSuccessor(state, {
          kind: 'proposal-exercised', proposalId: trial.proposalId, trialId: trial.trialId,
          outcome: 'failed', error: event.payload.error,
        });
        if (digest(event.payload.position) !== digest(expectedPosition)) throw new Error('failed trial position mismatch');
        trial.status = 'failed';
        trial.error = structuredClone(event.payload.error);
        const proposal = state.developmentalProposals.get(trial.proposalId);
        proposal.status = 'contradicted';
        proposal.trials.push({ trialId: trial.trialId, status: 'failed' });
        state.position = expectedPosition;
        break;
      }
      case 'developmental_transaction_staged': {
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (state.stagedDevelopmentalTransaction) throw new Error('ledger stages more than one developmental transaction in an encounter');
        if (event.payload.positionRoot !== (state.position?.root ?? null)) throw new Error('developmental transaction position binding mismatch');
        validateDevelopmentalDecisions(event.payload.decisions, state);
        state.stagedDevelopmentalTransaction = structuredClone(event.payload);
        break;
      }
      case 'tool_selection_recorded': {
        requireSubject(state);
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (state.selections.has(event.payload.selectionId)) throw new Error('duplicate tool selection id');
        if (event.payload.carrierRoot !== encounter.sounding.carrier.root) throw new Error('tool selection carrier binding mismatch');
        const binding = encounter.toolBindings.get(event.payload.tool?.id);
        if (!binding || binding.digest !== event.payload.tool.digest || binding.manifest.version !== event.payload.tool.version) {
          throw new Error('tool selection is not bound to projected geometry');
        }
        const selection = validateSelectionFrontier(binding.manifest, event.payload);
        state.selections.set(event.payload.selectionId, {
          selectionId: event.payload.selectionId,
          inferenceId: event.payload.inferenceId,
          soundingId: event.payload.soundingId,
          projection: event.payload.projection,
          carrierRoot: event.payload.carrierRoot,
          tool: structuredClone(event.payload.tool),
          ...selection,
        });
        state.selectionCount += 1;
        break;
      }
      case 'tool_revision_activated': {
        throw new Error(`${FORMAT} does not allow standalone tool activation`);
      }
      case 'tool_invocation_started': {
        requireSubject(state);
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (state.invocationIds.has(event.payload.invocationId)) throw new Error('duplicate tool invocation id');
        const binding = encounter.toolBindings.get(event.payload.tool?.id);
        if (!binding || binding.digest !== event.payload.tool.digest || binding.manifest.version !== event.payload.tool.version) {
          throw new Error('tool invocation is not bound to projected geometry');
        }
        authorizeSelection(state, encounter, binding.manifest, event.payload.input, event.payload.selectionReceipt);
        if (event.payload.selectionReceipt) state.usedSelectionIds.add(event.payload.selectionReceipt);
        state.invocationIds.add(event.payload.invocationId);
        state.activeToolInvocations.set(event.payload.invocationId, structuredClone(event.payload));
        state.invocationHistory.set(event.payload.invocationId, { ...structuredClone(event.payload), status: 'started' });
        break;
      }
      case 'tool_invocation_completed': {
        const invocation = state.activeToolInvocations.get(event.payload.invocationId);
        if (!invocation) throw new Error('completed tool invocation is not active');
        state.invocations.push({ ...invocation, output: jsonValue(event.payload.output, 'tool invocation output') });
        state.invocationHistory.set(event.payload.invocationId, { ...invocation, status: 'completed', output: jsonValue(event.payload.output, 'tool invocation output') });
        state.activeToolInvocations.delete(event.payload.invocationId);
        break;
      }
      case 'tool_invocation_failed': {
        const invocation = state.activeToolInvocations.get(event.payload.invocationId);
        if (!invocation) throw new Error('failed tool invocation is not active');
        state.invocationHistory.set(event.payload.invocationId, { ...invocation, status: 'failed', error: structuredClone(event.payload.error) });
        state.activeToolInvocations.delete(event.payload.invocationId);
        break;
      }
      case 'inference_started': {
        requireSubject(state);
        if (state.activeInferenceId) throw new Error('ledger starts overlapping inference');
        const sounding = state.soundings.get(event.payload.soundingId);
        if (!sounding) throw new Error('inference cites an unknown Sounding');
        if (sounding.status !== 'opened' || state.openSoundingId !== event.payload.soundingId) {
          throw new Error('inference does not claim the currently opened Sounding');
        }
        if (event.payload.projection !== sounding.projection) throw new Error('inference projection binding mismatch');
        consumeDeliveryProjection(state, event.payload.deliveryProjectionId ?? null, {
          phase: 'sounding', soundingId: event.payload.soundingId, projection: event.payload.projection,
          deltaIds: [], message: event.payload.inputMessage,
        });
        if (state.inferenceIds.has(event.payload.inferenceId)) throw new Error('duplicate inference id');
        const delivered = new Set(event.payload.deliveredDeltaIds);
        const projectedDeltaIds = sounding.sounding.deltas.map(delta => delta.id);
        if (delivered.size !== projectedDeltaIds.length || projectedDeltaIds.some(id => !delivered.has(id))) {
          throw new Error('inference Delta acknowledgement does not match its Sounding');
        }
        state.inferenceIds.add(event.payload.inferenceId);
        state.activeInferenceId = event.payload.inferenceId;
        state.activeEncounter = sounding;
        state.openSoundingId = null;
        sounding.status = 'active';
        sounding.inferenceId = event.payload.inferenceId;
        state.pendingDeltas = state.pendingDeltas.filter(delta => !delivered.has(delta.id));
        state.activeInputMessage = structuredClone(event.payload.inputMessage);
        state.activeTurnMessages = [];
        state.messages.push(structuredClone(event.payload.inputMessage));
        break;
      }
      case 'inference_checkpointed': {
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        assertInferencePayloadFits(state, event.payload, 'inference checkpoint');
        if (!Array.isArray(event.payload.responseMessages)) throw new Error('checkpointed inference lacks response messages');
        if (!Array.isArray(event.payload.requests)) throw new Error('checkpointed inference lacks request receipts');
        jsonValue(event.payload.step, 'checkpointed inference step');
        jsonValue(event.payload.usage, 'checkpointed inference usage');
        const retained = structuredClone(event.payload.responseMessages);
        state.activeTurnMessages.push(...retained);
        state.messages.push(...retained);
        state.inferenceCheckpointCount += 1;
        break;
      }
      case 'inference_steered': {
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        assertInferencePayloadFits(state, event.payload, 'steering checkpoint');
        if (!Array.isArray(event.payload.deliveredDeltaIds)
          || !matchesPendingPrefix(state.pendingDeltas, event.payload.deliveredDeltaIds)) {
          throw new Error('steered Delta acknowledgement does not match pending world contact');
        }
        if (!Array.isArray(event.payload.checkpointMessages)) throw new Error('steered inference lacks checkpoint messages');
        const message = validateSteeringMessage(event.payload.inputMessage);
        consumeDeliveryProjection(state, event.payload.deliveryProjectionId ?? null, {
          phase: 'steering', soundingId: event.payload.soundingId, projection: event.payload.projection,
          deltaIds: event.payload.deliveredDeltaIds, message,
        });
        const deliveredCount = event.payload.deliveredDeltaIds.length;
        const delivered = structuredClone(state.pendingDeltas.slice(0, deliveredCount));
        encounter.steeringDeltas.push(...delivered);
        state.pendingDeltas = state.pendingDeltas.slice(deliveredCount);
        const retainedMessages = [...structuredClone(event.payload.checkpointMessages), message];
        state.activeTurnMessages.push(...retainedMessages);
        state.messages.push(...retainedMessages);
        state.steeringEvents += 1;
        state.steeredDeltaCount += delivered.length;
        break;
      }
      case 'inference_completed': {
        if (state.activeInferenceId !== event.payload.inferenceId) throw new Error('completed inference is not active');
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        assertInferencePayloadFits(state, event.payload, 'inference result');
        if ([...state.activeToolInvocations.values()].some(invocation => invocation.inferenceId === event.payload.inferenceId)) {
          throw new Error('cannot complete inference with an uncertain tool invocation');
        }
        if (!Array.isArray(event.payload.responseMessages)) throw new Error('completed inference lacks response messages');
        if (!Array.isArray(event.payload.activatedRevisions)) throw new Error('completed inference lacks activated revisions');
        if (event.payload.activatedRevisions.length !== state.stagedRevisions.length
          || event.payload.activatedRevisions.some((revision, index) => digest(revision) !== digest(state.stagedRevisions[index]))) {
          throw new Error('completed inference activation does not match staged revisions');
        }
        const expectedPosition = event.format === FORMAT
          ? developmentalSuccessorForCompletion(state, {
            revisions: event.payload.activatedRevisions,
            carrierTransition: event.payload.activatedCarrierTransition,
            consequenceTransitions: event.payload.activatedConsequenceTransitions,
            wakeTransition: event.payload.activatedWakeTransition ?? null,
            developmentalTransaction: event.payload.activatedDevelopmentalTransaction ?? null,
          })
          : null;
        for (const revision of event.payload.activatedRevisions) {
          const tool = validateToolModule(revision.tool);
          const current = state.tools.get(tool.id);
          if ((current ? toolModuleDigest(current) : null) !== revision.previousTool) throw new Error('tool revision ancestry mismatch');
          state.tools.set(tool.id, tool);
          state.toolHistory.set(toolModuleDigest(tool), tool);
        }
        if (digest(event.payload.activatedCarrierTransition) !== digest(state.stagedCarrierTransition)) {
          throw new Error('completed inference carrier activation does not match staged transition');
        }
        if (event.payload.activatedCarrierTransition) {
          state.carrier = applyCarrierTransition(state.carrier, event.payload.activatedCarrierTransition);
          inferencePolicyFromCarrier(state.carrier);
        }
        if (!Array.isArray(event.payload.activatedConsequenceTransitions)
          || event.payload.activatedConsequenceTransitions.length !== state.stagedConsequenceTransitions.length
          || event.payload.activatedConsequenceTransitions.some((transition, index) => digest(transition) !== digest(state.stagedConsequenceTransitions[index]))) {
          throw new Error('completed inference consequence activation does not match staged transitions');
        }
        for (const transition of event.payload.activatedConsequenceTransitions) {
          const consequence = state.consequences.get(transition.deltaId);
          if (!consequence) throw new Error(`completed inference cites unknown consequence: ${transition.deltaId}`);
          consequence.status = transition.action === 'defer' ? 'deferred' : 'settled';
          consequence.disposition = structuredClone(transition);
        }
        if (digest(event.payload.activatedWakeTransition ?? null) !== digest(state.stagedWakeTransition)) {
          throw new Error('completed inference wake activation does not match staged transition');
        }
        if (state.stagedWakeTransition
          && state.invocationHistory.get(state.stagedWakeTransition.invocationId)?.status !== 'completed') {
          throw new Error('completed inference cannot activate a wake from an incomplete invocation');
        }
        state.nextWake = state.stagedWakeTransition ? structuredClone(state.stagedWakeTransition) : null;
        if (digest(event.payload.activatedDevelopmentalTransaction ?? null)
          !== digest(state.stagedDevelopmentalTransaction)) {
          throw new Error('completed inference developmental transaction activation mismatch');
        }
        if (state.stagedDevelopmentalTransaction) {
          applyDevelopmentalTransaction(state, state.stagedDevelopmentalTransaction);
        }
        if (event.format === FORMAT) {
          if (digest(event.payload.activatedPosition ?? null) !== digest(expectedPosition)) {
            throw new Error('completed inference developmental position transition mismatch');
          }
          if (expectedPosition) state.position = expectedPosition;
        }
        if (state.activeEncounter.sounding.frontier !== undefined) {
          const projectedConsequenceIds = new Set([
            ...state.activeEncounter.sounding.deltas.filter(delta => delta.bearsOn?.length).map(delta => delta.id),
            ...state.activeEncounter.sounding.unresolvedConsequences.map(consequence => consequence.delta.id),
            ...state.activeEncounter.steeringDeltas.filter(delta => delta.bearsOn?.length).map(delta => delta.id),
          ]);
          state.consequenceSweepIds = state.consequenceSweepIds.filter(deltaId => {
            const consequence = state.consequences.get(deltaId);
            return consequence?.status !== 'settled' && !projectedConsequenceIds.has(deltaId);
          });
          if (state.consequenceSweepIds.length === 0 && state.pendingDeltas.length === 0) {
            state.consequenceSweepActive = false;
          }
        }
        state.messages.push(...structuredClone(event.payload.responseMessages));
        state.activeEncounter.status = 'completed';
        state.activeInferenceId = null;
        state.activeEncounter = null;
        state.stagedRevisions = [];
        state.stagedToolIds = new Set();
        state.stagedCarrierTransition = null;
        state.stagedConsequenceTransitions = [];
        state.stagedConsequenceIds = new Set();
        state.stagedWakeTransition = null;
        state.stagedDevelopmentalTransaction = null;
        state.selections = new Map();
        state.usedSelectionIds = new Set();
        state.recoveryMessages = [];
        state.activeInputMessage = null;
        state.activeTurnMessages = [];
        state.completedInferences += 1;
        break;
      }
      case 'inference_failed':
        if (state.activeInferenceId !== event.payload.inferenceId) throw new Error('failed inference is not active');
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        assertInferencePayloadFits(state, event.payload, 'inference failure');
        if (!Array.isArray(event.payload.checkpointMessages)) throw new Error('failed inference lacks checkpoint messages');
        state.messages.push(...structuredClone(event.payload.checkpointMessages));
        const runtimeFailure = {
          name: String(event.payload.error?.name ?? 'Error'),
          message: String(event.payload.error?.message ?? 'Unknown inference failure'),
        };
        const interruptionMessage = {
          role: 'user',
          content: `[inference_interrupted]\nThe previous inference ended unexpectedly after ${state.activeTurnMessages.length + event.payload.checkpointMessages.length} retained response and steering messages. Every world Delta delivered to that encounter has been returned to the next Sounding. Reorient from retained completed tool results rather than inventing missing output. This kernel-authored runtime diagnostic is not world consequence and does not interpret the failure:\n[music_runtime_failure]\n${canonical(runtimeFailure)}\n[/music_runtime_failure]\n[/inference_interrupted]`,
        };
        state.messages.push(interruptionMessage);
        state.recoveryMessages = [...structuredClone(state.activeTurnMessages), ...structuredClone(event.payload.checkpointMessages), interruptionMessage];
        state.pendingDeltas = requeueDeliveredDeltas(state.activeEncounter, state.pendingDeltas);
        if (state.activeEncounter.sounding.wake) {
          state.nextWake = restoreOpeningWake(state.activeEncounter.sounding.wake);
        }
        for (const [invocationId, invocation] of state.activeToolInvocations) {
          if (invocation.inferenceId === event.payload.inferenceId) {
            state.activeToolInvocations.delete(invocationId);
            state.invocationHistory.set(invocationId, { ...invocation, status: 'uncertain' });
          }
        }
        state.activeEncounter.status = 'interrupted';
        state.activeInferenceId = null;
        state.activeEncounter = null;
        state.stagedRevisions = [];
        state.stagedToolIds = new Set();
        state.stagedCarrierTransition = null;
        state.stagedConsequenceTransitions = [];
        state.stagedConsequenceIds = new Set();
        state.stagedWakeTransition = null;
        state.stagedDevelopmentalTransaction = null;
        state.selections = new Map();
        state.usedSelectionIds = new Set();
        state.activeInputMessage = null;
        state.activeTurnMessages = [];
        state.failedInferences += 1;
        break;
      default:
        throw new Error(`unknown Music event type: ${event.type}`);
    }
  }
  return state;
}

function developmentalSuccessorForCompletion(state, {
  revisions = [], carrierTransition = null, consequenceTransitions = [], wakeTransition = null,
  developmentalTransaction = null,
}) {
  if (!state.position) return null;
  const admittedRevisions = developmentalTransaction
    ? developmentalTransaction.decisions
      .filter(decision => decision.disposition === 'admit' || decision.disposition === 'rollback')
      .map(decision => state.developmentalProposals.get(decision.proposalId)?.revision)
      .filter(Boolean)
    : [];
  const admittedCarrierTransitions = developmentalTransaction
    ? developmentalTransaction.decisions
      .filter(decision => decision.disposition === 'admit')
      .map(decision => state.developmentalProposals.get(decision.proposalId))
      .filter(proposal => proposal?.kind === 'carrier')
      .map(proposal => proposal.transition)
    : [];
  if (admittedCarrierTransitions.length > 1) throw new Error('one developmental transaction cannot admit multiple carrier successors');
  const changes = revisions.length + consequenceTransitions.length
    + admittedRevisions.length + admittedCarrierTransitions.length + (developmentalTransaction?.decisions.length ?? 0)
    + (carrierTransition ? 1 : 0) + (wakeTransition ? 1 : 0);
  if (changes === 0) return null;
  const tools = new Map(state.tools);
  for (const revision of [...revisions, ...admittedRevisions]) tools.set(revision.tool.id, revision.tool);
  let carrier = carrierTransition ? applyCarrierTransition(state.carrier, carrierTransition) : state.carrier;
  if (admittedCarrierTransitions[0]) carrier = applyCarrierTransition(carrier, admittedCarrierTransitions[0]);
  const opening = wakeTransition
    ? openingFromWake(wakeTransition, state.position.activeOpening)
    : undefined;
  return createDevelopmentalSuccessor(state.position, {
    tools,
    carrier,
    carrierTransition: admittedCarrierTransitions[0] ?? carrierTransition,
    consequenceTransitions,
    standingTransitions: [
      ...consequenceTransitions.map(transition => ({ kind: 'consequence', transition })),
      ...(developmentalTransaction?.decisions ?? []).map(decision => ({ kind: 'proposal', decision })),
    ],
    opening,
  });
}

function developmentalStandingSuccessor(state, transition) {
  if (!state.position) return null;
  return createDevelopmentalSuccessor(state.position, {
    tools: state.tools,
    carrier: state.carrier,
    standingTransitions: [transition],
  });
}

function validateDevelopmentalDecisions(value, state) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error('developmental transaction needs 1-32 decisions');
  }
  const seen = new Set();
  return value.map(raw => {
    const proposalId = typeof raw?.proposalId === 'string' ? raw.proposalId.trim() : '';
    if (!proposalId || seen.has(proposalId)) throw new Error('developmental decisions need distinct known proposal ids');
    seen.add(proposalId);
    const proposal = state.developmentalProposals.get(proposalId);
    if (!proposal) throw new Error(`unknown developmental proposal: ${proposalId}`);
    const disposition = raw.disposition;
    if (!DEVELOPMENTAL_DISPOSITIONS.has(disposition)) throw new Error(`invalid developmental disposition: ${disposition}`);
    if ((disposition === 'admit' || disposition === 'rollback')
      && !proposal.trials.some(trial => trial.status === 'completed')) {
      throw new Error(`developmental proposal ${proposalId} must be exercised before ${disposition}`);
    }
    if (disposition === 'rollback' && (proposal.kind !== 'tool' || proposal.revision.rollbackOf === null)) {
      throw new Error(`developmental proposal ${proposalId} is not a rollback proposal`);
    }
    if (['admitted', 'denied', 'retired'].includes(proposal.status)) {
      throw new Error(`developmental proposal ${proposalId} is already ${proposal.status}`);
    }
    const interpretation = typeof raw.interpretation === 'string' ? raw.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('developmental decision needs a bounded interpretation');
    return { proposalId, disposition, interpretation };
  });
}

function applyDevelopmentalTransaction(state, transaction) {
  for (const decision of transaction.decisions) {
    const proposal = state.developmentalProposals.get(decision.proposalId);
    if (!proposal) throw new Error(`developmental transaction cites unknown proposal: ${decision.proposalId}`);
    if (decision.disposition === 'admit' || decision.disposition === 'rollback') {
      if (proposal.kind === 'tool') {
        const tool = validateToolModule(proposal.revision.tool);
        const current = state.tools.get(tool.id);
        if ((current ? toolModuleDigest(current) : null) !== proposal.revision.previousTool) {
          throw new Error(`developmental proposal ${decision.proposalId} no longer succeeds active tool geometry`);
        }
        state.tools.set(tool.id, tool);
        state.toolHistory.set(toolModuleDigest(tool), tool);
      } else {
        if (decision.disposition === 'rollback') throw new Error('carrier proposals do not use rollback disposition');
        state.carrier = applyCarrierTransition(state.carrier, proposal.transition);
        inferencePolicyFromCarrier(state.carrier);
      }
      proposal.status = decision.disposition === 'rollback' ? 'rolled-back' : 'admitted';
    } else {
      proposal.status = decision.disposition === 'deny' ? 'denied'
        : (decision.disposition === 'defer' ? 'deferred'
          : (decision.disposition === 'contradict' ? 'contradicted' : 'retired'));
    }
    proposal.standing.push({
      transactionId: transaction.transactionId,
      disposition: decision.disposition,
      interpretation: decision.interpretation,
    });
  }
}

function projectDevelopmentalProposal(proposal, includeSource) {
  const base = {
    proposalId: proposal.proposalId,
    kind: proposal.kind,
    authoredAt: proposal.authoredAt,
    status: proposal.status,
    trials: structuredClone(proposal.trials),
    standing: structuredClone(proposal.standing),
  };
  if (proposal.kind === 'tool') {
    const revision = proposal.revision;
    return {
      ...base,
      interpretation: revision.interpretation,
      evidence: structuredClone(revision.evidence),
      consequences: structuredClone(revision.consequences),
      tool: includeSource
        ? structuredClone(revision.tool)
        : { id: revision.tool.id, version: revision.tool.version, digest: toolModuleDigest(revision.tool) },
    };
  }
  return {
    ...base,
    interpretation: proposal.transition.interpretation,
    evidence: structuredClone(proposal.transition.evidence),
    consequences: structuredClone(proposal.transition.consequences),
    carrier: {
      componentId: proposal.transition.component.id,
      parentRoot: proposal.transition.parentRoot,
      successorRoot: proposal.transition.successorRoot,
      ...(includeSource ? { component: structuredClone(proposal.transition.component) } : {}),
    },
  };
}

function verifyChain(events) {
  let parent = null;
  const format = events[0]?.format ?? FORMAT;
  if (!READABLE_FORMATS.has(format)) throw new Error(`unsupported Music event format: ${format}`);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.format !== format || event.sequence !== index || event.parent !== parent) {
      throw new Error(`broken event ancestry at ledger line ${index + 1}`);
    }
    const { hash, ...unsigned } = event;
    if (hash !== digest(unsigned)) throw new Error(`event digest mismatch at ledger line ${index + 1}`);
    parent = hash;
  }
}

function parseLedgerText(text) {
  if (text.length === 0) return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.length === 0) return [];
  const lines = body.split('\n');
  const events = lines.map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`invalid JSON at ledger line ${index + 1}`); }
  });
  verifyChain(events);
  return events;
}

function writeAll(descriptor, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written < 1) throw new Error('ledger write made no progress');
    offset += written;
  }
}

function boundedWriterLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 256) throw new Error('writer label must be 1-256 characters');
  return label;
}

function readWriterLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || value.format !== WRITER_FORMAT || typeof value.token !== 'string'
      || !Number.isInteger(value.pid) || typeof value.host !== 'string'
      || typeof value.label !== 'string' || typeof value.at !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function writerIsAlive(owner) {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function releaseWriterLock(path, lease) {
  const owner = readWriterLock(path);
  if (!owner) throw new Error('Music writer lease disappeared before release');
  if (owner.token !== lease.token) throw new Error('Music writer lease ownership changed before release');
  unlinkSync(path);
}

function validateLedgerRecoveryReceipt(receipt) {
  if (!receipt || !['newline-restored', 'torn-tail-removed'].includes(receipt.kind)
    || !Number.isInteger(receipt.bytes) || receipt.bytes < 0
    || typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || (receipt.backupPath !== undefined && (typeof receipt.backupPath !== 'string' || !receipt.backupPath))) {
    throw new Error('invalid ledger tail recovery receipt');
  }
  if ((receipt.kind === 'torn-tail-removed') !== (receipt.backupPath !== undefined)) {
    throw new Error('ledger tail recovery backup binding mismatch');
  }
}

function validateRuntimeProvenance(value, eventFormat) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format !== 'music-runtime-1'
    || value.eventFormat !== eventFormat
    || !['resident', 'single-run'].includes(value.mode)
    || typeof value.release?.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.release.commit)
    || typeof value.release?.version !== 'string' || !value.release.version.trim() || value.release.version.length > 128
    || typeof value.release?.workingTreeClean !== 'boolean'
    || typeof value.release?.workingTreeStateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.release.workingTreeStateSha256)
    || typeof value.release?.root !== 'string' || !value.release.root
    || typeof value.home !== 'string' || !value.home
    || typeof value.process?.node !== 'string' || !value.process.node
    || typeof value.process?.platform !== 'string' || !value.process.platform
    || typeof value.process?.arch !== 'string' || !value.process.arch) {
    throw new Error('invalid resident runtime provenance');
  }
  return structuredClone(value);
}

function validateDelta(delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('Delta must be an object');
  if (delta.authority !== 'world') throw new Error('Delta must have world authority');
  if (typeof delta.id !== 'string' || !delta.id.trim() || delta.id.length > 128) throw new Error('Delta needs a bounded id');
  if (typeof delta.stream !== 'string' || !delta.stream.trim() || delta.stream.length > 128) throw new Error('Delta needs a bounded stream');
  if (typeof delta.at !== 'string' || Number.isNaN(Date.parse(delta.at))) throw new Error('Delta needs an ISO timestamp');
  if (delta.bearsOn !== undefined) {
    if (!Array.isArray(delta.bearsOn) || delta.bearsOn.length < 1 || delta.bearsOn.length > 32) {
      throw new Error('Delta bearsOn must contain 1-32 invocation references');
    }
    const invocationIds = new Set();
    for (const reference of delta.bearsOn) {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)
        || reference.kind !== 'tool-invocation'
        || typeof reference.invocationId !== 'string' || !reference.invocationId.trim() || reference.invocationId.length > 128
        || Object.keys(reference).some(key => !['kind', 'invocationId'].includes(key))) {
        throw new Error('invalid Delta invocation reference');
      }
      if (invocationIds.has(reference.invocationId)) throw new Error(`Delta repeats invocation reference: ${reference.invocationId}`);
      invocationIds.add(reference.invocationId);
    }
  }
  if (Buffer.byteLength(canonical(delta)) > MAX_DELTA_BYTES) throw new Error(`Delta exceeds ${MAX_DELTA_BYTES} bytes`);
}

function validateConsequenceReferences(delta, state) {
  for (const reference of delta.bearsOn ?? []) {
    if (!state.invocationIds.has(reference.invocationId)) {
      throw new Error(`Delta cites unknown tool invocation: ${reference.invocationId}`);
    }
  }
}

function countInvocationStatus(state, status) {
  return [...state.invocationHistory.values()].filter(invocation => invocation.status === status).length;
}

function assertInferencePayloadFits(state, payload, label) {
  if (!state.activeEncounter) throw new Error(`${label} requires an active encounter`);
  const maximum = inferencePolicyFromProjection(state.activeEncounter.sounding.carrier).maxInferenceEventBytes;
  const bytes = Buffer.byteLength(canonical(payload));
  if (bytes > maximum) throw new Error(`${label} exceeds active inference policy limit ${maximum} bytes (received ${bytes})`);
}

function boundedEvidence(evidence) {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence) || evidence.length > 32 || evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)) {
    throw new Error('revision evidence must be at most 32 bounded references');
  }
  return [...evidence];
}

function retainConsequenceEvidence(deltaIds, encounter) {
  if (deltaIds === undefined) return [];
  if (!Array.isArray(deltaIds) || deltaIds.length > 32
    || deltaIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)
    || new Set(deltaIds).size !== deltaIds.length) {
    throw new Error('consequenceDeltaIds must contain at most 32 unique bounded ids');
  }
  const delivered = deliveredConsequences(encounter);
  return deltaIds.map(deltaId => {
    const delta = delivered.get(deltaId);
    if (!delta) throw new Error(`consequence Delta was not delivered in this Sounding: ${deltaId}`);
    if (!delta.bearsOn?.length) throw new Error(`Delta does not bear on a tool invocation: ${deltaId}`);
    return {
      deltaId,
      invocationIds: delta.bearsOn.map(reference => reference.invocationId),
    };
  });
}

function deliveredConsequences(encounter) {
  return new Map([
    ...encounter.sounding.deltas
      .filter(delta => delta.bearsOn?.length)
      .map(delta => [delta.id, delta]),
    ...(encounter.sounding.unresolvedConsequences ?? [])
      .map(consequence => [consequence.delta.id, consequence.delta]),
    ...(encounter.steeringDeltas ?? [])
      .filter(delta => delta.bearsOn?.length)
      .map(delta => [delta.id, delta]),
  ]);
}

function projectOpeningWake(nextWake, trigger, soundingAt) {
  if (!nextWake) {
    if (trigger === 'scheduled') throw new Error('scheduled Sounding requires an active future wake');
    return null;
  }
  if (trigger === 'scheduled' && Date.parse(soundingAt) < Date.parse(nextWake.wakeAt)) {
    throw new Error(`future wake is not due until ${nextWake.wakeAt}`);
  }
  return {
    ...structuredClone(nextWake),
    opening: trigger === 'scheduled' ? 'due' : 'preempted',
  };
}

function validateOpeningWake(openingWake, nextWake, trigger, soundingAt) {
  const expected = projectOpeningWake(nextWake, trigger, soundingAt);
  if (digest(openingWake) !== digest(expected)) throw new Error('Sounding future-wake binding mismatch');
}

function restoreOpeningWake(openingWake) {
  const restored = structuredClone(openingWake);
  delete restored.opening;
  return validateWakeTransition(restored);
}

function validateWakeTransition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.wakeId !== 'string' || !value.wakeId
    || typeof value.inferenceId !== 'string' || !value.inferenceId
    || typeof value.soundingId !== 'string' || !value.soundingId
    || typeof value.projection !== 'string' || !/^[a-f0-9]{64}$/.test(value.projection)
    || typeof value.invocationId !== 'string' || !value.invocationId
    || !value.tool || typeof value.tool.id !== 'string' || !value.tool.id
    || !Number.isInteger(value.tool.version) || value.tool.version < 1
    || typeof value.tool.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.tool.digest)
    || typeof value.stagedAt !== 'string' || Number.isNaN(Date.parse(value.stagedAt))
    || !Number.isSafeInteger(value.afterMs) || value.afterMs < 1_000
    || typeof value.wakeAt !== 'string' || Number.isNaN(Date.parse(value.wakeAt))
    || Date.parse(value.wakeAt) !== Date.parse(value.stagedAt) + value.afterMs
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2_048) {
    throw new Error('invalid retained future wake');
  }
  return structuredClone(value);
}

function planSoundingSurface(state, base) {
  const pending = state.pendingDeltas;
  const sweep = currentConsequenceSweep(state);
  const binding = state.tools.get(ENCOUNTER_SHAPE_TOOL_ID);
  if (!binding) throw new Error(`active geometry lacks ${ENCOUNTER_SHAPE_TOOL_ID}`);
  let deltas = [];
  let unresolvedConsequences = [];
  let pendingBlocked = false;
  let consequenceBlocked = false;

  const candidate = (nextDeltas = deltas, nextConsequences = unresolvedConsequences) => ({
    deltas: structuredClone(nextDeltas),
    unresolvedConsequences: structuredClone(nextConsequences),
    frontier: buildSoundingFrontier(pending, nextDeltas, sweep, nextConsequences),
  });
  const fits = surface => projectionInputFits(
    soundingProjectionInput({ ...base, ...surface }),
    { manifest: binding },
    MAX_PROJECTION_BYTES,
  );
  if (!fits(candidate())) throw new Error('active geometry cannot form a bounded Sounding');

  while (true) {
    let progressed = false;
    if (!pendingBlocked && deltas.length < pending.length) {
      const next = candidate([...deltas, pending[deltas.length]], unresolvedConsequences);
      if (soundingProjectionInput({ ...base, ...next }).facts.length <= MAX_PROJECTION_FACTS && fits(next)) {
        deltas = next.deltas;
        progressed = true;
      } else {
        pendingBlocked = true;
      }
    }
    if (!consequenceBlocked && unresolvedConsequences.length < sweep.length) {
      const next = candidate(deltas, [...unresolvedConsequences, sweep[unresolvedConsequences.length]]);
      if (soundingProjectionInput({ ...base, ...next }).facts.length <= MAX_PROJECTION_FACTS && fits(next)) {
        unresolvedConsequences = next.unresolvedConsequences;
        progressed = true;
      } else {
        consequenceBlocked = true;
      }
    }
    if (!progressed) break;
  }
  return {
    sounding: candidate(),
    sweepIds: sweep.map(consequence => consequence.delta.id),
  };
}

function planSteeringSurface(state, encounter) {
  const pending = state.pendingDeltas;
  const binding = encounter.toolBindings.get(ENCOUNTER_SHAPE_TOOL_ID);
  if (!binding) throw new Error(`Sounding ${encounter.sounding.id} lacks ${ENCOUNTER_SHAPE_TOOL_ID}`);
  let deltas = [];
  for (const delta of pending) {
    const next = [...deltas, delta];
    const frontier = buildSteeringFrontier(pending, next);
    const input = steeringProjectionInput(encounter, next, frontier);
    if (input.facts.length > MAX_PROJECTION_FACTS || !projectionInputFits(input, binding, MAX_PROJECTION_BYTES)) break;
    deltas = next;
  }
  if (pending.length > 0 && deltas.length === 0) {
    throw new Error('one valid pending Delta cannot form a bounded steering projection');
  }
  return { deltas: structuredClone(deltas), frontier: buildSteeringFrontier(pending, deltas) };
}

function currentConsequenceSweep(state) {
  const available = projectUnresolvedConsequences(state);
  if (!state.consequenceSweepActive) return available;
  const byId = new Map(available.map(consequence => [consequence.delta.id, consequence]));
  return state.consequenceSweepIds.map(deltaId => byId.get(deltaId)).filter(Boolean);
}

function buildSoundingFrontier(pending, deltas, sweep, unresolvedConsequences) {
  const pendingRemainder = pending.slice(deltas.length);
  const consequenceRemainder = sweep.slice(unresolvedConsequences.length);
  return {
    format: 'music-sounding-frontier-1',
    pending: frontierLane(pending, deltas.length, pendingRemainder, item => item.id),
    consequences: frontierLane(sweep, unresolvedConsequences.length, consequenceRemainder, item => item.delta.id),
  };
}

function buildSteeringFrontier(pending, deltas) {
  return {
    format: 'music-steering-frontier-1',
    pending: frontierLane(pending, deltas.length, pending.slice(deltas.length), item => item.id),
  };
}

function frontierLane(available, included, remainder, idOf) {
  return {
    available: available.length,
    included,
    remaining: remainder.length,
    queueDigest: digest(available),
    remainderDigest: digest(remainder),
    nextId: remainder.length === 0 ? null : idOf(remainder[0]),
  };
}

function soundingProjectionInput(sounding) {
  return {
    phase: 'sounding',
    trigger: sounding.trigger,
    soundingId: sounding.id,
    facts: [
      projectionFact('sounding:meta', { id: sounding.id, parent: sounding.parent, at: sounding.at, trigger: sounding.trigger }),
      projectionFact('sounding:subject', sounding.subject),
      projectionFact('sounding:tools', sounding.tools),
      projectionFact('sounding:carrier', sounding.carrier),
      ...(sounding.position ? [projectionFact('sounding:position', sounding.position)] : []),
      projectionFact('sounding:frontier', sounding.frontier),
      ...(sounding.wake ? [projectionFact('sounding:wake', sounding.wake)] : []),
      ...sounding.deltas.map(delta => projectionFact(`delta:${delta.id}`, delta)),
      ...sounding.unresolvedConsequences.map(consequence => projectionFact(`unresolved:${consequence.delta.id}`, consequence)),
    ],
  };
}

function steeringProjectionInput(encounter, deltas, frontier) {
  return {
    phase: 'steering',
    trigger: encounter.sounding.trigger,
    soundingId: encounter.sounding.id,
    facts: [
      projectionFact('steering:meta', { soundingId: encounter.sounding.id, projection: encounter.projection }),
      projectionFact('steering:frontier', frontier),
      ...deltas.map(delta => projectionFact(`delta:${delta.id}`, delta)),
    ],
  };
}

function projectionInputFits(input, binding, maximum) {
  if (input.facts.length > MAX_PROJECTION_FACTS) return false;
  return Buffer.byteLength(canonical(deliveryRecoveryMessage(
    input,
    binding,
    'x'.repeat(MAX_DELIVERY_FAILURE_MESSAGE_BYTES),
  ))) <= maximum;
}

function assertProspectiveGeometryFits(state, { tool = null, carrierTransition = null } = {}) {
  const tools = new Map(state.tools);
  for (const revision of state.stagedRevisions) tools.set(revision.tool.id, revision.tool);
  if (tool) tools.set(tool.id, tool);
  let carrier = state.carrier;
  if (state.stagedCarrierTransition) carrier = applyCarrierTransition(carrier, state.stagedCarrierTransition);
  if (carrierTransition) carrier = applyCarrierTransition(carrier, carrierTransition);
  assertActiveGeometryFits(tools, carrier, state.subject, state.position);
}

function assertActiveGeometryFits(tools, carrier, subject, position = null) {
  inferencePolicyFromCarrier(carrier);
  const binding = tools.get(ENCOUNTER_SHAPE_TOOL_ID);
  if (!binding) throw new Error(`active geometry requires ${ENCOUNTER_SHAPE_TOOL_ID}`);
  const sounding = {
    id: 'active-surface-capacity-check',
    subject: structuredClone(subject),
    parent: '0'.repeat(64),
    at: '9999-12-31T23:59:59.999Z',
    trigger: 'manual',
    tools: [...tools.values()].sort((a, b) => a.id.localeCompare(b.id)).map(projectTool),
    carrier: projectCarrier(carrier),
    ...(position ? { position: projectDevelopmentalPosition(position) } : {}),
    wake: null,
    deltas: [],
    unresolvedConsequences: [],
    frontier: buildSoundingFrontier([], [], [], []),
  };
  const input = soundingProjectionInput(sounding);
  if (!projectionInputFits(input, { manifest: binding }, MAX_ACTIVE_SURFACE_BYTES)) {
    throw new Error(`active tool, carrier, and position geometry exceeds ${MAX_ACTIVE_SURFACE_BYTES} bytes`);
  }
}

function projectionInput(state, encounter, phase, deltaIds) {
  if (!['sounding', 'steering'].includes(phase)) throw new Error('delivery projection phase must be sounding or steering');
  const sounding = encounter.sounding;
  if (phase === 'sounding') {
    if (encounter.status !== 'opened') throw new Error('initial delivery projection requires an opened Sounding');
    if (deltaIds !== undefined && (!Array.isArray(deltaIds) || deltaIds.length !== 0)) {
      throw new Error('initial delivery projection does not accept steering Delta ids');
    }
    if (sounding.frontier === undefined) {
      return {
        phase,
        trigger: sounding.trigger,
        soundingId: sounding.id,
        facts: [
          projectionFact('sounding:meta', { id: sounding.id, parent: sounding.parent, at: sounding.at, trigger: sounding.trigger }),
          projectionFact('sounding:subject', sounding.subject),
          projectionFact('sounding:tools', sounding.tools),
          projectionFact('sounding:carrier', sounding.carrier),
          ...(sounding.position ? [projectionFact('sounding:position', sounding.position)] : []),
          ...sounding.deltas.map(delta => projectionFact(`delta:${delta.id}`, delta)),
          ...sounding.unresolvedConsequences.map(consequence => projectionFact(`unresolved:${consequence.delta.id}`, consequence)),
        ],
      };
    }
    return soundingProjectionInput(sounding);
  }
  if (state.activeEncounter !== encounter || state.activeInferenceId === null) {
    throw new Error('steering delivery projection requires the active encounter');
  }
  const planned = planSteeringSurface(state, encounter);
  if (digest(planned.deltas.map(delta => delta.id)) !== digest(deltaIds)) {
    throw new Error('steering delivery projection does not match bounded pending world contact');
  }
  return steeringProjectionInput(encounter, planned.deltas, planned.frontier);
}

function projectionFact(id, value) {
  const factDigest = digest(value);
  const encoded = canonical(value);
  return {
    id,
    digest: factDigest,
    envelope: `[music_fact id=${JSON.stringify(id)} digest=${factDigest}]\n${encoded}\n[/music_fact]`,
  };
}

function validateDeliveryProjectionStart(payload, state) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid delivery projection start');
  const encounter = state.soundings.get(payload.soundingId);
  if (!encounter) throw new Error('delivery projection cites unknown Sounding');
  if (payload.projection !== encounter.projection) throw new Error('delivery projection Sounding binding mismatch');
  if (payload.phase === 'sounding') {
    if (payload.inferenceId !== null) throw new Error('initial delivery projection cannot cite an inference');
  } else if (payload.phase === 'steering') {
    if (payload.inferenceId !== state.activeInferenceId) throw new Error('steering delivery projection inference mismatch');
  }
  const input = projectionInput(state, encounter, payload.phase, payload.deltaIds);
  if (payload.inputDigest !== digest(input)) throw new Error('delivery projection input digest mismatch');
  if (digest(payload.factDigests) !== digest(input.facts.map(fact => ({ id: fact.id, digest: fact.digest })))) {
    throw new Error('delivery projection fact binding mismatch');
  }
  const binding = encounter.toolBindings.get(ENCOUNTER_SHAPE_TOOL_ID);
  if (!binding || payload.tool?.id !== ENCOUNTER_SHAPE_TOOL_ID
    || payload.tool.version !== binding.manifest.version || payload.tool.digest !== binding.digest) {
    throw new Error('delivery projection tool binding mismatch');
  }
  if (typeof payload.projectionId !== 'string' || !payload.projectionId) throw new Error('delivery projection needs an id');
  return {
    projectionId: payload.projectionId,
    soundingId: payload.soundingId,
    inferenceId: payload.inferenceId,
    projection: payload.projection,
    phase: payload.phase,
    deltaIds: [...payload.deltaIds],
    tool: structuredClone(payload.tool),
    input,
  };
}

function validateProjectionMessage(value, input) {
  const message = jsonValue(value, 'delivery projection message');
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || message.role !== 'user' || typeof message.content !== 'string' || !message.content
    || Object.keys(message).some(key => !['role', 'content'].includes(key))) {
    throw new Error('delivery projection must produce one nonempty user text message');
  }
  for (const fact of input.facts) {
    if (!message.content.includes(fact.envelope)) throw new Error(`delivery projection omitted required fact: ${fact.id}`);
  }
  if (Buffer.byteLength(canonical(message)) > MAX_PROJECTION_BYTES) throw new Error(`delivery projection exceeds ${MAX_PROJECTION_BYTES} bytes`);
  return message;
}

function emergencyProjection(input, binding, reason) {
  return validateProjectionMessage(deliveryRecoveryMessage(input, binding, reason), input);
}

function deliveryRecoveryMessage(input, binding, reason) {
  return {
    role: 'user',
    content: `[delivery_recovery]\nThe retained ${binding.manifest.id}@${binding.manifest.version} delivery module failed validation or execution: ${reason}\nExact required facts follow so the continuing subject can inspect or roll back its delivery machinery.\n[/delivery_recovery]\n${input.facts.map(fact => fact.envelope).join('\n')}`,
  };
}

function deliveryProjectionErrorRecord(error) {
  const record = errorRecord(error);
  return {
    name: record.name.slice(0, 256),
    message: record.message.slice(0, 2_048),
    ...(record.stack === undefined ? {} : { stack: record.stack.slice(0, 16_384) }),
  };
}

function consumeDeliveryProjection(state, projectionId, expected) {
  if (projectionId === null) return;
  if (typeof projectionId !== 'string' || state.usedDeliveryProjectionIds.has(projectionId)) {
    throw new Error('delivery projection receipt is invalid or already used');
  }
  const projection = state.deliveryProjections.get(projectionId);
  if (!projection || !['completed', 'recovery'].includes(projection.status)
    || projection.phase !== expected.phase || projection.soundingId !== expected.soundingId
    || projection.projection !== expected.projection || digest(projection.deltaIds) !== digest(expected.deltaIds)
    || digest(projection.message) !== digest(expected.message)) {
    throw new Error('delivery projection receipt does not match encounter input');
  }
  state.usedDeliveryProjectionIds.add(projectionId);
}

function matchesPendingPrefix(pendingDeltas, deltaIds) {
  if (!Array.isArray(deltaIds) || deltaIds.length === 0 || deltaIds.length > pendingDeltas.length) return false;
  return deltaIds.every((id, index) => id === pendingDeltas[index].id);
}

function requeueDeliveredDeltas(encounter, pendingDeltas) {
  const pendingIds = new Set(pendingDeltas.map(delta => delta.id));
  const delivered = [...encounter.sounding.deltas, ...(encounter.steeringDeltas ?? [])]
    .filter(delta => !pendingIds.has(delta.id));
  return [...structuredClone(delivered), ...structuredClone(pendingDeltas)];
}

function validateSteeringMessage(value) {
  const message = jsonValue(value, 'steering input message');
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || message.role !== 'user' || typeof message.content !== 'string' || !message.content) {
    throw new Error('steering input message must be a nonempty user text message');
  }
  return message;
}

function validateConsequenceTransition(proposal, state, encounter) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('consequence transition must be an object');
  }
  const deltaId = typeof proposal.deltaId === 'string' ? proposal.deltaId.trim() : '';
  if (!deltaId || deltaId.length > 128) throw new Error('consequence transition needs a bounded Delta id');
  if (!['defer', 'settle'].includes(proposal.action)) throw new Error('consequence transition action must be defer or settle');
  const interpretation = typeof proposal.interpretation === 'string' ? proposal.interpretation.trim() : '';
  if (!interpretation || interpretation.length > 4_096) throw new Error('consequence transition needs a bounded interpretation');
  const consequence = state.consequences.get(deltaId);
  if (!consequence || consequence.status === 'settled') throw new Error(`consequence is not unresolved: ${deltaId}`);
  const delivered = deliveredConsequences(encounter).get(deltaId);
  if (!delivered || digest(delivered) !== digest(consequence.delta)) {
    throw new Error(`unresolved consequence was not delivered in this Sounding: ${deltaId}`);
  }
  const priorStatus = proposal.priorStatus ?? consequence.status;
  if (priorStatus !== consequence.status) throw new Error(`consequence prior status mismatch: ${deltaId}`);
  return {
    deltaId,
    action: proposal.action,
    priorStatus,
    interpretation,
    evidence: boundedEvidence(proposal.evidence),
    invocationIds: consequence.delta.bearsOn.map(reference => reference.invocationId),
  };
}

function validateRetainedConsequences(consequences, encounter) {
  if (!Array.isArray(consequences)) throw new Error('staged change lacks consequence lineage');
  const expected = retainConsequenceEvidence(consequences.map(consequence => consequence?.deltaId), encounter);
  if (digest(expected) !== digest(consequences)) throw new Error('staged consequence lineage does not match delivered Deltas');
  return expected;
}

function requireActiveEncounter(state, inferenceId, soundingId, projection = undefined) {
  if (state.activeInferenceId !== inferenceId || !state.activeEncounter) {
    throw new Error(`inference is not active: ${inferenceId}`);
  }
  if (state.activeEncounter.sounding.id !== soundingId) throw new Error('active inference is bound to another Sounding');
  if (projection !== undefined && state.activeEncounter.projection !== projection) throw new Error('active inference projection binding mismatch');
  return state.activeEncounter;
}

function bindProjectedTools(activeTools, projectedTools) {
  if (!Array.isArray(projectedTools) || activeTools.size !== projectedTools.length) throw new Error('Sounding tools do not match active geometry');
  const projected = new Map(projectedTools.map(tool => [tool.id, tool]));
  const result = new Map();
  for (const [id, active] of activeTools) {
    const manifest = validateToolModule(active);
    const manifestHash = toolModuleDigest(manifest);
    const projection = projected.get(id);
    if (!projection || projection.digest !== manifestHash || projection.version !== manifest.version) {
      throw new Error(`Sounding tool binding mismatch: ${id}`);
    }
    result.set(id, { digest: manifestHash, manifest });
  }
  return result;
}

function validateStagedRevision(payload, state) {
  const tool = validateToolModule(payload.tool);
  if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
  const current = state.tools.get(tool.id);
  const previousTool = current ? toolModuleDigest(current) : null;
  if (payload.previousTool !== previousTool) throw new Error('staged tool revision ancestry mismatch');
  if (current && (tool.version !== current.version + 1 || tool.parent !== previousTool)) {
    throw new Error('staged tool revision does not succeed the active geometry');
  }
  if (!current && (tool.version !== 1 || tool.parent !== null)) throw new Error('staged new tool has invalid ancestry');
  const rollbackOf = payload.rollbackOf ?? null;
  if (rollbackOf !== null) {
    const target = state.toolHistory.get(rollbackOf);
    if (!target || target.id !== tool.id) throw new Error('staged rollback cites unknown tool history');
    if (digest(projectToolBody(target)) !== digest(projectToolBody(tool))) throw new Error('staged rollback does not restore cited executable body');
  }
  const interpretation = typeof payload.interpretation === 'string' ? payload.interpretation.trim() : '';
  if (!interpretation || interpretation.length > 4_096) throw new Error('staged revision needs a bounded interpretation');
  return {
    inferenceId: payload.inferenceId,
    soundingId: payload.soundingId,
    projection: payload.projection,
    interpretation,
    evidence: boundedEvidence(payload.evidence),
    consequences: validateRetainedConsequences(payload.consequences, state.activeEncounter),
    previousTool,
    tool,
    rollbackOf,
  };
}

function validateInitialTools(tools) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > MAX_TOOLS) {
    throw new Error(`initial tools must contain 1-${MAX_TOOLS} ordinary modules`);
  }
  const ids = new Set();
  return tools.map(candidate => {
    const tool = validateToolModule(candidate);
    if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
    if (ids.has(tool.id)) throw new Error(`duplicate initial tool id: ${tool.id}`);
    ids.add(tool.id);
    return tool;
  });
}

function projectCarrierTransition(payload, encounter) {
  const interpretation = typeof payload.interpretation === 'string' ? payload.interpretation.trim() : '';
  if (!interpretation || interpretation.length > 4_096) throw new Error('staged carrier transition needs a bounded interpretation');
  return {
    interpretation,
    evidence: boundedEvidence(payload.evidence),
    consequences: validateRetainedConsequences(payload.consequences, encounter),
    component: structuredClone(payload.component),
    parentRoot: payload.parentRoot,
    parentRuleDigest: payload.parentRuleDigest,
    parentStateDigest: payload.parentStateDigest,
    successorRoot: payload.successorRoot,
    successorRuleDigest: payload.successorRuleDigest,
    successorStateDigest: payload.successorStateDigest,
  };
}

function validateSelectionFrontier(manifest, frontier) {
  if (!manifest.selection) throw new Error(`tool ${manifest.id} does not admit selection`);
  if (!frontier || typeof frontier !== 'object' || Array.isArray(frontier)) throw new Error('selection frontier must be an object');
  if (!Array.isArray(frontier.candidates) || frontier.candidates.length < 1 || frontier.candidates.length > MAX_SELECTION_CANDIDATES) {
    throw new Error(`selection frontier needs 1-${MAX_SELECTION_CANDIDATES} candidates`);
  }
  if (Buffer.byteLength(canonical(frontier.candidates)) > MAX_SELECTION_BYTES) throw new Error(`selection frontier exceeds ${MAX_SELECTION_BYTES} bytes`);
  const ids = new Set();
  const values = new Set();
  const discriminator = manifest.selection.discriminator;
  const candidates = frontier.candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('selection candidate must be an object');
    if (typeof candidate.id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(candidate.id)) throw new Error('invalid selection candidate id');
    if (ids.has(candidate.id)) throw new Error(`duplicate selection candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    const input = jsonValue(candidate.input, 'selection candidate input');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('selection candidate input must be an object');
    const value = input[discriminator];
    if (typeof value !== 'string' || !manifest.selection.values.includes(value)) {
      throw new Error(`selection candidate needs a supported ${discriminator}`);
    }
    if (values.has(value)) throw new Error(`selection frontier repeats ${discriminator}: ${value}`);
    values.add(value);
    return { id: candidate.id, input };
  });
  const required = new Set(manifest.selection.values);
  if (values.size !== required.size || [...required].some(value => !values.has(value))) {
    throw new Error(`selection frontier must cover every ${manifest.id} ${discriminator} exactly once`);
  }
  if (typeof frontier.selectedCandidateId !== 'string' || !ids.has(frontier.selectedCandidateId)) {
    throw new Error('selected candidate is absent from selection frontier');
  }
  const selected = candidates.find(candidate => candidate.id === frontier.selectedCandidateId);
  return { candidates, selectedCandidateId: frontier.selectedCandidateId, selected };
}

function authorizeSelection(state, encounter, manifest, input, selectionReceipt) {
  if (!manifest.selection) {
    if (selectionReceipt !== null && selectionReceipt !== undefined) throw new Error(`tool ${manifest.id} does not accept a selection receipt`);
    return null;
  }
  if (typeof selectionReceipt !== 'string' || !selectionReceipt) throw new Error(`tool ${manifest.id} requires a selection receipt`);
  const selection = state.selections.get(selectionReceipt);
  if (!selection) throw new Error(`unknown selection receipt: ${selectionReceipt}`);
  if (state.usedSelectionIds.has(selectionReceipt)) throw new Error(`selection receipt already used: ${selectionReceipt}`);
  if (selection.inferenceId !== state.activeInferenceId
    || selection.soundingId !== encounter.sounding.id
    || selection.projection !== encounter.projection
    || selection.carrierRoot !== encounter.sounding.carrier.root
    || selection.tool.digest !== toolModuleDigest(manifest)) {
    throw new Error('selection receipt is not bound to the active encounter geometry');
  }
  if (canonical(selection.selected.input) !== canonical(input)) {
    throw new Error('tool invocation does not match the selected candidate');
  }
  return selection;
}

function projectTool(tool) {
  return {
    id: tool.id,
    version: tool.version,
    digest: toolModuleDigest(tool),
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.selection === undefined ? {} : { selection: structuredClone(tool.selection) }),
  };
}

function projectUnresolvedConsequences(state) {
  const pendingIds = new Set(state.pendingDeltas.map(delta => delta.id));
  return [...state.consequences.values()]
    .filter(consequence => consequence.status !== 'settled' && !pendingIds.has(consequence.delta.id))
    .sort((left, right) => left.delta.at.localeCompare(right.delta.at) || left.delta.id.localeCompare(right.delta.id))
    .map(projectConsequence);
}

function projectConsequence(consequence) {
  return {
    delta: structuredClone(consequence.delta),
    status: consequence.status,
    ...(consequence.disposition === null ? {} : {
      disposition: {
        action: consequence.disposition.action,
        interpretation: consequence.disposition.interpretation,
        evidence: structuredClone(consequence.disposition.evidence),
      },
    }),
  };
}

function projectToolBody(tool) {
  return {
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    source: tool.source,
    ...(tool.selection === undefined ? {} : { selection: structuredClone(tool.selection) }),
  };
}

function requireSubject(state) {
  if (!state.subject) throw new Error('Music subject has not been initialized');
}

function jsonValue(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (encoded === undefined) throw new Error(`${label} is not a JSON value`);
  return JSON.parse(encoded);
}

function errorRecord(error) {
  if (error instanceof Error) {
    return {
      name: String(error.name).slice(0, 256),
      message: String(error.message).slice(0, 4_096),
      ...(error.stack === undefined ? {} : { stack: String(error.stack).slice(0, 16_384) }),
    };
  }
  return { name: 'Error', message: String(error).slice(0, 4_096) };
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}
