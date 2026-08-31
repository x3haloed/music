import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialMessageTool() {
  return validateToolModule({
    id: 'message',
    version: 1,
    parent: null,
    description: 'Place a message in the local outbound channel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'ask'] },
        recipient: { type: 'string', minLength: 1, maxLength: 256 },
        content: { type: 'string', maxLength: 8_192 },
        question: { type: 'string', maxLength: 512 },
      },
      required: ['action', 'recipient'],
      additionalProperties: false,
    },
    source: sourceBody(message),
    selection: {
      kind: 'frontier',
      discriminator: 'action',
      values: ['send', 'ask'],
      description: 'Author one concrete candidate for every available message action, then select one using the active carrier and present consequence.',
    },
  });
}

async function message(input) {
  if (!input || typeof input !== 'object') throw new Error('message input must be an object');
  if (typeof input.recipient !== 'string' || !input.recipient) throw new Error('message needs a recipient');
  if (input.action === 'send') {
    if (typeof input.content !== 'string') throw new Error('send needs content');
    return { kind: 'emission', channel: 'outbox', body: `to=${input.recipient}\n${input.content}` };
  }
  if (input.action === 'ask') {
    if (typeof input.question !== 'string') throw new Error('ask needs a question');
    return { kind: 'emission', channel: 'outbox', body: `to=${input.recipient}\n[question] ${input.question}` };
  }
  throw new Error(`unknown message action: ${String(input.action)}`);
}
