import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from './canonical.js';
import { applyCarrierTransition, createCarrierTransition, initialCarrier, projectCarrier, readCarrier, serializeCarrier } from './carrier.js';
import { inferencePolicyFromCarrier, inferencePolicyFromProjection } from './inference-policy.js';
import { executeToolModule, toolModuleDigest, validateToolModule } from './tool-module.js';
import {
  createDevelopmentalOpening, createDevelopmentalSuccessor, initialDevelopmentalPosition, openingFromWake,
  projectDevelopmentalPosition, readDevelopmentalPosition,
} from './development.js';

export const MUSIC_EVENT_FORMAT = 'music-event-12';
const FORMAT = MUSIC_EVENT_FORMAT;
const READABLE_FORMATS = new Set(['music-event-10', 'music-event-11', FORMAT]);
const WRITER_FORMAT = 'music-writer-1';
const ENCOUNTER_SHAPE_TOOL_ID = 'shape_encounter';
const DEVELOPMENTAL_REVIEW_TOOL_ID = 'review_developmental_position';
const TRAJECTORY_ELECTION_TOOL_ID = 'elect_trajectory';
const MAX_TOOLS = 32;
const MAX_SELECTION_CANDIDATES = 16;
const MAX_SELECTION_BYTES = 64 * 1_024;
const MAX_DELTA_BYTES = 64 * 1_024;
const MAX_PROJECTION_BYTES = 2 * 1_024 * 1_024;
const MAX_ACTIVE_SURFACE_BYTES = 512 * 1_024;
const MAX_PROJECTION_FACTS = 128;
const MAX_DEVELOPMENTAL_FRONTIER_PROPOSALS = 32;
const MAX_CARRIER_TRIAL_PROBE_BYTES = 16 * 1_024;
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

  initializeMigrated({ subject, tools, toolHistory, carrier, lineage, checkpoint }) {
    if (this.state().subject) throw new Error('Music subject already exists');
    const retainedSubject = validateMigratedSubject(subject);
    const initial = validateInitialTools(tools);
    const retainedCarrier = readCarrier(carrier);
    const retainedLineage = validateLegacyLineage(lineage);
    const retainedHistory = validateMigratedToolHistory(toolHistory, initial);
    const retainedCheckpoint = validateLegacyCheckpoint(checkpoint);
    const toolsById = new Map(initial.map(tool => [tool.id, tool]));
    const at = this.clock().toISOString();
    const position = initialDevelopmentalPosition({
      tools: toolsById,
      carrier: retainedCarrier,
      openingId: this.id(),
      at,
      openingContent: {
        origin: 'legacy-migration',
        lineage: {
          sourceFormat: retainedLineage.sourceFormat,
          sourceHead: retainedLineage.sourceHead,
          sourceSha256: retainedLineage.sourceSha256,
          eventCount: retainedLineage.eventCount,
        },
        ...(retainedCheckpoint.nextWake === null ? {} : {
          legacyOpening: {
            originalId: retainedCheckpoint.nextWake.wakeId,
            originalNotBefore: retainedCheckpoint.nextWake.wakeAt,
            reason: retainedCheckpoint.nextWake.reason,
            invocationId: retainedCheckpoint.nextWake.invocationId,
            tool: retainedCheckpoint.nextWake.tool,
          },
        }),
      },
      openingNotBefore: retainedCheckpoint.nextWake === null
        ? null
        : new Date(Math.max(Date.parse(at), Date.parse(retainedCheckpoint.nextWake.wakeAt))).toISOString(),
    });
    assertActiveGeometryFits(toolsById, retainedCarrier, retainedSubject, position);
    this.append('subject_created', {
      subject: retainedSubject,
      tools: initial,
      toolHistory: retainedHistory,
      carrier: serializeCarrier(retainedCarrier),
      position,
      lineage: retainedLineage,
      legacyCheckpoint: retainedCheckpoint,
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
    this.settleTerminalDevelopmentalTrials();
    const state = this.state();
    requireSubject(state);
    if (state.activeInferenceId) throw new Error(`cannot open a Sounding while inference is active: ${state.activeInferenceId}`);
    if (state.openSoundingId) throw new Error(`an opened Sounding is still awaiting an encounter: ${state.openSoundingId}`);
    if (!['delta', 'continuation', 'opening', 'scheduled', 'heartbeat', 'manual'].includes(trigger)) throw new Error('invalid Sounding trigger');
    const carrierTrial = armedCarrierTrial(state);
    const soundingCarrier = carrierTrial
      ? projectCarrier(applyCarrierTransition(
        state.carrier,
        state.developmentalProposals.get(carrierTrial.proposalId).transition,
      ))
      : projectCarrier(state.carrier);
    const base = {
      id: this.id(),
      subject: structuredClone(state.subject),
      parent: state.head,
      at: this.clock().toISOString(),
      trigger,
      tools: [...state.tools.values()].sort((a, b) => a.id.localeCompare(b.id)).map(projectTool),
      carrier: soundingCarrier,
      ...(state.position ? { position: projectDevelopmentalPosition(state.position) } : {}),
      development: projectDevelopmentalFrontier(state),
      ...(carrierTrial ? { developmentalTrial: projectArmedCarrierTrial(carrierTrial, soundingCarrier.root) } : {}),
      ...trajectoryElectionOpportunity(state, trigger),
    };
    if (trigger === 'opening' && !dueUnpresentedOpening(state, Date.parse(base.at))) {
      const notBefore = state.position?.activeOpening?.notBefore;
      throw new Error(notBefore ? `developmental opening is not due until ${notBefore}` : 'no due unpresented developmental opening');
    }
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
      consequences: retainConsequenceEvidence(proposal.consequenceDeltaIds, encounter, state),
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

  offerToolProposal(proposal, offer) {
    const state = this.state();
    requireSubject(state);
    if (state.activeInferenceId || state.openSoundingId) {
      throw new Error('developmental machinery can be offered only between encounters');
    }
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('proposal offer needs a bounded interpretation');
    const requested = proposal?.tool;
    const current = state.tools.get(requested?.id);
    const tool = validateToolModule({
      ...requested,
      version: current ? current.version + 1 : 1,
      parent: current ? toolModuleDigest(current) : null,
    });
    if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
    const pendingDuplicate = [...state.developmentalProposals.values()].find(candidate =>
      candidate.kind === 'tool'
      && !['denied', 'contradicted', 'retired', 'admitted', 'rolled-back'].includes(candidate.status)
      && candidate.revision.tool.id === tool.id);
    if (pendingDuplicate) throw new Error(`tool ${tool.id} already has active proposal ${pendingDuplicate.proposalId}`);
    if (current && digest(projectToolBody(current)) === digest(projectToolBody(tool))) {
      throw new Error(`tool ${tool.id} already has the offered executable body`);
    }
    const pendingNewTools = [...state.developmentalProposals.values()]
      .filter(candidate => candidate.kind === 'tool' && candidate.status !== 'denied'
        && candidate.status !== 'contradicted' && candidate.status !== 'retired'
        && candidate.revision.previousTool === null).length;
    if (!current && state.tools.size + pendingNewTools >= MAX_TOOLS) throw new Error(`tool limit ${MAX_TOOLS} reached`);
    assertProspectiveGeometryFits(state, { tool });
    const retainedOffer = validateDevelopmentalOffer(offer, tool);
    const proposalId = this.id();
    const authoredAt = this.clock().toISOString();
    const revision = {
      inferenceId: null,
      soundingId: null,
      projection: null,
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      consequences: [],
      previousTool: current ? toolModuleDigest(current) : null,
      tool,
      rollbackOf: null,
    };
    this.append('developmental_proposal_offered', {
      proposalId,
      kind: 'tool',
      authoredAt,
      offer: retainedOffer,
      revision,
      position: developmentalStandingSuccessor(state, {
        kind: 'proposal-offered', proposalId, proposalKind: 'tool',
        revisionDigest: digest(revision), offerDigest: digest(retainedOffer),
      }),
    });
    return {
      proposalId, kind: 'tool', status: 'authored', authoredAt,
      offer: structuredClone(retainedOffer), revision: structuredClone(revision),
    };
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
      consequences: retainConsequenceEvidence(proposal.consequenceDeltaIds, encounter, state),
      ...transition,
    };
    this.append('developmental_proposal_authored', {
      proposalId,
      kind: 'carrier',
      authoredAt: this.clock().toISOString(),
      transition: retained,
      position: developmentalStandingSuccessor(state, {
        kind: 'proposal-authored', proposalId, proposalKind: 'carrier',
        transitionDigest: digest(projectCarrierTransition(retained, encounter, state)),
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
    const retainedInput = jsonValue(input, 'developmental trial input');
    if (proposal.kind === 'carrier') {
      if (Buffer.byteLength(canonical(retainedInput)) > MAX_CARRIER_TRIAL_PROBE_BYTES) {
        throw new Error(`developmental carrier trial probe exceeds ${MAX_CARRIER_TRIAL_PROBE_BYTES} bytes`);
      }
      if ([...state.developmentalTrials.values()].some(trial => trial.binding?.kind === 'carrier'
        && ['armed', 'presented'].includes(trial.status))) {
        throw new Error('only one carrier proposal may await a later-encounter trial');
      }
      if (stagedCarrierAdmission(state)) {
        throw new Error('cannot arm a carrier trial while this encounter stages another carrier admission');
      }
      const position = developmentalStandingSuccessor(state, {
        kind: 'proposal-trial-armed', proposalId, trialId, binding, inputDigest: digest(retainedInput),
      });
      this.append('developmental_trial_armed', {
        trialId, proposalId, inferenceId, soundingId, projection: encounter.projection,
        binding, input: retainedInput, position,
      });
      return {
        trialId,
        proposalId,
        status: 'armed',
        meaning: 'The provisional carrier will govern the next fresh encounter; it has not yet been exercised.',
      };
    }
    this.append('developmental_trial_started', {
      trialId, proposalId, inferenceId, soundingId, projection: encounter.projection,
      binding, input: retainedInput,
      executionEnvironmentBefore: executionEnvironmentReceipt(this.toolEnvironment),
    });
    try {
      const output = await executeToolModule(proposal.revision.tool, input, {
          trialId, proposalId, inferenceId, soundingId, projection: encounter.projection,
          invocationId: `developmental-trial:${trialId}`,
          ledgerPath: this.ledgerPath,
          environment: structuredClone(this.toolEnvironment),
          selectToolAction: (selectedToolId, frontier) => previewToolSelection(selectedToolId, frontier),
          recordTrajectoryElection: frontier => previewTrajectoryElection(frontier, state),
          executeTrajectoryElection: frontier => previewTrajectoryElection(frontier, state),
          recordDevelopmentalReview: frontier => ({
            format: 'music-developmental-review-preview-1',
            ...validateDevelopmentalReview(frontier, encounter),
          }),
          stageConsequenceTransition: candidate => previewConsequenceTransition(candidate, state, encounter),
          stageCarrierTransition: candidate => createCarrierTransition(state.carrier, candidate),
          stageWakeTransition: candidate => previewOpeningTransition(candidate, this.clock),
        });
      const current = this.state();
      this.append('developmental_trial_completed', {
        trialId,
        output,
        executionEnvironmentAfter: executionEnvironmentReceipt(this.toolEnvironment),
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
        executionEnvironmentAfter: executionEnvironmentReceipt(this.toolEnvironment),
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
    const decisions = validateDevelopmentalDecisions(proposal?.decisions ?? [], state, { allowEmpty: proposal?.opening !== undefined });
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('developmental transaction needs a bounded interpretation');
    const opening = proposal?.opening === undefined ? null : validateProposedOpening(proposal.opening, state, this.id, this.clock);
    if (decisions.length === 0 && opening === null) throw new Error('developmental transaction needs decisions or a successor opening');
    const prior = state.stagedDevelopmentalTransaction;
    if (prior?.opening && opening) throw new Error('developmental transaction already has a successor opening');
    const combinedDecisions = validateDevelopmentalDecisions(
      [...(prior?.decisions ?? []), ...decisions], state, { allowEmpty: (prior?.opening ?? opening) !== null },
    );
    if (combinedDecisions.some(decision => decision.disposition === 'admit'
      && state.developmentalProposals.get(decision.proposalId)?.kind === 'carrier')
      && [...state.developmentalTrials.values()].some(trial => trial.binding?.kind === 'carrier'
        && ['armed', 'presented'].includes(trial.status))) {
      throw new Error('cannot admit carrier geometry while a later-encounter carrier trial is active');
    }
    const combinedInterpretation = prior
      ? `${prior.interpretation}\n\n${interpretation}`
      : interpretation;
    if (combinedInterpretation.length > 4_096) {
      throw new Error('combined developmental transaction interpretation exceeds 4096 characters');
    }
    const transaction = {
      transactionId: prior?.transactionId ?? this.id(), inferenceId, soundingId, projection: encounter.projection,
      positionRoot: state.position?.root ?? null,
      interpretation: combinedInterpretation,
      evidence: mergeDevelopmentalEvidence(prior?.evidence ?? [], boundedEvidence(proposal.evidence)),
      decisions: combinedDecisions,
      opening: prior?.opening ?? opening,
    };
    assertDevelopmentalTransactionFits(state, transaction);
    if (prior) {
      this.append('developmental_transaction_amended', {
        previousTransactionDigest: digest(prior),
        transaction,
      });
    } else {
      this.append('developmental_transaction_staged', transaction);
    }
    return structuredClone(transaction);
  }

  stageOpeningTransition(inferenceId, soundingId, invocationId, proposal) {
    const state = this.state();
    const invocation = state.activeToolInvocations.get(invocationId);
    if (!invocation || invocation.inferenceId !== inferenceId || invocation.soundingId !== soundingId) {
      throw new Error('successor opening requires its active tool invocation');
    }
    const afterMs = proposal?.afterMs;
    if (!Number.isSafeInteger(afterMs) || afterMs < 1_000) throw new Error('successor opening afterMs must be at least 1000');
    const reason = typeof proposal?.reason === 'string' ? proposal.reason.trim() : '';
    if (!reason || reason.length > 2_048) throw new Error('successor opening needs a bounded reason');
    const authoredAt = this.clock().toISOString();
    const notBefore = new Date(Date.parse(authoredAt) + afterMs).toISOString();
    return this.stageDevelopmentalTransaction(inferenceId, soundingId, {
      decisions: [],
      interpretation: reason,
      evidence: [],
      opening: {
        authoredAt,
        notBefore,
        content: {
          reason,
          ...(proposal.content === undefined ? {} : { content: jsonValue(proposal.content, 'successor opening content') }),
          invocationId,
          tool: structuredClone(invocation.tool),
        },
        closes: {
          openingId: state.position?.activeOpening?.id ?? null,
          status: typeof proposal?.closureStatus === 'string' && proposal.closureStatus.trim()
            ? proposal.closureStatus.trim() : 'continued',
          interpretation: reason,
        },
      },
    });
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

  inspectTrajectoryElection(inferenceId, soundingId, electionId) {
    const state = this.state();
    requireActiveEncounter(state, inferenceId, soundingId);
    const election = state.trajectoryElections.get(electionId);
    if (!election) throw new Error(`unknown trajectory election: ${electionId}`);
    return structuredClone(election);
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

  selectToolAction(inferenceId, soundingId, toolId, frontier, trajectoryElectionReceipt = null) {
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
      ...(trajectoryElectionReceipt === null ? {} : { trajectoryElectionReceipt }),
      ...selection,
    });
    return {
      selectionReceipt: selectionId,
      selectedCandidateId: selection.selectedCandidateId,
      selected: structuredClone(selection.selected),
    };
  }

  recordTrajectoryElection(inferenceId, soundingId, invocationId, frontier) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const invocation = state.activeToolInvocations.get(invocationId);
    if (!invocation || invocation.inferenceId !== inferenceId || invocation.soundingId !== soundingId
      || invocation.tool.id !== TRAJECTORY_ELECTION_TOOL_ID) {
      throw new Error('trajectory election requires its active ordinary selector invocation');
    }
    const election = validateTrajectoryElectionFrontier(frontier, state);
    const floorGrounding = groundTrajectoryFloors(election.candidates, state);
    const electionId = this.id();
    this.append('trajectory_election_recorded', {
      electionId,
      inferenceId,
      soundingId,
      projection: encounter.projection,
      carrierRoot: encounter.sounding.carrier.root,
      selector: structuredClone(invocation.tool),
      invocationId,
      floorGrounding,
      ...election,
    });
    return {
      format: election.reviewId ? 'music-trajectory-election-2' : 'music-trajectory-election-1',
      trajectoryElectionReceipt: electionId,
      ...(election.reviewId ? {
        reviewId: election.reviewId,
        reviewDigest: election.reviewDigest,
        trajectory: structuredClone(election.trajectory),
      } : {}),
      candidates: structuredClone(election.candidates),
      selectedCandidateId: election.selectedCandidateId,
      selected: structuredClone(election.selected),
      floorGrounding: structuredClone(floorGrounding),
    };
  }

  recordDevelopmentalReview(inferenceId, soundingId, invocationId, frontier) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const invocation = state.activeToolInvocations.get(invocationId);
    if (!invocation || invocation.inferenceId !== inferenceId || invocation.soundingId !== soundingId
      || invocation.tool.id !== DEVELOPMENTAL_REVIEW_TOOL_ID) {
      throw new Error('developmental review requires its active ordinary review invocation');
    }
    const review = validateDevelopmentalReview(frontier, encounter);
    const reviewId = this.id();
    this.append('developmental_review_recorded', {
      reviewId,
      inferenceId,
      soundingId,
      projection: encounter.projection,
      carrierRoot: encounter.sounding.carrier.root,
      reviewer: structuredClone(invocation.tool),
      invocationId,
      ...review,
    });
    return {
      format: 'music-developmental-review-1',
      reviewId,
      findings: structuredClone(review.findings),
      candidates: structuredClone(review.candidates),
    };
  }

  deliverTrajectoryContext(inferenceId) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId || !state.activeEncounter) {
      throw new Error(`inference is not active: ${inferenceId}`);
    }
    const elections = [...state.trajectoryElections.values()].filter(election => election.inferenceId === inferenceId);
    if (elections.length !== 1) throw new Error('trajectory context requires exactly one election in this inference');
    const election = elections[0];
    const message = trajectoryContextMessage(election);
    this.append('trajectory_context_delivered', {
      inferenceId,
      soundingId: state.activeEncounter.sounding.id,
      projection: state.activeEncounter.projection,
      electionId: election.electionId,
      message,
    });
    return structuredClone(message);
  }

  async executeTrajectoryElection(inferenceId, soundingId, invocationId, frontier) {
    const election = this.recordTrajectoryElection(inferenceId, soundingId, invocationId, frontier);
    const action = election.selected?.action;
    if (!action || action.kind === 'quiet') {
      return {
        ...election,
        action: {
          kind: 'quiet',
          observation: action?.observation ?? null,
        },
      };
    }
    if (action.kind !== 'tool' || typeof action.tool !== 'string' || !action.tool
      || !action.input || typeof action.input !== 'object' || Array.isArray(action.input)) {
      throw new Error('elected trajectory action is not a concrete tool input');
    }
    if (action.tool === TRAJECTORY_ELECTION_TOOL_ID) {
      throw new Error('a trajectory election cannot recursively select itself');
    }
    const state = this.state();
    const target = state.activeEncounter?.toolBindings.get(action.tool)?.manifest;
    if (!target) throw new Error(`elected trajectory action names unavailable tool: ${action.tool}`);
    let selectionReceipt = action.selectionReceipt ?? null;
    if (target.selection && selectionReceipt === null) {
      const nested = trajectoryToolSelectionFrontier(target, election);
      selectionReceipt = this.selectToolAction(
        inferenceId,
        soundingId,
        action.tool,
        nested,
        election.trajectoryElectionReceipt,
      ).selectionReceipt;
    }
    const invoked = await this.invokeToolRetained(
      inferenceId,
      soundingId,
      action.tool,
      action.input,
      selectionReceipt,
      election.trajectoryElectionReceipt,
    );
    return {
      ...election,
      action: {
        kind: 'tool',
        tool: action.tool,
        input: structuredClone(action.input),
        invocationId: invoked.invocationId,
        output: structuredClone(invoked.output),
      },
    };
  }

  async invokeTool(inferenceId, soundingId, toolId, input, selectionReceipt = null, trajectoryElectionReceipt = null) {
    const invocation = await this.invokeToolRetained(
      inferenceId, soundingId, toolId, input, selectionReceipt, trajectoryElectionReceipt,
    );
    return invocation.output;
  }

  async invokeToolRetained(inferenceId, soundingId, toolId, input, selectionReceipt = null, trajectoryElectionReceipt = null) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const binding = encounter.toolBindings.get(toolId);
    if (!binding) throw new Error(`tool ${toolId} was not projected in Sounding ${soundingId}`);
    const tool = binding.manifest;
    const selection = authorizeSelection(state, encounter, tool, input, selectionReceipt);
    const trajectoryElection = authorizeTrajectoryElection(
      state, encounter, tool, input, trajectoryElectionReceipt,
    );
    const invocationId = this.id();
    const executionEnvironmentBefore = executionEnvironmentReceipt(this.toolEnvironment);
    this.append('tool_invocation_started', {
      invocationId,
      inferenceId,
      soundingId,
      projection: encounter.projection,
      tool: { id: tool.id, version: tool.version, digest: toolModuleDigest(tool) },
      selectionReceipt: selection?.selectionId ?? null,
      trajectoryElectionReceipt: trajectoryElection?.electionId ?? null,
      trajectoryBasis: trajectoryBasis(tool.id, trajectoryElection?.electionId ?? null),
      executionEnvironmentBefore,
      input: structuredClone(input),
    });
    const proposalIdsBeforeInvocation = new Set(state.developmentalProposals.keys());
    try {
      const ordinaryOutput = await executeToolModule(tool, input, {
        invocationId,
        inferenceId,
        soundingId,
        projection: encounter.projection,
        ledgerPath: this.ledgerPath,
        environment: structuredClone(this.toolEnvironment),
        selectToolAction: (selectedToolId, frontier) => this.selectToolAction(inferenceId, soundingId, selectedToolId, frontier),
        recordTrajectoryElection: frontier => this.recordTrajectoryElection(
          inferenceId, soundingId, invocationId, frontier,
        ),
        recordDevelopmentalReview: frontier => this.recordDevelopmentalReview(
          inferenceId, soundingId, invocationId, frontier,
        ),
        executeTrajectoryElection: frontier => this.executeTrajectoryElection(
          inferenceId, soundingId, invocationId, frontier,
        ),
        stageConsequenceTransition: proposal => this.stageConsequenceTransition(inferenceId, soundingId, proposal),
        stageCarrierTransition: proposal => {
          const authored = this.authorCarrierProposal(inferenceId, soundingId, proposal);
          return { ...authored.transition, proposalId: authored.proposalId, status: authored.status };
        },
        stageWakeTransition: proposal => this.stageOpeningTransition(inferenceId, soundingId, invocationId, proposal),
      });
      const output = attachDevelopmentalEffects(
        ordinaryOutput,
        [...this.state().developmentalProposals.values()]
          .filter(proposal => !proposalIdsBeforeInvocation.has(proposal.proposalId)),
      );
      const executionEnvironmentAfter = executionEnvironmentReceipt(this.toolEnvironment);
      this.append('tool_invocation_completed', { invocationId, output, executionEnvironmentAfter });
      return { invocationId, output };
    } catch (error) {
      this.append('tool_invocation_failed', {
        invocationId,
        error: errorRecord(error),
        executionEnvironmentAfter: executionEnvironmentReceipt(this.toolEnvironment),
      });
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
    requireRecurrenceElection(state, inferenceId);
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
    this.settleTerminalDevelopmentalTrials();
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
    this.settleTerminalDevelopmentalTrials();
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

  settleTerminalDevelopmentalTrials() {
    const settled = [];
    while (true) {
      const state = this.state();
      const trial = [...state.developmentalTrials.values()].find(candidate =>
        candidate.binding?.kind === 'carrier' && candidate.status === 'presented'
        && state.soundings.get(candidate.encounter)?.terminal);
      if (!trial) return settled;
      const sounding = state.soundings.get(trial.encounter);
      const terminal = sounding.terminal;
      if (terminal.kind === 'completed') {
        const output = carrierTrialOutcome(trial, sounding, terminal);
        this.append('developmental_trial_completed', {
          trialId: trial.trialId,
          output,
          position: developmentalStandingSuccessor(state, {
            kind: 'proposal-exercised', proposalId: trial.proposalId, trialId: trial.trialId,
            outcome: 'completed', outputDigest: digest(output),
          }),
        });
      } else {
        const error = {
          name: 'CarrierTrialEncounterFailed',
          message: `The provisional carrier encounter ended with retained inference failure ${terminal.event}.`,
        };
        this.append('developmental_trial_failed', {
          trialId: trial.trialId,
          error,
          position: developmentalStandingSuccessor(state, {
            kind: 'proposal-exercised', proposalId: trial.proposalId, trialId: trial.trialId,
            outcome: 'failed', error,
          }),
        });
      }
      settled.push(trial.trialId);
    }
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
      retainedToolVersions: state.toolHistory.size,
      carrierRoot: projectCarrier(state.carrier).root,
      positionRoot: state.position?.root ?? null,
      developmentalProposals: state.developmentalProposals.size,
      provisionalDevelopmentalProposals: [...state.developmentalProposals.values()]
        .filter(proposal => !['admitted', 'rolled-back', 'denied', 'retired'].includes(proposal.status)).length,
      developmentalTrials: [...state.developmentalTrials.values()]
        .filter(trial => ['completed', 'failed'].includes(trial.status)).length,
      armedDevelopmentalTrials: [...state.developmentalTrials.values()]
        .filter(trial => trial.status === 'armed').length,
      presentedDevelopmentalTrials: [...state.developmentalTrials.values()]
        .filter(trial => trial.status === 'presented').length,
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
      lineage: state.lineage ? structuredClone(state.lineage) : null,
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
      activeOpening: state.position?.activeOpening ? structuredClone(state.position.activeOpening) : null,
      activeOpeningPresented: state.position?.activeOpening
        ? state.presentedOpeningIds.has(state.position.activeOpening.id) : false,
      uncertainInvocationsWithoutWorldContact: [...state.invocationHistory.entries()]
        .filter(([invocationId, invocation]) => invocation.status === 'uncertain' && !state.contactedInvocationIds.has(invocationId)).length,
      selections: state.selectionCount,
      developmentalReviews: state.developmentalReviewIds.size,
      trajectoryElections: state.trajectoryElectionIds.size,
      activeTrajectory: structuredClone([...state.trajectoryElections.values()].at(-1) ?? null),
      electedActions: state.usedTrajectoryElectionIds.size,
      adHocActions: [...state.invocationHistory.values()]
        .filter(invocation => invocation.trajectoryBasis?.kind === 'ad-hoc').length,
      selectorInvocations: [...state.invocationHistory.values()]
        .filter(invocation => invocation.trajectoryBasis?.kind === 'selector').length,
      developmentalAdmissions: [...state.developmentalProposals.values()]
        .flatMap(proposal => proposal.standing)
        .filter(standing => standing.disposition === 'admit' || standing.disposition === 'rollback')
        .reduce((counts, standing) => {
          const basis = standing.admissionBasis ?? 'exercise-only';
          counts[basis] = (counts[basis] ?? 0) + 1;
          return counts;
        }, {}),
      executionEnvironmentChanges: [...state.invocationHistory.values()]
        .filter(invocation => invocation.executionEnvironmentBefore?.digest
          && invocation.executionEnvironmentAfter?.digest
          && invocation.executionEnvironmentBefore.digest !== invocation.executionEnvironmentAfter.digest).length,
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
    contactedElectionIds: new Set(),
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
    presentedOpeningIds: new Set(),
    selections: new Map(),
    usedSelectionIds: new Set(),
    selectionCount: 0,
    developmentalReviews: new Map(),
    developmentalReviewIds: new Set(),
    developmentalReviewInvocationIds: new Set(),
    trajectoryElections: new Map(),
    trajectoryElectionIds: new Set(),
    trajectoryElectionInvocationIds: new Set(),
    usedTrajectoryElectionIds: new Set(),
    deliveredTrajectoryContextIds: new Set(),
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
    lineage: null,
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
        for (const tool of event.payload.toolHistory ?? []) {
          const valid = validateToolModule(tool);
          state.toolHistory.set(toolModuleDigest(valid), valid);
        }
        state.carrier = readCarrier(event.payload.carrier);
        state.position = event.format === FORMAT
          ? readDevelopmentalPosition(event.payload.position, { tools: state.tools, carrier: state.carrier })
          : null;
        state.lineage = event.payload.lineage === undefined ? null : validateLegacyLineage(event.payload.lineage);
        if (event.payload.legacyCheckpoint !== undefined) {
          hydrateLegacyCheckpoint(state, validateLegacyCheckpoint(event.payload.legacyCheckpoint));
        }
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
        for (const reference of delta.bearsOn ?? []) {
          if (reference.kind === 'tool-invocation') state.contactedInvocationIds.add(reference.invocationId);
          else state.contactedElectionIds.add(reference.electionId);
        }
        state.pendingDeltas.push(structuredClone(delta));
        break;
      }
      case 'sounding_opened': {
        requireSubject(state);
        const sounding = event.payload.sounding;
        if (event.payload.projection !== digest(sounding)) throw new Error('Sounding projection digest mismatch');
        const carrierTrial = validateSoundingCarrierTrial(state, sounding.developmentalTrial ?? null);
        const expectedCarrier = carrierTrial
          ? projectCarrier(applyCarrierTransition(
            state.carrier,
            state.developmentalProposals.get(carrierTrial.proposalId).transition,
          ))
          : projectCarrier(state.carrier);
        if (digest(sounding.carrier) !== digest(expectedCarrier)) throw new Error('Sounding carrier projection mismatch');
        if (event.format === FORMAT) {
          if (!state.position || digest(sounding.position) !== digest(projectDevelopmentalPosition(state.position))) {
            throw new Error('Sounding developmental position projection mismatch');
          }
          if (sounding.development !== undefined
            && digest(sounding.development) !== digest(projectDevelopmentalFrontier(state))) {
            throw new Error('Sounding developmental frontier projection mismatch');
          }
          if (sounding.trajectoryElection !== undefined) {
            const projected = digest({ trajectoryElection: sounding.trajectoryElection });
            const accepted = [
              trajectoryElectionOpportunity(state, sounding.trigger),
              legacyTrajectoryElectionOpportunity(state, sounding.trigger),
            ].some(opportunity => projected === digest(opportunity));
            if (!accepted) throw new Error('Sounding trajectory-election opportunity mismatch');
          }
        }
        if (state.openSoundingId || state.activeInferenceId) throw new Error('ledger opens overlapping Soundings');
        if (state.soundings.has(sounding.id)) throw new Error(`ledger repeats Sounding id: ${sounding.id}`);
        const toolBindings = bindProjectedTools(state.tools, sounding.tools);
        validateOpeningWake(sounding.wake ?? null, state.nextWake, sounding.trigger, sounding.at);
        const opening = dueUnpresentedOpening(state, Date.parse(sounding.at));
        if (sounding.trigger === 'opening' && !opening) throw new Error('Sounding claims no due unpresented opening');
        const presentedOpeningId = opening?.id ?? null;
        if (presentedOpeningId) state.presentedOpeningIds.add(presentedOpeningId);
        if (sounding.frontier === undefined) {
          const includeCausalLineage = sounding.unresolvedConsequences
            .some(consequence => consequence.causalLineage !== undefined);
          if (digest(sounding.unresolvedConsequences)
            !== digest(projectUnresolvedConsequences(state, { includeCausalLineage }))) {
            throw new Error('Sounding unresolved consequence projection mismatch');
          }
        } else {
          const includeCausalLineage = sounding.deltaLineage !== undefined
            || sounding.unresolvedConsequences.some(consequence => consequence.causalLineage !== undefined);
          const planned = planSoundingSurface(state, {
            id: sounding.id,
            subject: sounding.subject,
            parent: sounding.parent,
            at: sounding.at,
            trigger: sounding.trigger,
            tools: sounding.tools,
            carrier: sounding.carrier,
            ...(sounding.position ? { position: sounding.position } : {}),
            ...(sounding.development ? { development: sounding.development } : {}),
            ...(sounding.developmentalTrial ? { developmentalTrial: sounding.developmentalTrial } : {}),
            ...(sounding.trajectoryElection ? { trajectoryElection: sounding.trajectoryElection } : {}),
            wake: sounding.wake ?? null,
          }, { includeCausalLineage });
          if (digest(sounding.deltas) !== digest(planned.sounding.deltas)
            || digest(sounding.unresolvedConsequences) !== digest(planned.sounding.unresolvedConsequences)
            || (sounding.deltaLineage !== undefined
              && digest(sounding.deltaLineage) !== digest(planned.sounding.deltaLineage))
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
          presentedOpeningId,
        });
        if (carrierTrial) {
          carrierTrial.status = 'presented';
          carrierTrial.encounter = sounding.id;
          carrierTrial.encounterProjection = event.payload.projection;
          const proposal = state.developmentalProposals.get(carrierTrial.proposalId);
          proposal.status = 'trialing';
          updateProposalTrial(proposal, carrierTrial.trialId, 'presented');
        }
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
        if (event.format === FORMAT) throw new Error('current ledgers require developmental proposals for tool changes');
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
        if (event.format === FORMAT) throw new Error('current ledgers require developmental proposals for carrier changes');
        requireSubject(state);
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (state.stagedCarrierTransition) throw new Error('ledger stages more than one carrier transition in an encounter');
        const transition = projectCarrierTransition(event.payload, state.activeEncounter, state);
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
        if (event.format === FORMAT) throw new Error('current ledgers retain recurrence in developmental openings');
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
          ? projectCarrierTransition(event.payload.transition, state.activeEncounter, state)
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
      case 'developmental_proposal_offered': {
        requireSubject(state);
        if (state.activeInferenceId || state.openSoundingId) {
          throw new Error('developmental proposal offer overlaps an encounter');
        }
        if (typeof event.payload.proposalId !== 'string' || !event.payload.proposalId.trim()
          || event.payload.proposalId.length > 128
          || typeof event.payload.authoredAt !== 'string' || Number.isNaN(Date.parse(event.payload.authoredAt))) {
          throw new Error('developmental proposal offer needs bounded identity and time');
        }
        if (state.developmentalProposals.has(event.payload.proposalId)) throw new Error('duplicate developmental proposal id');
        if (event.payload.kind !== 'tool') throw new Error('unsupported developmental proposal offer kind');
        const revision = validateOfferedRevision(event.payload.revision, state);
        const offer = validateDevelopmentalOffer(event.payload.offer, revision.tool);
        const expectedPosition = developmentalStandingSuccessor(state, {
          kind: 'proposal-offered', proposalId: event.payload.proposalId,
          proposalKind: 'tool', revisionDigest: digest(revision), offerDigest: digest(offer),
        });
        if (digest(event.payload.position) !== digest(expectedPosition)) throw new Error('proposal offer position mismatch');
        state.developmentalProposals.set(event.payload.proposalId, {
          proposalId: event.payload.proposalId,
          kind: 'tool',
          authoredAt: event.payload.authoredAt,
          status: 'authored',
          offer,
          revision,
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
        validateExecutionEnvironmentReceipt(event.payload.executionEnvironmentBefore, { optional: true });
        state.developmentalTrials.set(event.payload.trialId, {
          ...structuredClone(event.payload), encounter: encounter.sounding.id, status: 'started',
        });
        break;
      }
      case 'developmental_trial_armed': {
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        const proposal = state.developmentalProposals.get(event.payload.proposalId);
        if (!proposal || proposal.kind !== 'carrier') throw new Error('armed developmental trial needs a carrier proposal');
        if (!['authored', 'exercised', 'deferred', 'contradicted'].includes(proposal.status)) {
          throw new Error(`carrier proposal ${proposal.proposalId} is ${proposal.status}, not trialable`);
        }
        if (state.developmentalTrials.has(event.payload.trialId)) throw new Error('duplicate developmental trial id');
        if ([...state.developmentalTrials.values()].some(trial => trial.binding?.kind === 'carrier'
          && ['armed', 'presented'].includes(trial.status))) {
          throw new Error('ledger arms overlapping carrier trials');
        }
        const expectedBinding = {
          kind: 'carrier', id: proposal.transition.component.id, digest: proposal.transition.successorRoot,
        };
        if (digest(event.payload.binding) !== digest(expectedBinding)) throw new Error('armed carrier trial binding mismatch');
        const expectedPosition = developmentalStandingSuccessor(state, {
          kind: 'proposal-trial-armed', proposalId: proposal.proposalId, trialId: event.payload.trialId,
          binding: expectedBinding, inputDigest: digest(event.payload.input),
        });
        if (digest(event.payload.position) !== digest(expectedPosition)) throw new Error('armed carrier trial position mismatch');
        state.developmentalTrials.set(event.payload.trialId, {
          ...structuredClone(event.payload), encounter: encounter.sounding.id, status: 'armed',
        });
        proposal.status = 'armed';
        proposal.trials.push({ trialId: event.payload.trialId, status: 'armed' });
        state.position = expectedPosition;
        break;
      }
      case 'developmental_trial_completed': {
        const trial = state.developmentalTrials.get(event.payload.trialId);
        if (!trial || !['started', 'presented'].includes(trial.status)) throw new Error('completed developmental trial is not active');
        const output = jsonValue(event.payload.output, 'developmental trial output');
        validateExecutionEnvironmentReceipt(event.payload.executionEnvironmentAfter, { optional: true });
        if (trial.binding.kind === 'carrier' && trial.status === 'presented') {
          validateCarrierTrialOutcome(output, trial, state);
        }
        const expectedPosition = developmentalStandingSuccessor(state, {
          kind: 'proposal-exercised', proposalId: trial.proposalId, trialId: trial.trialId,
          outcome: 'completed', outputDigest: digest(output),
        });
        if (digest(event.payload.position) !== digest(expectedPosition)) throw new Error('completed trial position mismatch');
        trial.status = 'completed';
        trial.output = output;
        if (event.payload.executionEnvironmentAfter !== undefined) {
          trial.executionEnvironmentAfter = structuredClone(event.payload.executionEnvironmentAfter);
        }
        const proposal = state.developmentalProposals.get(trial.proposalId);
        proposal.status = 'exercised';
        updateProposalTrial(proposal, trial.trialId, 'completed');
        state.position = expectedPosition;
        break;
      }
      case 'developmental_trial_failed': {
        const trial = state.developmentalTrials.get(event.payload.trialId);
        if (!trial || !['started', 'armed', 'presented'].includes(trial.status)) throw new Error('failed developmental trial is not active');
        const expectedPosition = developmentalStandingSuccessor(state, {
          kind: 'proposal-exercised', proposalId: trial.proposalId, trialId: trial.trialId,
          outcome: 'failed', error: event.payload.error,
        });
        validateExecutionEnvironmentReceipt(event.payload.executionEnvironmentAfter, { optional: true });
        if (digest(event.payload.position) !== digest(expectedPosition)) throw new Error('failed trial position mismatch');
        trial.status = 'failed';
        trial.error = structuredClone(event.payload.error);
        if (event.payload.executionEnvironmentAfter !== undefined) {
          trial.executionEnvironmentAfter = structuredClone(event.payload.executionEnvironmentAfter);
        }
        const proposal = state.developmentalProposals.get(trial.proposalId);
        proposal.status = 'contradicted';
        updateProposalTrial(proposal, trial.trialId, 'failed');
        state.position = expectedPosition;
        break;
      }
      case 'developmental_transaction_staged': {
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (state.stagedDevelopmentalTransaction) throw new Error('ledger stages more than one developmental transaction in an encounter');
        if (event.payload.positionRoot !== (state.position?.root ?? null)) throw new Error('developmental transaction position binding mismatch');
        validateDevelopmentalDecisions(event.payload.decisions, state, { allowEmpty: event.payload.opening !== null });
        if (event.payload.opening !== null) validateRetainedOpeningTransition(event.payload.opening, state);
        state.stagedDevelopmentalTransaction = structuredClone(event.payload);
        break;
      }
      case 'developmental_transaction_amended': {
        const prior = state.stagedDevelopmentalTransaction;
        if (!prior) throw new Error('ledger amends a developmental transaction before staging one');
        if (event.payload.previousTransactionDigest !== digest(prior)) {
          throw new Error('developmental transaction amendment does not cite current staged state');
        }
        const transaction = event.payload.transaction;
        requireActiveEncounter(state, transaction.inferenceId, transaction.soundingId, transaction.projection);
        if (transaction.transactionId !== prior.transactionId
          || transaction.positionRoot !== prior.positionRoot
          || transaction.positionRoot !== (state.position?.root ?? null)) {
          throw new Error('developmental transaction amendment changes its retained identity or position binding');
        }
        if (prior.opening !== null && digest(transaction.opening) !== digest(prior.opening)) {
          throw new Error('developmental transaction amendment replaces its successor opening');
        }
        validateDevelopmentalDecisions(transaction.decisions, state, { allowEmpty: transaction.opening !== null });
        if (transaction.opening !== null) validateRetainedOpeningTransition(transaction.opening, state);
        boundedEvidence(transaction.evidence);
        if (typeof transaction.interpretation !== 'string' || !transaction.interpretation.trim()
          || transaction.interpretation.length > 4_096) {
          throw new Error('amended developmental transaction needs a bounded interpretation');
        }
        assertDevelopmentalTransactionFits(state, transaction);
        state.stagedDevelopmentalTransaction = structuredClone(transaction);
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
        if (event.payload.trajectoryElectionReceipt !== undefined) {
          const election = state.trajectoryElections.get(event.payload.trajectoryElectionReceipt);
          if (!election) throw new Error('tool selection cites an unknown trajectory election');
          const derived = validateSelectionFrontier(
            binding.manifest,
            trajectoryToolSelectionFrontier(binding.manifest, election),
          );
          if (digest(selection) !== digest(derived)) {
            throw new Error('tool selection does not match its trajectory-election frontier');
          }
        }
        state.selections.set(event.payload.selectionId, {
          selectionId: event.payload.selectionId,
          inferenceId: event.payload.inferenceId,
          soundingId: event.payload.soundingId,
          projection: event.payload.projection,
          carrierRoot: event.payload.carrierRoot,
          tool: structuredClone(event.payload.tool),
          ...(event.payload.trajectoryElectionReceipt === undefined
            ? {}
            : { trajectoryElectionReceipt: event.payload.trajectoryElectionReceipt }),
          ...selection,
        });
        state.selectionCount += 1;
        break;
      }
      case 'trajectory_election_recorded': {
        requireSubject(state);
        const encounter = requireActiveEncounter(
          state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection,
        );
        if (typeof event.payload.electionId !== 'string' || !event.payload.electionId.trim()
          || event.payload.electionId.length > 128) {
          throw new Error('trajectory election needs a bounded id');
        }
        if (state.trajectoryElectionIds.has(event.payload.electionId)) {
          throw new Error('duplicate trajectory election id');
        }
        if (state.trajectoryElectionInvocationIds.has(event.payload.invocationId)) {
          throw new Error('one selector invocation cannot retain multiple trajectory elections');
        }
        const invocation = state.activeToolInvocations.get(event.payload.invocationId);
        if (!invocation || invocation.tool.id !== TRAJECTORY_ELECTION_TOOL_ID
          || event.payload.selector?.id !== invocation.tool.id
          || invocation.tool.digest !== event.payload.selector?.digest
          || invocation.tool.version !== event.payload.selector?.version) {
          throw new Error('trajectory election is not bound to its active selector invocation');
        }
        if (event.payload.carrierRoot !== encounter.sounding.carrier.root) {
          throw new Error('trajectory election carrier binding mismatch');
        }
        const election = validateTrajectoryElectionFrontier(event.payload, state);
        if (event.payload.floorGrounding !== undefined) {
          const grounding = groundTrajectoryFloors(election.candidates, state);
          if (digest(event.payload.floorGrounding) !== digest(grounding)) {
            throw new Error('trajectory election floor grounding mismatch');
          }
        }
        state.trajectoryElectionIds.add(event.payload.electionId);
        state.trajectoryElectionInvocationIds.add(event.payload.invocationId);
        state.trajectoryElections.set(event.payload.electionId, {
          electionId: event.payload.electionId,
          inferenceId: event.payload.inferenceId,
          soundingId: event.payload.soundingId,
          projection: event.payload.projection,
          carrierRoot: event.payload.carrierRoot,
          selector: structuredClone(event.payload.selector),
          invocationId: event.payload.invocationId,
          ...(event.payload.floorGrounding === undefined
            ? {}
            : { floorGrounding: structuredClone(event.payload.floorGrounding) }),
          ...election,
        });
        break;
      }
      case 'developmental_review_recorded': {
        requireSubject(state);
        const encounter = requireActiveEncounter(
          state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection,
        );
        if (typeof event.payload.reviewId !== 'string' || !event.payload.reviewId.trim()
          || event.payload.reviewId.length > 128) throw new Error('developmental review needs a bounded id');
        if (state.developmentalReviewIds.has(event.payload.reviewId)) throw new Error('duplicate developmental review id');
        if (state.developmentalReviewInvocationIds.has(event.payload.invocationId)) {
          throw new Error('one review invocation cannot retain multiple developmental reviews');
        }
        const invocation = state.activeToolInvocations.get(event.payload.invocationId);
        if (!invocation || invocation.tool.id !== DEVELOPMENTAL_REVIEW_TOOL_ID
          || event.payload.reviewer?.id !== invocation.tool.id
          || invocation.tool.digest !== event.payload.reviewer?.digest
          || invocation.tool.version !== event.payload.reviewer?.version) {
          throw new Error('developmental review is not bound to its active review invocation');
        }
        if (event.payload.carrierRoot !== encounter.sounding.carrier.root) {
          throw new Error('developmental review carrier binding mismatch');
        }
        const review = validateDevelopmentalReview(event.payload, encounter);
        state.developmentalReviewIds.add(event.payload.reviewId);
        state.developmentalReviewInvocationIds.add(event.payload.invocationId);
        state.developmentalReviews.set(event.payload.reviewId, {
          reviewId: event.payload.reviewId,
          inferenceId: event.payload.inferenceId,
          soundingId: event.payload.soundingId,
          projection: event.payload.projection,
          carrierRoot: event.payload.carrierRoot,
          reviewer: structuredClone(event.payload.reviewer),
          invocationId: event.payload.invocationId,
          ...review,
        });
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
        authorizeTrajectoryElection(
          state, encounter, binding.manifest, event.payload.input,
          event.payload.trajectoryElectionReceipt ?? null,
        );
        if (event.payload.trajectoryElectionReceipt) {
          state.usedTrajectoryElectionIds.add(event.payload.trajectoryElectionReceipt);
        }
        const basis = trajectoryBasis(binding.manifest.id, event.payload.trajectoryElectionReceipt ?? null);
        if (event.payload.trajectoryBasis !== undefined && digest(event.payload.trajectoryBasis) !== digest(basis)) {
          throw new Error('tool invocation trajectory basis mismatch');
        }
        validateExecutionEnvironmentReceipt(event.payload.executionEnvironmentBefore, { optional: true });
        const retainedInvocation = { ...structuredClone(event.payload), trajectoryBasis: basis };
        state.invocationIds.add(event.payload.invocationId);
        state.activeToolInvocations.set(event.payload.invocationId, retainedInvocation);
        state.invocationHistory.set(event.payload.invocationId, { ...retainedInvocation, status: 'started' });
        break;
      }
      case 'tool_invocation_completed': {
        const invocation = state.activeToolInvocations.get(event.payload.invocationId);
        if (!invocation) throw new Error('completed tool invocation is not active');
        validateExecutionEnvironmentReceipt(event.payload.executionEnvironmentAfter, { optional: true });
        const completed = {
          ...invocation,
          status: 'completed',
          output: jsonValue(event.payload.output, 'tool invocation output'),
          ...(event.payload.executionEnvironmentAfter === undefined ? {} : {
            executionEnvironmentAfter: structuredClone(event.payload.executionEnvironmentAfter),
          }),
        };
        state.invocations.push(completed);
        state.invocationHistory.set(event.payload.invocationId, completed);
        state.activeToolInvocations.delete(event.payload.invocationId);
        break;
      }
      case 'tool_invocation_failed': {
        const invocation = state.activeToolInvocations.get(event.payload.invocationId);
        if (!invocation) throw new Error('failed tool invocation is not active');
        validateExecutionEnvironmentReceipt(event.payload.executionEnvironmentAfter, { optional: true });
        state.invocationHistory.set(event.payload.invocationId, {
          ...invocation,
          status: 'failed',
          error: structuredClone(event.payload.error),
          ...(event.payload.executionEnvironmentAfter === undefined ? {} : {
            executionEnvironmentAfter: structuredClone(event.payload.executionEnvironmentAfter),
          }),
        });
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
      case 'trajectory_context_delivered': {
        const encounter = requireActiveEncounter(
          state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection,
        );
        const election = state.trajectoryElections.get(event.payload.electionId);
        if (!election || election.inferenceId !== event.payload.inferenceId
          || election.soundingId !== encounter.sounding.id) {
          throw new Error('trajectory context is not bound to its active election');
        }
        if (state.deliveredTrajectoryContextIds.has(event.payload.electionId)) {
          throw new Error('trajectory context was delivered more than once');
        }
        const expected = trajectoryContextMessage(election);
        if (digest(event.payload.message) !== digest(expected)) throw new Error('trajectory context message mismatch');
        state.activeTurnMessages.push(structuredClone(expected));
        state.messages.push(structuredClone(expected));
        state.deliveredTrajectoryContextIds.add(event.payload.electionId);
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
        requireRecurrenceElection(state, event.payload.inferenceId);
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
        state.activeEncounter.terminal = {
          kind: 'completed', event: event.hash, inferenceId: event.payload.inferenceId,
          finishReason: event.payload.finishReason,
        };
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
        if (state.activeEncounter.presentedOpeningId) {
          state.presentedOpeningIds.delete(state.activeEncounter.presentedOpeningId);
        }
        for (const [invocationId, invocation] of state.activeToolInvocations) {
          if (invocation.inferenceId === event.payload.inferenceId) {
            state.activeToolInvocations.delete(invocationId);
            state.invocationHistory.set(invocationId, { ...invocation, status: 'uncertain' });
          }
        }
        state.activeEncounter.status = 'interrupted';
        state.activeEncounter.terminal = {
          kind: 'failed', event: event.hash, inferenceId: event.payload.inferenceId,
          error: structuredClone(event.payload.error),
        };
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
    + (developmentalTransaction?.opening ? 1 : 0)
    + (carrierTransition ? 1 : 0) + (wakeTransition ? 1 : 0);
  if (changes === 0) return null;
  const tools = new Map(state.tools);
  for (const revision of [...revisions, ...admittedRevisions]) tools.set(revision.tool.id, revision.tool);
  let carrier = carrierTransition ? applyCarrierTransition(state.carrier, carrierTransition) : state.carrier;
  if (admittedCarrierTransitions[0]) carrier = applyCarrierTransition(carrier, admittedCarrierTransitions[0]);
  const opening = developmentalTransaction?.opening?.successor
    ?? (wakeTransition ? openingFromWake(wakeTransition, state.position.activeOpening) : undefined);
  return createDevelopmentalSuccessor(state.position, {
    tools,
    carrier,
    carrierTransition: admittedCarrierTransitions[0] ?? carrierTransition,
    consequenceTransitions,
    standingTransitions: [
      ...consequenceTransitions.map(transition => ({ kind: 'consequence', transition })),
      ...(developmentalTransaction?.decisions ?? []).map(decision => ({ kind: 'proposal', decision })),
      ...(developmentalTransaction?.opening ? [{
        kind: 'opening-closed',
        closes: developmentalTransaction.opening.closes,
        successorId: developmentalTransaction.opening.successor.id,
      }] : []),
    ],
    opening,
    openingTransition: developmentalTransaction?.opening ?? null,
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

function validateDevelopmentalDecisions(value, state, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > 32 || (!allowEmpty && value.length < 1)) {
    throw new Error(`developmental transaction needs ${allowEmpty ? '0' : '1'}-32 decisions`);
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
    const admissionBasis = (disposition === 'admit' || disposition === 'rollback')
      ? developmentalAdmissionBasis(proposal)
      : null;
    if (raw.admissionBasis !== undefined && raw.admissionBasis !== admissionBasis) {
      throw new Error(`developmental proposal ${proposalId} admission basis mismatch`);
    }
    return {
      proposalId,
      disposition,
      interpretation,
      ...(admissionBasis === null ? {} : { admissionBasis }),
    };
  });
}

function developmentalAdmissionBasis(proposal) {
  const consequences = proposal.kind === 'tool'
    ? proposal.revision.consequences
    : proposal.transition.consequences;
  return consequences.length > 0 ? 'consequence-linked' : 'exercise-only';
}

function validateProposedOpening(raw, state, id, clock) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('successor opening must be an object');
  const current = state.position?.activeOpening ?? null;
  const closes = validateOpeningClosure(raw.closes, current);
  const authoredAt = raw.authoredAt ?? clock().toISOString();
  const successor = createDevelopmentalOpening({
    id: id(),
    parent: current?.id ?? null,
    authoredAt,
    notBefore: raw.notBefore ?? null,
    content: raw.content,
  });
  return { successor, closes };
}

function validateRetainedOpeningTransition(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('retained opening transition must be an object');
  const current = state.position?.activeOpening ?? null;
  const successor = createDevelopmentalOpening(value.successor);
  if (successor.parent !== (current?.id ?? null)) throw new Error('successor opening ancestry mismatch');
  const closes = validateOpeningClosure(value.closes, current);
  return { successor, closes };
}

function validateOpeningClosure(value, current) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('successor opening needs an explicit closure receipt');
  if ((value.openingId ?? null) !== (current?.id ?? null)) throw new Error('opening closure does not cite the active opening');
  const status = typeof value.status === 'string' ? value.status.trim() : '';
  const interpretation = typeof value.interpretation === 'string' ? value.interpretation.trim() : '';
  if (!status || status.length > 128) throw new Error('opening closure status must be 1-128 characters');
  if (!interpretation || interpretation.length > 4_096) throw new Error('opening closure interpretation must be 1-4096 characters');
  return { openingId: value.openingId ?? null, status, interpretation };
}

function previewOpeningTransition(proposal, clock) {
  const afterMs = proposal?.afterMs;
  if (!Number.isSafeInteger(afterMs) || afterMs < 1_000) throw new Error('successor opening afterMs must be at least 1000');
  const reason = typeof proposal?.reason === 'string' ? proposal.reason.trim() : '';
  if (!reason || reason.length > 2_048) throw new Error('successor opening needs a bounded reason');
  const authoredAt = clock().toISOString();
  return {
    kind: 'provisional-opening-transition',
    afterMs,
    reason,
    authoredAt,
    notBefore: new Date(Date.parse(authoredAt) + afterMs).toISOString(),
    ...(proposal.content === undefined ? {} : { content: jsonValue(proposal.content, 'successor opening content') }),
  };
}

function previewConsequenceTransition(proposal, state, encounter) {
  return { kind: 'provisional-consequence-transition', ...validateConsequenceTransition(proposal, state, encounter) };
}

function previewToolSelection(toolId, frontier) {
  if (!frontier || typeof frontier !== 'object' || Array.isArray(frontier)) throw new Error('selection frontier must be an object');
  if (frontier.tool !== toolId) throw new Error('selection frontier tool mismatch');
  if (!Array.isArray(frontier.candidates) || frontier.candidates.length < 1 || frontier.candidates.length > MAX_SELECTION_CANDIDATES) {
    throw new Error(`selection frontier needs 1-${MAX_SELECTION_CANDIDATES} candidates`);
  }
  const selected = frontier.candidates.find(candidate => candidate?.id === frontier.selectedCandidateId);
  if (!selected) throw new Error('selection frontier does not contain its selected candidate');
  return {
    kind: 'provisional-tool-selection',
    selectionReceipt: null,
    selectedCandidateId: frontier.selectedCandidateId,
    selected: jsonValue(selected, 'selected developmental trial candidate'),
  };
}

function previewTrajectoryElection(frontier, state) {
  const election = validateTrajectoryElectionFrontier(frontier, state);
  const floorGrounding = groundTrajectoryFloors(election.candidates, state);
  return {
    format: 'music-provisional-trajectory-election-1',
    trajectoryElectionReceipt: null,
    selectedCandidateId: election.selectedCandidateId,
    selected: structuredClone(election.selected),
    floorGrounding,
    action: election.selected.action?.kind === 'quiet'
      ? { kind: 'quiet', observation: election.selected.action.observation ?? null }
      : {
        kind: 'preview',
        tool: election.selected.action?.tool ?? null,
        input: structuredClone(election.selected.action?.input ?? null),
        meaning: 'A provisional selector trial does not execute or govern an active ordinary action.',
      },
  };
}

function assertDevelopmentalTransactionFits(state, transaction) {
  const tools = new Map(state.tools);
  let carrier = state.carrier;
  for (const decision of transaction.decisions) {
    if (decision.disposition !== 'admit' && decision.disposition !== 'rollback') continue;
    const proposal = state.developmentalProposals.get(decision.proposalId);
    if (proposal.kind === 'tool') {
      const current = tools.get(proposal.revision.tool.id);
      if ((current ? toolModuleDigest(current) : null) !== proposal.revision.previousTool) {
        throw new Error(`developmental proposal ${decision.proposalId} no longer succeeds active tool geometry`);
      }
      tools.set(proposal.revision.tool.id, proposal.revision.tool);
    } else {
      carrier = applyCarrierTransition(carrier, proposal.transition);
    }
  }
  const position = developmentalSuccessorForCompletion(state, { developmentalTransaction: transaction });
  assertActiveGeometryFits(tools, carrier, state.subject, position ?? state.position);
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
      ...(decision.admissionBasis === undefined ? {} : { admissionBasis: decision.admissionBasis }),
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
    ...(proposal.offer === undefined ? {} : { offer: structuredClone(proposal.offer) }),
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

function projectDevelopmentalFrontier(state) {
  const available = [...state.developmentalProposals.values()]
    .filter(proposal => !['admitted', 'rolled-back', 'denied', 'retired'].includes(proposal.status))
    .map(projectDevelopmentalFrontierProposal);
  const pages = Math.max(1, Math.ceil(available.length / MAX_DEVELOPMENTAL_FRONTIER_PROPOSALS));
  const page = available.length === 0 ? 0 : state.completedInferences % pages;
  const start = page * MAX_DEVELOPMENTAL_FRONTIER_PROPOSALS;
  const proposals = available.slice(start, start + MAX_DEVELOPMENTAL_FRONTIER_PROPOSALS);
  return {
    format: 'music-developmental-frontier-1',
    available: available.length,
    included: proposals.length,
    remaining: available.length - proposals.length,
    queueDigest: digest(available),
    page: { index: page, count: pages },
    proposals,
  };
}

function projectDevelopmentalFrontierProposal(proposal) {
  const latestTrial = proposal.trials.at(-1) ?? null;
  const base = {
    proposalId: proposal.proposalId,
    kind: proposal.kind,
    authoredAt: proposal.authoredAt,
    status: proposal.status,
    interpretation: proposal.kind === 'tool'
      ? proposal.revision.interpretation : proposal.transition.interpretation,
    latestTrial: latestTrial === null ? null : structuredClone(latestTrial),
    admissionEligible: proposal.trials.some(trial => trial.status === 'completed'),
    ...(proposal.offer === undefined ? {} : { offer: structuredClone(proposal.offer) }),
  };
  return proposal.kind === 'tool'
    ? {
      ...base,
      target: {
        id: proposal.revision.tool.id,
        version: proposal.revision.tool.version,
        digest: toolModuleDigest(proposal.revision.tool),
      },
    }
    : {
      ...base,
      target: {
        componentId: proposal.transition.component.id,
        successorRoot: proposal.transition.successorRoot,
      },
    };
}

function attachDevelopmentalEffects(output, proposals) {
  if (proposals.length === 0) return output;
  return {
    format: 'music-tool-result-with-development-1',
    ordinaryOutput: structuredClone(output),
    developmentalEffects: proposals.map(proposal => ({
      format: 'music-developmental-effect-1',
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      status: proposal.status,
      active: false,
      frontierVisibility: 'next-sounding',
      governsActiveGeometry: false,
      trial: proposal.kind === 'carrier'
        ? 'trial_development must arm this proposal; it must then govern a fresh encounter to become exercised'
        : 'trial_development must execute this provisional tool to make its behavior part of retained standing',
      admission: 'advance_development must explicitly admit an exercised proposal before it becomes active',
      prospectiveAdmissionBasis: developmentalAdmissionBasis(proposal),
    })),
  };
}

function armedCarrierTrial(state) {
  const armed = [...state.developmentalTrials.values()]
    .filter(trial => trial.binding?.kind === 'carrier' && trial.status === 'armed');
  if (armed.length > 1) throw new Error('developmental state contains overlapping armed carrier trials');
  if ([...state.developmentalTrials.values()].some(trial =>
    trial.binding?.kind === 'carrier' && trial.status === 'presented')) {
    throw new Error('a presented carrier trial must reach a retained terminal outcome before another Sounding');
  }
  return armed[0] ?? null;
}

function projectArmedCarrierTrial(trial, carrierRoot) {
  return {
    format: 'music-carrier-trial-1',
    trialId: trial.trialId,
    proposalId: trial.proposalId,
    componentId: trial.binding.id,
    carrierRoot,
    probe: structuredClone(trial.input),
  };
}

function validateSoundingCarrierTrial(state, value) {
  const trial = armedCarrierTrial(state);
  if (!trial) {
    if (value !== null) throw new Error('Sounding cites a carrier trial that is not armed');
    return null;
  }
  const proposal = state.developmentalProposals.get(trial.proposalId);
  if (!proposal || proposal.kind !== 'carrier') throw new Error('armed carrier trial lost its proposal');
  const carrier = applyCarrierTransition(state.carrier, proposal.transition);
  const expected = projectArmedCarrierTrial(trial, projectCarrier(carrier).root);
  if (digest(value) !== digest(expected)) throw new Error('Sounding carrier trial projection mismatch');
  return trial;
}

function carrierTrialOutcome(trial, sounding, terminal) {
  return {
    format: 'music-carrier-trial-outcome-1',
    trialId: trial.trialId,
    proposalId: trial.proposalId,
    soundingId: sounding.sounding.id,
    projection: sounding.projection,
    carrierRoot: sounding.sounding.carrier.root,
    terminal: structuredClone(terminal),
  };
}

function validateCarrierTrialOutcome(output, trial, state) {
  const sounding = state.soundings.get(trial.encounter);
  if (!sounding?.terminal || sounding.terminal.kind !== 'completed') {
    throw new Error('completed carrier trial lacks a completed later encounter');
  }
  if (digest(output) !== digest(carrierTrialOutcome(trial, sounding, sounding.terminal))) {
    throw new Error('completed carrier trial outcome mismatch');
  }
}

function updateProposalTrial(proposal, trialId, status) {
  const retained = proposal.trials.find(trial => trial.trialId === trialId);
  if (retained) retained.status = status;
  else proposal.trials.push({ trialId, status });
}

function stagedCarrierAdmission(state) {
  return state.stagedDevelopmentalTransaction?.decisions.some(decision =>
    decision.disposition === 'admit'
    && state.developmentalProposals.get(decision.proposalId)?.kind === 'carrier') ?? false;
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

function validateMigratedSubject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('migration needs a retained subject');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = value.name === null ? null : (typeof value.name === 'string' ? value.name.trim() : '');
  if (!id || id.length > 128) throw new Error('migrated subject id must be 1-128 characters');
  if (name !== null && name.length > 128) throw new Error('migrated subject designation must be at most 128 characters');
  if (typeof value.bornAt !== 'string' || Number.isNaN(Date.parse(value.bornAt))) throw new Error('migrated subject needs its original birth time');
  return { id, name: name || null, bornAt: value.bornAt };
}

function validateLegacyLineage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('migration needs legacy lineage');
  if (!['music-event-10', 'music-event-11'].includes(value.sourceFormat)) throw new Error('legacy lineage source format is not migratable');
  if (typeof value.sourceHead !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceHead)) throw new Error('legacy lineage needs its source head');
  if (typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) throw new Error('legacy lineage needs its source digest');
  if (!Number.isSafeInteger(value.eventCount) || value.eventCount < 1) throw new Error('legacy lineage needs a positive event count');
  if (typeof value.archive !== 'string' || !value.archive || value.archive.length > 1_024) throw new Error('legacy lineage needs a bounded archive path');
  if (typeof value.migratedAt !== 'string' || Number.isNaN(Date.parse(value.migratedAt))) throw new Error('legacy lineage needs a migration time');
  return {
    format: 'music-legacy-lineage-1',
    sourceFormat: value.sourceFormat,
    sourceHead: value.sourceHead,
    sourceSha256: value.sourceSha256,
    eventCount: value.eventCount,
    archive: value.archive,
    migratedAt: value.migratedAt,
  };
}

function validateMigratedToolHistory(values, activeTools) {
  if (!Array.isArray(values) || values.length < activeTools.length) throw new Error('migration needs complete retained tool history');
  const retained = [];
  const digests = new Set();
  for (const candidate of values) {
    const tool = validateToolModule(candidate);
    const toolDigest = toolModuleDigest(tool);
    if (digests.has(toolDigest)) continue;
    digests.add(toolDigest);
    retained.push(tool);
  }
  for (const tool of activeTools) {
    if (!digests.has(toolModuleDigest(tool))) throw new Error(`migration tool history omits active ${tool.id}`);
  }
  return retained;
}

function validateLegacyCheckpoint(value) {
  const checkpoint = jsonValue(value, 'legacy operational checkpoint');
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new Error('migration needs a legacy operational checkpoint');
  if (!Array.isArray(checkpoint.deltaIds) || checkpoint.deltaIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('legacy checkpoint delta ids are invalid');
  }
  if (!Array.isArray(checkpoint.pendingDeltas)) throw new Error('legacy checkpoint pending Deltas are invalid');
  checkpoint.pendingDeltas.forEach(validateDelta);
  if (!Array.isArray(checkpoint.consequences)) throw new Error('legacy checkpoint consequences are invalid');
  for (const entry of checkpoint.consequences) {
    if (typeof entry?.deltaId !== 'string' || !entry.deltaId || !entry.consequence) throw new Error('legacy checkpoint consequence entry is invalid');
    validateDelta(entry.consequence.delta);
    if (!['open', 'deferred', 'settled'].includes(entry.consequence.status)) throw new Error('legacy checkpoint consequence status is invalid');
  }
  if (!Array.isArray(checkpoint.invocationHistory)
    || checkpoint.invocationHistory.some(entry => typeof entry?.invocationId !== 'string' || !entry.invocationId || !entry.invocation)) {
    throw new Error('legacy checkpoint invocation history is invalid');
  }
  if (!Array.isArray(checkpoint.invocations)) throw new Error('legacy checkpoint invocations are invalid');
  if (!Array.isArray(checkpoint.contactedInvocationIds)
    || checkpoint.contactedInvocationIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('legacy checkpoint contacted invocations are invalid');
  }
  if (typeof checkpoint.consequenceSweepActive !== 'boolean' || !Array.isArray(checkpoint.consequenceSweepIds)) {
    throw new Error('legacy checkpoint consequence sweep is invalid');
  }
  const nextWake = checkpoint.nextWake === null ? null : validateWakeTransition(checkpoint.nextWake);
  const runtimeFailure = checkpoint.runtimeFailure === null ? null : jsonValue(checkpoint.runtimeFailure, 'legacy runtime failure');
  return {
    format: 'music-legacy-checkpoint-1',
    deltaIds: [...new Set(checkpoint.deltaIds)],
    pendingDeltas: structuredClone(checkpoint.pendingDeltas),
    consequences: structuredClone(checkpoint.consequences),
    invocationHistory: structuredClone(checkpoint.invocationHistory),
    invocations: structuredClone(checkpoint.invocations),
    contactedInvocationIds: [...new Set(checkpoint.contactedInvocationIds)],
    consequenceSweepActive: checkpoint.consequenceSweepActive,
    consequenceSweepIds: [...checkpoint.consequenceSweepIds],
    nextWake,
    runtimeFailure,
  };
}

function hydrateLegacyCheckpoint(state, checkpoint) {
  state.invocationHistory = new Map(checkpoint.invocationHistory.map(entry => [entry.invocationId, structuredClone(entry.invocation)]));
  state.invocationIds = new Set(state.invocationHistory.keys());
  state.invocations = structuredClone(checkpoint.invocations);
  state.contactedInvocationIds = new Set(checkpoint.contactedInvocationIds);
  state.deltaIds = new Set(checkpoint.deltaIds);
  state.pendingDeltas = structuredClone(checkpoint.pendingDeltas);
  for (const delta of state.pendingDeltas) {
    if (!state.deltaIds.has(delta.id)) throw new Error(`legacy checkpoint omits pending Delta id: ${delta.id}`);
    validateConsequenceReferences(delta, state);
  }
  state.consequences = new Map();
  state.consequenceDeltaIds = new Set();
  for (const { deltaId, consequence } of checkpoint.consequences) {
    if (deltaId !== consequence.delta.id || !state.deltaIds.has(deltaId)) throw new Error('legacy checkpoint consequence identity mismatch');
    validateConsequenceReferences(consequence.delta, state);
    state.consequences.set(deltaId, structuredClone(consequence));
    state.consequenceDeltaIds.add(deltaId);
  }
  state.consequenceSweepActive = checkpoint.consequenceSweepActive;
  state.consequenceSweepIds = [...checkpoint.consequenceSweepIds];
  for (const deltaId of state.consequenceSweepIds) {
    if (!state.consequences.has(deltaId)) throw new Error(`legacy checkpoint sweep cites unknown consequence: ${deltaId}`);
  }
  state.runtimeFailure = checkpoint.runtimeFailure === null ? undefined : structuredClone(checkpoint.runtimeFailure);
}

function validateDelta(delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('Delta must be an object');
  if (delta.authority !== 'world') throw new Error('Delta must have world authority');
  if (typeof delta.id !== 'string' || !delta.id.trim() || delta.id.length > 128) throw new Error('Delta needs a bounded id');
  if (typeof delta.stream !== 'string' || !delta.stream.trim() || delta.stream.length > 128) throw new Error('Delta needs a bounded stream');
  if (typeof delta.at !== 'string' || Number.isNaN(Date.parse(delta.at))) throw new Error('Delta needs an ISO timestamp');
  if (delta.bearsOn !== undefined) {
    if (!Array.isArray(delta.bearsOn) || delta.bearsOn.length < 1 || delta.bearsOn.length > 32) {
      throw new Error('Delta bearsOn must contain 1-32 causal references');
    }
    const references = new Set();
    for (const reference of delta.bearsOn) {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        throw new Error('invalid Delta causal reference');
      }
      let key;
      if (reference.kind === 'tool-invocation'
        && typeof reference.invocationId === 'string' && reference.invocationId.trim()
        && reference.invocationId.length <= 128
        && !Object.keys(reference).some(field => !['kind', 'invocationId'].includes(field))) {
        key = `tool-invocation:${reference.invocationId}`;
      } else if (reference.kind === 'trajectory-election'
        && typeof reference.electionId === 'string' && reference.electionId.trim()
        && reference.electionId.length <= 128
        && !Object.keys(reference).some(field => !['kind', 'electionId'].includes(field))) {
        key = `trajectory-election:${reference.electionId}`;
      } else {
        throw new Error('invalid Delta causal reference');
      }
      if (references.has(key)) throw new Error(`Delta repeats causal reference: ${key}`);
      references.add(key);
    }
  }
  if (Buffer.byteLength(canonical(delta)) > MAX_DELTA_BYTES) throw new Error(`Delta exceeds ${MAX_DELTA_BYTES} bytes`);
}

function validateConsequenceReferences(delta, state) {
  for (const reference of delta.bearsOn ?? []) {
    if (reference.kind === 'tool-invocation' && !state.invocationIds.has(reference.invocationId)) {
      throw new Error(`Delta cites unknown tool invocation: ${reference.invocationId}`);
    }
    if (reference.kind === 'trajectory-election' && !state.trajectoryElectionIds.has(reference.electionId)) {
      throw new Error(`Delta cites unknown trajectory election: ${reference.electionId}`);
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

function executionEnvironmentReceipt(environment) {
  const dependencyRoot = typeof environment?.dependencyRoot === 'string'
    ? environment.dependencyRoot.trim()
    : '';
  const files = dependencyRoot
    ? ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].map(name => {
      const path = join(dependencyRoot, name);
      try {
        const bytes = readFileSync(path);
        return {
          name,
          status: 'present',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      } catch (error) {
        if (error?.code === 'ENOENT') return { name, status: 'absent' };
        return {
          name,
          status: 'unreadable',
          code: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'unknown',
        };
      }
    })
    : [];
  const dependencyHabitat = dependencyRoot
    ? { root: dependencyRoot, files }
    : null;
  const unsealed = {
    format: 'music-execution-environment-1',
    scope: 'declared-resident-dependency-manifests-not-arbitrary-files-or-external-state',
    dependencyHabitat,
  };
  return { ...unsealed, digest: digest(unsealed) };
}

function validateExecutionEnvironmentReceipt(value, { optional = false } = {}) {
  if (value === undefined && optional) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format !== 'music-execution-environment-1'
    || typeof value.scope !== 'string'
    || typeof value.digest !== 'string') {
    throw new Error('invalid execution environment receipt');
  }
  const unsealed = {
    format: value.format,
    scope: value.scope,
    dependencyHabitat: value.dependencyHabitat ?? null,
  };
  if (digest(unsealed) !== value.digest) throw new Error('execution environment receipt digest mismatch');
  return structuredClone(value);
}

function mergeDevelopmentalEvidence(left, right) {
  return boundedEvidence([...new Set([...left, ...right])]);
}

function retainConsequenceEvidence(deltaIds, encounter, state) {
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
    if (!delta.bearsOn?.length) throw new Error(`Delta does not bear on retained causal activity: ${deltaId}`);
    return {
      deltaId,
      ...causalLineage(delta, state),
    };
  });
}

function causalLineage(delta, state) {
  const invocationIds = delta.bearsOn
    .filter(reference => reference.kind === 'tool-invocation')
    .map(reference => reference.invocationId);
  const electionIds = new Set(delta.bearsOn
    .filter(reference => reference.kind === 'trajectory-election')
    .map(reference => reference.electionId));
  for (const invocationId of invocationIds) {
    const electionId = state.invocationHistory.get(invocationId)?.trajectoryElectionReceipt;
    if (electionId) electionIds.add(electionId);
  }
  return {
    invocationIds,
    ...(electionIds.size === 0 ? {} : { electionIds: [...electionIds] }),
  };
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

function dueUnpresentedOpening(state, now) {
  const opening = state.position?.activeOpening;
  if (!opening || state.presentedOpeningIds.has(opening.id)) return null;
  if (opening.notBefore !== null && now < Date.parse(opening.notBefore)) return null;
  return opening;
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

function trajectoryElectionOpportunity(state, trigger) {
  if (!['opening', 'scheduled', 'heartbeat'].includes(trigger)) return {};
  if ((state.pendingDeltas?.length ?? 0) > 0
    || (state.consequences instanceof Map && projectUnresolvedConsequences(state).length > 0)) return {};
  const selector = state.tools.get(TRAJECTORY_ELECTION_TOOL_ID);
  const reviewer = state.tools.get(DEVELOPMENTAL_REVIEW_TOOL_ID);
  if (!selector || !reviewer) return {};
  return {
    trajectoryElection: {
      format: 'music-trajectory-election-opportunity-2',
      occasion: trigger === 'heartbeat' ? 'instruction-free-recurrence' : 'subject-opening-recurrence',
      reviewer: {
        id: reviewer.id,
        version: reviewer.version,
        digest: toolModuleDigest(reviewer),
      },
      selector: {
        id: selector.id,
        version: selector.version,
        digest: toolModuleDigest(selector),
      },
      consequenceAddressable: true,
      entry: 'required',
      actionObligation: false,
      quietPermitted: true,
      frontier: {
        minimumCandidates: 2,
        minimumExecutableCandidates: 1,
      },
    },
  };
}

// Event format 12 already contains the earlier, optional heartbeat opportunity.
// It remains reconstructable history; only newly opened Soundings receive the
// stronger recurrence entry contract above.
function legacyTrajectoryElectionOpportunity(state, trigger) {
  if (trigger !== 'heartbeat') return {};
  const selector = state.tools.get(TRAJECTORY_ELECTION_TOOL_ID);
  if (!selector) return {};
  return {
    trajectoryElection: {
      format: 'music-trajectory-election-opportunity-1',
      occasion: 'instruction-free-recurrence',
      selector: {
        id: selector.id,
        version: selector.version,
        digest: toolModuleDigest(selector),
      },
      consequenceAddressable: true,
      obligation: false,
    },
  };
}

function requireRecurrenceElection(state, inferenceId) {
  const opportunity = state.activeEncounter?.sounding?.trajectoryElection;
  if (opportunity?.entry !== 'required') return;
  const reviews = [...state.developmentalReviews.values()]
    .filter(review => review.inferenceId === inferenceId);
  if (reviews.length !== 1) {
    throw new Error(`recurrence inference requires exactly one retained developmental review; found ${reviews.length}`);
  }
  const elections = [...state.trajectoryElections.values()]
    .filter(election => election.inferenceId === inferenceId);
  if (elections.length !== 1) {
    throw new Error(`recurrence inference requires exactly one retained trajectory election; found ${elections.length}`);
  }
  if (elections[0].reviewId !== reviews[0].reviewId) {
    throw new Error('recurrence trajectory election must judge the retained developmental review');
  }
  if (!state.deliveredTrajectoryContextIds.has(elections[0].electionId)) {
    throw new Error('recurrence inference must receive its retained trajectory context before completion');
  }
  if (!elections[0].candidates.some(candidate => candidate?.action?.kind === 'tool')) {
    throw new Error('recurrence trajectory frontier requires at least one executable contact candidate');
  }
}

function planSoundingSurface(state, base, { includeCausalLineage = true } = {}) {
  const pending = state.pendingDeltas;
  const sweep = currentConsequenceSweep(state, { includeCausalLineage });
  const binding = state.tools.get(ENCOUNTER_SHAPE_TOOL_ID);
  if (!binding) throw new Error(`active geometry lacks ${ENCOUNTER_SHAPE_TOOL_ID}`);
  let deltas = [];
  let unresolvedConsequences = [];
  let pendingBlocked = false;
  let consequenceBlocked = false;

  const candidate = (nextDeltas = deltas, nextConsequences = unresolvedConsequences) => ({
    deltas: structuredClone(nextDeltas),
    ...(includeCausalLineage ? { deltaLineage: projectDeltaLineage(nextDeltas, state) } : {}),
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

function projectDeltaLineage(deltas, state) {
  return deltas
    .filter(delta => delta.bearsOn?.length)
    .map(delta => ({ deltaId: delta.id, ...causalLineage(delta, state) }));
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

function currentConsequenceSweep(state, { includeCausalLineage = true } = {}) {
  const available = projectUnresolvedConsequences(state, { includeCausalLineage });
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
      ...(sounding.development ? [projectionFact('sounding:development', sounding.development)] : []),
      ...(sounding.developmentalTrial
        ? [projectionFact('sounding:developmental-trial', sounding.developmentalTrial)] : []),
      ...(sounding.trajectoryElection
        ? [projectionFact('sounding:trajectory-election', sounding.trajectoryElection)] : []),
      projectionFact('sounding:frontier', sounding.frontier),
      ...(sounding.wake ? [projectionFact('sounding:wake', sounding.wake)] : []),
      ...(sounding.deltaLineage?.length
        ? [projectionFact('sounding:delta-lineage', sounding.deltaLineage)] : []),
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
    development: {
      format: 'music-developmental-frontier-1', available: 0, included: 0, remaining: 0,
      queueDigest: digest([]), page: { index: 0, count: 1 }, proposals: [],
    },
    ...trajectoryElectionOpportunity({ tools }, 'heartbeat'),
    wake: null,
    deltaLineage: [],
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
          ...(sounding.development ? [projectionFact('sounding:development', sounding.development)] : []),
          ...(sounding.developmentalTrial
            ? [projectionFact('sounding:developmental-trial', sounding.developmentalTrial)] : []),
          ...(sounding.trajectoryElection
            ? [projectionFact('sounding:trajectory-election', sounding.trajectoryElection)] : []),
          ...(sounding.deltaLineage?.length
            ? [projectionFact('sounding:delta-lineage', sounding.deltaLineage)] : []),
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
    ...causalLineage(consequence.delta, state),
  };
}

function validateRetainedConsequences(consequences, encounter, state) {
  if (!Array.isArray(consequences)) throw new Error('staged change lacks consequence lineage');
  const expected = retainConsequenceEvidence(consequences.map(consequence => consequence?.deltaId), encounter, state);
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
    consequences: validateRetainedConsequences(payload.consequences, state.activeEncounter, state),
    previousTool,
    tool,
    rollbackOf,
  };
}

function validateOfferedRevision(payload, state) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('developmental offer lacks a tool revision');
  }
  const tool = validateToolModule(payload.tool);
  if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
  const current = state.tools.get(tool.id);
  const previousTool = current ? toolModuleDigest(current) : null;
  if (payload.previousTool !== previousTool) throw new Error('offered tool revision ancestry mismatch');
  if (current && (tool.version !== current.version + 1 || tool.parent !== previousTool)) {
    throw new Error('offered tool revision does not succeed the active geometry');
  }
  if (!current && (tool.version !== 1 || tool.parent !== null)) throw new Error('offered new tool has invalid ancestry');
  if (payload.inferenceId !== null || payload.soundingId !== null || payload.projection !== null) {
    throw new Error('release-offered machinery cannot claim resident inference authorship');
  }
  if (payload.rollbackOf !== null) throw new Error('release-offered machinery cannot claim resident rollback authorship');
  const interpretation = typeof payload.interpretation === 'string' ? payload.interpretation.trim() : '';
  if (!interpretation || interpretation.length > 4_096) throw new Error('offered revision needs a bounded interpretation');
  if (!Array.isArray(payload.consequences) || payload.consequences.length !== 0) {
    throw new Error('release-offered machinery cannot claim resident consequence lineage');
  }
  return {
    inferenceId: null,
    soundingId: null,
    projection: null,
    interpretation,
    evidence: boundedEvidence(payload.evidence),
    consequences: [],
    previousTool,
    tool,
    rollbackOf: null,
  };
}

function validateDevelopmentalOffer(value, tool) {
  const offer = jsonValue(value, 'developmental offer provenance');
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)
    || offer.format !== 'music-developmental-offer-1'
    || offer.authority !== 'release'
    || !offer.release || typeof offer.release !== 'object' || Array.isArray(offer.release)
    || typeof offer.release.commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(offer.release.commit)
    || typeof offer.release.version !== 'string' || !offer.release.version.trim() || offer.release.version.length > 128
    || offer.release.workingTreeClean !== true
    || typeof offer.release.workingTreeStateSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(offer.release.workingTreeStateSha256)
    || !offer.tool || typeof offer.tool !== 'object' || Array.isArray(offer.tool)
    || offer.tool.id !== tool.id || offer.tool.digest !== toolModuleDigest(tool)
    || Object.keys(offer).some(key => !['format', 'authority', 'release', 'tool'].includes(key))
    || Object.keys(offer.release).some(key => !['commit', 'version', 'workingTreeClean', 'workingTreeStateSha256'].includes(key))
    || Object.keys(offer.tool).some(key => !['id', 'digest'].includes(key))) {
    throw new Error('invalid developmental offer provenance');
  }
  return offer;
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

function projectCarrierTransition(payload, encounter, state) {
  const interpretation = typeof payload.interpretation === 'string' ? payload.interpretation.trim() : '';
  if (!interpretation || interpretation.length > 4_096) throw new Error('staged carrier transition needs a bounded interpretation');
  return {
    interpretation,
    evidence: boundedEvidence(payload.evidence),
    consequences: validateRetainedConsequences(payload.consequences, encounter, state),
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

function validateDevelopmentalReview(frontier, encounter) {
  const value = jsonValue(frontier, 'developmental review');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.findings) || value.findings.length < 1 || value.findings.length > 24
    || !Array.isArray(value.candidates) || value.candidates.length < 2
    || value.candidates.length > MAX_SELECTION_CANDIDATES) {
    throw new Error('developmental review needs bounded findings and candidates');
  }
  if (Buffer.byteLength(canonical({ findings: value.findings, candidates: value.candidates })) > MAX_SELECTION_BYTES) {
    throw new Error(`developmental review exceeds ${MAX_SELECTION_BYTES} bytes`);
  }
  const findingIds = new Set();
  const findings = value.findings.map(finding => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)
      || typeof finding.id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(finding.id)
      || findingIds.has(finding.id)
      || !['harm', 'constraint', 'unresolved-stake', 'opportunity', 'maintenance'].includes(finding.class)
      || !['critical', 'high', 'medium', 'low', 'background'].includes(finding.severity)
      || !['immediate', 'near', 'eventual', 'none'].includes(finding.urgency)
      || !['critical', 'high', 'medium', 'low', 'none', 'unknown'].includes(finding.costOfDelay)
      || typeof finding.condition !== 'string' || !finding.condition.trim() || finding.condition.length > 2_048
      || !Array.isArray(finding.evidence) || finding.evidence.length < 1 || finding.evidence.length > 16
      || finding.evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)) {
      throw new Error('invalid developmental review finding');
    }
    findingIds.add(finding.id);
    return structuredClone(finding);
  });
  const candidateIds = new Set();
  let executable = 0;
  const candidates = value.candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(candidate.id)
      || candidateIds.has(candidate.id)
      || typeof candidate.description !== 'string' || !candidate.description.trim() || candidate.description.length > 2_048
      || !Array.isArray(candidate.addressesFindingIds) || candidate.addressesFindingIds.length < 1
      || candidate.addressesFindingIds.length > 24
      || new Set(candidate.addressesFindingIds).size !== candidate.addressesFindingIds.length
      || candidate.addressesFindingIds.some(id => !findingIds.has(id))) {
      throw new Error('invalid developmental review candidate');
    }
    candidateIds.add(candidate.id);
    const action = candidate.action;
    if (!action || typeof action !== 'object' || Array.isArray(action) || !['tool', 'quiet'].includes(action.kind)) {
      throw new Error(`review candidate ${candidate.id} needs a typed action`);
    }
    if (action.kind === 'tool') {
      if (typeof action.tool !== 'string' || !action.tool
        || !action.input || typeof action.input !== 'object' || Array.isArray(action.input)
        || [DEVELOPMENTAL_REVIEW_TOOL_ID, TRAJECTORY_ELECTION_TOOL_ID].includes(action.tool)
        || !encounter.toolBindings.has(action.tool)) {
        throw new Error(`review candidate ${candidate.id} needs an available non-organ tool action`);
      }
      executable += 1;
    } else if (action.tool !== undefined || action.input !== undefined) {
      throw new Error(`quiet review candidate ${candidate.id} cannot carry a tool action`);
    }
    return structuredClone(candidate);
  });
  if (executable < 1) throw new Error('developmental review needs at least one executable contact candidate');
  return { findings, candidates };
}

function validateTrajectoryEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 2_048
    || typeof value.direction !== 'string' || !value.direction.trim() || value.direction.length > 2_048
    || !['immediate', 'near', 'open-ended'].includes(value.horizon)
    || !Array.isArray(value.successSignals) || value.successSignals.length < 1 || value.successSignals.length > 8
    || value.successSignals.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)
    || !Array.isArray(value.reconsiderWhen) || value.reconsiderWhen.length < 1 || value.reconsiderWhen.length > 8
    || value.reconsiderWhen.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)) {
    throw new Error('invalid trajectory envelope');
  }
  return structuredClone(value);
}

