import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectedAgent, socialMethodNames, sourceDigest } from '../scripts/connected-agent.mjs';

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

const apiOrigin = 'http://127.0.0.1:8789';
const frontendOrigin = 'http://social.localhost:18000';
const sourceHash = 'a'.repeat(64);
const methods = ['summary', 'listItems'];

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A fake ticket/conversation API plus fake socket/stub factories, sharing one clock. */
function createFakeTransport({ now, leaseMs = 30 * 60 * 1000, hooks = {} }) {
  let workspaceCreated = false;
  let registrations = 0;
  const sockets = [];
  const stubs = [];
  const requests = [];

  function fetchImpl(url, options) {
    requests.push({ url, method: options?.method, headers: options?.headers, body: options?.body });
    const target = new URL(url);
    if (target.pathname === '/v2/workspaces/ws_1/door-grants' && options.method === 'POST') {
      const { requirementKey } = JSON.parse(options.body);
      return Promise.resolve(jsonResponse(201, { data: { grant: { requirementKey }, persistedToAgent: false } }));
    }
    if (target.pathname === '/v2/workspaces' && options.method === 'POST') {
      workspaceCreated = true;
      return Promise.resolve(jsonResponse(200, { data: { workspaceId: 'ws_1' } }));
    }
    if (target.pathname === '/v2/workspaces/ws_1/messages') {
      return Promise.resolve(workspaceCreated ? jsonResponse(200, {}) : jsonResponse(404, {}));
    }
    if (target.pathname === '/v2/workspaces/ws_1/rpc-ticket' && options.method === 'POST') {
      return Promise.resolve(jsonResponse(200, { data: { ticket: `ticket_${sockets.length + 1}` } }));
    }
    if (target.pathname === '/v2/gadget-dev/rpc-ticket' && options.method === 'POST') {
      return Promise.resolve(jsonResponse(200, { data: { ticket: `ticket_${sockets.length + 1}` } }));
    }
    return Promise.resolve(jsonResponse(404, { error: { message: 'unhandled route in fake transport' } }));
  }

  function openSocket(url) {
    const listeners = {};
    const socket = {
      url,
      closed: false,
      addEventListener(type, cb) { (listeners[type] ??= []).push(cb); },
      close() { socket.closed = true; },
      emit(type) { for (const cb of listeners[type] ?? []) cb(); }
    };
    sockets.push(socket);
    return socket;
  }

  function openSession(socket) {
    let brokenCallback = null;
    const stub = {
      socket,
      disposed: false,
      calls: { registerDevelopmentGadget: 0, runTurn: 0, pendingAsks: 0, answerAsk: 0, conversationActions: 0 },
      async subscribe() {},
      async registerDevelopmentGadget(metadata) {
        stub.calls.registerDevelopmentGadget += 1;
        stub.registered = metadata;
        registrations += 1;
        return { gadgetId: `dev:${registrations}`, expiresAt: now() + leaseMs };
      },
      async runTurn(message) {
        stub.calls.runTurn += 1;
        return hooks.runTurn ? hooks.runTurn(message) : { turnId: `t_${registrations}`, messages: [] };
      },
      async pendingAsks() { stub.calls.pendingAsks += 1; return hooks.pendingAsks ? hooks.pendingAsks() : []; },
      async answerAsk(actionId, decision) { stub.calls.answerAsk += 1; return hooks.answerAsk ? hooks.answerAsk(actionId, decision) : { applied: true }; },
      async conversationActions() { return []; },
      async developmentDoors() { return hooks.developmentDoors ? hooks.developmentDoors() : []; },
      async developmentConnectionChoices() { return hooks.connectionChoices ? hooks.connectionChoices() : []; },
      async grantDevelopmentConnection(input) { stub.connectionGrants = [...(stub.connectionGrants ?? []), input]; return hooks.grantConnection ? hooks.grantConnection(input) : { ok: true, requirementKey: `${input.requirementKey}:IG_FAVCRM`, env: 'env.IG_FAVCRM', label: 'IG FavCRM' }; },
      async grantDevelopmentDoor(requirementKey) { stub.doorGrants = [...(stub.doorGrants ?? []), requirementKey]; return hooks.grantDoor ? hooks.grantDoor(requirementKey) : { requirementKey }; },
      async revokeDevelopmentDoor(requirementKey) { stub.doorRevokes = [...(stub.doorRevokes ?? []), requirementKey]; return { requirementKey, ungranted: true }; },
      onRpcBroken(cb) { brokenCallback = cb; },
      breakNow(error) { brokenCallback?.(error ?? new Error('rpc broken')); },
      [Symbol.dispose]() { stub.disposed = true; }
    };
    stubs.push(stub);
    return stub;
  }

  return { fetchImpl, openSocket, openSession, sockets, stubs, requests, registrationCount: () => registrations };
}

