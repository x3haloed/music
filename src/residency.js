import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export class ResidentLease {
  constructor(root, { clock = () => new Date(), pid = process.pid } = {}) {
    this.path = join(root, 'resident.lock');
    this.clock = clock;
    this.pid = pid;
    this.fd = null;
  }

  acquire(retry = true) {
    if (this.fd !== null) throw new Error('resident lease is already held');
    try {
      this.fd = openSync(this.path, 'wx', 0o600);
      writeSync(this.fd, `${JSON.stringify({ format: 'music-v3-resident-lease-1', pid: this.pid, acquiredAt: this.clock().toISOString() })}\n`);
      fsyncSync(this.fd);
      return this;
    } catch (error) {
      if (error?.code === 'EEXIST' && retry && stale(this.path)) {
        unlinkSync(this.path);
        return this.acquire(false);
      }
      if (error?.code === 'EEXIST') throw new Error('another live resident owns this run');
      throw error;
    }
  }

  release() {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}

function stale(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isInteger(value.pid) || value.pid <= 0) return false;
    try { process.kill(value.pid, 0); return false; }
    catch (error) { return error?.code === 'ESRCH'; }
  } catch {
    return false;
  }
}