function validateTrajectoryElectionFrontier(frontier, state = null) {
  if (!frontier || typeof frontier !== 'object' || Array.isArray(frontier)) {
    throw new Error('trajectory election frontier must be an object');
  }
  if (frontier.reviewId !== undefined) {
    if (!state) throw new Error('review-bound trajectory election needs retained state');
    const review = state.developmentalReviews.get(frontier.reviewId);
    if (!review) throw new Error(`trajectory election cites unknown developmental review: ${frontier.reviewId}`);
    if (review.inferenceId !== state.activeInferenceId
      || review.soundingId !== state.activeEncounter?.sounding?.id
      || review.projection !== state.activeEncounter?.projection) {
      throw new Error('trajectory election review is not bound to the active encounter');
    }
    if (!Array.isArray(frontier.assessments) || frontier.assessments.length !== review.candidates.length) {
      throw new Error('trajectory election must assess every frozen review candidate exactly once');
    }
    const assessments = new Map();
    for (const assessment of frontier.assessments) {
      if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)
        || typeof assessment.candidateId !== 'string' || assessments.has(assessment.candidateId)
        || !review.candidates.some(candidate => candidate.id === assessment.candidateId)
        || typeof assessment.worldValid !== 'boolean' || typeof assessment.reversible !== 'boolean'
        || typeof assessment.heldRepeat !== 'boolean'
        || !Array.isArray(assessment.completedFloors) || assessment.completedFloors.length > 16
        || !Number.isInteger(assessment.predictedExpansion) || !Number.isInteger(assessment.actionableRegret)
        || typeof assessment.basis !== 'string' || !assessment.basis.trim() || assessment.basis.length > 2_048) {
        throw new Error('invalid trajectory candidate assessment');
      }
      assessments.set(assessment.candidateId, structuredClone(assessment));
    }
    const candidates = review.candidates.map(candidate => {
      const assessment = assessments.get(candidate.id);
      return {
        ...structuredClone(candidate),
        geometry: {
          worldValid: assessment.worldValid,
          reversible: assessment.reversible,
          heldRepeat: assessment.heldRepeat,
          completedFloors: structuredClone(assessment.completedFloors),
          predictedExpansion: assessment.predictedExpansion,
          actionableRegret: assessment.actionableRegret,
          basis: assessment.basis,
        },
      };
    });
    if (typeof frontier.selectedCandidateId !== 'string'
      || !candidates.some(candidate => candidate.id === frontier.selectedCandidateId)) {
      throw new Error('selected trajectory candidate is absent from frozen review');
    }
    const selected = candidates.find(candidate => candidate.id === frontier.selectedCandidateId);
    return {
      reviewId: review.reviewId,
      reviewDigest: digest({ findings: review.findings, candidates: review.candidates }),
      assessments: structuredClone(frontier.assessments),
      candidates,
      selectedCandidateId: frontier.selectedCandidateId,
      selected,
      trajectory: validateTrajectoryEnvelope(frontier.trajectory),
    };
  }
  if (!Array.isArray(frontier.candidates) || frontier.candidates.length < 2
    || frontier.candidates.length > MAX_SELECTION_CANDIDATES) {
    throw new Error(`trajectory election frontier needs 2-${MAX_SELECTION_CANDIDATES} candidates`);
  }
  if (Buffer.byteLength(canonical(frontier.candidates)) > MAX_SELECTION_BYTES) {
    throw new Error(`trajectory election frontier exceeds ${MAX_SELECTION_BYTES} bytes`);
  }
  const ids = new Set();
  const candidates = frontier.candidates.map(candidate => {
    const value = jsonValue(candidate, 'trajectory election candidate');
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value.id)) {
      throw new Error('invalid trajectory election candidate');
    }
    if (ids.has(value.id)) throw new Error(`duplicate trajectory election candidate id: ${value.id}`);
    ids.add(value.id);
    return value;
  });
  if (typeof frontier.selectedCandidateId !== 'string' || !ids.has(frontier.selectedCandidateId)) {
    throw new Error('selected trajectory candidate is absent from its frontier');
  }
  const selected = candidates.find(candidate => candidate.id === frontier.selectedCandidateId);
  return { candidates, selectedCandidateId: frontier.selectedCandidateId, selected };
}

