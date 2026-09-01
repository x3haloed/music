import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonical, digest } from '../src/canonical.js';
import { createHabitat, defaultModelConfig, migrateHabitat, offerSeedTool, readHabitat, snapshotHabitat } from '../src/habitat.js';
import { MusicKernel } from '../src/kernel.js';
import { initialTools } from '../src/seeds.js';

const repository = resolve(import.meta.dirname, '..');

test('habitat creation establishes a separate uninitialized resident world with the approved model', () => {
  const parent = mkdtempSync(join(tmpdir(), 'music-habitat-create-'));
  const root = join(parent, 'resident');
  const habitat = createHabitat(root);

  assert.deepEqual(readHabitat(root), habitat);
  assert.equal(existsSync(habitat.ledger), false, 'preparation does not hatch or name a resident');
  assert.deepEqual(JSON.parse(readFileSync(habitat.modelConfig, 'utf8')), defaultModelConfig());
  assert.equal(JSON.parse(readFileSync(habitat.modelConfig, 'utf8')).model, 'z-ai/glm-5.3-flash');
  assert.throws(() => createHabitat(root), /not empty/);
});

test('the habitat command initializes and audits one ledger without placing it in the installation', () => {
  const parent = mkdtempSync(join(tmpdir(), 'music-habitat-command-'));
  const root = join(parent, 'resident');
  const create = habitatCommand(['create', root]);
  assert.equal(create.status, 0, create.stderr);

  const initialized = habitatCommand(['init', root]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const habitat = readHabitat(root);
  const kernel = new MusicKernel(habitat.ledger);
  assert.equal(kernel.state().subject.name, null);
  assert.equal(kernel.events().length, 1);
  assert.equal(resolve(habitat.ledger).startsWith(repository), false);

  const audit = habitatCommand(['audit', root]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).subject.name, null);
  assert.notEqual(habitatCommand(['init', root, 'Another Resident']).status, 0);
});

test('a stopped habitat receives a seed tool as inactive exact contact, never silent activation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'music-habitat-offer-'));
  const habitat = createHabitat(join(parent, 'resident'));
  const kernel = new MusicKernel(habitat.ledger);
  kernel.initialize(null, initialTools().filter(tool => tool.id !== 'elect_trajectory'));
  const release = {
    commit: 'c'.repeat(40), version: '0.0.1', workingTreeClean: true,
    workingTreeStateSha256: 'd'.repeat(64),
  };

  const offered = await offerSeedTool(habitat.root, 'elect_trajectory', { release });
  const reconstructed = new MusicKernel(habitat.ledger);
  assert.equal(offered.active, false);
  assert.equal(reconstructed.state().tools.has('elect_trajectory'), false);
  assert.equal(reconstructed.state().developmentalProposals.get(offered.proposalId).offer.release.commit, release.commit);
  assert.deepEqual(reconstructed.state().pendingDeltas.map(delta => delta.id), [offered.contactDeltaId]);
  assert.equal(reconstructed.state().pendingDeltas[0].payload.active, false);

  const held = reconstructed.acquireWriter('fixture live resident');
  try {
    await assert.rejects(() => offerSeedTool(habitat.root, 'elect_trajectory', { release }), /writer lease is held/);
  } finally {
    held();
  }
});

