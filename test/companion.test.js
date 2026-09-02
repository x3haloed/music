import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveCompanionPhase, discoverActiveResidentRoot, discoverResidentCli, projectConversation, sendCompanionMessage } from '../src/companion.js';

test('Companion projects retained human observations and actual outbox deliveries without inventing replies', () => {
  const root = mkdtempSync(join(tmpdir(), 'music-companion-conversation-'));
  const events = [
    { type: 'observation.received', at: '2026-09-01T00:00:00.000Z', payload: { id: 'hello', channel: 'operator', from: 'Chad', content: { message: 'Hello.' } } },
    { type: 'observation.received', at: '2026-09-01T00:01:00.000Z', payload: { id: 'pulse', channel: 'continuity', from: 'music', content: { kind: 'continuity-pulse', instructions: [] } } },
  ];
  mkdirSync(join(root, 'outbox'));
  writeFileSync(join(root, 'outbox', 'delivery.json'), JSON.stringify({ deliveryId: 'delivery', message: { text: 'I am here.' }, cycleId: 'cycle-1', subjectId: 'subject-1' }));
  const projected = projectConversation(root, events);
  assert.deepEqual(projected.map(message => [message.direction, message.speaker, message.text]), [
    ['human', 'Chad', 'Hello.'],
    ['resident', 'Resident', 'I am here.'],
  ]);
  assert.equal(projected[1].structuredContent, undefined);
});

test('Companion gives structured resident contact a readable claim while retaining its exact payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'music-companion-structured-'));
  mkdirSync(join(root, 'outbox'));
  const message = { kind: 'gate-release', claim: 'The gate is released.', evidence: { digest: 'abc' } };
  writeFileSync(join(root, 'outbox', 'delivery.json'), JSON.stringify({ deliveryId: 'delivery', message }));
  const [projected] = projectConversation(root, []);
  assert.equal(projected.text, 'The gate is released.');
  assert.deepEqual(projected.structuredContent, message);
});

test('Companion executes the sealed CLI directly instead of relaunching its Electron executable', async () => {
  let call;
  const result = await sendCompanionMessage('/run', ' hello ', {
    cliPath: '/release/src/cli.js',
    execute: async (...args) => {
      call = args;
      return { stdout: JSON.stringify({ accepted: true, pendingObservations: 1, head: 'abc' }) };
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(call[0], '/release/src/cli.js');
  assert.deepEqual(call[1], ['observe', '/run', '{"message":"hello"}', 'operator', 'Chad']);
});

test('Companion discovers the exact CLI from the live resident lease rather than the development tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'music-companion-discovery-'));
  const cli = join(root, 'release', 'src', 'cli.js');
  mkdirSync(join(root, 'release', 'src'), { recursive: true });
  writeFileSync(cli, '');
  writeFileSync(join(root, 'resident.lock'), JSON.stringify({ format: 'music-v4-resident-lease-1', pid: 42 }));
  const found = await discoverResidentCli(root, { execute: async () => ({ stdout: `node ${cli} hatch /run /spec\n` }) });
  assert.equal(found, cli);
});

test('Companion follows the newest live successor instead of a fixed resident directory', () => {
  const residents = mkdtempSync(join(tmpdir(), 'music-companion-residents-'));
  const old = join(residents, 'resident');
  const successor = join(residents, 'resident-successor');
  mkdirSync(old);
  mkdirSync(successor);
  writeFileSync(join(old, 'resident.lock'), JSON.stringify({ format: 'music-v4-resident-lease-1', pid: 41, acquiredAt: '2026-09-01T01:00:00.000Z' }));
  writeFileSync(join(successor, 'resident.lock'), JSON.stringify({ format: 'music-v4-resident-lease-1', pid: 42, acquiredAt: '2026-09-01T02:00:00.000Z' }));
  assert.equal(discoverActiveResidentRoot(residents, { processAlive: pid => pid === 42 }), successor);
});

test('Companion presence reports the active fresh perspective without treating it as a message', () => {
  const events = [
    { type: 'actor.started', payload: { invocationId: 'actor-1', role: 'expand' } },
  ];
  const audit = { completed: null, waitingUntil: null };
  assert.deepEqual(deriveCompanionPhase(events, audit, true), { id: 'expand', label: 'Expanding', tone: 'thinking' });
  assert.deepEqual(deriveCompanionPhase(events, audit, false), { id: 'offline', label: 'Offline', tone: 'error' });
});