function trajectoryContextMessage(election) {
  const envelope = {
    format: 'music-trajectory-envelope-1',
    authority: 'resident-trajectory-elector',
    trajectoryId: election.electionId,
    actionBinding: {
      receiptField: 'trajectoryElectionReceipt',
      receipt: election.electionId,
      appliesTo: 'the exact selected tool action',
    },
    review: election.reviewId ? { id: election.reviewId, digest: election.reviewDigest } : null,
    selectedCandidateId: election.selectedCandidateId,
    selected: structuredClone(election.selected),
    trajectory: election.trajectory ? structuredClone(election.trajectory) : {
      objective: election.selected?.description ?? 'Continue under the elected candidate.',
      direction: election.selected?.geometry?.basis ?? 'Let later world contact correct this selection.',
      horizon: 'near',
      successSignals: ['The selected contact bears observable consequence.'],
      reconsiderWhen: ['World contact contradicts the elected basis.'],
    },
  };
  return {
    role: 'user',
    content: `<music_trajectory_context>${canonical(envelope)}</music_trajectory_context>`,
  };
}

function trajectoryToolSelectionFrontier(manifest, election) {
  if (!manifest.selection) throw new Error(`tool ${manifest.id} does not require nested selection geometry`);
  const candidates = election.candidates
    .filter(candidate => candidate?.action?.kind === 'tool' && candidate.action.tool === manifest.id)
    .map(candidate => ({ id: candidate.id, input: structuredClone(candidate.action.input) }));
  return {
    tool: manifest.id,
    candidates,
    selectedCandidateId: election.selectedCandidateId,
  };
}

