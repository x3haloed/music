import { canonical, digest } from './canonical.js';

const ID = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_COMPONENTS = 16;
const MAX_RULE_CHARS = 1_024;
const MAX_VALUE_BYTES = 16 * 1_024;

export function initialCarrier() {
  return new Map([[
    'orientation',
    validateCarrierComponent({
      id: 'orientation',
      rule: { description: 'A bounded subject-authored basis that may shape selection in later encounters.' },
      state: { generation: 0, value: 'No learned selection consequence is currently active.' },
    }),
  ]]);
}

export function readCarrier(components) {
  if (!Array.isArray(components) || components.length < 1 || components.length > MAX_COMPONENTS) {
    throw new Error(`carrier needs 1-${MAX_COMPONENTS} components`);
  }
  const carrier = new Map();
  for (const raw of components) {
    const component = validateCarrierComponent(raw);
    if (carrier.has(component.id)) throw new Error(`duplicate carrier component: ${component.id}`);
    carrier.set(component.id, component);
  }
  return carrier;
}

export function serializeCarrier(carrier) {
  return [...carrier.values()].sort((a, b) => a.id.localeCompare(b.id)).map(component => structuredClone(component));
}

export function projectCarrier(carrier) {
  const components = serializeCarrier(carrier).map(component => projectComponent(component));
  return {
    root: digest(components.map(component => ({
      id: component.id,
      ruleDigest: component.ruleDigest,
      stateDigest: component.stateDigest,
    }))),
    components,
  };
}

export function createCarrierTransition(carrier, proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('carrier transition must be an object');
  const id = proposal.componentId;
  if (!ID.test(id ?? '')) throw new Error('invalid carrier component id');
  const current = carrier.get(id);
  if (!current && carrier.size >= MAX_COMPONENTS) throw new Error(`carrier component limit ${MAX_COMPONENTS} reached`);
  const rule = current
    ? current.rule
    : { description: requiredText(proposal.rule, 'new carrier component rule', MAX_RULE_CHARS) };
  if (current && proposal.rule !== undefined && proposal.rule !== current.rule.description) {
    throw new Error('carrier rule identity is stable; create a new component for a different rule');
  }
  const component = validateCarrierComponent({
    id,
    rule,
    state: {
      generation: current ? current.state.generation + 1 : 0,
      value: jsonValue(proposal.value, 'carrier component value'),
    },
  });
  const parent = projectCarrier(carrier);
  const successorCarrier = new Map(carrier);
  successorCarrier.set(id, component);
  const successor = projectCarrier(successorCarrier);
  return {
    component,
    parentRoot: parent.root,
    parentRuleDigest: current ? ruleDigest(current) : null,
    parentStateDigest: current ? stateDigest(current) : null,
    successorRoot: successor.root,
    successorRuleDigest: ruleDigest(component),
    successorStateDigest: stateDigest(component),
  };
}

export function applyCarrierTransition(carrier, transition) {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) throw new Error('invalid carrier transition');
  const parent = projectCarrier(carrier);
  if (transition.parentRoot !== parent.root) throw new Error('carrier transition parent root mismatch');
  const component = validateCarrierComponent(transition.component);
  const current = carrier.get(component.id);
  if ((current ? ruleDigest(current) : null) !== transition.parentRuleDigest) throw new Error('carrier rule ancestry mismatch');
  if ((current ? stateDigest(current) : null) !== transition.parentStateDigest) throw new Error('carrier state ancestry mismatch');
  if (current && ruleDigest(component) !== ruleDigest(current)) throw new Error('carrier transition changed stable rule identity');
  if (current && component.state.generation !== current.state.generation + 1) throw new Error('carrier state generation must increment by one');
  if (!current && component.state.generation !== 0) throw new Error('new carrier component must begin at generation zero');
  if (ruleDigest(component) !== transition.successorRuleDigest || stateDigest(component) !== transition.successorStateDigest) {
    throw new Error('carrier transition component identity mismatch');
  }
  const result = new Map(carrier);
  result.set(component.id, component);
  if (projectCarrier(result).root !== transition.successorRoot) throw new Error('carrier transition successor root mismatch');
  return result;
}

function validateCarrierComponent(component) {
  if (!component || typeof component !== 'object' || Array.isArray(component)) throw new Error('carrier component must be an object');
  if (!ID.test(component.id ?? '')) throw new Error('invalid carrier component id');
  const rule = { description: requiredText(component.rule?.description, 'carrier rule', MAX_RULE_CHARS) };
  if (!Number.isInteger(component.state?.generation) || component.state.generation < 0) throw new Error('invalid carrier state generation');
  const value = jsonValue(component.state.value, 'carrier component value');
  if (Buffer.byteLength(canonical(value)) > MAX_VALUE_BYTES) throw new Error(`carrier component value exceeds ${MAX_VALUE_BYTES} bytes`);
  return { id: component.id, rule, state: { generation: component.state.generation, value } };
}

function projectComponent(component) {
  return {
    id: component.id,
    rule: structuredClone(component.rule),
    ruleDigest: ruleDigest(component),
    state: structuredClone(component.state),
    stateDigest: stateDigest(component),
  };
}

function ruleDigest(component) {
  return digest({ id: component.id, rule: component.rule });
}

function stateDigest(component) {
  return digest({ id: component.id, ruleDigest: ruleDigest(component), state: component.state });
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${label} must be nonempty and at most ${maximum} characters`);
  return value.trim();
}

function jsonValue(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch (error) {
    throw new Error(`${label} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (encoded === undefined) throw new Error(`${label} is not a JSON value`);
  return JSON.parse(encoded);
}
