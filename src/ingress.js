import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_INGRESS_FILE_BYTES = 128 * 1_024;

export function prepareIngress(root) {
  for (const name of ['pending', 'accepted', 'rejected']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return {
    root,
    pending: join(root, 'pending'),
    accepted: join(root, 'accepted'),
    rejected: join(root, 'rejected'),
  };
}

export function submitWorldDelta(root, delta, { id = () => randomUUID(), clock = () => new Date() } = {}) {
  const paths = prepareIngress(root);
  const stamp = clock().toISOString().replaceAll(':', '-');
  const name = `${stamp}-${id()}.json`;
  const temporary = join(paths.pending, `.${name}.tmp`);
  const target = join(paths.pending, name);
  const bytes = `${JSON.stringify(delta)}\n`;
  if (Buffer.byteLength(bytes) > MAX_INGRESS_FILE_BYTES) throw new Error(`world Delta ingress file exceeds ${MAX_INGRESS_FILE_BYTES} bytes`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, bytes, null, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, target);
  return target;
}

export function pendingIngressFiles(root) {
  const paths = prepareIngress(root);
  return readdirSync(paths.pending)
    .filter(name => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map(name => join(paths.pending, name));
}

export function readIngressDelta(path) {
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_INGRESS_FILE_BYTES) throw new Error(`world Delta ingress file exceeds ${MAX_INGRESS_FILE_BYTES} bytes`);
  return JSON.parse(bytes.toString('utf8'));
}

export function archiveIngressFile(root, path, outcome, error = undefined) {
  if (!['accepted', 'rejected'].includes(outcome)) throw new Error('invalid ingress archive outcome');
  const paths = prepareIngress(root);
  const name = basename(path);
  let target = join(paths[outcome], name);
  if (!existsSync(target)) renameSync(path, target);
  else if (existsSync(path)) {
    target = join(paths[outcome], `${randomUUID()}-${name}`);
    renameSync(path, target);
  }
  if (outcome === 'rejected' && error !== undefined) {
    writeFileSync(`${target}.error.json`, `${JSON.stringify(errorRecord(error))}\n`, { mode: 0o600 });
  }
  return target;
}

function errorRecord(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}
