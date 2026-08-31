import assert from 'node:assert/strict';
import test from 'node:test';
import { generateText, isStepCount, jsonSchema, tool } from 'ai';
import { assertToolCapability, createConfiguredModel } from '../src/provider.js';

test('dedicated OpenRouter provider carries the complete tool protocol with strict compatibility', async () => {
  const previous = process.env.MUSIC_TEST_OPENROUTER_KEY;
  process.env.MUSIC_TEST_OPENROUTER_KEY = 'secret-test-key';
  let call = 0;
  const fetch = async () => {
    call += 1;
    return jsonResponse(call === 1
      ? completion({
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'message', arguments: '{"content":"hello"}' } }],
        }, 'tool_calls')
      : completion({ content: 'done' }, 'stop'));
  };

  try {
    const configured = createConfiguredModel({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      apiKeyEnv: 'MUSIC_TEST_OPENROUTER_KEY',
      appName: 'Music Tests',
      appUrl: 'https://example.invalid/music',
    }, { fetch });
    const result = await generateText({
      model: configured.model,
      tools: {
        message: tool({
          description: 'Emit a test message.',
          inputSchema: jsonSchema({
            type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false,
          }),
          execute: async ({ content }) => ({ emitted: content }),
        }),
      },
      stopWhen: isStepCount(2),
      prompt: 'Send hello.',
    });

    assert.equal(result.text, 'done');
    assert.equal(call, 2);
    const requests = configured.requests();
    assert.equal(requests[0].body.model, 'openai/gpt-4o-mini');
    assert.equal(requests[0].body.tools[0].function.name, 'message');
    assert.ok(requests[1].body.messages.some(message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call-1'));
    assert.ok(requests[1].body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-1'));
    assert.ok(requests[0].headerNames.includes('http-referer'));
    assert.ok(requests[0].headerNames.includes('x-openrouter-title'));
    assert.ok(!requests[0].headerNames.includes('authorization'));
  } finally {
    if (previous === undefined) delete process.env.MUSIC_TEST_OPENROUTER_KEY;
    else process.env.MUSIC_TEST_OPENROUTER_KEY = previous;
  }
});

test('generic OpenAI-compatible endpoints remain a separate provider path', async () => {
  const configured = createConfiguredModel({
    provider: 'openai-compatible',
    name: 'local-test',
    model: 'local-model',
    baseURL: 'http://localhost:1234/v1',
    capabilities: { tools: true },
  }, {
    fetch: async () => jsonResponse(completion({ content: 'local response' }, 'stop')),
  });

  const result = await generateText({ model: configured.model, prompt: 'Hello.' });
  assert.equal(result.text, 'local response');
  assert.equal(configured.requests()[0].url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(configured.requests()[0].body.model, 'local-model');
});

test('OpenRouter capability preflight rejects models without declared tool support', async () => {
  const previous = process.env.MUSIC_TEST_OPENROUTER_KEY;
  process.env.MUSIC_TEST_OPENROUTER_KEY = 'secret-test-key';
  try {
    const baseConfig = {
      provider: 'openrouter', model: 'example/model', apiKeyEnv: 'MUSIC_TEST_OPENROUTER_KEY',
    };
    await assert.doesNotReject(() => assertToolCapability(baseConfig, {
      fetch: async () => jsonResponse({ data: { id: 'example/model', supported_parameters: ['tools', 'temperature'] } }),
    }));
    await assert.rejects(() => assertToolCapability(baseConfig, {
      fetch: async () => jsonResponse({ data: { id: 'example/model', supported_parameters: ['temperature'] } }),
    }), /does not declare tool support/);
  } finally {
    if (previous === undefined) delete process.env.MUSIC_TEST_OPENROUTER_KEY;
    else process.env.MUSIC_TEST_OPENROUTER_KEY = previous;
  }
});

test('generic providers require an explicit tool-capability claim', async () => {
  await assert.rejects(() => assertToolCapability({
    provider: 'openai-compatible', model: 'unknown', baseURL: 'http://localhost:1234/v1',
  }), /capabilities\.tools=true/);
});

test('provider config carries explicit inference spend guards', () => {
  const configured = createConfiguredModel({
    provider: 'openai-compatible', model: 'local', baseURL: 'http://localhost:1234/v1',
    capabilities: { tools: true }, maxSteps: 1, maxOutputTokens: 32, maxRetries: 0,
  });
  assert.deepEqual(configured.inference, { maxSteps: 1, maxOutputTokens: 32, maxRetries: 0 });
  assert.throws(() => createConfiguredModel({
    provider: 'openai-compatible', model: 'local', baseURL: 'http://localhost:1234/v1',
    capabilities: { tools: true }, maxRetries: -1,
  }), /maxRetries/);
});

function completion(message, finishReason) {
  return {
    id: 'generation-1',
    object: 'chat.completion',
    created: 1_788_000_000,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
