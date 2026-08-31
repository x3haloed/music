import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './canonical.js';
import { executeAction, manifestDigest, validateManifest } from './geometry.js';

const FORMAT = 'music-event-1';
const MAX_TOOLS = 32;
const MAX_DELTA_BYTES = 64 * 1_024;
const MAX_INFERENCE_BYTES = 2 * 1_024 * 1_024;
const RESERVED_TOOL_IDS = new Set(['revise_tool']);

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
    if (!['delta', 'heartbeat', 'manual'].includes(trigger)) throw new Error('invalid Sounding trigger');
    const sounding = {
      id: this.id(),
      subject: structuredClone(state.subject),
      parent: state.head,
      at: this.clock().toISOString(),
      trigger,
      deltas: structuredClone(state.pendingDeltas),
      tools: [...state.tools.values()].sort((a, b) => a.id.localeCompare(b.id)).map(projectTool),
    };
    this.append('sounding_opened', {
      sounding,
      projection: digest(sounding),
      deliveredDeltaIds: sounding.deltas.map(delta => delta.id),
    });
    return sounding;
  }

  activateToolRevision(proposal) {
    const state = this.state();
    requireSubject(state);
    if (proposal?.authority !== 'agent') throw new Error('tool revision must have agent authority');
    if (proposal.parent !== state.head) throw new Error('tool revision is not bound to the current authoritative self');
    const interpretation = typeof proposal.interpretation === 'string' ? proposal.interpretation.trim() : '';
    if (!interpretation || interpretation.length > 4_096) throw new Error('revision needs a bounded interpretation');
    const tool = validateManifest(proposal.tool);
    if (RESERVED_TOOL_IDS.has(tool.id)) throw new Error(`${tool.id} is reserved by the continuity kernel`);
    const current = state.tools.get(tool.id);
    if (!current && state.tools.size >= MAX_TOOLS) throw new Error(`tool limit ${MAX_TOOLS} reached`);
    if (current) {
      if (tool.version !== current.version + 1) throw new Error('tool revision must increment the active version by one');
      if (tool.parent !== manifestDigest(current)) throw new Error('tool revision is not bound to the active tool geometry');
    } else if (tool.version !== 1 || tool.parent !== null) {
      throw new Error('a new tool must begin at version 1 with no tool parent');
    }
    this.append('tool_revision_activated', {
      authority: 'agent',
      interpretation,
      evidence: boundedEvidence(proposal.evidence),
      previousTool: current ? manifestDigest(current) : null,
      tool,
    });
    return this.state().tools.get(tool.id);
  }

  invokeTool(toolId, actionId, input, { soundingId = null } = {}) {
    const state = this.state();
    requireSubject(state);
    const tool = state.tools.get(toolId);
    if (!tool) throw new Error(`unknown tool: ${toolId}`);
    if (soundingId !== null && !state.soundingIds.has(soundingId)) throw new Error(`unknown Sounding: ${soundingId}`);
    const output = executeAction(tool, actionId, input);
    this.append('tool_invoked', {
      authority: 'agent',
      soundingId,
      tool: { id: tool.id, version: tool.version, digest: manifestDigest(tool) },
      action: actionId,
      input: structuredClone(input),
      output,
    });
    return output;
  }

  beginInference(soundingId, model, inputMessage) {
    const state = this.state();
    requireSubject(state);
    if (!state.soundingIds.has(soundingId)) throw new Error(`unknown Sounding: ${soundingId}`);
    if (state.activeInferenceId) throw new Error(`inference already active: ${state.activeInferenceId}`);
    if (typeof model?.provider !== 'string' || typeof model?.model !== 'string') throw new Error('inference needs provider and model identity');
    const message = jsonValue(inputMessage, 'inference input message');
    const inferenceId = this.id();
    this.append('inference_started', {
      inferenceId,
      soundingId,
      model: { provider: model.provider, model: model.model },
      inputMessage: message,
    });
    return inferenceId;
  }

  completeInference(inferenceId, result) {
    const state = this.state();
    if (state.activeInferenceId !== inferenceId) throw new Error(`inference is not active: ${inferenceId}`);
    const payload = jsonValue({
      inferenceId,
      responseMessages: result.responseMessages,
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      steps: result.steps,
      requests: result.requests ?? [],
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
      pendingDeltas: state.pendingDeltas.length,
      emissions: state.emissions.length,
      completedInferences: state.completedInferences,
      failedInferences: state.failedInferences,
      activeInferenceId: state.activeInferenceId,
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
    deltaIds: new Set(),
    pendingDeltas: [],
    soundingIds: new Set(),
    emissions: [],
    messages: [],
    activeInferenceId: null,
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
        state.soundingIds.add(sounding.id);
        const delivered = new Set(event.payload.deliveredDeltaIds);
        state.pendingDeltas = state.pendingDeltas.filter(delta => !delivered.has(delta.id));
        break;
      }
      case 'tool_revision_activated': {
        requireSubject(state);
        const tool = validateManifest(event.payload.tool);
        const current = state.tools.get(tool.id);
        if (current && event.payload.previousTool !== manifestDigest(current)) throw new Error('tool revision ancestry mismatch');
        if (!current && event.payload.previousTool !== null) throw new Error('new tool has a previous-tool digest');
        state.tools.set(tool.id, tool);
        break;
      }
      case 'tool_invoked':
        requireSubject(state);
        state.emissions.push(structuredClone(event.payload));
        break;
      case 'inference_started':
        requireSubject(state);
        if (state.activeInferenceId) throw new Error('ledger starts overlapping inference');
        if (!state.soundingIds.has(event.payload.soundingId)) throw new Error('inference cites an unknown Sounding');
        if (state.inferenceIds.has(event.payload.inferenceId)) throw new Error('duplicate inference id');
        state.inferenceIds.add(event.payload.inferenceId);
        state.activeInferenceId = event.payload.inferenceId;
        state.messages.push(structuredClone(event.payload.inputMessage));
        break;
      case 'inference_completed':
        if (state.activeInferenceId !== event.payload.inferenceId) throw new Error('completed inference is not active');
        if (!Array.isArray(event.payload.responseMessages)) throw new Error('completed inference lacks response messages');
        state.messages.push(...structuredClone(event.payload.responseMessages));
        state.activeInferenceId = null;
        state.completedInferences += 1;
        break;
      case 'inference_failed':
        if (state.activeInferenceId !== event.payload.inferenceId) throw new Error('failed inference is not active');
        if (!Array.isArray(event.payload.checkpointMessages)) throw new Error('failed inference lacks checkpoint messages');
        state.messages.push(...structuredClone(event.payload.checkpointMessages));
        state.messages.push({
          role: 'user',
          content: `[inference_interrupted]\nThe previous inference ended unexpectedly after ${event.payload.checkpointMessages.length} retained response messages. Its error was recorded by the harness. Reorient from the completed tool results and current Sounding rather than inventing missing output.\n[/inference_interrupted]`,
        });
        state.activeInferenceId = null;
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
    }],
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
