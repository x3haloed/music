import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './canonical.js';
import { applyCarrierTransition, createCarrierTransition, initialCarrier, projectCarrier, readCarrier, serializeCarrier } from './carrier.js';
import { executeAction, manifestDigest, validateManifest } from './geometry.js';

const FORMAT = 'music-event-3';
const MAX_TOOLS = 32;
const MAX_SELECTION_CANDIDATES = 16;
const MAX_SELECTION_BYTES = 64 * 1_024;
const MAX_DELTA_BYTES = 64 * 1_024;
const MAX_INFERENCE_BYTES = 2 * 1_024 * 1_024;
const RESERVED_TOOL_IDS = new Set(['revise_tool', 'revise_carrier', 'select_tool_action']);

export class MusicKernel {
  constructor(ledgerPath, { clock = () => new Date(), id = () => randomUUID() } = {}) {
    this.ledgerPath = ledgerPath;
    this.clock = clock;
    this.id = id;
  }

  initialize(name) {
    if (this.events().length !== 0) throw new Error('Music subject already exists');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > 128) throw new Error('subject name must be 1-128 characters');
    this.append('subject_created', {
      subject: { id: this.id(), name: trimmed, bornAt: this.clock().toISOString() },
      tools: [initialMessageTool()],
      carrier: serializeCarrier(initialCarrier()),
    });
    return this.state();
  }

  admitDelta(delta) {
    const state = this.state();
    requireSubject(state);
    validateDelta(delta);
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

  inferenceMessages(inferenceId) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId || !state.activeInputMessage) throw new Error(`inference is not active: ${inferenceId}`);
    return structuredClone([...state.recoveryMessages, state.activeInputMessage]);
  }

  stageToolRevision(inferenceId, soundingId, proposal) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const interpretation = typeof proposal?.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('revision needs a bounded interpretation');
    const requested = proposal?.tool;
    const current = state.tools.get(requested?.id);
    const tool = validateManifest({
      ...requested,
      version: current ? current.version + 1 : 1,
      parent: current ? manifestDigest(current) : null,
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
      previousTool: current ? manifestDigest(current) : null,
      tool,
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

  invokeTool(inferenceId, soundingId, toolId, actionId, input, selectionReceipt = null) {
    const state = this.state();
    const encounter = requireActiveEncounter(state, inferenceId, soundingId);
    const binding = encounter.toolBindings.get(toolId);
    if (!binding) throw new Error(`tool ${toolId} was not projected in Sounding ${soundingId}`);
    const tool = binding.manifest;
    const selection = authorizeSelection(state, encounter, tool, actionId, input, selectionReceipt);
    const output = executeAction(tool, actionId, input);
    this.append('tool_invoked', {
      inferenceId,
      soundingId,
      projection: encounter.projection,
      tool: { id: tool.id, version: tool.version, digest: manifestDigest(tool) },
      selectionReceipt: selection?.selectionId ?? null,
      action: actionId,
      input: structuredClone(input),
      output,
    });
    return output;
  }

  beginInference(soundingId, model, inputMessage) {
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
    });
    return inferenceId;
  }

  completeInference(inferenceId, result) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    const stagedRevisions = state.stagedRevisions.map(revision => structuredClone(revision));
    const stagedCarrierTransition = state.stagedCarrierTransition ? structuredClone(state.stagedCarrierTransition) : null;
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
      tools: [...state.tools.values()].map(tool => ({ id: tool.id, version: tool.version, digest: manifestDigest(tool) })),
      carrierRoot: projectCarrier(state.carrier).root,
      pendingDeltas: state.pendingDeltas.length,
      emissions: state.emissions.length,
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
    carrier: new Map(),
    deltaIds: new Set(),
    pendingDeltas: [],
    soundings: new Map(),
    openSoundingId: null,
    emissions: [],
    messages: [],
    recoveryMessages: [],
    activeInputMessage: null,
    activeInferenceId: null,
    activeEncounter: null,
    stagedRevisions: [],
    stagedToolIds: new Set(),
    stagedCarrierTransition: null,
    selections: new Map(),
    usedSelectionIds: new Set(),
    selectionCount: 0,
    inferenceIds: new Set(),
    completedInferences: 0,
    failedInferences: 0,
  };
  for (const event of events) {
    state.head = event.hash;
    switch (event.type) {
      case 'subject_created':
        if (state.subject) throw new Error('ledger contains multiple subjects');
        state.subject = structuredClone(event.payload.subject);
        for (const tool of event.payload.tools) {
          const valid = validateManifest(tool);
          state.tools.set(valid.id, valid);
        }
        state.carrier = readCarrier(event.payload.carrier);
        break;
      case 'delta_admitted': {
        requireSubject(state);
        const delta = event.payload.delta;
        validateDelta(delta);
        if (state.deltaIds.has(delta.id)) throw new Error(`ledger repeats delta id: ${delta.id}`);
        state.deltaIds.add(delta.id);
        state.pendingDeltas.push(structuredClone(delta));
        break;
      }
      case 'sounding_opened': {
        requireSubject(state);
        const sounding = event.payload.sounding;
        if (event.payload.projection !== digest(sounding)) throw new Error('Sounding projection digest mismatch');
        if (digest(sounding.carrier) !== digest(projectCarrier(state.carrier))) throw new Error('Sounding carrier projection mismatch');
        if (state.openSoundingId || state.activeInferenceId) throw new Error('ledger opens overlapping Soundings');
        if (state.soundings.has(sounding.id)) throw new Error(`ledger repeats Sounding id: ${sounding.id}`);
        const toolBindings = bindProjectedTools(state.tools, sounding.tools);
        state.soundings.set(sounding.id, {
          sounding: structuredClone(sounding),
          projection: event.payload.projection,
          toolBindings,
          status: 'opened',
          inferenceId: null,
        });
        state.openSoundingId = sounding.id;
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
        const transition = projectCarrierTransition(event.payload);
        applyCarrierTransition(state.carrier, transition);
        state.stagedCarrierTransition = transition;
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
        throw new Error('music-event-3 does not allow standalone tool activation');
      }
      case 'tool_invoked': {
        requireSubject(state);
        const encounter = requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        const binding = encounter.toolBindings.get(event.payload.tool?.id);
        if (!binding || binding.digest !== event.payload.tool.digest || binding.manifest.version !== event.payload.tool.version) {
          throw new Error('tool invocation is not bound to projected geometry');
        }
        authorizeSelection(state, encounter, binding.manifest, event.payload.action, event.payload.input, event.payload.selectionReceipt);
        if (event.payload.selectionReceipt) state.usedSelectionIds.add(event.payload.selectionReceipt);
        state.emissions.push(structuredClone(event.payload));
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
        state.messages.push(structuredClone(event.payload.inputMessage));
        break;
      }
      case 'inference_completed': {
        if (state.activeInferenceId !== event.payload.inferenceId) throw new Error('completed inference is not active');
        requireActiveEncounter(state, event.payload.inferenceId, event.payload.soundingId, event.payload.projection);
        if (!Array.isArray(event.payload.responseMessages)) throw new Error('completed inference lacks response messages');
        if (!Array.isArray(event.payload.activatedRevisions)) throw new Error('completed inference lacks activated revisions');
        if (event.payload.activatedRevisions.length !== state.stagedRevisions.length
          || event.payload.activatedRevisions.some((revision, index) => digest(revision) !== digest(state.stagedRevisions[index]))) {
          throw new Error('completed inference activation does not match staged revisions');
        }
        for (const revision of event.payload.activatedRevisions) {
          const tool = validateManifest(revision.tool);
          const current = state.tools.get(tool.id);
          if ((current ? manifestDigest(current) : null) !== revision.previousTool) throw new Error('tool revision ancestry mismatch');
          state.tools.set(tool.id, tool);
        }
        if (digest(event.payload.activatedCarrierTransition) !== digest(state.stagedCarrierTransition)) {
          throw new Error('completed inference carrier activation does not match staged transition');
        }
        if (event.payload.activatedCarrierTransition) {
          state.carrier = applyCarrierTransition(state.carrier, event.payload.activatedCarrierTransition);
        }
        state.messages.push(...structuredClone(event.payload.responseMessages));
        state.activeEncounter.status = 'completed';
        state.activeInferenceId = null;
        state.activeEncounter = null;
        state.stagedRevisions = [];
        state.stagedToolIds = new Set();
        state.stagedCarrierTransition = null;
        state.selections = new Map();
        state.usedSelectionIds = new Set();
        state.recoveryMessages = [];
        state.activeInputMessage = null;
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
          content: `[inference_interrupted]\nThe previous inference ended unexpectedly after ${event.payload.checkpointMessages.length} retained response messages. Its error was recorded by the harness. Reorient from the completed tool results and current Sounding rather than inventing missing output.\n[/inference_interrupted]`,
        };
        state.messages.push(interruptionMessage);
        state.recoveryMessages = [...structuredClone(event.payload.checkpointMessages), interruptionMessage];
        state.activeEncounter.status = 'interrupted';
        state.activeInferenceId = null;
        state.activeEncounter = null;
        state.stagedRevisions = [];
        state.stagedToolIds = new Set();
        state.stagedCarrierTransition = null;
        state.selections = new Map();
        state.usedSelectionIds = new Set();
        state.activeInputMessage = null;
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
  if (Buffer.byteLength(canonical(delta)) > MAX_DELTA_BYTES) throw new Error(`Delta exceeds ${MAX_DELTA_BYTES} bytes`);
}

function boundedEvidence(evidence) {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence) || evidence.length > 32 || evidence.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)) {
    throw new Error('revision evidence must be at most 32 bounded references');
  }
  return [...evidence];
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
    const manifest = validateManifest(active);
    const manifestHash = manifestDigest(manifest);
    const projection = projected.get(id);
    if (!projection || projection.digest !== manifestHash || projection.version !== manifest.version) {
      throw new Error(`Sounding tool binding mismatch: ${id}`);
    }
    result.set(id, { digest: manifestHash, manifest });
  }
  return result;
}