async function withStateDirectory(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-lease-test-'));
  try { await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('renews the lease a few minutes before it expires, over the same socket', async () => {
  await withStateDirectory(async (stateDirectory) => {
    let now = 1_000_000;
    const transport = createFakeTransport({ now: () => now });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), now: () => now, ...transport
    });
    assert.equal(transport.registrationCount(), 1);
    const firstExpiry = agent.info.expiresAt;
    assert.equal(agent.info.gadgetId, 'dev:1');

    // Nowhere near expiry: no renewal.
    now = firstExpiry - 10 * 60 * 1000;
    await agent.handle({ operation: 'pending' });
    assert.equal(transport.registrationCount(), 1);

    // Inside the renewal window: renew, over the same socket.
    now = firstExpiry - 4 * 60 * 1000;
    const response = await agent.handle({ operation: 'pending' });
    assert.equal(transport.registrationCount(), 2);
    assert.equal(transport.sockets.length, 1, 'renewal must not open a new socket');
    assert.equal(agent.info.gadgetId, 'dev:2');
    assert.ok(agent.info.expiresAt > firstExpiry);
    assert.equal(response.agent.gadgetId, 'dev:2');
    agent.close();
  });
});

test('never renews while a turn is running, and retries right after it ends', async () => {
  await withStateDirectory(async (stateDirectory) => {
    let now = 1_000_000;
    // Lease is always "due" (well inside the 5-minute renewal window) so the
    // only thing that can stop a renewal attempt is the turn-in-flight guard.
    const hooks = {};
    const transport = createFakeTransport({ now: () => now, leaseMs: 4 * 60 * 1000, hooks });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), now: () => now, ...transport
    });
    assert.equal(transport.registrationCount(), 1);

    let releaseTurn;
    let turnStarted;
    const gate = new Promise((resolve) => { releaseTurn = resolve; });
    const started = new Promise((resolve) => { turnStarted = resolve; });
    // Signals only once actually inside runTurn — i.e. after the pre-turn
    // renewal has resolved and turnInFlight has been set — so awaiting it is
    // deterministic instead of guessing a microtask-tick count.
    hooks.runTurn = async (message) => { turnStarted(); await gate; return { turnId: 'turn_1', message }; };

    const runCall = agent.handle({ operation: 'run', message: 'hello' });
    await started;
    assert.equal(transport.registrationCount(), 2, 'renews once before the turn starts');

    // A concurrent poll while the turn is running must not renew.
    await agent.handle({ operation: 'pending' });
    assert.equal(transport.registrationCount(), 2, 'no renewal while a turn is in flight');

    releaseTurn();
    const result = await runCall;
    assert.equal(result.result.turnId, 'turn_1');
    assert.equal(transport.registrationCount(), 3, 'renews again once the turn has ended');
    agent.close();
  });
});

test('reconnects lazily on the next operation after the socket breaks, and reports truthful status meanwhile', async () => {
  await withStateDirectory(async (stateDirectory) => {
    let now = 1_000_000;
    const transport = createFakeTransport({ now: () => now });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), now: () => now, ...transport
    });
    assert.equal(agent.info.connected, true);
    assert.equal(agent.info.gadgetId, 'dev:1');
    const firstSocket = transport.sockets[0];
    const firstStub = transport.stubs[0];

    firstStub.breakNow();
    assert.equal(agent.info.connected, false, 'a break is reflected before any operation is attempted');
    assert.equal(agent.info.gadgetId, null);
    assert.equal(agent.info.expiresAt, null);
    assert.equal(firstStub.disposed, true);
    assert.equal(firstSocket.closed, true);

    const response = await agent.handle({ operation: 'pending' }, 'session=alice');
    assert.equal(transport.sockets.length, 2, 'rebuilds ticket, socket and registration on the next call');
    assert.equal(agent.info.connected, true);
    assert.equal(agent.info.gadgetId, 'dev:2');
    assert.equal(response.agent.connected, true);
    agent.close();
  });
});

