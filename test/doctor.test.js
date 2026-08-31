import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CORE_PATHS = [
  'package.json', 'package-lock.json', 'bin/music-doctor.js', 'bin/music-habitat.js',
  'src/canonical.js', 'src/carrier.js', 'src/cli.js', 'src/ingress.js', 'src/inference-policy.js', 'src/habitat.js',
  'src/kernel.js', 'src/mailbox.js', 'src/mind.js', 'src/provider.js', 'src/resident.js',
  'src/runtime-provenance.js', 'src/tool-module.js',
];

test('the external doctor detects, backs up, and restores corrupted stable core source', () => {
  const root = mkdtempSync(join(tmpdir(), 'music-doctor-test-'));
  for (const path of CORE_PATHS) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(process.cwd(), path), target);
  }
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Music Test', '-c', 'user.email=music@example.invalid', 'commit', '--quiet', '-m', 'known core']);
  const kernelPath = join(root, 'src', 'kernel.js');
  const expected = readFileSync(kernelPath, 'utf8');
  writeFileSync(kernelPath, 'corrupted stable core\n');

  const failed = doctor(root, 'check');
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(failed.stdout).changed.map(file => file.path), ['src/kernel.js']);

  const repaired = doctor(root, 'restore');
  assert.equal(repaired.status, 0);
  const receipt = JSON.parse(repaired.stdout);
  assert.deepEqual(receipt.restored, ['src/kernel.js']);
  assert.equal(readFileSync(kernelPath, 'utf8'), expected);
  assert.equal(readFileSync(join(receipt.backupRoot, 'src', 'kernel.js'), 'utf8'), 'corrupted stable core\n');
  assert.equal(existsSync(join(root, '.music', 'bootstrap-recovery')), true);
  assert.equal(doctor(root, 'check').status, 0);
});

function doctor(root, command) {
  return spawnSync(process.execPath, [join(root, 'bin', 'music-doctor.js'), command, root], { encoding: 'utf8' });
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}
