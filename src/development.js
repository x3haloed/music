import { canonical, digest } from './canonical.js';
import { projectCarrier } from './carrier.js';
import { toolModuleDigest } from './tool-module.js';

const MAX_OPENING_BYTES = 32 * 1_024;

export function toolsetRoot(tools) {
  const values = tools instanceof Map ? [...tools.values()] : tools;
  if (!Array.isArray(values)) throw new Error('developmental toolset must be a Map or array');
  return digest(values
    .map(tool => ({ id: tool.id, digest: toolModuleDigest(tool) }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export function initialDevelopmentalPosition({ tools, carrier, openingId, at, openingContent = { origin: 'birth' } }) {
  const opening = validateOpening({
    id: requiredId(openingId, 'initial opening id'),
    parent: null,
    authoredAt: requiredTimestamp(at, 'initial opening time'),
    notBefore: null,
    content: openingContent,
  });
  return sealPosition({
    generation: 0,
    parentPositionRoot: null,
    carrierRoot: projectCarrier(carrier).root,
    toolsetRoot: toolsetRoot(tools),
    standingRoot: digest([]),
    pursuitRoot: digest(null),
    activeOpening: opening,
    archiveRoot: digest([]),
  });
}

export function readDevelopmentalPosition(value, { tools, carrier } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('developmental position must be an object');
  const position = sealPosition(value);
  if (value.root !== position.root) throw new Error('developmental position root mismatch');
  if (tools && position.toolsetRoot !== toolsetRoot(tools)) throw new Error('developmental position toolset root mismatch');
  if (carrier && position.carrierRoot !== projectCarrier(carrier).root) throw new Error('developmental position carrier root mismatch');
  return position;
}

export function projectDevelopmentalPosition(position) {
  return structuredClone(readDevelopmentalPosition(position));
}

export function createDevelopmentalOpening(value) {
  return validateOpening(value);
}

export function createDevelopmentalSuccessor(position, {
  tools,
  carrier,
  carrierTransition = null,
  consequenceTransitions = [],
  standingTransitions = consequenceTransitions,
  opening = undefined,
  openingTransition = null,
} = {}) {
  const current = readDevelopmentalPosition(position);
  const activeOpening = opening === undefined
    ? current.activeOpening
    : (opening === null ? null : validateOpening(opening));
  const standingRoot = standingTransitions.length === 0
    ? current.standingRoot
    : digest({ parent: current.standingRoot, transitions: standingTransitions });
  const pursuitRoot = carrierTransition === null
    ? current.pursuitRoot
    : digest({ parent: current.pursuitRoot, carrierTransition });
  const openingChanged = digest(activeOpening) !== digest(current.activeOpening);
  const archiveRoot = openingChanged
    ? digest({
      parent: current.archiveRoot,
      opening: current.activeOpening,
      transition: openingTransition === null ? null : jsonValue(openingTransition, 'developmental opening transition'),
    })
    : current.archiveRoot;
  return sealPosition({
    generation: current.generation + 1,
    parentPositionRoot: current.root,
    carrierRoot: projectCarrier(carrier).root,
    toolsetRoot: toolsetRoot(tools),
    standingRoot,
    pursuitRoot,
    activeOpening,
    archiveRoot,
  });
}

export function openingFromWake(wake, parentOpening) {
  if (!wake || typeof wake !== 'object' || Array.isArray(wake)) throw new Error('opening wake must be an object');
  return validateOpening({
    id: wake.wakeId,
    parent: parentOpening?.id ?? null,
    authoredAt: wake.stagedAt,
    notBefore: wake.wakeAt,
    content: {
      reason: wake.reason,
      invocationId: wake.invocationId,
      tool: structuredClone(wake.tool),
    },
  });
}

function sealPosition(value) {
  if (!Number.isInteger(value.generation) || value.generation < 0) throw new Error('developmental position generation must be a nonnegative integer');
  const parentPositionRoot = value.parentPositionRoot === null ? null : requiredDigest(value.parentPositionRoot, 'parent position root');
  if (value.generation === 0 && parentPositionRoot !== null) throw new Error('initial developmental position cannot have a parent');
  if (value.generation > 0 && parentPositionRoot === null) throw new Error('successor developmental position needs a parent');
  const unsealed = {
    format: 'music-developmental-position-1',
    generation: value.generation,
    parentPositionRoot,
    carrierRoot: requiredDigest(value.carrierRoot, 'position carrier root'),
    toolsetRoot: requiredDigest(value.toolsetRoot, 'position toolset root'),
    standingRoot: requiredDigest(value.standingRoot, 'position standing root'),
    pursuitRoot: requiredDigest(value.pursuitRoot, 'position pursuit root'),
    activeOpening: value.activeOpening === null ? null : validateOpening(value.activeOpening),
    archiveRoot: requiredDigest(value.archiveRoot, 'position archive root'),
  };
  return { ...unsealed, root: digest(unsealed) };
}

function validateOpening(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('developmental opening must be an object');
  const content = jsonValue(value.content, 'developmental opening content');
  if (Buffer.byteLength(canonical(content)) > MAX_OPENING_BYTES) {
    throw new Error(`developmental opening content exceeds ${MAX_OPENING_BYTES} bytes`);
  }
  const authoredAt = requiredTimestamp(value.authoredAt, 'developmental opening authoredAt');
  const notBefore = value.notBefore === null ? null : requiredTimestamp(value.notBefore, 'developmental opening notBefore');
  if (notBefore !== null && Date.parse(notBefore) < Date.parse(authoredAt)) {
    throw new Error('developmental opening notBefore precedes authorship');
  }
  return {
    id: requiredId(value.id, 'developmental opening id'),
    parent: value.parent === null ? null : requiredId(value.parent, 'developmental opening parent'),
    authoredAt,
    notBefore,
    content,
  };
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`${label} must be 1-128 characters`);
  return value.trim();
}

function requiredDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function requiredTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function jsonValue(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch (error) {
    throw new Error(`${label} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (encoded === undefined) throw new Error(`${label} is not a JSON value`);
  return JSON.parse(encoded);
}