test('gives up reconnecting after the attempt cap and reports a clear error', async () => {
  await withStateDirectory(async (stateDirectory) => {
    let now = 1_000_000;
    let allowConnect = true;
    const transport = createFakeTransport({ now: () => now });
    const realFetch = transport.fetchImpl;
    const fetchImpl = (url, options) => (allowConnect ? realFetch(url, options) : Promise.reject(new Error('API unreachable')));
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), now: () => now,
      openSocket: transport.openSocket, openSession: transport.openSession, fetchImpl
    });
    transport.stubs[0].breakNow();
    assert.equal(agent.info.connected, false);

    allowConnect = false;
    let lastMessage = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      now += 20_000; // clear any backoff window before trying again
      try {
        await agent.handle({ operation: 'pending' }, 'session=alice');
        assert.fail('must not report connected while the API stays unreachable');
      } catch (error) {
        lastMessage = error.message;
      }
    }
    assert.match(lastMessage, /restart this development host/i);
    agent.close();
  });
});

test('translates a replaced registration into a clear error and drops the connection without retrying', async () => {
  await withStateDirectory(async (stateDirectory) => {
    let now = 1_000_000;
    const hooks = {};
    const transport = createFakeTransport({ now: () => now, hooks });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), now: () => now, ...transport
    });
    hooks.pendingAsks = () => { throw new Error('Development registration ended. Reconnect and submit a new action.'); };

    await assert.rejects(agent.handle({ operation: 'pending' }), /Local registration was replaced; submit the action again\./);
    assert.equal(transport.stubs[0].calls.pendingAsks, 1, 'the failed call is never retried inline');
    assert.equal(agent.info.connected, false);

    // The next operation reconnects on its own.
    hooks.pendingAsks = undefined;
    const response = await agent.handle({ operation: 'pending' }, 'session=alice');
    assert.deepEqual(response.asks, []);
    assert.equal(agent.info.connected, true);
    agent.close();
  });
});

const prodApi = 'https://api.agenticos.hk';
const prodWorkspace = 'chat_11111111-1111-1111-1111-111111111111';

test('gadget-dev token path mints tickets over bearer HTTPS and never creates a conversation', async () => {
  await withStateDirectory(async (stateDirectory) => {
    let now = 1_000_000;
    const transport = createFakeTransport({ now: () => now });
    const agent = await createConnectedAgent({
      apiOrigin: prodApi, devToken: 'dev_token_secret', workspaceId: prodWorkspace,
      stateDirectory, title: 'Social Content', sourceHash, methods, callLocal: async () => ({}),
      now: () => now, ...transport
    });
    assert.equal(transport.requests.some((request) => request.url.includes('/v2/workspaces') && request.method === 'POST'), false);
    const ticket = transport.requests.find((request) => request.url.endsWith('/v2/gadget-dev/rpc-ticket'));
    assert.ok(ticket);
    assert.equal(ticket.headers.authorization, 'Bearer dev_token_secret');
    assert.equal(ticket.headers.cookie, undefined);
    assert.equal(ticket.headers.origin, undefined);
    assert.match(transport.sockets[0].url, /^wss:\/\/api\.agenticos\.hk\/v2\/workspaces\/chat_11111111-1111-1111-1111-111111111111\/rpc\?ticket=/);
    assert.equal(agent.info.workspaceId, prodWorkspace);
    agent.close();
  });
});

