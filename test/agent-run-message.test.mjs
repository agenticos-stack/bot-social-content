// The host's agent turn text: the owner/host message keeps its 16,000-character
// cap; the gadget's own instructions travel beside it with their own bound.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { composeRunMessage } from '../scripts/connected-agent.mjs';

test('a typed message alone is passed through trimmed', () => {
  assert.equal(composeRunMessage({ message: '  Draft this batch.  ' }), 'Draft this batch.');
});

test('the message cap still applies to what was asked', () => {
  assert.throws(() => composeRunMessage({ message: 'x'.repeat(16_001) }), /up to 16,000 characters/);
  assert.throws(() => composeRunMessage({ message: '   ' }), /up to 16,000 characters/);
});

test('the real agent.md no longer pushes a draft over the message cap', () => {
  const notes = readFileSync(new URL('../src/agent.md', import.meta.url), 'utf8');
  const message = 'The owner requested drafts for batch batch_abc in LOCAL_DEVELOPMENT.';
  assert.ok(notes.length + message.length > 16_000, 'fixture: the notes alone exceed the message cap');
  const composed = composeRunMessage({ message, instructions: notes });
  assert.ok(composed.startsWith(message));
  assert.ok(composed.endsWith(notes.trim()));
});

test('instructions have their own bound and must be text', () => {
  assert.throws(() => composeRunMessage({ message: 'ok', instructions: 'y'.repeat(64_001) }), /64,000/);
  assert.throws(() => composeRunMessage({ message: 'ok', instructions: { text: 'no' } }), /must be text/);
  assert.equal(composeRunMessage({ message: 'ok', instructions: '   ' }), 'ok');
});
