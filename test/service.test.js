import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderLaunchAgent, serviceDefinition } from '../src/service.js';

test('LaunchAgent binds one immutable release to one durable run and restart-safe resident command', () => {
  const root = mkdtempSync(join(tmpdir(), 'music-v4-service-'));
  const release = join(root, 'release');
  const spec = join(root, 'resident.json');
  mkdirSync(join(release, 'src'), { recursive: true });
  writeFileSync(join(release, 'src', 'cli.js'), '');
  writeFileSync(spec, '{}');
  const definition = serviceDefinition({
    label: 'com.x3haloed.music.resident-v4', release, run: join(root, 'resident'), spec,
    node: '/usr/local/bin/node', logsRoot: join(root, 'logs'),
  });
  const plist = renderLaunchAgent(definition);
  assert.match(plist, /<string>resident<\/string>/);
  assert.match(plist, new RegExp(definition.cli.replaceAll('/', '\\/')));
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /OPENROUTER_API_KEY|EnvironmentVariables/);
});

test('LaunchAgent XML escapes all external path and label material', () => {
  const root = mkdtempSync(join(tmpdir(), 'music-v4-service-'));
  const release = join(root, 'release&body');
  const spec = join(root, 'resident.json');
  mkdirSync(join(release, 'src'), { recursive: true });
  writeFileSync(join(release, 'src', 'cli.js'), '');
  writeFileSync(spec, '{}');
  const plist = renderLaunchAgent({ label: 'com.example.music', release, run: join(root, 'resident'), spec, node: '/usr/bin/node', logsRoot: join(root, 'logs') });
  assert.match(plist, /release&amp;body/);
  assert.doesNotMatch(plist, /release&body/);
});
