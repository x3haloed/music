import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachAttentionManifest, DEFAULT_ATTENTION_POLICY } from '../src/attention.js';
import { OpenRouterActor } from '../src/actor.js';
import { builtinWorlds } from '../src/builtin-worlds.js';
import { RoleSchemas } from '../src/protocol.js';
import { RunStore } from '../src/store.js';

test('attention progressively indexes low-salience material under its target without destroying its exact reference', () => {
  const exactSubject = { format: 'music-v3-object-1', sha256: 'a'.repeat(64), bytes: 123, mediaType: 'application/json' };
  const projection = {
    subjectEvidence: exactSubject,
    subject: { facts: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`fact-${index}`, { body: 'x'.repeat(1000) }])), memory: { bulky: 'y'.repeat(200_000) } },
    history: Array.from({ length: 12 }, (_, generation) => ({ generation, successor: { id: `subject-${generation}` }, receipt: { reference: exactSubject }, detail: 'structural-card' })),
  };
  const policy = { ...DEFAULT_ATTENTION_POLICY, targetInputTokens: 20_000, maximumInputTokens: 30_000, maximumInputCharacters: 80_000 };
  const result = attachAttentionManifest(projection, policy);
  assert.ok(JSON.stringify(result).length < 80_000);
  assert.ok(result.attentionManifest.indexedHistoryEntries > 0);
  assert.equal(result.subjectFactsIndex.exactSubject.sha256, exactSubject.sha256);
  assert.equal(result.subject.memory.bulky.exactSubject.sha256, exactSubject.sha256);
});

test('provider input overflow is a permanent local failure before network inference', async () => {
  let invoked = false;
  const actor = new OpenRouterActor({
    model: 'test/model', maximumInputTokens: 16_384, maximumInputCharacters: 65_536,
    languageModel: { specificationVersion: 'v4', provider: 'test', modelId: 'test', supportedUrls: {}, doGenerate: async () => { invoked = true; throw new Error('should not invoke'); } },
  });
  await assert.rejects(() => actor.invoke({ role: 'orient', schema: RoleSchemas.orient, task: 'Orient.', projection: { subject: { memory: 'x'.repeat(70_000) } } }), error => {
    assert.equal(error.name, 'InferenceInputTooLargeError');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(invoked, false);
});

test('evidence-read returns bounded exact ranges from a verified retained object', async t => {
  const root = mkdtempSync(join(tmpdir(), 'music-evidence-read-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RunStore(root);
  const reference = store.put({ text: 'abcdefghijklmnopqrstuvwxyz' });
  const adapter = builtinWorlds().get('evidence-read');
  const output = await adapter.execute({ reference, offset: 10, maxCharacters: 8 }, { runRoot: root });
  assert.equal(output.content.length, 8);
  assert.equal(output.sha256, reference.sha256);
  assert.equal(output.hasMore, true);
  assert.deepEqual(adapter.conformOutput(output), []);
});
