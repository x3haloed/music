export const INFERENCE_POLICY_COMPONENT_ID = 'inference_policy';

export const DEFAULT_INFERENCE_POLICY = Object.freeze({
  maxSteps: 120,
  maxOutputTokens: 15_000,
  maxInferenceEventBytes: 2 * 1_024 * 1_024,
  timeoutMs: 30 * 60_000,
});

const PHYSICAL_CEILINGS = Object.freeze({
  maxSteps: 10_000,
  maxOutputTokens: 131_072,
  maxInferenceEventBytes: 64 * 1_024 * 1_024,
  timeoutMs: 24 * 60 * 60_000,
});

export function inferencePolicyFromCarrier(carrier) {
  const component = carrier.get(INFERENCE_POLICY_COMPONENT_ID);
  return validateInferencePolicy(component?.state?.value ?? DEFAULT_INFERENCE_POLICY);
}

export function inferencePolicyFromProjection(carrier) {
  const component = carrier?.components?.find(candidate => candidate.id === INFERENCE_POLICY_COMPONENT_ID);
  return validateInferencePolicy(component?.state?.value ?? DEFAULT_INFERENCE_POLICY);
}

export function validateInferencePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_INFERENCE_POLICY, key))) {
    throw new Error('inference policy must contain only maxSteps, maxOutputTokens, maxInferenceEventBytes, and timeoutMs');
  }
  const policy = {};
  for (const [key, ceiling] of Object.entries(PHYSICAL_CEILINGS)) {
    // Ledgers created before output allowance became plastic do not carry this
    // field. Read them as the new default without rewriting retained history.
    const candidate = key === 'maxOutputTokens' && value[key] === undefined
      ? DEFAULT_INFERENCE_POLICY.maxOutputTokens
      : value[key];
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > ceiling) {
      throw new Error(`inference policy ${key} must be an integer from 1 to ${ceiling}`);
    }
    policy[key] = candidate;
  }
  if (policy.maxInferenceEventBytes < 64 * 1_024) {
    throw new Error('inference policy maxInferenceEventBytes must be at least 65536');
  }
  if (policy.timeoutMs < 1_000) throw new Error('inference policy timeoutMs must be at least 1000');
  return Object.freeze(policy);
}
