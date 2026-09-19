// Audit social-content-69e27f0-review F02a/F02b: the actual agent-to-router
// boundary keeps its certainty when the UPSTREAM answer, not just the local
// host, is unreadable, malformed or mismatched.
//
// Assembled real chain: createConnectedAgent → createDoorRuntime →
// createDevelopmentSessions → createConnectedApi → grantReceiptOutcome.
// Only two things are mocked: the upstream transport (the REST `fetchImpl`
// and the RPC `stub` a socket session would present — `developmentDoors`,
// `grantDevelopmentDoor`, `registerDevelopmentGadget`), and a controlled
// runtime-spec boundary standing in for the running isolate's `env` (what
// `preview.mjs#refreshDoors` would otherwise build by actually starting a
// worker). `grantDoor` and `grantedDoorKeys` are never mocked — they are the
// real functions under test, exactly as `door-runtime.mjs:26`'s own
// `!Array.isArray` guard is dead unless something upstream can still hand it
// a non-array.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectedAgent } from '../scripts/connected-agent.mjs';
import { createDoorRuntime } from '@agenticos-dev/bot-devkit/doors';
import { createDevelopmentSessions } from '../scripts/development-session.mjs';
import { createConnectedApi } from '../scripts/connected-api.mjs';
import { grantReceiptOutcome } from '@agenticos-dev/bot-devkit/doors';

const origin = 'http://127.0.0.1:17931';
const apiOrigin = 'http://127.0.0.1:8789';
const requirementKey = 'metered_fetch';

/**
 * One assembled host: a real agent, door runtime, development session and
 * router, wired to a synthetic upstream.
 *
 * `onGrant`/`onList` play the platform's two RPC surfaces the audit named:
 * the REST `door-grants` route (`onGrant`) and `developmentDoors()`
 * (`onList`), reached identically by both `agent.grantDoor` and
 * `agent.grantedDoorKeys`/`agent.doors`. `runtimeSpec` is the controlled
 * boundary standing in for the isolate `preview.mjs` would actually start:
 * a function of the current platform state to the set of requirement keys
 * the RUNNING environment has, independent of what was just granted — so a
 * test can make the platform confirm a grant while the runtime never picks
 * it up (case 9), which is exactly the gap `activateRuntime`'s requirement
 * key check exists to close.
 */
