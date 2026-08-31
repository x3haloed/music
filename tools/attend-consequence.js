import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialConsequenceTool() {
  return validateToolModule({
    id: 'attend_consequence',
    version: 1,
    parent: null,
    description: 'Explicitly defer or settle a world consequence delivered in this Sounding. Deferred consequences remain present in later Soundings; settlement removes them from the active surface while retaining their history.',
    inputSchema: {
      type: 'object',
      properties: {
        deltaId: { type: 'string', minLength: 1, maxLength: 128 },
        action: { type: 'string', enum: ['defer', 'settle'] },
        interpretation: { type: 'string', minLength: 1, maxLength: 4_096 },
        evidence: {
          type: 'array', maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 512 },
        },
      },
      required: ['deltaId', 'action', 'interpretation'],
      additionalProperties: false,
    },
    source: sourceBody(attendConsequence),
  });
}

async function attendConsequence(input, context) {
  return context.stageConsequenceTransition(input);
}
