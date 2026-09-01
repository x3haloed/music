import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('doctor and template expose an executable sealed envelope', () => {
  const doctor = JSON.parse(execFileSync(process.execPath, ['bin/music-doctor.js'], { cwd: root, encoding: 'utf8' }));
  assert.equal(doctor.ready, true);
  assert.match(doctor.runtime.sources['src/selector.js'], /^[a-f0-9]{64}$/);
  assert.match(doctor.runtime.sources['src/cli.js'], /^[a-f0-9]{64}$/);
  const worlds = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'worlds'], { cwd: root, encoding: 'utf8' }));
  assert.ok(worlds.some(value => value.id === 'http-json' && /^[a-f0-9]{64}$/.test(value.identity)));
  const template = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'template', 'http-json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(template.format, 'music-v3-run-spec-1');
  assert.equal(template.limits.continuityPulseMs, 300_000);
  assert.equal(template.worlds[0].adapterIdentity, worlds.find(value => value.id === 'http-json').identity);
});

test('CLI refuses an unapproved OpenRouter model before inference', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v3-model-policy-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const spec = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'template', 'operator-outbox'], { cwd: root, encoding: 'utf8' }));
  spec.actor.model = 'expensive/provider-model';
  const specPath = join(parent, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec));
  assert.throws(
    () => execFileSync(process.execPath, ['src/cli.js', 'init', join(parent, 'run'), specPath], { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
    error => /outside MUSIC_ALLOWED_OPENROUTER_MODELS/.test(String(error.stderr)),
  );
});