async function withHost({
  onGrant,
  onList,
  runtimeSpec = (state) => (state.granted ? new Set([requirementKey]) : new Set())
} = {}, run) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'grant-agent-boundary-'));
  const state = { granted: false, grantWrites: [], grantAttempts: 0, listReads: 0, activations: 0 };
  let agent;
  let development;
  try {
    const fetchImpl = async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/v2/workspaces') return Response.json({ data: { workspaceId: 'ws_synthetic' } });
      if (path.endsWith('/rpc-ticket')) return Response.json({ data: { ticket: 'synthetic-only' } });
      if (path.endsWith('/door-grants')) {
        state.grantAttempts += 1;
        state.grantWrites.push(JSON.parse(options.body));
        if (onGrant) return onGrant(state);
        state.granted = true;
        return Response.json({ data: { grant: { requirementKey }, persistedToAgent: false } }, { status: 201 });
      }
      throw new Error(`Unexpected synthetic request: ${path}`);
    };
    const stub = {
      subscribe: async () => {},
      registerDevelopmentGadget: async () => ({ gadgetId: 'dev:synthetic', expiresAt: Date.now() + 3_600_000 }),
      developmentDoors: async () => {
        state.listReads += 1;
        return onList ? onList(state) : (state.granted ? [{ requirementKey, envKey: requirementKey, granted: true }] : []);
      },
      [Symbol.dispose]() {}
    };
    agent = await createConnectedAgent({
      apiOrigin, frontendOrigin: origin, cookie: 'synthetic-only', stateDirectory,
      title: 'Boundary test agent', sourceHash: 'a'.repeat(64), methods: ['summary'],
      requirements: [{ requirementKey, kind: 'capability' }],
      callLocal: async () => ({}), fetchImpl,
      openSocket: () => ({ addEventListener() {}, close() {} }), openSession: () => stub
    });
    const runtime = createDoorRuntime({
      agent,
      activateRuntime: async (force, key) => {
        state.activations += 1;
        const running = runtimeSpec(state);
        if (key && !running.has(key)) return { status: 'refresh_failed', message: 'The running local source does not have this door.' };
        return { status: 'ready' };
      }
    });
    development = createDevelopmentSessions({
      appKey: 'synthetic', origin,
      authenticate: async () => ({ userId: 'u_synthetic', orgId: 'o_synthetic', cookie: 'synthetic-only' }),
      createRuntime: async () => ({ ...runtime, dispose: async () => {} })
    });
    await development.start(new Request(origin));
    const handle = createConnectedApi({
      apiOrigin, frontendOrigin: origin, development, platform: 'local',
      fetcher: async () => { throw new Error('Network disabled'); }
    });
    const post = async (action, body) => {
      const payload = { requirementKey, ...(action === 'grant' ? { persistToAgent: false } : {}), ...body };
      const response = await handle(new Request(`${origin}/api/dev/${action}`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload)
      }));
      const bodyText = await response.text();
      return { status: response.status, body: JSON.parse(bodyText), receipt: grantReceiptOutcome({ ok: response.ok, status: response.status, bodyText }) };
    };
    await run({ post, state, development, agent });
  } finally {
    await development?.dispose();
    agent?.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

// 1. Matching grant plus usable runtime → activated.
test('matching grant plus a runtime that actually has the door: activated', async () => {
  await withHost({}, async ({ post, state }) => {
    const answer = await post('grant');
    assert.equal(answer.status, 200);
    assert.equal(answer.receipt.outcome, 'activated');
    assert.equal(state.grantAttempts, 1);
    assert.equal(state.grantWrites[0].persistToAgent, false);
  });
});

// 2. Genuine refusal → denied, no write.
test('a classified upstream refusal is denied, with no consent write', async () => {
  await withHost({
    onGrant: () => Response.json({ error: { message: 'Only the owner can grant this door.', code: 'not_owner' } }, { status: 403 })
  }, async ({ post, state }) => {
    const answer = await post('grant');
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error.certainty, 'refused');
    assert.equal(answer.receipt.outcome, 'denied');
    assert.equal(state.grantAttempts, 1);
    assert.deepEqual(state.grantWrites, [{ requirementKey, persistToAgent: false }], 'the request was sent, but nothing confirms it landed');
  });
});

// 3 & 4. Consent saved then the response lost is unconfirmed; recovery
// activates with no second write.
test('consent saved then response lost: unconfirmed, then recovery activates with one write total', async () => {
  await withHost({
    onGrant: (state) => { state.granted = true; throw new Error('Response lost after consent saved'); }
  }, async ({ post, state }) => {
    const lost = await post('grant');
    assert.equal(lost.status, 502);
    assert.equal(lost.body.error.certainty, 'unknown');
    assert.equal(lost.receipt.outcome, 'unconfirmed');
    assert.equal(state.grantAttempts, 1);

    const recovered = await post('activate');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.receipt.outcome, 'activated');
    assert.equal(state.grantAttempts, 1, 'recovery never re-sends the grant');
    assert.equal(state.grantWrites.length, 1, 'still exactly one write');
    assert.equal(state.grantWrites[0].persistToAgent, false, 'recovery never broadens consent');
  });
});

// 5. Malformed 200 grant → unconfirmed (F02a).
test('F02a: an HTTP 200 grant with truncated JSON is unconfirmed, not activated', async () => {
  await withHost({
    onGrant: () => new Response('{"data":', { status: 200, headers: { 'content-type': 'application/json' } })
  }, async ({ post, state }) => {
    const answer = await post('grant');
    assert.equal(answer.status, 502);
    assert.equal(answer.body.error.certainty, 'unknown');
    assert.equal(answer.receipt.outcome, 'unconfirmed');
    assert.equal(state.activations, 0, 'an unconfirmed grant never reaches runtime activation');
  });
});