test('gadget-dev reconnect uses the current token and refuses cookies or unknown API origins', async () => {
  await withStateDirectory(async (stateDirectory) => {
    let now = 1_000_000;
    const transport = createFakeTransport({ now: () => now });
    await assert.rejects(createConnectedAgent({
      apiOrigin: 'https://evil.example', devToken: 'dev_token_secret', workspaceId: prodWorkspace,
      stateDirectory, title: 'Social Content', sourceHash, methods, callLocal: async () => ({}),
      now: () => now, ...transport
    }), /api\.agenticos\.hk/);
    await assert.rejects(createConnectedAgent({
      apiOrigin: prodApi, cookie: 'session=alice', devToken: 'dev_token_secret', workspaceId: prodWorkspace,
      stateDirectory, title: 'Social Content', sourceHash, methods, callLocal: async () => ({}),
      now: () => now, ...transport
    }), /cannot be combined/);

    const agent = await createConnectedAgent({
      apiOrigin: prodApi, devToken: 'first', workspaceId: prodWorkspace,
      stateDirectory, title: 'Social Content', sourceHash, methods, callLocal: async () => ({}),
      now: () => now, ...transport
    });
    transport.stubs[0].breakNow();
    await agent.handle({ operation: 'pending' }, 'second');
    const tickets = transport.requests.filter((request) => request.url.endsWith('/v2/gadget-dev/rpc-ticket'));
    assert.equal(tickets.length, 2);
    assert.equal(tickets[1].headers.authorization, 'Bearer second');
    agent.close();
  });
});

test('reload points the live session at new source, over the same socket', async () => {
  /*
   * `registerDevelopmentGadget` is built to be called again: it revokes the
   * previous binding and mints a fresh `dev:<uuid>` so action arguments
   * captured against the old id cannot resolve to the replacement. A reload
   * uses exactly that, rather than reconnecting — so the socket, the
   * conversation and the granted doors survive an edit.
   */
  await withStateDirectory(async (stateDirectory) => {
    const transport = createFakeTransport({ now: () => 1_000_000 });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), ...transport
    });
    assert.equal(agent.info.gadgetId, 'dev:1');
    assert.equal(transport.registrationCount(), 1);
    const socketBefore = transport.sockets.length;

    const next = 'b'.repeat(64);
    const result = await agent.reload({ sourceHash: next, methods: socialMethodNames() });

    assert.equal(result.sourceHash, next);
    assert.equal(result.gadgetId, 'dev:2', 'a reload re-registers, so the id is new');
    assert.equal(agent.info.gadgetId, 'dev:2');
    assert.equal(transport.registrationCount(), 2);
    assert.equal(transport.sockets.length, socketBefore, 'the socket is reused, not reopened');
    agent.close();
  });
});

test('reload refuses a digest that is not one, rather than registering it', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const transport = createFakeTransport({ now: () => 1_000_000 });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), ...transport
    });
    for (const bad of [undefined, '', 'nope', 'A'.repeat(64), 'a'.repeat(63)]) {
      await assert.rejects(agent.reload({ sourceHash: bad }), /Invalid source digest/);
    }
    assert.equal(transport.registrationCount(), 1, 'a refused reload registers nothing');
    agent.close();
  });
});


test('grants only a declared door, with the owner scope sent explicitly and the current cookie', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const transport = createFakeTransport({ now: () => 1_000_000 });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, requirements: [{ requirementKey: 'metered_fetch', kind: 'capability' }],
      callLocal: async () => ({}), now: () => 1_000_000, ...transport
    });
    const before = transport.requests.length;
    await assert.rejects(agent.grantDoor({ requirementKey: 'email', persistToAgent: false }, 'session=alice'), /not one this gadget declared/);
    await assert.rejects(agent.grantDoor({ requirementKey: 'metered_fetch' }, 'session=alice'), /conversation only/);
    assert.equal(transport.requests.length, before, 'a refused grant never reaches the API');

    const result = await agent.grantDoor({ requirementKey: 'metered_fetch', persistToAgent: false }, 'session=rotated');
    assert.deepEqual(result, { requirementKey: 'metered_fetch', persistedToAgent: false });
    const sent = transport.requests.at(-1);
    assert.equal(new URL(sent.url).pathname, '/v2/workspaces/ws_1/door-grants');
    assert.equal(sent.headers.cookie, 'session=rotated');
    assert.equal(sent.headers.origin, frontendOrigin);
    assert.deepEqual(JSON.parse(sent.body), { requirementKey: 'metered_fetch', persistToAgent: false });
    agent.close();
  });
});

