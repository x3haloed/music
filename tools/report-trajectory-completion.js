import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialTrajectoryCompletionTool() {
  return validateToolModule({
    id: 'report_trajectory_completion',
    version: 1,
    parent: null,
    description: 'Emit a structured actor receipt when you judge the active trajectory done. This is a completion claim, not authority to close or change trajectory. Music returns the exact receipt together with the active trajectory to the trajectory elector, which alone decides whether to continue or replace it.',
    inputSchema: {
      type: 'object',
      properties: {
        trajectoryId: { type: 'string', minLength: 1, maxLength: 128 },
        summary: { type: 'string', minLength: 1, maxLength: 4_096 },
        successSignals: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object',
            properties: {
              signal: { type: 'string', minLength: 1, maxLength: 512 },
              status: { type: 'string', enum: ['met', 'unmet', 'uncertain'] },
              evidence: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 512 } },
            },
            required: ['signal', 'status', 'evidence'], additionalProperties: false,
          },
        },
        remainingConcerns: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 512 } },
        evidence: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 512 } },
      },
      required: ['trajectoryId', 'summary', 'successSignals', 'remainingConcerns', 'evidence'], additionalProperties: false,
    },
    source: sourceBody(reportTrajectoryCompletion),
  });
}

async function reportTrajectoryCompletion(input, context) {
  return context.recordTrajectoryCompletion(input);
}
