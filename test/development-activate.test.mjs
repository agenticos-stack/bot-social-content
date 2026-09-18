// Assembled preview host boundary: HTTP router → authenticated development
// session wrapper → runtime activation. No network, no runtime mock bypassing
// the wrapper: the router is `createConnectedApi`, the wrapper is the real
// `createDevelopmentSessions`, and only the runtime underneath is synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectedApi } from '../scripts/connected-api.mjs';
import { createDevelopmentSessions } from '../scripts/development-session.mjs';
import { refuse } from '@agenticos-dev/bot-devkit/doors';

const origin = 'http://127.0.0.1:17931';

function host({ identity = { userId: 'u1', orgId: 'o1' }, activate } = {}) {
  let current = identity;
  const calls = [];
  const development = createDevelopmentSessions({
    appKey: 'synthetic',
    origin,
    authenticate: async () => current,
    createRuntime: async () => ({
      ...(activate === null ? {} : {
        activate: async (input) => {
          calls.push(input);
          return activate ? activate(input) : { requirementKey: input.requirementKey, runtime: { status: 'ready' } };
        }
      }),
      dispose: async () => {}
    })
  });
  const handle = createConnectedApi({
    apiOrigin: 'http://127.0.0.1:8789',
    frontendOrigin: origin,
    development,
    platform: 'local',
    fetcher: async () => { throw new Error('Network disabled'); }
  });
  const post = (body) => handle(new Request(`${origin}/api/dev/activate`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  return { development, post, calls, signInAs: (next) => { current = next; } };
}

test('authenticated owner of the running session reaches the runtime and gets its result', async () => {
  const h = host();
  await h.development.start(new Request(origin));
  const response = await h.post({ requirementKey: 'metered_fetch' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { requirementKey: 'metered_fetch', runtime: { status: 'ready' } });
  assert.deepEqual(h.calls, [{ requirementKey: 'metered_fetch' }]);
  await h.development.dispose();
});

test('no running session: refused, and no session is started by activation', async () => {
  const h = host();
  const response = await h.post({ requirementKey: 'metered_fetch' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /Start the development session first/);
  assert.equal(h.calls.length, 0);
  await h.development.dispose();
});

test('a different user or organization cannot activate on this session', async () => {
  for (const other of [{ userId: 'u2', orgId: 'o1' }, { userId: 'u1', orgId: 'o2' }]) {
    const h = host();
    await h.development.start(new Request(origin));
    h.signInAs(other);
    const response = await h.post({ requirementKey: 'metered_fetch' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error.message, /switch account or organization/);
    assert.equal(h.calls.length, 0);
    await h.development.dispose();
  }
});

test('signed out: refused before any runtime work', async () => {
  const h = host();
  await h.development.start(new Request(origin));
  h.signInAs(null);
  const response = await h.post({ requirementKey: 'metered_fetch' });
  assert.equal(response.status, 409);
  assert.equal(h.calls.length, 0);
  await h.development.dispose();
});

test('a door the conversation does not hold is refused by the runtime, not granted', async () => {
  const h = host({ activate: () => { throw refuse('That permission has not been granted in this conversation.', 'not_granted'); } });
  await h.development.start(new Request(origin));
  const response = await h.post({ requirementKey: 'metered_fetch' });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error.message, /has not been granted/);
  assert.equal(body.error.certainty, 'refused');
  await h.development.dispose();
});

test('a runtime that could not start the door reports refresh_failed, not success', async () => {
  const h = host({ activate: (input) => ({ requirementKey: input.requirementKey, runtime: { status: 'refresh_failed', message: 'isolate failed' } }) });
  await h.development.start(new Request(origin));
  const response = await h.post({ requirementKey: 'metered_fetch' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.runtime.status, 'refresh_failed');
  await h.development.dispose();
});

test('a runtime without activation support answers with a clear refusal', async () => {
  const h = host({ activate: null });
  await h.development.start(new Request(origin));
  const response = await h.post({ requirementKey: 'metered_fetch' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /unavailable in this development session/);
  await h.development.dispose();
});

test('the body names the door and nothing else', async () => {
  const h = host();
  await h.development.start(new Request(origin));
  const response = await h.post({ requirementKey: 'metered_fetch', persistToAgent: true });
  assert.equal(response.status, 400);
  assert.equal(h.calls.length, 0);
  await h.development.dispose();
});
