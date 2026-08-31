import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './canonical.js';
import { applyCarrierTransition, createCarrierTransition, initialCarrier, projectCarrier, readCarrier, serializeCarrier } from './carrier.js';
import { executeToolModule, toolModuleDigest, validateToolModule } from './tool-module.js';
import { initialFilePatchTool } from '../tools/file-patch.js';
import { initialMessageTool } from '../tools/message.js';
import { initialSelectionTool } from '../tools/select-tool-action.js';
import { initialConsequenceTool } from '../tools/attend-consequence.js';
import { initialEncounterShapeTool } from '../tools/shape-encounter.js';

const FORMAT = 'music-event-8';
const ENCOUNTER_SHAPE_TOOL_ID = 'shape_encounter';
const MAX_TOOLS = 32;
const MAX_SELECTION_CANDIDATES = 16;
const MAX_SELECTION_BYTES = 64 * 1_024;
const MAX_DELTA_BYTES = 64 * 1_024;
const MAX_INFERENCE_BYTES = 2 * 1_024 * 1_024;
const RESERVED_TOOL_IDS = new Set(['inspect_tool', 'revise_tool', 'rollback_tool', 'revise_carrier']);

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
  }

  initialize(name) {
    if (this.events().length !== 0) throw new Error('Music subject already exists');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > 128) throw new Error('subject name must be 1-128 characters');
    this.append('subject_created', {
      subject: { id: this.id(), name: trimmed, bornAt: this.clock().toISOString() },
      tools: [initialMessageTool(), initialFilePatchTool(), initialSelectionTool(), initialConsequenceTool(), initialEncounterShapeTool()],
      carrier: serializeCarrier(initialCarrier()),
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

  openSounding(trigger = 'manual') {
    const state = this.state();
    requireSubject(state);
    if (state.activeInferenceId) throw new Error(`cannot open a Sounding while inference is active: ${state.activeInferenceId}`);
    if (state.openSoundingId) throw new Error(`an opened Sounding is still awaiting an encounter: ${state.openSoundingId}`);
    if (!['delta', 'heartbeat', 'manual'].includes(trigger)) throw new Error('invalid Sounding trigger');
    const sounding = {
      id: this.id(),
      subject: structuredClone(state.subject),
      parent: state.head,
      at: this.clock().toISOString(),
      trigger,
      deltas: structuredClone(state.pendingDeltas),
      unresolvedConsequences: projectUnresolvedConsequences(state),
      tools: [...state.tools.values()].sort((a, b) => a.id.localeCompare(b.id)).map(projectTool),
      carrier: projectCarrier(state.carrier),
    };
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

  pendingSteeringDeltas(inferenceId) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    return structuredClone(state.pendingDeltas);
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
    if (Buffer.byteLength(canonical(payload)) > MAX_INFERENCE_BYTES) throw new Error(`steering checkpoint exceeds ${MAX_INFERENCE_BYTES} bytes`);
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

  completeInference(inferenceId, result) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    const stagedRevisions = state.stagedRevisions.map(revision => structuredClone(revision));
    const stagedCarrierTransition = state.stagedCarrierTransition ? structuredClone(state.stagedCarrierTransition) : null;
    const stagedConsequenceTransitions = state.stagedConsequenceTransitions.map(transition => structuredClone(transition));
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
    }, 'inference result');
    if (Buffer.byteLength(canonical(payload)) > MAX_INFERENCE_BYTES) throw new Error(`inference result exceeds ${MAX_INFERENCE_BYTES} bytes`);
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
    if (Buffer.byteLength(canonical(payload)) > MAX_INFERENCE_BYTES) throw new Error(`inference failure exceeds ${MAX_INFERENCE_BYTES} bytes`);
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
      unresolvedConsequences: [...state.consequences.values()].filter(consequence => consequence.status !== 'settled').length,
      deferredConsequences: [...state.consequences.values()].filter(consequence => consequence.status === 'deferred').length,
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
    const text = readFileSync(this.ledgerPath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const events = lines.map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`invalid JSON at ledger line ${index + 1}`); }
    });
    verifyChain(events);
    return events;
  }

  append(type, payload) {
    const events = this.events();
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
      writeSync(descriptor, `${canonical(event)}\n`, null, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return event;
  }
}

