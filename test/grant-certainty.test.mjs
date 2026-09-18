// Audit f0922d6 F02: a grant or activation failure keeps its certainty across
// the assembled host path — real router (createConnectedApi) → real session
// wrapper (createDevelopmentSessions) → real door runtime (createDoorRuntime)
// → receipt parser. Only the platform agent underneath is synthetic, and it
// counts every consent write.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectedApi } from '../scripts/connected-api.mjs';
import { createDevelopmentSessions } from '../scripts/development-session.mjs';
import { createDoorRuntime } from '@agenticos-dev/bot-devkit/doors';
import { refuse } from '@agenticos-dev/bot-devkit/doors';
import { grantReceiptOutcome } from '@agenticos-dev/bot-devkit/doors';

const origin = 'http://127.0.0.1:17931';

/** A synthetic platform: an authoritative grant list plus scripted failures. */
function platform({ onGrant, onList, onActivate } = {}) {
  const state = { granted: new Set(), grantWrites: [], activations: 0, lists: 0 };
  const agent = {
    async grantDoor(input) {
      if (input?.requirementKey !== 'metered_fetch') throw refuse('That door is not one this gadget declared.', 'not_declared');
      state.grantWrites.push({ ...input });
      if (onGrant) return onGrant(input, state);
      state.granted.add(input.requirementKey);
      return { requirementKey: input.requirementKey, persistedToAgent: false };
    },
    async grantedDoorKeys() {
      state.lists += 1;
      if (onList) return onList(state);
      return [...state.granted];
    }
  };
  const activateRuntime = async (force) => {
    state.activations += 1;
    if (onActivate) return onActivate(force, state);
    return { status: 'ready' };
  };
  return { state, agent, activateRuntime };
}

function host(p, { rawRuntime } = {}) {
  const development = createDevelopmentSessions({
    appKey: 'synthetic', origin,
    authenticate: async () => ({ userId: 'u1', orgId: 'o1', cookie: 'session=a' }),
    createRuntime: async () => ({ ...(rawRuntime ?? createDoorRuntime(p)), dispose: async () => {} })
  });
  const handle = createConnectedApi({
    apiOrigin: 'http://127.0.0.1:8789', frontendOrigin: origin, development, platform: 'local',
    fetcher: async () => { throw new Error('Network disabled'); }
  });
  const post = async (path, body) => {
    const response = await handle(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const bodyText = await response.text();
    return { status: response.status, body: JSON.parse(bodyText), result: grantReceiptOutcome({ ok: response.ok, status: response.status, bodyText }) };
  };
  return {
    development,
    grant: (requirementKey = 'metered_fetch') => post('/api/dev/grant', { requirementKey, persistToAgent: false }),
    activate: (requirementKey = 'metered_fetch') => post('/api/dev/activate', { requirementKey })
  };
}

async function started(p, options) {
  const h = host(p, options);
  await h.development.start(new Request(origin));
  return h;
}

function assertNoBroaderConsent(state) {
  for (const write of state.grantWrites) assert.equal(write.persistToAgent, false, 'recovery never broadens consent');
}

test('explicit refusal before any write is denied, with no consent write', async () => {
  const p = platform();
  const h = await started(p);
  const answer = await h.grant('email');
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error.certainty, 'refused');
  assert.equal(answer.body.error.code, 'not_declared');
  assert.equal(answer.result.outcome, 'denied');
  assert.equal(p.state.grantWrites.length, 0);
  await h.development.dispose();
});

test('upstream refusal (structured 4xx) stays denied through the whole path', async () => {
  const p = platform({ onGrant: () => { throw refuse('Only the owner can grant this door.', 'not_owner'); } });
  const h = await started(p);
  const answer = await h.grant();
  assert.equal(answer.status, 409);
  assert.equal(answer.result.outcome, 'denied');
  await h.development.dispose();
});

test('consent persisted then the response lost is unconfirmed; activation recheck shows it granted with no second grant write', async () => {
  const p = platform({ onGrant: (input, state) => { state.granted.add(input.requirementKey); throw new Error('The upstream response was lost.'); } });
  const h = await started(p);
  const answer = await h.grant();
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error.certainty, 'unknown');
  assert.equal(answer.result.outcome, 'unconfirmed');
  assert.equal(p.state.grantWrites.length, 1);

  const recheck = await h.activate();
  assert.equal(recheck.status, 200);
  assert.equal(recheck.result.outcome, 'activated');
  assert.equal(p.state.lists, 1, 'recovery re-read the authoritative grant list');
  assert.equal(p.state.grantWrites.length, 1, 'recovery wrote no second grant');
  assertNoBroaderConsent(p.state);
  await h.development.dispose();
});

