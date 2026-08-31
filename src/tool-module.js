import { canonical, digest } from './canonical.js';

const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_SOURCE_BYTES = 256 * 1_024;
const MAX_SCHEMA_BYTES = 64 * 1_024;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function validateToolModule(module) {
  if (!module || typeof module !== 'object' || Array.isArray(module)) throw new Error('tool module must be an object');
  if (!ID.test(module.id ?? '')) throw new Error('invalid tool id');
  if (!Number.isInteger(module.version) || module.version < 1) throw new Error('invalid tool version');
  if (module.parent !== null && (typeof module.parent !== 'string' || !/^[a-f0-9]{64}$/.test(module.parent))) {
    throw new Error('invalid tool parent');
  }
  const description = requiredText(module.description, 'tool description', 4_096);
  const inputSchema = jsonValue(module.inputSchema, 'tool input schema');
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema) || inputSchema.type !== 'object') {
    throw new Error('tool input schema must be a JSON Schema object');
  }
  if (Buffer.byteLength(canonical(inputSchema)) > MAX_SCHEMA_BYTES) throw new Error(`tool input schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  const source = requiredText(module.source, 'tool source', MAX_SOURCE_BYTES);
  compileSource(source, module.id, module.version);
  const selection = module.selection === undefined ? undefined : validateSelection(module.selection);
  return {
    id: module.id,
    version: module.version,
    parent: module.parent,
    description,
    inputSchema,
    source,
    ...(selection === undefined ? {} : { selection }),
  };
}

export function toolModuleDigest(module) {
  return digest(validateToolModule(module));
}

export async function executeToolModule(module, input, context = {}) {
  const valid = validateToolModule(module);
  const execute = compileSource(valid.source, valid.id, valid.version);
  const output = await execute(jsonValue(input, 'tool input'), Object.freeze({
    ...context,
    tool: Object.freeze({ id: valid.id, version: valid.version, digest: toolModuleDigest(valid) }),
  }));
  return jsonValue(output, `output from ${valid.id}`);
}

export function sourceBody(fn) {
  if (typeof fn !== 'function') throw new Error('tool implementation must be a function');
  const source = fn.toString();
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).trim();
}

function compileSource(source, id, version) {
  try {
    return new AsyncFunction('input', 'context', `"use strict";\n${source}\n//# sourceURL=music-tool:${id}@${version}`);
  } catch (error) {
    throw new Error(`tool ${id}@${version} source does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('tool selection must be an object');
  if (selection.kind !== 'frontier') throw new Error('unsupported tool selection kind');
  const discriminator = requiredId(selection.discriminator, 'selection discriminator');
  if (!Array.isArray(selection.values) || selection.values.length < 1 || selection.values.length > 16) {
    throw new Error('selection values must contain 1-16 ids');
  }
  const values = selection.values.map(value => requiredId(value, 'selection value'));
  if (new Set(values).size !== values.length) throw new Error('selection values must be unique');
  return {
    kind: 'frontier',
    discriminator,
    values,
    description: requiredText(selection.description, 'selection description', 2_048),
  };
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty`);
  if (Buffer.byteLength(value) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
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