// 6. Wrong or missing confirmed requirement → not activated (F02a, the
// substitution case: a well-formed body that just does not name the door
// that was asked for).
test('F02a: a well-formed grant response that confirms the wrong door is unconfirmed, never substituted', async () => {
  for (const badGrant of [
    () => Response.json({ data: { grant: { requirementKey: 'schedule' }, persistedToAgent: false } }, { status: 200 }),
    () => Response.json({ data: { grant: {}, persistedToAgent: false } }, { status: 200 }),
    () => Response.json({ data: { persistedToAgent: false } }, { status: 200 })
  ]) {
    await withHost({ onGrant: badGrant }, async ({ post, state }) => {
      const answer = await post('grant');
      assert.equal(answer.status, 502);
      assert.equal(answer.receipt.outcome, 'unconfirmed');
      assert.notEqual(answer.receipt.outcome, 'activated');
      assert.equal(state.activations, 0);
    });
  }
});

// 7. Malformed inventory → unconfirmed (F02b).
test('F02b: a non-array authoritative grant list is unconfirmed, never a confirmed denial', async () => {
  await withHost({
    onGrant: () => { throw new Error('Grant must never be called for an activation-only case'); },
    onList: () => ({ error: 'unexpected non-array RPC response' })
  }, async ({ post, state }) => {
    const answer = await post('activate');
    assert.equal(answer.status, 502);
    assert.equal(answer.body.error.certainty, 'unknown');
    assert.equal(answer.receipt.outcome, 'unconfirmed');
    assert.equal(state.grantAttempts, 0, 'malformed inventory never triggers a grant');
  });
});

// 8. Valid empty inventory → denied (confirmed absence). Proves the F02b fix
// did not also break the legitimate case: a real, valid empty array is still
// a confirmed absence, not an unreadable one.
test('a genuinely empty authoritative list is a confirmed absence: denied', async () => {
  await withHost({ onList: () => [] }, async ({ post, state }) => {
    const answer = await post('activate');
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error.certainty, 'refused');
    assert.equal(answer.body.error.code, 'not_granted');
    assert.equal(answer.receipt.outcome, 'denied');
    assert.equal(state.grantAttempts, 0);
  });
});

// 8a. F02c: an array-shaped inventory whose own entries are malformed is
// still unreadable, not a confirmed absence. The bug checked only
// `Array.isArray` and then filtered `granted === true`, so an entry with no
// fields at all, or one that names the right requirementKey but answers
// `granted` with something other than a real boolean, silently vanished from
// the filtered list — a valid-looking [] the caller could not tell apart
// from an owner who genuinely granted nothing. Reproduces
// grant-entry-shape-probe.mjs cases 1 and 2.
for (const [label, entry] of [
  ['an entry missing every required field', {}],
  ['a matching entry whose granted is not a boolean', { requirementKey, granted: 'unreadable' }]
]) {
  test(`F02c: ${label} is unconfirmed, never a confirmed denial`, async () => {
    await withHost({
      onGrant: () => { throw new Error('Grant must never be called for an activation-only case'); },
      onList: () => [entry]
    }, async ({ post, state }) => {
      const answer = await post('activate');
      assert.equal(answer.status, 502);
      assert.equal(answer.body.error.certainty, 'unknown');
      assert.equal(answer.receipt.outcome, 'unconfirmed');
      assert.equal(state.grantAttempts, 0, 'a malformed entry never triggers a grant');
      assert.equal(state.activations, 0, 'a malformed entry never reaches runtime activation');
    });
  });
}

// 8b. A row with unknown additive fields (a connector family's `family`,
// `methods`, or anything else the platform might add) is still read
// normally: only the three required fields are checked.
test('F02c: an inventory row with unknown additive fields is still read as granted', async () => {
  await withHost({
    onList: () => [{ requirementKey, envKey: requirementKey, granted: true, family: 'social', methods: ['post'] }],
    runtimeSpec: () => new Set([requirementKey])
  }, async ({ post, state }) => {
    const answer = await post('activate');
    assert.equal(answer.status, 200);
    assert.equal(answer.receipt.outcome, 'activated');
    assert.equal(state.grantAttempts, 0, 'activation never re-sends a grant for an already-granted door');
  });
});