function groundTrajectoryFloors(candidates, state) {
  const grounded = candidates.map(candidate => {
    const floors = candidate?.geometry?.completedFloors;
    if (!Array.isArray(floors) || floors.length > 16) {
      throw new Error(`trajectory candidate ${candidate?.id ?? '<unknown>'} needs 0-16 completed floor references`);
    }
    const seen = new Set();
    const references = floors.map(reference => {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        throw new Error(`trajectory candidate ${candidate.id} completed floors must be exact retained references`);
      }
      const kind = reference.kind;
      const id = typeof reference.id === 'string' ? reference.id.trim() : '';
      if (!['world-delta', 'tool-invocation', 'trajectory-election', 'developmental-proposal', 'active-tool'].includes(kind)
        || !id || id.length > 128) {
        throw new Error(`trajectory candidate ${candidate.id} has an invalid completed floor reference`);
      }
      const key = `${kind}:${id}`;
      if (seen.has(key)) throw new Error(`trajectory candidate ${candidate.id} repeats a completed floor`);
      seen.add(key);
      if (kind === 'world-delta' && !state.deltaIds.has(id)) {
        throw new Error(`trajectory candidate ${candidate.id} cites unknown world Delta floor: ${id}`);
      }
      if (kind === 'tool-invocation' && state.invocationHistory.get(id)?.status !== 'completed') {
        throw new Error(`trajectory candidate ${candidate.id} cites an incomplete tool invocation floor: ${id}`);
      }
      if (kind === 'trajectory-election' && !state.trajectoryElections.has(id)) {
        throw new Error(`trajectory candidate ${candidate.id} cites unknown trajectory election floor: ${id}`);
      }
      if (kind === 'developmental-proposal') {
        const proposal = state.developmentalProposals.get(id);
        if (!proposal || !['admitted', 'rolled-back'].includes(proposal.status)) {
          throw new Error(`trajectory candidate ${candidate.id} cites an unadmitted developmental floor: ${id}`);
        }
      }
      let digestValue;
      if (kind === 'active-tool') {
        const tool = state.tools.get(id);
        digestValue = typeof reference.digest === 'string' ? reference.digest : '';
        if (!tool || digestValue !== toolModuleDigest(tool)) {
          throw new Error(`trajectory candidate ${candidate.id} cites a non-current active tool floor: ${id}`);
        }
      } else if (reference.digest !== undefined) {
        throw new Error(`trajectory candidate ${candidate.id} ${kind} floor cannot carry a digest`);
      }
      return {
        kind,
        id,
        ...(kind === 'active-tool' ? { digest: digestValue } : {}),
      };
    });
    return { candidateId: candidate.id, references };
  });
  return {
    format: 'music-trajectory-floor-grounding-1',
    scope: 'reference-existence-and-current-status-not-subject-interpretation',
    candidates: grounded,
  };
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

