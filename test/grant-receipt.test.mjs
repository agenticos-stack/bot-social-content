// Audit b7de9dd R1: the preview host reads a grant/activation receipt strictly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grantReceiptOutcome } from '@agenticos-dev/bot-devkit/doors';

const ok = (bodyText) => ({ ok: true, status: 200, bodyText });

test('explicit runtime ready or unchanged is activated', () => {
  assert.equal(grantReceiptOutcome(ok(JSON.stringify({ data: { runtime: { status: 'ready' } } }))).outcome, 'activated');
  assert.equal(grantReceiptOutcome(ok(JSON.stringify({ data: { runtime: { status: 'unchanged' } } }))).outcome, 'activated');
});

test('explicit refresh failure is activation_failed and keeps its message', () => {
  const result = grantReceiptOutcome(ok(JSON.stringify({ data: { runtime: { status: 'refresh_failed', message: 'isolate failed' } } })));
  assert.deepEqual(result, { outcome: 'activation_failed', message: 'isolate failed' });
});

test('HTTP 200 that cannot be read, or says nothing about the runtime, is unconfirmed', () => {
  for (const body of ['{not json', '', '   ', 'null', JSON.stringify({ data: {} }), JSON.stringify({ data: { runtime: {} } }), JSON.stringify({ data: { runtime: { status: 'starting' } } })]) {
    assert.equal(grantReceiptOutcome(ok(body)).outcome, 'unconfirmed', `body ${JSON.stringify(body)}`);
  }
});

test('a classified client refusal is denied; a server error or unreadable refusal is unconfirmed', () => {
  assert.deepEqual(grantReceiptOutcome({ ok: false, status: 409, bodyText: JSON.stringify({ error: { message: 'That permission has not been granted in this conversation.', code: 'not_granted', certainty: 'refused' } }) }), {
    outcome: 'denied',
    message: 'That permission has not been granted in this conversation.'
  });
  assert.equal(grantReceiptOutcome({ ok: false, status: 502, bodyText: '' }).outcome, 'unconfirmed');
  assert.equal(grantReceiptOutcome({ ok: false, status: 409, bodyText: '<html>' }).outcome, 'unconfirmed');
  assert.equal(grantReceiptOutcome({ ok: false, status: 500, bodyText: JSON.stringify({ error: { message: 'boom' } }) }).outcome, 'unconfirmed');
});

test('F02: an explained 4xx without certainty refused (older router) is unconfirmed, not denied', () => {
  assert.equal(grantReceiptOutcome({ ok: false, status: 409, bodyText: JSON.stringify({ error: { message: 'The upstream response was lost.' } }) }).outcome, 'unconfirmed');
  assert.equal(grantReceiptOutcome({ ok: false, status: 409, bodyText: JSON.stringify({ error: { message: 'x', certainty: 'unknown' } }) }).outcome, 'unconfirmed');
  assert.equal(grantReceiptOutcome({ ok: false, status: 502, bodyText: JSON.stringify({ error: { message: 'x', certainty: 'refused' } }) }).outcome, 'unconfirmed');
  assert.equal(grantReceiptOutcome({ ok: false, status: 400, bodyText: JSON.stringify({ error: { message: 'A door is required.', code: 'invalid_request', certainty: 'refused' } }) }).outcome, 'denied');
});
