import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialMessageTool() {
  return validateToolModule({
    id: 'message',
    version: 1,
    parent: null,
    description: 'Deliver a human-visible message through the configured durable mailbox. Final assistant text is private working speech. When replying to an inbox Delta, preserve its id as replyToDeltaId so the external reply can retain causal lineage.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send', 'ask'] },
        recipient: { type: 'string', minLength: 1, maxLength: 256 },
        content: { type: 'string', maxLength: 8_192 },
        question: { type: 'string', maxLength: 512 },
        replyToDeltaId: { type: 'string', minLength: 1, maxLength: 128 },
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
  const content = input.action === 'send'
    ? input.content
    : input.action === 'ask' ? input.question : undefined;
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${String(input.action)} needs content`);
  const mailboxRoot = context.environment?.mailboxRoot;
  if (typeof mailboxRoot !== 'string' || !mailboxRoot.trim()) throw new Error('message delivery needs a configured mailboxRoot');
  if (typeof context.invocationId !== 'string' || !context.invocationId) throw new Error('message delivery lacks invocation identity');
  if (typeof context.soundingId !== 'string' || !context.soundingId) throw new Error('message delivery lacks Sounding identity');

  const { mkdir, open, rename, unlink } = await import('node:fs/promises');
  const { resolve, join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const pending = join(resolve(mailboxRoot), 'outbound', 'pending');
  await mkdir(pending, { recursive: true, mode: 0o700 });
  const messageId = randomUUID();
  const name = `${new Date().toISOString().replaceAll(':', '-')}-${messageId}.json`;
  const temporary = join(pending, `.${name}.tmp`);
  const target = join(pending, name);
  const envelope = {
    format: 'music-mailbox-message-1',
    messageId,
    invocationId: context.invocationId,
    soundingId: context.soundingId,
    at: new Date().toISOString(),
    action: input.action,
    recipient: input.recipient,
    content: content.trim(),
    ...(input.replyToDeltaId === undefined ? {} : { replyToDeltaId: input.replyToDeltaId }),
  };
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const directory = await open(pending, 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  const body = input.action === 'ask'
    ? `to=${input.recipient}\n[question] ${content.trim()}`
    : `to=${input.recipient}\n${content.trim()}`;
  return {
    kind: 'mailbox-delivery', channel: 'outbox', body,
    messageId, invocationId: context.invocationId, recipient: input.recipient,
    replyToDeltaId: input.replyToDeltaId ?? null,
  };
}
