// Assembled preview host boundary for live updates: HTTP router → the real
// authenticated development session wrapper → a runtime's host event feed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectedApi } from '../scripts/connected-api.mjs';
import { createDevelopmentSessions } from '../scripts/development-session.mjs';

const origin = 'http://127.0.0.1:17931';

function host() {
  let identity = { userId: 'u1', orgId: 'o1' };
  const listeners = new Set();
  const development = createDevelopmentSessions({
    appKey: 'synthetic',
    origin,
    authenticate: async () => identity,
    createRuntime: async () => ({
      events(listener) { listeners.add(listener); return () => listeners.delete(listener); },
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
  const open = () => {
    const controller = new AbortController();
    return { controller, response: handle(new Request(`${origin}/api/dev/events`, { method: 'GET', headers: { origin }, signal: controller.signal })) };
  };
  return { development, open, listeners, emit: (type) => { for (const l of [...listeners]) l({ type }); }, signInAs: (next) => { identity = next; } };
}

async function readUntil(reader, predicate, limit = 20) {
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < limit; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    if (predicate(text)) break;
  }
  return text;
}

test('the running session owner receives host-observed changes as events', async () => {
  const h = host();
  await h.development.start(new Request(origin));
  const { response } = h.open();
  const res = await response;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  await readUntil(reader, (t) => t.includes(': connected'));
  assert.equal(h.listeners.size, 1);
  h.emit('generated_image');
  h.emit('revision');
  const text = await readUntil(reader, (t) => t.includes('"revision"'));
  assert.match(text, /data: \{"type":"generated_image"\}/);
  assert.match(text, /data: \{"type":"revision"\}/);
  await reader.cancel();
  assert.equal(h.listeners.size, 0, 'cancelling the stream unsubscribes');
  await h.development.dispose();
});

test('no running session: refused, and none is started', async () => {
  const h = host();
  const res = await h.open().response;
  assert.equal(res.status, 409);
  assert.match((await res.json()).error.message, /Start the development session first/);
  assert.equal(h.listeners.size, 0);
  await h.development.dispose();
});

test('another account cannot listen to this session', async () => {
  const h = host();
  await h.development.start(new Request(origin));
  h.signInAs({ userId: 'u2', orgId: 'o1' });
  const res = await h.open().response;
  assert.equal(res.status, 409);
  assert.equal(h.listeners.size, 0);
  await h.development.dispose();
});
