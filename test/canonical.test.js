import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, digest } from '../src/canonical.js';

test('canonical JSON is stable across object insertion order', () => {
  assert.equal(canonical({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

test('canonical JSON rejects values that cannot be retained exactly', () => {
  assert.throws(() => canonical({ missing: undefined }), /undefined/);
  assert.throws(() => canonical({ infinite: Infinity }), /finite/);
});