function reduceEvents(events) {
  const state = {
    head: null,
    subject: null,
    tools: new Map(),
    toolHistory: new Map(),
    carrier: new Map(),
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
        break;
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
        if (digest(sounding.unresolvedConsequences) !== digest(projectUnresolvedConsequences(state))) {
          throw new Error('Sounding unresolved consequence projection mismatch');
        }
        if (state.openSoundingId || state.activeInferenceId) throw new Error('ledger opens overlapping Soundings');
        if (state.soundings.has(sounding.id)) throw new Error(`ledger repeats Sounding id: ${sounding.id}`);
        const toolBindings = bindProjectedTools(state.tools, sounding.tools);
        state.soundings.set(sounding.id, {
          sounding: structuredClone(sounding),
          projection: event.payload.projection,
          toolBindings,
          steeringDeltas: [],
          status: 'opened',
          inferenceId: null,
        });
        state.openSoundingId = sounding.id;
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
      case 'inference_steered': {
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
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
        if ([...state.activeToolInvocations.values()].some(invocation => invocation.inferenceId === event.payload.inferenceId)) {
          throw new Error('cannot complete inference with an uncertain tool invocation');
        }
        if (!Array.isArray(event.payload.responseMessages)) throw new Error('completed inference lacks response messages');
        if (!Array.isArray(event.payload.activatedRevisions)) throw new Error('completed inference lacks activated revisions');
        if (event.payload.activatedRevisions.length !== state.stagedRevisions.length
          || event.payload.activatedRevisions.some((revision, index) => digest(revision) !== digest(state.stagedRevisions[index]))) {
          throw new Error('completed inference activation does not match staged revisions');
        }
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
        state.messages.push(...structuredClone(event.payload.responseMessages));
        state.activeEncounter.status = 'completed';
        state.activeInferenceId = null;
        state.activeEncounter = null;
        state.stagedRevisions = [];
        state.stagedToolIds = new Set();
        state.stagedCarrierTransition = null;
        state.stagedConsequenceTransitions = [];
        state.stagedConsequenceIds = new Set();
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
        if (!Array.isArray(event.payload.checkpointMessages)) throw new Error('failed inference lacks checkpoint messages');
        state.messages.push(...structuredClone(event.payload.checkpointMessages));
        const interruptionMessage = {
          role: 'user',
          content: `[inference_interrupted]\nThe previous inference ended unexpectedly after ${state.activeTurnMessages.length + event.payload.checkpointMessages.length} retained response and steering messages. Its error was recorded by the harness. Every world Delta delivered to that encounter has been returned to the next Sounding. Reorient from retained completed tool results rather than inventing missing output.\n[/inference_interrupted]`,
        };
        state.messages.push(interruptionMessage);
        state.recoveryMessages = [...structuredClone(state.activeTurnMessages), ...structuredClone(event.payload.checkpointMessages), interruptionMessage];
        state.pendingDeltas = requeueDeliveredDeltas(state.activeEncounter, state.pendingDeltas);
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

function verifyChain(events) {
  let parent = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.format !== FORMAT || event.sequence !== index || event.parent !== parent) {
      throw new Error(`broken event ancestry at ledger line ${index + 1}`);
    }
    const { hash, ...unsigned } = event;
    if (hash !== digest(unsigned)) throw new Error(`event digest mismatch at ledger line ${index + 1}`);
    parent = hash;
  }
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

function projectionInput(state, encounter, phase, deltaIds) {
  if (!['sounding', 'steering'].includes(phase)) throw new Error('delivery projection phase must be sounding or steering');
  const sounding = encounter.sounding;
  if (phase === 'sounding') {
    if (encounter.status !== 'opened') throw new Error('initial delivery projection requires an opened Sounding');
    if (deltaIds !== undefined && (!Array.isArray(deltaIds) || deltaIds.length !== 0)) {
      throw new Error('initial delivery projection does not accept steering Delta ids');
    }
    return {
      phase,
      soundingId: sounding.id,
      facts: [
        projectionFact('sounding:meta', { id: sounding.id, parent: sounding.parent, at: sounding.at, trigger: sounding.trigger }),
        projectionFact('sounding:subject', sounding.subject),
        projectionFact('sounding:tools', sounding.tools),
        projectionFact('sounding:carrier', sounding.carrier),
        ...sounding.deltas.map(delta => projectionFact(`delta:${delta.id}`, delta)),
        ...sounding.unresolvedConsequences.map(consequence => projectionFact(`unresolved:${consequence.delta.id}`, consequence)),
      ],
    };
  }
  if (state.activeEncounter !== encounter || state.activeInferenceId === null) {
    throw new Error('steering delivery projection requires the active encounter');
  }
  if (!matchesPendingPrefix(state.pendingDeltas, deltaIds)) {
    throw new Error('steering delivery projection does not match pending world contact');
  }
  const deltas = state.pendingDeltas.slice(0, deltaIds.length);
  return {
    phase,
    soundingId: sounding.id,
    facts: [
      projectionFact('steering:meta', { soundingId: sounding.id, projection: encounter.projection }),
      ...deltas.map(delta => projectionFact(`delta:${delta.id}`, delta)),
    ],
  };
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
  if (Buffer.byteLength(canonical(message)) > MAX_INFERENCE_BYTES) throw new Error(`delivery projection exceeds ${MAX_INFERENCE_BYTES} bytes`);
  return message;
}

function emergencyProjection(input, binding, reason) {
  return validateProjectionMessage({
    role: 'user',
    content: `[delivery_recovery]\nThe retained ${binding.manifest.id}@${binding.manifest.version} delivery module failed validation or execution: ${reason}\nExact required facts follow so the continuing subject can inspect or roll back its delivery machinery.\n[/delivery_recovery]\n${input.facts.map(fact => fact.envelope).join('\n')}`,
  }, input);
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
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}
