import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialRetainContextTool() {
  return validateToolModule({
    id: 'retain_context',
    version: 1,
    parent: null,
    description: 'Author a provisional bounded account of the current situation. Completed transcripts remain audit history; no update is obligatory. The account becomes active continuity only after developmental exercise and explicit admission.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', maxLength: 16_384 },
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
      required: ['context', 'interpretation'],
      additionalProperties: false,
    },
    source: sourceBody(retainContext),
  });
}

async function retainContext(input, context) {
  const transition = context.stageCarrierTransition({
    componentId: 'continuity',
    value: input.context,
    interpretation: input.interpretation,
    evidence: input.evidence ?? [],
    consequenceDeltaIds: input.consequenceDeltaIds ?? [],
  });
  return {
    kind: 'continuity-proposal',
    proposalId: transition.proposalId,
    componentId: transition.component.id,
    generation: transition.component.state.generation,
    successorRoot: transition.successorRoot,
    active: false,
  };
}
