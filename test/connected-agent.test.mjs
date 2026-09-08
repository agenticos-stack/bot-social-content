import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socialMethodNames, sourceDigest } from '../scripts/connected-agent.mjs';

test('source digest is deterministic and independent of file insertion order', () => {
  assert.equal(sourceDigest({ 'b.js': 'b', 'a.js': 'a' }), sourceDigest({ 'a.js': 'a', 'b.js': 'b' }));
  assert.notEqual(sourceDigest({ 'a.js': 'a' }), sourceDigest({ 'a.js': 'changed' }));
});

test('development method metadata is bounded and unique', () => {
  const methods = socialMethodNames();
  assert.ok(methods.length > 10 && methods.length <= 64);
  assert.equal(new Set(methods).size, methods.length);
  assert.ok(methods.includes('summary'));
  assert.ok(methods.includes('saveRevision'));
});