function validateStagedRevision(payload, state) {
  const tool = validateManifest(payload.tool);
  if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
  const current = state.tools.get(tool.id);
  const previousTool = current ? manifestDigest(current) : null;
  if (payload.previousTool !== previousTool) throw new Error('staged tool revision ancestry mismatch');
  if (current && (tool.version !== current.version + 1 || tool.parent !== previousTool)) {
    throw new Error('staged tool revision does not succeed the active geometry');
  }
  if (!current && (tool.version !== 1 || tool.parent !== null)) throw new Error('staged new tool has invalid ancestry');
  const interpretation = typeof payload.interpretation === 'string' ? payload.interpretation.trim() : '';
  if (!interpretation || interpretation.length > 4_096) throw new Error('staged revision needs a bounded interpretation');
  return {
    inferenceId: payload.inferenceId,
    soundingId: payload.soundingId,
    projection: payload.projection,
    interpretation,
    evidence: boundedEvidence(payload.evidence),
    previousTool,
    tool,
  };
}

function projectCarrierTransition(payload) {
  const interpretation = typeof payload.interpretation === 'string' ? payload.interpretation.trim() : '';
  if (!interpretation || interpretation.length > 4_096) throw new Error('staged carrier transition needs a bounded interpretation');
  return {
    interpretation,
    evidence: boundedEvidence(payload.evidence),
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
  const actions = new Set();
  const candidates = frontier.candidates.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('selection candidate must be an object');
    if (typeof candidate.id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(candidate.id)) throw new Error('invalid selection candidate id');
    if (ids.has(candidate.id)) throw new Error(`duplicate selection candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    if (typeof candidate.action !== 'string') throw new Error('selection candidate needs an action');
    if (actions.has(candidate.action)) throw new Error(`selection frontier repeats action: ${candidate.action}`);
    actions.add(candidate.action);
    const input = jsonValue(candidate.input, 'selection candidate input');
    executeAction(manifest, candidate.action, input);
    return { id: candidate.id, action: candidate.action, input };
  });
  if (manifest.selection.coverage === 'all-actions') {
    const required = new Set(manifest.actions.map(action => action.id));
    if (actions.size !== required.size || [...required].some(action => !actions.has(action))) {
      throw new Error(`selection frontier must cover every ${manifest.id} action exactly once`);
    }
  }
  if (typeof frontier.selectedCandidateId !== 'string' || !ids.has(frontier.selectedCandidateId)) {
    throw new Error('selected candidate is absent from selection frontier');
  }
  const selected = candidates.find(candidate => candidate.id === frontier.selectedCandidateId);
  return { candidates, selectedCandidateId: frontier.selectedCandidateId, selected };
}

function authorizeSelection(state, encounter, manifest, actionId, input, selectionReceipt) {
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
    || selection.tool.digest !== manifestDigest(manifest)) {
    throw new Error('selection receipt is not bound to the active encounter geometry');
  }
  if (selection.selected.action !== actionId || canonical(selection.selected.input) !== canonical(input)) {
    throw new Error('tool invocation does not match the selected candidate');
  }
  return selection;
}

function projectTool(tool) {
  return {
    id: tool.id,
    version: tool.version,
    digest: manifestDigest(tool),
    description: tool.description,
    actions: tool.actions.map(action => ({
      id: action.id,
      description: action.description,
      fields: structuredClone(action.fields),
    })),
    ...(tool.selection === undefined ? {} : { selection: structuredClone(tool.selection) }),
  };
}

function requireSubject(state) {
  if (!state.subject) throw new Error('Music subject has not been initialized');
}

function initialMessageTool() {
  return validateManifest({
    id: 'message',
    version: 1,
    parent: null,
    description: 'Place a message in the local outbound channel.',
    actions: [{
      id: 'send',
      description: 'Send a composed message to a named recipient.',
      fields: [
        { name: 'recipient', type: 'string', required: true, maxLength: 256 },
        { name: 'content', type: 'string', required: true, maxLength: 8_192 },
      ],
      effect: { kind: 'emit', channel: 'outbox', template: 'to={recipient}\n{content}' },
    }, {
      id: 'ask',
      description: 'Ask a short question before committing to a composed message.',
      fields: [
        { name: 'recipient', type: 'string', required: true, maxLength: 256 },
        { name: 'question', type: 'string', required: true, maxLength: 512 },
      ],
      effect: { kind: 'emit', channel: 'outbox', template: 'to={recipient}\n[question] {question}' },
    }],
    selection: {
      kind: 'frontier',
      coverage: 'all-actions',
      description: 'Author one concrete candidate for every available message action, then select one using the active carrier and present consequence.',
    },
  });
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