test('a habitat snapshot holds the writer authority and retains a digest inventory outside the resident world', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'music-habitat-snapshot-'));
  const habitat = createHabitat(join(parent, 'residents', 'fixture'));
  const kernel = new MusicKernel(habitat.ledger);
  kernel.initialize('Fixture Resident', (await import('../src/seeds.js')).initialTools());
  writeFileSync(join(habitat.home, 'resident-note.txt'), 'belongs to the resident\n');
  const backupRoot = join(parent, 'backups');

  const result = snapshotHabitat(habitat.root, backupRoot);

  assert.equal(result.habitat, habitat.root);
  assert.equal(resolve(result.snapshot).startsWith(realpathSync(backupRoot)), true);
  assert.equal(existsSync(join(result.snapshot, 'state', 'events.jsonl.writer-lock')), false);
  const manifest = JSON.parse(readFileSync(join(result.snapshot, 'snapshot.json'), 'utf8'));
  const note = manifest.files.find(file => file.path === 'home/resident-note.txt');
  assert.equal(note.sha256, createHash('sha256').update('belongs to the resident\n').digest('hex'));
  assert.equal(readFileSync(join(result.snapshot, 'state', 'events.jsonl'), 'utf8'), readFileSync(habitat.ledger, 'utf8'));

  const release = kernel.acquireWriter('fixture live resident');
  try {
    assert.throws(() => snapshotHabitat(habitat.root, backupRoot), /writer lease is held/);
  } finally {
    release();
  }
});

test('snapshot refuses a destination that could recursively absorb or overwrite the habitat', () => {
  const parent = mkdtempSync(join(tmpdir(), 'music-habitat-containment-'));
  const habitat = createHabitat(join(parent, 'resident'));
  assert.throws(() => snapshotHabitat(habitat.root, join(habitat.root, 'backups')), /must not contain one another/);
  assert.throws(() => snapshotHabitat(habitat.root, parent), /must not contain one another/);
});

test('legacy migration preserves exact lineage and resumes the same subject in current developmental geometry', () => {
  const parent = mkdtempSync(join(tmpdir(), 'music-habitat-migration-'));
  const habitat = createHabitat(join(parent, 'resident'));
  const source = readFileSync(join(repository, 'test', 'fixtures', 'music-event-11.jsonl'));
  const sourceEvents = source.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const unsigned = {
    format: 'music-event-11',
    sequence: sourceEvents.length,
    parent: sourceEvents.at(-1).hash,
    at: '2026-08-31T19:00:00.000Z',
    type: 'delta_admitted',
    payload: { delta: {
      authority: 'world', id: 'migration-pending-contact', stream: 'migration-test',
      at: '2026-08-31T19:00:00.000Z', payload: { observation: 'Preserve me as active contact.' },
    } },
  };
  const event = { ...unsigned, hash: digest(unsigned) };
  const legacyBytes = Buffer.from(`${source.toString('utf8').trimEnd()}\n${canonical(event)}\n`);
  writeFileSync(habitat.ledger, legacyBytes, { mode: 0o600 });
  const legacy = new MusicKernel(habitat.ledger);
  const legacyAudit = legacy.audit();
  const legacyState = legacy.state();

  const result = migrateHabitat(habitat.root);
  const current = new MusicKernel(habitat.ledger);
  const audit = current.audit();

  assert.deepEqual(audit.subject, legacyAudit.subject);
  assert.deepEqual(audit.tools, legacyAudit.tools);
  assert.equal(audit.retainedToolVersions, legacyState.toolHistory.size);
  assert.equal(audit.carrierRoot, legacyAudit.carrierRoot);
  assert.equal(audit.lineage.sourceHead, legacyAudit.head);
  assert.equal(audit.lineage.sourceSha256, createHash('sha256').update(legacyBytes).digest('hex'));
  assert.deepEqual(readFileSync(result.archive), legacyBytes);
  assert.equal(current.events().length, 1);
  assert.deepEqual([...current.state().deltaIds], [...legacyState.deltaIds]);
  assert.deepEqual(current.state().pendingDeltas.map(delta => delta.id), ['migration-pending-contact']);
  assert.equal(current.state().toolHistory.size, legacyState.toolHistory.size);
  assert.equal(current.state().position.activeOpening.content.origin, 'legacy-migration');
  assert.equal(current.state().position.activeOpening.content.lineage.sourceHead, legacyAudit.head);
  assert.throws(() => migrateHabitat(habitat.root), /does not need legacy migration/);
});

function habitatCommand(args) {
  return spawnSync(process.execPath, [join(repository, 'bin', 'music-habitat.js'), ...args], {
    cwd: repository,
    encoding: 'utf8',
  });
}
