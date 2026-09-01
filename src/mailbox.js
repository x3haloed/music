import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const INBOUND_FORMAT = 'music-v2-mailbox-inbound-1';
const OUTBOUND_FORMAT = 'music-v2-mailbox-message-1';
const MAX_MESSAGE_BYTES = 128 * 1024;

export function submitInboundMessage(habitat, { sender, recipient = 'the entity', channel = 'inbox', content, authentication = null }, {
  id = () => randomUUID(), clock = () => new Date(),
} = {}) {
  const root = resolve(habitat, 'mailbox', 'inbound');
  const pending = join(root, 'pending');
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  const message = {
    format: INBOUND_FORMAT,
    id: boundedId(id()),
    sender: boundedText(sender, 'message sender', 256),
    recipient: boundedText(recipient, 'message recipient', 256),
    channel: boundedText(channel, 'message channel', 128),
    content: boundedText(content, 'message content', 16_384, false),
    authentication,
    submittedAt: clock().toISOString(),
  };
  const name = `${message.submittedAt.replaceAll(':', '-')}-${message.id}.json`;
  atomicJson(join(pending, name), message);
  return structuredClone(message);
}

export function drainInboundMessages(habitat, kernel) {
  const root = resolve(habitat, 'mailbox', 'inbound');
  const pending = join(root, 'pending');
  const accepted = join(root, 'accepted');
  const rejected = join(root, 'rejected');
  for (const path of [pending, accepted, rejected]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const observations = [];
  for (const name of readdirSync(pending).filter(value => value.endsWith('.json') && !value.startsWith('.')).sort()) {
    const path = join(pending, name);
    try {
      const bytes = readFileSync(path);
      if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error(`inbound message exceeds ${MAX_MESSAGE_BYTES} bytes`);
      const message = validateInboundMessage(JSON.parse(bytes.toString('utf8')));
      const duplicate = kernel.state().observations.find(value => value.id === message.id);
      if (duplicate) observations.push(duplicate);
      else observations.push(kernel.receiveMessage({
        id: message.id,
        sender: message.sender,
        recipient: message.recipient,
        channel: message.channel,
        content: message.content,
        authentication: message.authentication,
        observedAt: message.submittedAt,
        delivery: { adapter: 'music-v2-mailbox-1', envelope: name, transformed: false },
      }));
      renameUnique(path, accepted, name);
    } catch (error) {
      const target = renameUnique(path, rejected, name);
      writeFileSync(`${target}.error.json`, `${JSON.stringify({ name: error?.name ?? 'Error', message: String(error?.message ?? error), rejectedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    }
  }
  return observations;
}

export function pendingOutboundMessages(habitat) {
  const pending = resolve(habitat, 'mailbox', 'outbound', 'pending');
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  return readdirSync(pending).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort().map(name => {
    const path = join(pending, name);
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error(`outbound message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    return { path, message: validateOutboundMessage(JSON.parse(bytes.toString('utf8'))) };
  });
}

export function archiveOutboundMessage(habitat, path) {
  const delivered = resolve(habitat, 'mailbox', 'outbound', 'delivered');
  mkdirSync(delivered, { recursive: true, mode: 0o700 });
  return renameUnique(path, delivered, basename(path));
}

export function validateInboundMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== INBOUND_FORMAT) throw new Error('invalid inbound mailbox message');
  return {
    format: INBOUND_FORMAT,
    id: boundedId(value.id),
    sender: boundedText(value.sender, 'message sender', 256),
    recipient: boundedText(value.recipient, 'message recipient', 256),
    channel: boundedText(value.channel, 'message channel', 128),
    content: boundedText(value.content, 'message content', 16_384, false),
    authentication: value.authentication ?? null,
    submittedAt: iso(value.submittedAt),
  };
}

export function validateOutboundMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== OUTBOUND_FORMAT) throw new Error('invalid outbound mailbox message');
  for (const field of ['messageId', 'at', 'action', 'recipient', 'content']) if (typeof value[field] !== 'string' || !value[field]) throw new Error(`outbound message lacks ${field}`);
  if (!['send', 'ask'].includes(value.action)) throw new Error('outbound message has invalid action');
  return structuredClone(value);
}

function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function renameUnique(source, directory, name) {
  let target = join(directory, name);
  if (existsSync(target)) target = join(directory, `${randomUUID()}-${name}`);
  renameSync(source, target);
  return target;
}

function boundedId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('invalid message id');
  return value;
}

function boundedText(value, label, maximum, trim = true) {
  if (typeof value !== 'string' || (trim ? !value.trim() : value.length === 0)) throw new Error(`${label} must be nonempty`);
  const text = trim ? value.trim() : value;
  if (Buffer.byteLength(text) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return text;
}

function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('invalid message timestamp');
  return value;
}
