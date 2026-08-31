import { digest } from './canonical.js';

const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const FIELD_TYPES = new Set(['string', 'number', 'boolean']);
const MAX_ACTIONS = 16;
const MAX_FIELDS = 16;
const MAX_TEMPLATE_CHARS = 4_096;

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('tool manifest must be an object');
  }
  if (!ID.test(manifest.id ?? '')) throw new Error('invalid tool id');
  if (!Number.isInteger(manifest.version) || manifest.version < 1) throw new Error('invalid tool version');
  if (manifest.parent !== null && (typeof manifest.parent !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.parent))) {
    throw new Error('invalid tool parent');
  }
  requiredText(manifest.description, 'tool description', 1_024);
  if (!Array.isArray(manifest.actions) || manifest.actions.length < 1 || manifest.actions.length > MAX_ACTIONS) {
    throw new Error(`tool needs 1-${MAX_ACTIONS} actions`);
  }
  const actionIds = new Set();
  for (const action of manifest.actions) {
    if (!ID.test(action?.id ?? '')) throw new Error('invalid action id');
    if (actionIds.has(action.id)) throw new Error(`duplicate action id: ${action.id}`);
    actionIds.add(action.id);
    requiredText(action.description, `description for ${action.id}`, 1_024);
    if (!Array.isArray(action.fields) || action.fields.length > MAX_FIELDS) {
      throw new Error(`action ${action.id} has invalid fields`);
    }
    const fieldNames = new Set();
    for (const field of action.fields) {
      if (!ID.test(field?.name ?? '')) throw new Error(`invalid field name in ${action.id}`);
      if (fieldNames.has(field.name)) throw new Error(`duplicate field ${field.name} in ${action.id}`);
      fieldNames.add(field.name);
      if (!FIELD_TYPES.has(field.type)) throw new Error(`invalid type for ${action.id}.${field.name}`);
      if (typeof field.required !== 'boolean') throw new Error(`required must be boolean for ${action.id}.${field.name}`);
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 65_536)) {
        throw new Error(`invalid maxLength for ${action.id}.${field.name}`);
      }
    }
    if (action.effect?.kind !== 'emit') throw new Error(`unsupported effect for ${action.id}`);
    if (!ID.test(action.effect.channel ?? '')) throw new Error(`invalid effect channel for ${action.id}`);
    requiredText(action.effect.template, `effect template for ${action.id}`, MAX_TEMPLATE_CHARS);
    for (const placeholder of placeholders(action.effect.template)) {
      if (!fieldNames.has(placeholder)) throw new Error(`template for ${action.id} references unknown field ${placeholder}`);
    }
  }
  return structuredClone(manifest);
}

export function manifestDigest(manifest) {
  return digest(validateManifest(manifest));
}

export function executeAction(manifest, actionId, input) {
  validateManifest(manifest);
  const action = manifest.actions.find(candidate => candidate.id === actionId);
  if (!action) throw new Error(`unknown action ${manifest.id}.${actionId}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('tool input must be an object');
  const known = new Set(action.fields.map(field => field.name));
  for (const name of Object.keys(input)) {
    if (!known.has(name)) throw new Error(`unknown input field ${name}`);
  }
  for (const field of action.fields) {
    const value = input[field.name];
    if (value === undefined) {
      if (field.required) throw new Error(`missing required field ${field.name}`);
      continue;
    }
    if (typeof value !== field.type) throw new Error(`${field.name} must be ${field.type}`);
    if (field.type === 'number' && !Number.isFinite(value)) throw new Error(`${field.name} must be finite`);
    if (field.type === 'string' && field.maxLength !== undefined && value.length > field.maxLength) {
      throw new Error(`${field.name} exceeds maxLength ${field.maxLength}`);
    }
  }
  return {
    kind: 'emission',
    channel: action.effect.channel,
    body: action.effect.template.replace(/\{([a-z][a-z0-9_-]{0,47})\}/g, (_, name) => String(input[name] ?? '')),
  };
}

function placeholders(template) {
  return [...template.matchAll(/\{([a-z][a-z0-9_-]{0,47})\}/g)].map(match => match[1]);
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be nonempty and at most ${maximum} characters`);
  }
}
