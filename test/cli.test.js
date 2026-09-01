import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('doctor and template expose an executable sealed envelope', () => {
  const doctor = JSON.parse(execFileSync(process.execPath, ['bin/music-doctor.js'], { cwd: root, encoding: 'utf8' }));
  assert.equal(doctor.ready, true);
  const worlds = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'worlds'], { cwd: root, encoding: 'utf8' }));
  assert.ok(worlds.some(value => value.id === 'http-json' && /^[a-f0-9]{64}$/.test(value.identity)));
  const template = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'template', 'http-json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(template.format, 'music-v3-run-spec-1');
  assert.equal(template.worlds[0].adapterIdentity, worlds.find(value => value.id === 'http-json').identity);
});