test('a gadget-dev token grants a door over the socket, conversation-only', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const transport = createFakeTransport({ now: () => 1_000_000 });
    const agent = await createConnectedAgent({
      apiOrigin: prodApi, devToken: 'dev_token_secret', workspaceId: prodWorkspace, stateDirectory, title: 'Social Content dev',
      sourceHash, methods, requirements: [{ requirementKey: 'metered_fetch', kind: 'capability' }],
      callLocal: async () => ({}), now: () => 1_000_000, ...transport
    });
    const before = transport.requests.length;
    const result = await agent.grantDoor({ requirementKey: 'metered_fetch', persistToAgent: false }, 'dev_token_secret');
    // No REST call ever leaves — a dev session holds no cookie. The socket
    // grant is attributed server-side to the member the token binds.
    assert.deepEqual(result, { requirementKey: 'metered_fetch', persistedToAgent: false });
    assert.deepEqual(transport.stubs[0].doorGrants, ['metered_fetch']);
    assert.equal(transport.requests.length, before);
    agent.close();
  });
});

test('registers the source server.js so the platform scans its reads, and re-sends it on reload', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const transport = createFakeTransport({ now: () => 1_000_000 });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, serverSource: 'static readMethods = ["summary"]',
      callLocal: async () => ({}), now: () => 1_000_000, ...transport
    });
    assert.equal(transport.stubs[0].registered.serverSource, 'static readMethods = ["summary"]');
    assert.equal('readMethods' in transport.stubs[0].registered, false);
    await agent.reload({ sourceHash: 'b'.repeat(64), serverSource: 'static readMethods = ["summary", "listItems"]' });
    assert.equal(transport.stubs[0].registered.serverSource, 'static readMethods = ["summary", "listItems"]');
    agent.close();
  });
});

test('projects a granted family member with the connector methods the platform reports', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const hooks = {
      developmentDoors: () => [
        { envKey: 'social', requirementKey: 'social', granted: true },
        { envKey: 'destination', requirementKey: 'destination', granted: false },
        { envKey: 'IG_FAVCRM', requirementKey: 'destination:IG_FAVCRM', granted: true, family: 'destination', methods: ['describe', 'instagram_list_media'] },
        { envKey: 'IG_STRAY', requirementKey: 'IG_STRAY', granted: true, methods: ['describe'] }
      ]
    };
    const transport = createFakeTransport({ now: () => 1_000_000, hooks });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, callLocal: async () => ({}), now: () => 1_000_000, ...transport
    });
    const doors = await agent.doors({ social: ['createDraft'] });
    assert.deepEqual(doors.spec, { social: ['createDraft'], IG_FAVCRM: ['describe', 'instagram_list_media'] });
    agent.close();
  });
});

test('connects an account only for a declared family, and says the platform refusal', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const hooks = { connectionChoices: () => [{ requirementKey: 'destination', label: 'Destination channels', members: [], choices: [] }] };
    const transport = createFakeTransport({ now: () => 1_000_000, hooks });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, requirements: [{ requirementKey: 'destination', kind: 'connector_resource', role: 'destination' }, { requirementKey: 'social', kind: 'capability' }],
      callLocal: async () => ({}), now: () => 1_000_000, ...transport
    });
    assert.equal((await agent.connectionChoices())[0].requirementKey, 'destination');
    await assert.rejects(agent.grantConnection({ requirementKey: 'social', resolvedId: 'crb_1' }), /not one this gadget declared/);
    await assert.rejects(agent.grantConnection({ requirementKey: 'destination', resolvedId: '' }), /Choose an account/);
    assert.equal(transport.stubs[0].connectionGrants, undefined);
    assert.deepEqual(await agent.grantConnection({ requirementKey: 'destination', resolvedId: 'crb_1' }), { requirementKey: 'destination:IG_FAVCRM', env: 'env.IG_FAVCRM', label: 'IG FavCRM' });
    assert.deepEqual(transport.stubs[0].connectionGrants, [{ requirementKey: 'destination', resolvedId: 'crb_1' }]);
    hooks.grantConnection = () => ({ ok: false, code: 'requirement_max_reached', message: 'destination already holds the maximum of 1.' });
    await assert.rejects(agent.grantConnection({ requirementKey: 'destination', resolvedId: 'crb_2' }), /maximum of 1/);
    agent.close();
  });
});

