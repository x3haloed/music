import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHabitat, readHabitat, snapshotHabitat } from '../src/habitat.js';
import { MusicKernel } from '../src/kernel.js';
import { acquireResidentLease, releaseResidentLease } from '../src/resident-lease.js';

test('habitat creation prepares private resident state without hatching or naming anyone', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v2-habitat-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const habitat = createHabitat(join(parent, 'resident'));
  assert.deepEqual(readHabitat(habitat.root), habitat);
  assert.equal(existsSync(habitat.ledger), false);
  assert.equal(existsSync(habitat.home), true);
  assert.equal(existsSync(habitat.outbox), true);
  assert.throws(() => createHabitat(habitat.root), /not empty/);
});

test('snapshot holds the ledger lease and retains an exact external inventory', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v2-snapshot-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const habitat = createHabitat(join(parent, 'resident'));
  const kernel = new MusicKernel(habitat.root);
  kernel.initialize();
  writeFileSync(join(habitat.home, 'note.txt'), 'belongs to this resident\n');
  const result = snapshotHabitat(habitat.root, join(parent, 'backups'));
  const manifest = JSON.parse(readFileSync(join(result.snapshot, 'snapshot.json'), 'utf8'));
  const note = manifest.files.find(file => file.path === 'home/note.txt');
  assert.equal(note.sha256, createHash('sha256').update('belongs to this resident\n').digest('hex'));
  assert.equal(readFileSync(join(result.snapshot, 'state', 'ledger.jsonl'), 'utf8'), readFileSync(habitat.ledger, 'utf8'));
  const lock = kernel.ledger.acquire();
  try {
    assert.throws(() => snapshotHabitat(habitat.root, join(parent, 'backups')), /already active/);
  } finally {
    const { closeSync, unlinkSync } = process.getBuiltinModule('node:fs');
    closeSync(lock);
    unlinkSync(kernel.ledger.lockPath);
  }
});

test('snapshot refuses recursive containment in either direction', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v2-containment-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const habitat = createHabitat(join(parent, 'resident'));
  assert.throws(() => snapshotHabitat(habitat.root, join(habitat.root, 'backups')), /must not contain/);
  assert.throws(() => snapshotHabitat(habitat.root, parent), /must not contain/);
});

test('a live resident lease excludes snapshots and a dead lease is reclaimable', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v2-resident-lease-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const habitat = createHabitat(join(parent, 'resident'));
  new MusicKernel(habitat.root).initialize();
  const lease = acquireResidentLease(habitat.root, 'resident');
  assert.throws(() => snapshotHabitat(habitat.root, join(parent, 'backups')), /resident lease is already active/);
  assert.equal(releaseResidentLease(lease), true);
  writeFileSync(join(habitat.state, 'resident.lock'), `${JSON.stringify({
    format: 'music-v2-resident-lease-1', token: 'dead', pid: 2_147_483_647, purpose: 'resident',
  })}\n`);
  const reclaimed = acquireResidentLease(habitat.root, 'resident');
  assert.notEqual(reclaimed.owner.token, 'dead');
  releaseResidentLease(reclaimed);
});
