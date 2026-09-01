import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function acquireResidentLease(habitatRoot, purpose = 'resident') {
  const path = join(habitatRoot, 'state', 'resident.lock');
  const owner = {
    format: 'music-v2-resident-lease-1',
    token: randomUUID(),
    pid: process.pid,
    purpose,
    acquiredAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return { path, owner };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readOwner(path);
      if (existing?.pid && processIsAlive(existing.pid)) {
        throw new Error(`resident lease is already active (pid ${existing.pid}, purpose ${existing.purpose ?? 'unknown'})`);
      }
      // A process that no longer exists cannot retain causal authority. Reclaim
      // its exact stale marker; O_EXCL decides any race between reclaimers.
      try { unlinkSync(path); } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new Error('could not acquire resident lease');
}

export function releaseResidentLease(lease) {
  if (!lease || !existsSync(lease.path)) return false;
  const current = readOwner(lease.path);
  if (current?.token !== lease.owner.token) throw new Error('resident lease ownership changed before release');
  unlinkSync(lease.path);
  return true;
}

function readOwner(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
