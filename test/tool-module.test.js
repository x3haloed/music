import assert from 'node:assert/strict';
import test from 'node:test';
import { executeToolModule } from '../src/tool-module.js';

function moduleWith(source) {
  return {
    id: 'learned_probe',
    version: 1,
    parent: null,
    description: 'A learned probe used to exercise executable source form.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    source,
  };
}

test('a learned tool body returns its JSON value directly', async () => {
  assert.deepEqual(
    await executeToolModule(moduleWith('return { ok: true };'), {}),
    { ok: true },
  );
});

test('a full function wrapper receives an exact corrective diagnostic', async () => {
  await assert.rejects(
    executeToolModule(moduleWith('async function run(input, context) { return { ok: true }; }'), {}),
    /source defines a function instead of executing body statements; remove the function wrapper and return a JSON value directly/,
  );
});
