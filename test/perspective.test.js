import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstJsonValue } from '../src/perspective.js';

test('deterministic adapter extracts one complete JSON value from OpenRouter trailing prose', () => {
  const text = 'preface {"value":"brace } and quote \\\" stay quoted","nested":[1,{"ok":true}]} trailing notes';
  assert.equal(extractFirstJsonValue(text), '{"value":"brace } and quote \\\" stay quoted","nested":[1,{"ok":true}]}');
  assert.deepEqual(JSON.parse(extractFirstJsonValue(text)), {
    value: 'brace } and quote " stay quoted',
    nested: [1, { ok: true }],
  });
});

test('deterministic adapter rejects incomplete JSON', () => {
  assert.throws(() => extractFirstJsonValue('{"value":'), /no complete/);
});

test('deterministic adapter skips bracketed prose before a valid object', () => {
  assert.equal(extractFirstJsonValue('[not JSON] note {"valid":true}'), '{"valid":true}');
});
