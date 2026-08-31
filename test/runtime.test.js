import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { MusicKernel, MUSIC_EVENT_FORMAT } from '../src/kernel.js';
import { createRuntimeProvenance } from '../src/runtime-provenance.js';
import { initialTools } from '../src/seeds.js';

const repository = resolve(import.meta.dirname, '..');

test('runtime provenance binds a real Git release and explicit resident home', () => {
  const home = mkdtempSync(join(tmpdir(), 'music-runtime-home-'));
  const runtime = createRuntimeProvenance(home, { sourceRoot: repository, mode: 'resident' });
  assert.equal(runtime.format, 'music-runtime-1');
  assert.equal(runtime.eventFormat, MUSIC_EVENT_FORMAT);
  assert.equal(runtime.mode, 'resident');
  assert.equal(runtime.release.commit, execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(runtime.release.root, repository);
  assert.match(runtime.release.workingTreeStateSha256, /^[a-f0-9]{64}$/);
  assert.equal(runtime.home, realpathSync(home));
  assert.equal(runtime.process.node, process.version);
});

test('runtime starts become append-only identity-adjacent provenance without changing the subject', () => {
  const root = mkdtempSync(join(tmpdir(), 'music-runtime-ledger-'));
  const kernel = new MusicKernel(join(root, 'events.jsonl'));
  kernel.initialize('Test Subject', initialTools());
  const subject = structuredClone(kernel.state().subject);
  const first = fixtureRuntime(root, '1'.repeat(40), 'resident');
  const second = fixtureRuntime(root, '2'.repeat(40), 'single-run');

  kernel.recordRuntimeStart(first);
  kernel.recordRuntimeStart(second);

  const restarted = new MusicKernel(kernel.ledgerPath);
  assert.deepEqual(restarted.state().subject, subject);
  assert.equal(restarted.audit().runtimeStarts, 2);
  assert.deepEqual(restarted.audit().runtime, second);
  assert.deepEqual(restarted.events().slice(-2).map(event => event.type), ['runtime_started', 'runtime_started']);
});

test('live commands refuse to run without an explicit resident home', () => {
  const root = mkdtempSync(join(tmpdir(), 'music-runtime-cli-'));
  const result = spawnSync(process.execPath, [join(repository, 'src', 'cli.js'), 'run', join(root, 'events.jsonl'), join(root, 'model.json')], {
    cwd: repository,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'MUSIC_HOME')),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run requires MUSIC_HOME/);
  assert.equal(result.stdout, '');
});

function fixtureRuntime(home, commit, mode) {
  return {
    format: 'music-runtime-1', eventFormat: MUSIC_EVENT_FORMAT, mode,
    release: {
      commit, version: '0.0.1', workingTreeClean: true,
      workingTreeStateSha256: '0'.repeat(64), root: repository,
    },
    home,
    process: { node: process.version, platform: process.platform, arch: process.arch },
  };
}