test('a lost grant that never landed: unconfirmed, and the recheck is an honest refusal that writes nothing', async () => {
  const p = platform({ onGrant: () => { throw new Error('fetch failed'); } });
  const h = await started(p);
  const answer = await h.grant();
  assert.equal(answer.result.outcome, 'unconfirmed');
  const recheck = await h.activate();
  assert.equal(recheck.status, 409);
  assert.equal(recheck.body.error.code, 'not_granted');
  assert.equal(recheck.result.outcome, 'denied');
  assert.equal(p.state.grantWrites.length, 1);
  assert.equal(p.state.activations, 0, 'nothing started for a key the platform does not list');
  await h.development.dispose();
});

test('activation performed then the response lost is unconfirmed; recheck activates', async () => {
  let lose = true;
  const p = platform({
    onActivate: () => {
      if (lose) { lose = false; throw new Error('socket closed after restart'); }
      return { status: 'unchanged' };
    }
  });
  p.state.granted.add('metered_fetch');
  const h = await started(p);
  const answer = await h.activate();
  assert.equal(answer.status, 502);
  assert.equal(answer.result.outcome, 'unconfirmed');
  assert.equal(p.state.activations, 1);
  const recheck = await h.activate();
  assert.equal(recheck.result.outcome, 'activated');
  assert.equal(p.state.grantWrites.length, 0, 'activation never creates consent');
  await h.development.dispose();
});

test('failure before any effect with an unknown cause is unconfirmed, never a fabricated denial', async () => {
  for (const p of [
    platform({ onList: () => { throw new Error('API request failed (503).'); } }),
    platform({ onList: () => { throw new TypeError('Cannot read properties of undefined'); } })
  ]) {
    const h = await started(p);
    const answer = await h.activate();
    assert.equal(answer.status, 502);
    assert.equal(answer.body.error.certainty, 'unknown');
    assert.equal(answer.result.outcome, 'unconfirmed');
    await h.development.dispose();
  }
  const p = platform({ onGrant: () => { throw 'not even an Error'; } });
  const h = await started(p);
  assert.equal((await h.grant()).result.outcome, 'unconfirmed');
  await h.development.dispose();
});

test('malformed successful responses are unconfirmed', async () => {
  for (const runtime of [
    { grant: async () => ({ requirementKey: 'metered_fetch' }), activate: async () => ({}) },
    { grant: async () => ({ runtime: { status: 'starting' } }), activate: async () => ({ runtime: null }) }
  ]) {
    const h = await started(null, { rawRuntime: runtime });
    const g = await h.grant();
    assert.equal(g.status, 200);
    assert.equal(g.result.outcome, 'unconfirmed');
    assert.equal((await h.activate()).result.outcome, 'unconfirmed');
    await h.development.dispose();
  }
});

test('success mappings hold: ready activated, refresh_failed activation_failed', async () => {
  const p = platform({ onActivate: (force) => (force ? { status: 'refresh_failed', message: 'isolate failed' } : { status: 'ready' }) });
  const h = await started(p);
  assert.equal((await h.grant()).result.outcome, 'activated');
  const again = await h.activate();
  assert.deepEqual(again.result, { outcome: 'activation_failed', message: 'isolate failed' });
  await h.development.dispose();
});

test('repeated rechecks after an unconfirmed grant never add or broaden consent', async () => {
  const p = platform({ onGrant: (input, state) => { state.granted.add(input.requirementKey); throw new Error('lost'); } });
  const h = await started(p);
  await h.grant();
  for (let i = 0; i < 3; i += 1) assert.equal((await h.activate()).result.outcome, 'activated');
  assert.equal(p.state.grantWrites.length, 1);
  assertNoBroaderConsent(p.state);
  await h.development.dispose();
});

test('session refusals (no session, wrong account) are classified refused', async () => {
  const p = platform();
  const h = host(p);
  const answer = await h.grant();
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error.code, 'no_session');
  assert.equal(answer.result.outcome, 'denied');
  assert.equal(p.state.grantWrites.length, 0);
  await h.development.dispose();
});

test('request validation is a classified refusal', async () => {
  const p = platform();
  const h = await started(p);
  const handleBad = await h.activate(42);
  assert.equal(handleBad.status, 400);
  assert.equal(handleBad.result.outcome, 'denied');
  await h.development.dispose();
});
