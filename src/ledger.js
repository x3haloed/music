import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './canonical.js';

export const LEDGER_FORMAT = 'music-v2-event-1';

export class Ledger {
  constructor(path, { clock = () => new Date(), id = () => randomUUID() } = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.clock = clock;
    this.id = id;
  }

  read() {
    if (!existsSync(this.path)) return [];
    const bytes = readFileSync(this.path, 'utf8');
    if (bytes.length === 0) return [];
    if (!bytes.endsWith('\n')) throw new Error('ledger ends with an incomplete event');
    const events = bytes.slice(0, -1).split('\n').map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`ledger event ${index + 1} is not valid JSON`, { cause: error });
      }
    });
    verifyChain(events);
    return events;
  }

  append(type, payload) {
    if (typeof type !== 'string' || !/^[a-z][a-z0-9_.-]*$/.test(type)) {
      throw new TypeError('event type must be a lower-case dotted identifier');
    }
    canonical(payload);
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = this.acquire();
    try {
      const events = this.read();
      const previous = events.at(-1) ?? null;
      const body = {
        format: LEDGER_FORMAT,
        sequence: events.length + 1,
        id: this.id(),
        at: this.clock().toISOString(),
        type,
        parent: previous?.hash ?? null,
        payload,
      };
      const event = { ...body, hash: digest(body) };
      const fd = openSync(this.path, 'a', 0o600);
      try {
        writeSync(fd, `${canonical(event)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return structuredClone(event);
    } finally {
      closeSync(lock);
      unlinkSync(this.lockPath);
    }
  }

  acquire() {
    try {
      return openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`ledger writer is already active: ${this.lockPath}`);
      }
      throw error;
    }
  }
}

export function verifyChain(events) {
  let parent = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`ledger event ${index + 1} is not an object`);
    }
    if (event.format !== LEDGER_FORMAT) throw new Error(`unsupported ledger format at event ${index + 1}`);
    if (event.sequence !== index + 1) throw new Error(`broken sequence at event ${index + 1}`);
    if (event.parent !== parent) throw new Error(`broken ancestry at event ${index + 1}`);
    const { hash, ...body } = event;
    if (typeof hash !== 'string' || digest(body) !== hash) {
      throw new Error(`invalid hash at event ${index + 1}`);
    }
    parent = hash;
  }
}