test('a gadget-dev token connects an account over the socket', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const transport = createFakeTransport({ now: () => 1_000_000 });
    const agent = await createConnectedAgent({
      apiOrigin: prodApi, devToken: 'dev_token_secret', workspaceId: prodWorkspace, stateDirectory, title: 'Social Content dev',
      sourceHash, methods, requirements: [{ requirementKey: 'destination', kind: 'connector_resource' }],
      callLocal: async () => ({}), now: () => 1_000_000, ...transport
    });
    // Studio cannot grant a development conversation's family — there is no
    // installed gadget row to discover it through — so the socket is the only
    // consent surface, and the member the token binds is who it records.
    const result = await agent.grantConnection({ requirementKey: 'destination', resolvedId: 'crb_1' });
    assert.deepEqual(result, { requirementKey: 'destination:IG_FAVCRM', env: 'env.IG_FAVCRM', label: 'IG FavCRM' });
    assert.deepEqual(transport.stubs[0].connectionGrants, [{ requirementKey: 'destination', resolvedId: 'crb_1' }]);
    agent.close();
  });
});

test('F02: grantDoor classifies upstream answers — structured 4xx refused, 5xx/unreadable/network unknown', async () => {
  const cases = [
    { name: 'structured 403', respond: () => jsonResponse(403, { error: { message: 'Only the owner can grant this.', code: 'not_owner' } }), certainty: 'refused', code: 'not_owner' },
    { name: 'structured 409 without code', respond: () => jsonResponse(409, { error: { message: 'Not declared.' } }), certainty: 'refused', code: 'upstream_refused' },
    { name: 'unreadable 400', respond: () => ({ ok: false, status: 400, json: async () => { throw new SyntaxError('bad'); } }), certainty: undefined },
    { name: '408', respond: () => jsonResponse(408, { error: { message: 'timeout' } }), certainty: undefined },
    { name: '500 with message', respond: () => jsonResponse(500, { error: { message: 'boom' } }), certainty: undefined },
    { name: '502 empty', respond: () => jsonResponse(502, null), certainty: undefined },
    { name: 'network', respond: () => { throw new TypeError('fetch failed'); }, certainty: undefined }
  ];
  for (const scenario of cases) {
    await withStateDirectory(async (stateDirectory) => {
      const transport = createFakeTransport({ now: () => 1_000_000 });
      const fetchImpl = (url, options) => new URL(url).pathname.endsWith('/door-grants')
        ? Promise.resolve().then(scenario.respond)
        : transport.fetchImpl(url, options);
      const agent = await createConnectedAgent({
        apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
        sourceHash, methods, requirements: [{ requirementKey: 'metered_fetch', kind: 'capability' }],
        callLocal: async () => ({}), now: () => 1_000_000, ...transport, fetchImpl
      });
      const error = await agent.grantDoor({ requirementKey: 'metered_fetch', persistToAgent: false }, 'session=alice').then(() => null, (e) => e);
      assert.ok(error, scenario.name);
      assert.equal(error.certainty, scenario.certainty, scenario.name);
      if (scenario.code) assert.equal(error.code, scenario.code, scenario.name);
      agent.close();
    });
  }
});

test('F02: grantDoor local validation refusals are classified refused', async () => {
  await withStateDirectory(async (stateDirectory) => {
    const transport = createFakeTransport({ now: () => 1_000_000 });
    const agent = await createConnectedAgent({
      apiOrigin, frontendOrigin, cookie: 'session=alice', stateDirectory, title: 'Social Content dev',
      sourceHash, methods, requirements: [{ requirementKey: 'metered_fetch', kind: 'capability' }],
      callLocal: async () => ({}), now: () => 1_000_000, ...transport
    });
    const undeclared = await agent.grantDoor({ requirementKey: 'email', persistToAgent: false }).catch((e) => e);
    assert.equal(undeclared.certainty, 'refused');
    assert.equal(undeclared.code, 'not_declared');
    const noScope = await agent.grantDoor({ requirementKey: 'metered_fetch' }).catch((e) => e);
    assert.equal(noScope.certainty, 'refused');
    agent.close();
  });
});
