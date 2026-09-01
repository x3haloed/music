import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHabitat } from '../src/habitat.js';
import { MusicKernel } from '../src/kernel.js';
import { drainInboundMessages, submitInboundMessage } from '../src/mailbox.js';

test('durable mailbox contact becomes one exact ordinary observation and duplicate delivery is idempotent', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v2-mailbox-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const habitat = createHabitat(join(parent, 'resident'));
  const kernel = new MusicKernel(habitat.root);
  kernel.initialize();
  const envelope = submitInboundMessage(habitat.root, {
    sender: 'Chad', content: 'This is world contact, not an instruction.', authentication: 'local terminal',
  }, { id: () => 'message-one', clock: () => new Date('2026-09-01T17:00:00.000Z') });
  assert.equal(kernel.state().observations.length, 0, 'submission does not race the ledger writer');
  const admitted = drainInboundMessages(habitat.root, kernel);
  assert.equal(admitted.length, 1);
  const observation = kernel.state().observations[0];
  assert.equal(observation.id, envelope.id);
  assert.equal(observation.sender, 'Chad');
  assert.equal(observation.content, envelope.content);
  assert.equal(observation.delivery.adapter, 'music-v2-mailbox-1');
  assert.equal(observation.instruction, undefined);

  submitInboundMessage(habitat.root, { sender: 'Chad', content: envelope.content }, {
    id: () => envelope.id, clock: () => new Date('2026-09-01T17:00:01.000Z'),
  });
  assert.equal(drainInboundMessages(habitat.root, kernel).length, 1);
  assert.equal(kernel.state().observations.length, 1);
});

test('malformed mailbox contact is archived as rejected without blocking later contact', t => {
  const parent = mkdtempSync(join(tmpdir(), 'music-v2-mailbox-reject-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const habitat = createHabitat(join(parent, 'resident'));
  const kernel = new MusicKernel(habitat.root);
  kernel.initialize();
  const pending = join(habitat.root, 'mailbox', 'inbound', 'pending');
  process.getBuiltinModule('node:fs').mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, 'broken.json'), '{not json}\n');
  submitInboundMessage(habitat.root, { sender: 'World', content: 'Valid after malformed contact.' }, { id: () => 'valid-two' });
  const admitted = drainInboundMessages(habitat.root, kernel);
  assert.equal(admitted.length, 1);
  assert.equal(kernel.state().observations[0].content, 'Valid after malformed contact.');
  const rejected = join(habitat.root, 'mailbox', 'inbound', 'rejected');
  assert.equal(readdirSync(rejected).some(name => name === 'broken.json'), true);
  assert.equal(readdirSync(rejected).some(name => name.endsWith('.error.json')), true);
  assert.equal(existsSync(join(pending, 'broken.json')), false);
});
