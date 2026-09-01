import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonical, clone, digest, identifier } from './canonical.js';

export const EVENT_FORMAT = 'music-v3-event-1';

export class RunStore {
  constructor(root, { clock = () => new Date(), id = identifier } = {}) {
    this.root = root;
    this.ledgerPath = join(root, 'ledger.ndjson');
    this.lockPath = join(root, 'writer.lock');
    this.objectRoot = join(root, 'objects', 'sha256');
    this.clock = clock;
    this.id = id;
  }

  initialize() {
    mkdirSync(this.objectRoot, { recursive: true, mode: 0o700 });
  }

  put(value) {
    const bytes = `${canonical(value)}\n`;
    const sha256 = digest(value);
    const path = join(this.objectRoot, sha256.slice(0, 2), `${sha256}.json`);
    if (!existsSync(path)) atomicWrite(path, bytes);
    else if (readFileSync(path, 'utf8') !== bytes) throw new Error(`object collision: ${sha256}`);
    return { format: 'music-v3-object-1', sha256, bytes: Buffer.byteLength(bytes), mediaType: 'application/json' };
  }

  get(reference) {
    if (!reference || reference.format !== 'music-v3-object-1') throw new Error('invalid object reference');
    const path = join(this.objectRoot, reference.sha256.slice(0, 2), `${reference.sha256}.json`);
    const bytes = readFileSync(path, 'utf8');
    if (Buffer.byteLength(bytes) !== reference.bytes) throw new Error(`object byte count mismatch: ${reference.sha256}`);
    const value = JSON.parse(bytes);
    if (digest(value) !== reference.sha256) throw new Error(`object digest mismatch: ${reference.sha256}`);
    return value;
  }

  importObjectGraph(value, sourceStore) {
    if (!sourceStore || typeof sourceStore.get !== 'function') throw new Error('source object store is required');
    this.initialize();
    const imported = new Set();
    const pending = [...collectReferences(value).values()];
    while (pending.length > 0) {
      const reference = pending.pop();
      if (imported.has(reference.sha256)) continue;
      const retained = sourceStore.get(reference);
      const copied = this.put(retained);
      if (copied.sha256 !== reference.sha256 || copied.bytes !== reference.bytes) {
        throw new Error(`imported object differs from predecessor: ${reference.sha256}`);
      }
      imported.add(reference.sha256);
      for (const nested of collectReferences(retained).values()) pending.push(nested);
    }
    return { objects: imported.size };
  }

  readEvents() {
    if (!existsSync(this.ledgerPath)) return [];
    const bytes = readFileSync(this.ledgerPath, 'utf8');
    if (bytes === '') return [];
    if (!bytes.endsWith('\n')) throw new Error('ledger ends with an incomplete event');
    const events = bytes.slice(0, -1).split('\n').map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`ledger event ${index + 1} is invalid JSON`, { cause: error }); }
    });
    verifyEvents(events);
    return events;
  }

  append(type, payload) {
    if (!/^[a-z][a-z0-9_.-]*$/.test(type)) throw new TypeError('invalid event type');
    canonical(payload);
    this.initialize();
    const lock = acquire(this.lockPath);
    try {
      const events = this.readEvents();
      const body = {
        format: EVENT_FORMAT,
        sequence: events.length + 1,
        id: this.id('event'),
        at: this.clock().toISOString(),
        type,
        parent: events.at(-1)?.hash ?? null,
        payload,
      };
      const event = { ...body, hash: digest(body) };
      const fd = openSync(this.ledgerPath, 'a', 0o600);
      try {
        writeSync(fd, `${canonical(event)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return clone(event);
    } finally {
      closeSync(lock);
      unlinkSync(this.lockPath);
    }
  }

  verifyObjectGraph() {
    const events = this.readEvents();
    const references = collectReferences(events);
    const verified = new Set();
    const pending = [...references.values()];
    while (pending.length > 0) {
      const reference = pending.pop();
      if (verified.has(reference.sha256)) continue;
      const value = this.get(reference);
      verified.add(reference.sha256);
      for (const nested of collectReferences(value).values()) pending.push(nested);
    }
    return { events: events.length, objects: verified.size, head: events.at(-1)?.hash ?? null };
  }

  snapshot(destination) {
    if (existsSync(destination)) throw new Error(`snapshot destination already exists: ${basename(destination)}`);
    const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
    mkdirSync(partial, { recursive: false, mode: 0o700 });
    const lock = acquire(this.lockPath);
    try {
      const events = this.readEvents();
      const references = collectReferences(events);
      const verified = new Map();
      const pending = [...references.values()];
      while (pending.length > 0) {
        const reference = pending.pop();
        if (verified.has(reference.sha256)) continue;
        const value = this.get(reference);
        verified.set(reference.sha256, reference);
        for (const nested of collectReferences(value).values()) pending.push(nested);
      }
      if (existsSync(this.ledgerPath)) copyFileSync(this.ledgerPath, join(partial, 'ledger.ndjson'));
      for (const reference of verified.values()) {
        const relative = join('objects', 'sha256', reference.sha256.slice(0, 2), `${reference.sha256}.json`);
        mkdirSync(dirname(join(partial, relative)), { recursive: true, mode: 0o700 });
        copyFileSync(join(this.root, relative), join(partial, relative));
      }
      const outbox = join(this.root, 'outbox');
      if (existsSync(outbox)) {
        mkdirSync(join(partial, 'outbox'), { mode: 0o700 });
        for (const name of readdirSync(outbox)) copyFileSync(join(outbox, name), join(partial, 'outbox', name));
      }
      const manifest = {
        format: 'music-v3-snapshot-1',
        createdAt: this.clock().toISOString(),
        head: events.at(-1)?.hash ?? null,
        events: events.length,
        objects: verified.size,
      };
      atomicWrite(join(partial, 'snapshot.json'), `${canonical(manifest)}\n`);
      renameSync(partial, destination);
      return manifest;
    } catch (error) {
      if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
      throw error;
    } finally {
      closeSync(lock);
      unlinkSync(this.lockPath);
    }
  }
}

export function verifyEvents(events) {
  let parent = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.format !== EVENT_FORMAT) throw new Error(`unsupported event format at ${index + 1}`);
    if (event.sequence !== index + 1) throw new Error(`broken event sequence at ${index + 1}`);
    if (event.parent !== parent) throw new Error(`broken event ancestry at ${index + 1}`);
    const { hash, ...body } = event;
    if (digest(body) !== hash) throw new Error(`invalid event hash at ${index + 1}`);
    parent = hash;
  }
}

function acquire(path, retry = true) {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    fsyncSync(fd);
    return fd;
  }
  catch (error) {
    if (error?.code === 'EEXIST' && retry && staleLock(path)) {
      unlinkSync(path);
      return acquire(path, false);
    }
    if (error?.code === 'EEXIST') throw new Error(`another live writer owns ${path}`);
    throw error;
  }
}

function staleLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isInteger(value.pid) || value.pid <= 0) return false;
    try { process.kill(value.pid, 0); return false; }
    catch (error) { return error?.code === 'ESRCH'; }
  } catch {
    return false;
  }
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function collectReferences(value, found = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if (value.format === 'music-v3-object-1' && typeof value.sha256 === 'string') {
    found.set(value.sha256, value);
    return found;
  }
  for (const item of Object.values(value)) collectReferences(item, found);
  return found;
}
