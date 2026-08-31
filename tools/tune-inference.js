import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialTuneInferenceTool() {
  return validateToolModule({
    id: 'tune_inference',
    version: 1,
    parent: null,
    description: 'Author a provisional inference policy for later encounters: maximum model steps, retained-event bytes, and total timeout. Supply a complete policy. It becomes active only after developmental exercise and explicit admission; broad physical ceilings remain in the kernel.',
    inputSchema: {
      type: 'object',
      properties: {
        maxSteps: { type: 'integer', minimum: 1, maximum: 10_000 },
        maxInferenceEventBytes: { type: 'integer', minimum: 65_536, maximum: 67_108_864 },
        timeoutMs: { type: 'integer', minimum: 1_000, maximum: 86_400_000 },
        interpretation: { type: 'string', minLength: 1, maxLength: 4_096 },
        evidence: {
          type: 'array', maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 512 },
        },
        consequenceDeltaIds: {
          type: 'array', maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      required: ['maxSteps', 'maxInferenceEventBytes', 'timeoutMs', 'interpretation'],
      additionalProperties: false,
    },
    source: sourceBody(tuneInference),
  });
}

async function tuneInference(input, context) {
  const transition = context.stageCarrierTransition({
    componentId: 'inference_policy',
    value: {
      maxSteps: input.maxSteps,
      maxInferenceEventBytes: input.maxInferenceEventBytes,
      timeoutMs: input.timeoutMs,
    },
    interpretation: input.interpretation,
    evidence: input.evidence ?? [],
    consequenceDeltaIds: input.consequenceDeltaIds ?? [],
  });
  return {
    kind: 'inference-policy-proposal',
    proposalId: transition.proposalId,
    policy: transition.component.state.value,
    generation: transition.component.state.generation,
    successorRoot: transition.successorRoot,
    active: false,
  };
}
