import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareIngress, submitWorldDelta } from './ingress.js';

const FORMAT = 'music-mailbox-message-1';
const MAX_MESSAGE_BYTES = 128 * 1_024;

export function prepareMailbox(root) {
  const ingress = prepareIngress(root);
  const outbound = join(root, 'outbound');
  const pendingOutbound = join(outbound, 'pending');
  const deliveredOutbound = join(outbound, 'delivered');
  mkdirSync(pendingOutbound, { recursive: true, mode: 0o700 });
  mkdirSync(deliveredOutbound, { recursive: true, mode: 0o700 });
  return { ...ingress, outbound, pendingOutbound, deliveredOutbound };
}

export function submitMailboxMessage(root, { from, content, bearsOnInvocationId } = {}, {
  id = () => randomUUID(),
  clock = () => new Date(),
} = {}) {
  const sender = boundedText(from, 'message sender', 256);
  const body = boundedText(content, 'message content', 16_384);
  const deltaId = `message-${id()}`;
  const at = clock().toISOString();
  const delta = {
    authority: 'world',
    id: deltaId,
    stream: 'inbox',
    at,
    ...(bearsOnInvocationId === undefined ? {} : {
      bearsOn: [{ kind: 'tool-invocation', invocationId: boundedText(bearsOnInvocationId, 'invocation id', 256) }],
    }),
    payload: {
      kind: 'message',
      medium: 'mailbox',
      from: sender,
      content: body,
      reply: { recipient: sender, replyToDeltaId: deltaId },
    },
  };
  const path = submitWorldDelta(root, delta, { id, clock });
  return { delta, path };
}

export function pendingOutboundMessages(root) {
  const paths = prepareMailbox(root);
  return readdirSync(paths.pendingOutbound)
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map(name => {
      const path = join(paths.pendingOutbound, name);
      const bytes = readFileSync(path);
      if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error(`outbound mailbox message exceeds ${MAX_MESSAGE_BYTES} bytes`);
      const message = validateOutboundMessage(JSON.parse(bytes.toString('utf8')));
      return { path, message };
    });
}

export function archiveOutboundMessage(root, path) {
  const paths = prepareMailbox(root);
  const name = basename(path);
  let target = join(paths.deliveredOutbound, name);
  if (!existsSync(target)) renameSync(path, target);
  else if (existsSync(path)) {
    target = join(paths.deliveredOutbound, `${randomUUID()}-${name}`);
    renameSync(path, target);
  }
  return target;
}

export function validateOutboundMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== FORMAT) {
    throw new Error('invalid outbound mailbox message');
  }
  for (const field of ['messageId', 'invocationId', 'soundingId', 'at', 'action', 'recipient', 'content']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error(`outbound mailbox message lacks ${field}`);
  }
  if (!['send', 'ask'].includes(value.action)) throw new Error('outbound mailbox message has invalid action');
  if (value.replyToDeltaId !== undefined && (typeof value.replyToDeltaId !== 'string' || !value.replyToDeltaId)) {
    throw new Error('outbound mailbox message has invalid replyToDeltaId');
  }
  return structuredClone(value);
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty`);
  const text = value.trim();
  if (Buffer.byteLength(text) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return text;
}