// 8c. A valid, well-formed granted row proceeds to activation exactly as
// before — the stricter validation never rejects the shape the platform
// actually sends.
test('F02c: a valid matching granted row lets activation proceed', async () => {
  await withHost({
    onList: () => [{ requirementKey, envKey: requirementKey, granted: true }],
    runtimeSpec: () => new Set([requirementKey])
  }, async ({ post, state }) => {
    const answer = await post('activate');
    assert.equal(answer.status, 200);
    assert.equal(answer.receipt.outcome, 'activated');
    assert.equal(state.grantAttempts, 0);
  });
});

// 9. Granted but runtime lacks the door → activation_failed.
test('the platform confirms the grant but the running local source never has the door: activation_failed', async () => {
  await withHost({ runtimeSpec: () => new Set() }, async ({ post, state }) => {
    const answer = await post('grant');
    assert.equal(answer.status, 200);
    assert.equal(answer.receipt.outcome, 'activation_failed');
    assert.equal(state.grantAttempts, 1, 'consent was still recorded upstream');

    const recheck = await post('activate');
    assert.equal(recheck.receipt.outcome, 'activation_failed');
    assert.equal(state.grantAttempts, 1, 'a runtime-only failure never re-sends the grant');
  });
});

// 10. Repeated recovery → same scope, one write.
test('repeated recovery after a lost response stays activated with the same scope and exactly one write', async () => {
  await withHost({
    onGrant: (state) => { state.granted = true; throw new Error('lost'); }
  }, async ({ post, state }) => {
    await post('grant');
    for (let i = 0; i < 3; i += 1) {
      const recheck = await post('activate');
      assert.equal(recheck.receipt.outcome, 'activated', `recheck ${i}`);
    }
    assert.equal(state.grantAttempts, 1);
    assert.equal(state.grantWrites.length, 1);
    assert.equal(state.grantWrites[0].requirementKey, requirementKey);
    assert.equal(state.grantWrites[0].persistToAgent, false, 'scope never broadens across rechecks');
  });
});

// Parity: the development-socket grant path (gadget-dev token, no cookie)
// validates the confirmed key exactly like the REST path — same rule,
// different transport, so a malformed or mismatched answer is unconfirmed on
// either surface rather than only the one the earlier fix covered.
test('parity: the socket grant path also refuses to substitute the requested key for a missing confirmation', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'grant-agent-boundary-socket-'));
  let agent;
  try {
    const stub = {
      subscribe: async () => {},
      registerDevelopmentGadget: async () => ({ gadgetId: 'dev:synthetic', expiresAt: Date.now() + 3_600_000 }),
      // The upstream RPC answers with no requirementKey at all — the same
      // shape of malformed confirmation as F02a's truncated REST body.
      grantDevelopmentDoor: async () => ({})
    };
    const fetchImpl = async (url) => {
      if (new URL(url).pathname.endsWith('/rpc-ticket')) return Response.json({ data: { ticket: 'synthetic-only' } });
      throw new Error(`Unexpected synthetic request: ${url}`);
    };
    agent = await createConnectedAgent({
      apiOrigin: 'https://api.agenticos.hk', devToken: 'dev_token_secret',
      workspaceId: 'chat_11111111-1111-1111-1111-111111111111',
      stateDirectory, title: 'Boundary test agent', sourceHash: 'a'.repeat(64), methods: ['summary'],
      requirements: [{ requirementKey, kind: 'capability' }],
      callLocal: async () => ({}), fetchImpl,
      openSocket: () => ({ addEventListener() {}, close() {} }), openSession: () => stub
    });
    await assert.rejects(
      agent.grantDoor({ requirementKey, persistToAgent: false }, 'dev_token_secret'),
      /did not confirm which door was granted/
    );
  } finally {
    agent?.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
