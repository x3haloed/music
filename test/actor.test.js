import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { CodexExecActor, OpenRouterActor } from '../src/actor.js';
import { RoleSchemas } from '../src/protocol.js';

test('OpenRouter actor accepts descriptive live stakes in one locally validated fresh request and binds reasoning policy', async () => {
  let request;
  const model = new MockLanguageModelV4({
    doGenerate: async options => {
      request = options;
      return {
        content: [{ type: 'text', text: JSON.stringify({ summary: 'Remain exact.', liveStakes: ['Whether the first contact leaves durable evidence'], recommendedNext: 'Contact the world.' }) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
        response: { id: 'response-1', modelId: 'provider/model-v1', timestamp: new Date('2026-01-01T00:00:00.000Z') },
      };
    },
  });
  const actor = new OpenRouterActor({ model: 'requested/model', languageModel: model });
  const result = await actor.invoke({
    role: 'orient',
    schema: RoleSchemas.orient,
    task: 'Orient.',
    projection: { subject: { generation: 7 }, retained: 'exact' },
  });
  assert.equal(result.output.summary, 'Remain exact.');
  assert.deepEqual(result.output.liveStakes, ['Whether the first contact leaves durable evidence']);
  assert.equal(result.model, 'provider/model-v1');
  assert.equal(result.responseId, 'response-1');
  assert.equal(request.responseFormat, undefined);
  assert.equal(request.providerOptions.openrouter.reasoning.effort, 'low');
  assert.equal(actor.describe().settings.reasoningEffort, 'low');
  assert.match(request.prompt[1].content[0].text, /"retained":"exact"/);
});

test('OpenRouter actor accepts one bare JSON fence but never extracts JSON from prose', async () => {
  let text = '```json\n{"summary":"Fenced.","liveStakes":[],"recommendedNext":"Proceed."}\n```';
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
    }),
  });
  const actor = new OpenRouterActor({ model: 'requested/model', languageModel: model });
  const request = { role: 'orient', schema: RoleSchemas.orient, task: 'Orient.', projection: { subject: { generation: 0 } } };
  assert.equal((await actor.invoke(request)).output.summary, 'Fenced.');
  text = 'Here is the result:\n```json\n{"summary":"Hidden.","liveStakes":[],"recommendedNext":"Proceed."}\n```';
  await assert.rejects(() => actor.invoke(request), /Unexpected token|Unexpected non-whitespace/);
});

test('Codex exec actor uses an ephemeral schema-bound process without retaining its workspace', async t => {
  const root = mkdtempSync(join(tmpdir(), 'music-v3-fake-codex-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-codex');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli test-1\\n'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
if (!process.argv.includes('exec')) { process.stderr.write('unsupported fake-codex command\\n'); process.exit(2); }
const outputIndex = process.argv.indexOf('--output-last-message');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) { process.stderr.write('missing output path\\n'); process.exit(2); }
const output = process.argv[outputIndex + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(output, JSON.stringify({ json: JSON.stringify({ summary: 'Fresh process.', liveStakes: ['continuity'], recommendedNext: 'Proceed.' }) }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
});
`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  const actor = new CodexExecActor({ model: 'test-model', binary });
  const result = await actor.invoke({ role: 'orient', schema: RoleSchemas.orient, task: 'Orient.', projection: { subject: { generation: 2 } } });
  assert.equal(result.output.summary, 'Fresh process.');
  assert.equal(result.responseId, 'thread-test');
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(actor.describe().settings.binaryVersion, 'codex-cli test-1');
  assert.equal(actor.describe().settings.authentication, 'chatgpt-subscription');
  assert.equal(JSON.stringify(actor.describe()).includes(root), false);
});