function authorizeTrajectoryElection(state, encounter, manifest, input, electionReceipt) {
  if (electionReceipt === null || electionReceipt === undefined) return null;
  if (typeof electionReceipt !== 'string' || !electionReceipt) {
    throw new Error('trajectory election receipt must be a nonempty id');
  }
  const election = state.trajectoryElections.get(electionReceipt);
  if (!election) throw new Error(`unknown trajectory election: ${electionReceipt}`);
  if (state.usedTrajectoryElectionIds.has(electionReceipt)) {
    throw new Error(`trajectory election receipt already used: ${electionReceipt}`);
  }
  if (election.inferenceId !== state.activeInferenceId
    || election.soundingId !== encounter.sounding.id
    || election.projection !== encounter.projection
    || election.carrierRoot !== encounter.sounding.carrier.root) {
    throw new Error('trajectory election receipt is not bound to the active encounter geometry');
  }
  const action = election.selected?.action;
  if (!action || action.kind !== 'tool' || action.tool !== manifest.id
    || canonical(action.input) !== canonical(input)) {
    throw new Error('tool invocation does not match the elected trajectory action');
  }
  return election;
}

function trajectoryBasis(toolId, electionId) {
  if (toolId === TRAJECTORY_ELECTION_TOOL_ID) {
    return { kind: 'selector', electionId: null };
  }
  return electionId
    ? { kind: 'elected', electionId }
    : { kind: 'ad-hoc', electionId: null };
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

function projectUnresolvedConsequences(state, { includeCausalLineage = true } = {}) {
  const pendingIds = new Set(state.pendingDeltas.map(delta => delta.id));
  return [...state.consequences.values()]
    .filter(consequence => consequence.status !== 'settled' && !pendingIds.has(consequence.delta.id))
    .sort((left, right) => left.delta.at.localeCompare(right.delta.at) || left.delta.id.localeCompare(right.delta.id))
    .map(consequence => projectConsequence(consequence, state, includeCausalLineage));
}

function projectConsequence(consequence, state, includeCausalLineage) {
  return {
    delta: structuredClone(consequence.delta),
    ...(includeCausalLineage ? { causalLineage: causalLineage(consequence.delta, state) } : {}),
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
