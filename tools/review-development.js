import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialDevelopmentalReviewTool() {
  return validateToolModule({
    id: 'review_developmental_position',
    version: 1,
    parent: null,
    description: 'Construct the exact typed developmental frontier that trajectory election must judge. This is a non-acting review: classify current harms, constraints, unresolved stakes, opportunities, and maintenance needs; rate severity, urgency, and cost of delay; then name bounded quiet or tool-contact candidates. The kernel freezes the result. This tool cannot set a trajectory or execute an action.',
    inputSchema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array', minItems: 1, maxItems: 24,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
              class: { type: 'string', enum: ['harm', 'constraint', 'unresolved-stake', 'opportunity', 'maintenance'] },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'background'] },
              urgency: { type: 'string', enum: ['immediate', 'near', 'eventual', 'none'] },
              costOfDelay: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none', 'unknown'] },
              condition: { type: 'string', minLength: 1, maxLength: 2_048 },
              evidence: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 512 } },
            },
            required: ['id', 'class', 'severity', 'urgency', 'costOfDelay', 'condition', 'evidence'],
            additionalProperties: false,
          },
        },
        candidates: {
          type: 'array', minItems: 2, maxItems: 16,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
              description: { type: 'string', minLength: 1, maxLength: 2_048 },
              addressesFindingIds: {
                type: 'array', minItems: 1, maxItems: 24,
                items: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
              },
              action: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['tool', 'quiet'] },
                  tool: {
                    type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$',
                    description: 'The exact ordinary tool id, or the literal sentinel quiet when kind is quiet.',
                  },
                  input: {
                    type: 'object', additionalProperties: true,
                    description: 'The exact tool input, or an empty object when kind is quiet.',
                  },
                  observation: { type: 'string', minLength: 1, maxLength: 2_048 },
                },
                required: ['kind', 'tool', 'input'], additionalProperties: false,
              },
            },
            required: ['id', 'description', 'addressesFindingIds', 'action'], additionalProperties: false,
          },
        },
      },
      required: ['findings', 'candidates'], additionalProperties: false,
    },
    source: sourceBody(reviewDevelopmentalPosition),
  });
}

async function reviewDevelopmentalPosition(input, context) {
  return context.recordDevelopmentalReview(input);
}
