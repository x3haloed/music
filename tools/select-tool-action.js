import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialSelectionTool() {
  return validateToolModule({
    id: 'select_tool_action',
    version: 1,
    parent: null,
    description: 'Author a complete candidate frontier for a selection-gated tool and retain the exact selected input as a single-use receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
        candidates: {
          type: 'array', minItems: 1, maxItems: 16,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
              input: { type: 'object', additionalProperties: true },
            },
            required: ['id', 'input'], additionalProperties: false,
          },
        },
        selectedCandidateId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
      },
      required: ['tool', 'candidates', 'selectedCandidateId'], additionalProperties: false,
    },
    source: sourceBody(selectToolAction),
  });
}

async function selectToolAction(input, context) {
  return context.selectToolAction(input.tool, input);
}
