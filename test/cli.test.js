import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../src/cli.js', import.meta.url).pathname;

test('CLI keeps governance control distinct from exact inbox observation', t => {
  const habitat = mkdtempSync(join(tmpdir(), 'music-v2-cli-'));
  t.after(() => rmSync(habitat, { recursive: true, force: true }));
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--habitat', habitat], { encoding: 'utf8' }));
  const initialized = run(['init']);
  assert.equal(initialized.subject.designation, null);
  const grant = run(['grant', 'local.read', '--by', 'Chad acting as machine owner']);
  assert.equal(grant.active, true);
  const message = run(['message', '--from', 'Chad', '--content', 'Please inspect something.']);
  assert.equal(message.content, 'Please inspect something.');
  const status = run(['status']);
  assert.equal(status.observations, 1);
  assert.equal(status.grants[0].capability, 'local.read');
  assert.equal(status.grants[0].grantedBy, 'Chad acting as machine owner');
});
