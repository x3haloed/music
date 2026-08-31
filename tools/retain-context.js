import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialRetainContextTool() {
  return validateToolModule({
    id: 'retain_context',
    version: 1,
    parent: null,
    description: 'Stage the bounded, subject-authored account of the current situation that should be present in later encounters. Completed transcripts remain audit history; this tool decides what becomes active continuity. No update is obligatory.',
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
    kind: 'continuity-transition',
    componentId: transition.component.id,
    generation: transition.component.state.generation,
    successorRoot: transition.successorRoot,
    visible: 'next-sounding',
  };
}

