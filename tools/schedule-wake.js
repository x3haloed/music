import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialScheduleWakeTool() {
  return validateToolModule({
    id: 'schedule_wake',
    version: 1,
    parent: null,
    description: 'Close the current developmental opening and author a structured successor opening for this same subject. Its bounded content and earliest presentation time become part of the parent-bound position after successful transaction commit; incoming world contact can present it once it is due.',
    inputSchema: {
      type: 'object',
      properties: {
        afterMs: { type: 'integer', minimum: 1_000 },
        reason: { type: 'string', minLength: 1, maxLength: 2_048 },
        closureStatus: { type: 'string', minLength: 1, maxLength: 128 },
        content: { type: 'object', additionalProperties: true },
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
