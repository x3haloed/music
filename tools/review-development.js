import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialDevelopmentalReviewTool() {
  return validateToolModule({
    id: 'review_developmental_position',
    version: 1,
    parent: null,
    description: 'Construct the exact typed developmental frontier that trajectory election must judge. This is a non-acting review: classify current harms, constraints, unresolved stakes, opportunities, and maintenance needs; rate severity, urgency, and cost of delay; then propose bounded directional candidates. Candidates are possible trajectories, never tool calls or action plans. The kernel freezes the result. This tool cannot set a trajectory or execute an action.',
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
              objective: { type: 'string', minLength: 1, maxLength: 2_048 },
              direction: { type: 'string', minLength: 1, maxLength: 2_048 },
              horizon: { type: 'string', enum: ['immediate', 'near', 'open-ended'] },
              successSignals: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 512 } },
              reconsiderWhen: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 512 } },
              addressesFindingIds: {
                type: 'array', minItems: 1, maxItems: 24,
                items: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' },
              },
            },
            required: ['id', 'objective', 'direction', 'horizon', 'successSignals', 'reconsiderWhen', 'addressesFindingIds'], additionalProperties: false,
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
