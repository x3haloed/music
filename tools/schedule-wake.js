import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialScheduleWakeTool() {
  return validateToolModule({
    id: 'schedule_wake',
    version: 1,
    parent: null,
    description: 'Choose when this same continuing subject should next wake without waiting for world contact. The wake activates only if the current inference completes; world contact may preempt it without erasing its retained reason.',
    inputSchema: {
      type: 'object',
      properties: {
        afterMs: { type: 'integer', minimum: 1_000 },
        reason: { type: 'string', minLength: 1, maxLength: 2_048 },
      },
      required: ['afterMs', 'reason'],
      additionalProperties: false,
    },
    source: sourceBody(scheduleWake),
  });
}

async function scheduleWake(input, context) {
  return context.stageWakeTransition(input);
}
