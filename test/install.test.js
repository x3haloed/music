import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRelease } from '../src/install.js';

test('release installation copies only the runtime body and publishes atomically after verification', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v3-install-'));
  const destination = join(parent, 'music-0.0.4');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const result = installRelease(destination, {
    dependencyInstaller: () => {},
    releaseVerifier: () => ({ ready: true, node: process.version, runtime: { implementationSha256: 'a'.repeat(64), dependencyLockSha256: 'b'.repeat(64) } }),
    clock: () => new Date('2026-09-01T00:00:00.000Z'),
  });
  assert.equal(result.destination, destination);
  assert.equal(result.manifest.version, '0.0.4');
  assert.match(result.manifest.implementationSha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(destination, 'src/kernel.js')), true);
  assert.equal(existsSync(join(destination, 'package-lock.json')), true);
  assert.equal(existsSync(join(destination, 'test')), false);
  assert.equal(existsSync(join(destination, '.codex')), false);
  assert.throws(() => installRelease(destination, { dependencyInstaller: () => {} }), /already exists/);
});
