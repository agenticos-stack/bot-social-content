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
    requests.push({ url, method: options?.method, headers: options?.headers });
    const target = new URL(url);
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
      async registerDevelopmentGadget() {
        stub.calls.registerDevelopmentGadget += 1;
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
