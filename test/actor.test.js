import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { CodexExecActor, OpenRouterActor, renderInferenceInput, resolveCodexBinary } from '../src/actor.js';
import { RoleSchemas } from '../src/protocol.js';

test('OpenRouter returns one locally validated structured operation judgment', async () => {
  let request;
  const model = new MockLanguageModelV4({
    doGenerate: async options => {
      request = options;
      return response(selection(), 'provider/model-v1');
    },
  });
  const actor = new OpenRouterActor({ model: 'requested/model', languageModel: model });
  const result = await actor.invoke({ role: 'select', schema: RoleSchemas.select, task: 'Select.', projection: projection(7) });
  assert.equal(result.output.stake.id, 'stake-1');
  assert.equal(result.model, 'provider/model-v1');
  assert.equal(request.responseFormat, undefined);
  assert.equal(request.providerOptions.openrouter.reasoning.effort, 'low');
  assert.match(request.prompt[1].content[0].text, /"succession":7/);
  assert.doesNotMatch(request.prompt[1].content[0].text, /ROLE: select/);
  assert.match(request.prompt[2].content[0].text, /ROLE: select/);
});

test('fresh roles receive an identical complete projection core before distinct role context', () => {
  const core = projection(4);
  const select = renderInferenceInput({ role: 'select', projection: core, schema: RoleSchemas.select, task: 'Select.' });
  const expand = renderInferenceInput({ role: 'expand', projection: { ...core, roleAddition: { saturated: true } }, schema: RoleSchemas.expand, task: 'Expand.' });
  assert.equal(select.sharedText, expand.sharedText);
  assert.match(select.sharedText, /"operation":\{"operation":"select"\}/);
  assert.doesNotMatch(select.sharedText, /ROLE:/);
  assert.match(expand.roleText, /ROLE: expand/);
  assert.match(expand.roleText, /"roleAddition":\{"saturated":true\}/);
});

test('OpenRouter GPT-5.6 uses run affinity and an explicit shared-prefix cache breakpoint', async () => {
  let body;
  const actor = routedActor('openai/gpt-5.6-terra', value => { body = value; });
  await actor.invoke({ role: 'select', schema: RoleSchemas.select, task: 'Select.', projection: projection(1) });
  assert.match(body.session_id, /^music-[a-f0-9]{48}$/);
  assert.equal(body.prompt_cache_key, body.session_id);
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  assert.deepEqual(body.messages[1].content[0].cache_control, { type: 'ephemeral' });
});

test('OpenRouter Z.AI uses sticky affinity without unsupported explicit controls', async () => {
  let body;
  const actor = routedActor('z-ai/glm-5.3-flash', value => { body = value; });
  await actor.invoke({ role: 'select', schema: RoleSchemas.select, task: 'Select.', projection: projection(1) });
  assert.match(body.session_id, /^music-[a-f0-9]{48}$/);
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.messages[1].content[0].cache_control, undefined);
});

test('OpenRouter accepts one bare JSON fence but never mines JSON from prose', async () => {
  let text = `\`\`\`json\n${JSON.stringify(selection())}\n\`\`\``;
  const model = new MockLanguageModelV4({ doGenerate: async () => responseText(text) });
  const actor = new OpenRouterActor({ model: 'requested/model', languageModel: model });
  const request = { role: 'select', schema: RoleSchemas.select, task: 'Select.', projection: projection(0) };
  assert.equal((await actor.invoke(request)).output.stake.id, 'stake-1');
  text = `Here is the result:\n\`\`\`json\n${JSON.stringify(selection())}\n\`\`\``;
  await assert.rejects(() => actor.invoke(request), /Unexpected token|Unexpected non-whitespace/);
});

test('Codex inference uses an ephemeral schema-bound process and no response chain', async t => {
  const root = mkdtempSync(join(tmpdir(), 'music-v4-fake-codex-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-codex');
  const callLog = join(root, 'calls.jsonl');
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('codex-cli test-1\\n'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
if (!process.argv.includes('exec')) process.exit(2);
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
  fs.writeFileSync(output, JSON.stringify({ json: ${JSON.stringify(JSON.stringify(selection()))} }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\\n');
});
`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  const actor = new CodexExecActor({ model: 'test-model', binary });
  const result = await actor.invoke({ role: 'select', schema: RoleSchemas.select, task: 'Select.', projection: projection(2) });
  assert.equal(result.output.stake.id, 'stake-1');
  assert.equal(result.responseId, 'thread-test');
  await actor.invoke({ role: 'select', schema: RoleSchemas.select, task: 'Select.', projection: projection(3) });
  const calls = readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse);
  const roots = calls.map(call => call.args[call.args.indexOf('--cd') + 1]);
  assert.equal(roots[0], roots[1]);
  assert.equal(existsSync(roots[0]), false);
  assert.ok(calls[0].input.indexOf('RETAINED_PROJECTION_CORE:') < calls[0].input.indexOf('ROLE: select'));
});

test('Codex binary resolution prefers explicit configuration then the bundled ChatGPT CLI', () => {
  assert.equal(resolveCodexBinary('/custom/codex', { platform: 'darwin', exists: () => true }), '/custom/codex');
  assert.equal(
    resolveCodexBinary('', { platform: 'darwin', exists: path => path === '/Applications/ChatGPT.app/Contents/Resources/codex' }),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  assert.equal(resolveCodexBinary('', { platform: 'linux', exists: () => false }), 'codex');
});

function selection() {
  return {
    opportunityId: 'world:primary',
    stake: { id: 'stake-1', question: 'What bears on this?', successCondition: 'Contact distinguishes it.', surrenderCondition: 'No reachable contact distinguishes it.', mutationSurface: [] },
    rationale: 'It has standing.',
  };
}

function projection(succession) {
  return {
    format: 'music-v4-fresh-projection-1', run: { id: 'resident-run' },
    worlds: [], developmentalInterfaces: {}, capabilities: {},
    subject: { id: 'subject', succession }, operation: { operation: 'select' },
    opportunityProjection: { opportunities: [] }, activeEvidence: null, causalTrail: [],
  };
}

function response(value, modelId) { return { ...responseText(JSON.stringify(value)), response: { id: 'response-1', modelId, timestamp: new Date('2026-01-01T00:00:00.000Z') } }; }
function responseText(text) { return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 30, noCache: 30 }, outputTokens: { total: 20, text: 20 } }, warnings: [] }; }

function routedActor(model, capture) {
  return new OpenRouterActor({
    model, apiKey: 'test-key', providerOptions: { compatibility: 'strict', fetch: async (_url, init) => {
      capture(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'generation', created: 1, model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(selection()) } }], usage: { prompt_tokens: 1200, completion_tokens: 10, total_tokens: 1210, prompt_tokens_details: { cached_tokens: 900 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
}
