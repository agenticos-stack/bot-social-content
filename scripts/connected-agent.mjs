import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';

const SESSION_FILE = 'agent-session.json';
const MAX_MESSAGE_LENGTH = 16_000;

// The API issues a hard 30-minute lease and revokes on replacement, socket
// break, unsubscribe or expiry (workers/api/src/v2/development-gadget-registration.ts).
// Renew well before the deadline so an idle-but-open preview never crosses it
// mid-operation.
const RENEW_WINDOW_MS = 5 * 60 * 1000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_MAX_ATTEMPTS = 5;

// The API's own wording for a registration that no longer answers: revoked by
// a later registration, by expiry, or refused outright while local dev is
// off. Matched loosely so client-side transport noise (closed socket, aborted
// RPC) is folded into the same reconnect path rather than surfaced raw.
const REGISTRATION_ENDED_PATTERN = /development registration (ended|was superseded|is unavailable)/i;
const CONNECTION_BROKEN_PATTERN = /websocket|rpc (session|stub)|disconnected|broken pipe|econnreset/i;
const TURN_RUNNING_PATTERN = /stop the current turn/i;

/**
 * The host-side half of the local development bridge.
 *
 * The browser never receives the API cookie or the capnweb ticket. This
 * process mints the ticket with the authenticated cookie, owns the socket,
 * and hands the API a callback capability for the working source. The
 * runtime's DO and this agent session are deliberately separate identities.
 *
 * The registration this holds is a 30-minute lease, not a standing grant: it
 * renews itself a few minutes before `expiresAt` while the socket is
 * healthy, and rebuilds the whole session (ticket, socket, subscription,
 * registration) the next time it is asked to do something after the socket
 * closes or the API tears the RPC session down. Neither happens silently —
 * `info` and every operation's response report the live connection state, so
 * a stale "connected" never survives a lease that actually lapsed.
 */
export async function createConnectedAgent({
  apiOrigin,
  frontendOrigin,
  cookie,
  stateDirectory,
  title,
  sourceHash,
  methods,
  callLocal,
  now = Date.now,
  fetchImpl = fetch,
  openSocket = (url) => new WebSocket(url),
  openSession = (socket) => newWebSocketRpcSession(socket)
}) {
  const api = new URL(apiOrigin);
  const frontend = new URL(frontendOrigin);
  if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(api.hostname))
    throw new Error('Connected agent requires a loopback HTTP API origin.');
  if (frontend.protocol !== 'http:' || !['social.localhost', '127.0.0.1', 'localhost'].includes(frontend.hostname))
    throw new Error('Connected agent requires a local frontend origin.');
  if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('Invalid source digest.');

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const sessionPath = resolve(stateDirectory, SESSION_FILE);

  const events = [];
  function drainEvents() { return events.splice(0, events.length); }

  class Subscriber extends RpcTarget {
    // Streaming deltas contain the complete partial message on every update;
    // returning those through the BFF would turn a short local chat response
    // into megabytes of JSON. The turn result already carries the final
    // messages, so retain only small lifecycle facts for the preview UI.
    event(value) {
      const type = value && typeof value === 'object' && typeof value.type === 'string' ? value.type : '';
      if (type === 'agent_start' || type === 'turn_start' || type === 'turn_end') events.push({ type: 'event', value: { type } });
    }
    decisionRequested(value) {
      if (events.length < 32) events.push({ type: 'decision', value: { turnId: value?.turnId, toolName: value?.toolName, capability: value?.capability } });
    }
    turnEnded(value) {
      if (events.length < 32) events.push({ type: 'turn-ended', value: { turnId: value?.turnId, error: value?.error } });
    }
  }
  class LocalHost extends RpcTarget {
    async call(receivedHash, method, args) {
      if (receivedHash !== sourceHash) throw new Error('The local source changed. Restart the development session.');
      if (typeof method !== 'string' || !methods.includes(method)) throw new Error(`Unsupported local method: ${String(method)}`);
      if (!Array.isArray(args) || args.length > 64) throw new Error('Invalid local method arguments.');
      return callLocal(method, args);
    }
  }

  let workspaceId = null;
  /** The live socket/stub/lease, or null when disconnected. Never stale. */
  let session = null;
  let turnInFlight = false;
  let connecting = null;
  let reconnectAttempts = 0;
  let nextReconnectAt = 0;

  function disconnect() {
    if (!session) return;
    const stale = session;
    session = null;
    try { stale.stub[Symbol.dispose]?.(); } catch { /* already gone */ }
    try { stale.socket.close(); } catch { /* already gone */ }
  }

  async function connect(currentCookie) {
    if (typeof currentCookie !== 'string' || !currentCookie) throw new Error('An authenticated local session is required.');
    const resolvedWorkspaceId = await ensureConversation({ apiOrigin, frontendOrigin, cookie: currentCookie, statePath: sessionPath, title, fetchImpl });
    const ticket = await requestJson(`${apiOrigin}/v2/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/rpc-ticket`, {
      frontendOrigin, cookie: currentCookie, method: 'POST', body: {}, fetchImpl
    });
    if (typeof ticket?.data?.ticket !== 'string' || !ticket.data.ticket) throw new Error('The API returned no agent-session ticket.');
    const socketUrl = `${apiOrigin.replace(/^http:/, 'ws:')}/v2/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/rpc?ticket=${encodeURIComponent(ticket.data.ticket)}`;
    const socket = openSocket(socketUrl);
    const stub = openSession(socket);
    await stub.subscribe(new Subscriber());
    const registration = await stub.registerDevelopmentGadget({ title, sourceHash, methods }, new LocalHost());
    workspaceId = resolvedWorkspaceId;
    session = { stub, socket, gadgetId: registration.gadgetId, expiresAt: registration.expiresAt };
    reconnectAttempts = 0;
    nextReconnectAt = 0;
    stub.onRpcBroken?.(() => disconnect());
    if (typeof socket?.addEventListener === 'function') {
      socket.addEventListener('close', () => disconnect());
      socket.addEventListener('error', () => disconnect());
    }
  }

  /** Rebuild lazily on the next operation. Never retried inline for the caller. */
  async function ensureConnected(currentCookie) {
    if (session) return;
    if (connecting) return connecting;
    if (now() < nextReconnectAt) throw new Error('Reconnecting to the local development agent. Try again shortly.');
    if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) throw new Error('Could not reconnect the local development agent after several attempts. Restart this development host.');
    connecting = (async () => {
      try {
        await connect(currentCookie);
      } catch (error) {
        reconnectAttempts += 1;
        nextReconnectAt = now() + Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_DELAY_MS);
        throw new Error(`Could not reconnect the local development agent: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  /** Never renews mid-turn; a race with the server's own guard is swallowed and retried later. */
  async function maybeRenew() {
    if (!session || turnInFlight) return;
    if (now() < session.expiresAt - RENEW_WINDOW_MS) return;
    try {
      const registration = await session.stub.registerDevelopmentGadget({ title, sourceHash, methods }, new LocalHost());
      session.gadgetId = registration.gadgetId;
      session.expiresAt = registration.expiresAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (TURN_RUNNING_PATTERN.test(message)) return;
      disconnect();
    }
  }

  function statusSnapshot() {
    return { connected: Boolean(session), workspaceId, gadgetId: session?.gadgetId ?? null, expiresAt: session?.expiresAt ?? null };
  }

  async function handle(input, currentCookie) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid agent request.');
    const operation = input.operation;
    if (!['run', 'pending', 'answer', 'history'].includes(operation)) throw new Error('Unsupported agent operation.');
    let message;
    if (operation === 'run') {
      message = typeof input.message === 'string' ? input.message.trim() : '';
      if (!message || message.length > MAX_MESSAGE_LENGTH) throw new Error('Enter a message up to 16,000 characters.');
    }
    if (operation === 'answer' && (typeof input.actionId !== 'string' || typeof input.approve !== 'boolean'))
      throw new Error('An action id and decision are required.');

    await ensureConnected(currentCookie);
    await maybeRenew();

    try {
      if (operation === 'run') {
        turnInFlight = true;
        let result;
        try { result = await session.stub.runTurn(message); }
        finally { turnInFlight = false; }
        // The lease may have crossed the renewal window during the turn.
        await maybeRenew();
        return { result, events: drainEvents(), agent: statusSnapshot() };
      }
      if (operation === 'pending') return { asks: await session.stub.pendingAsks(), events: drainEvents(), agent: statusSnapshot() };
      if (operation === 'answer') {
        const result = await session.stub.answerAsk(input.actionId, { approve: input.approve });
        return { result, events: drainEvents(), agent: statusSnapshot() };
      }
      return { actions: await session.stub.conversationActions(), events: drainEvents(), agent: statusSnapshot() };
    } catch (error) {
      // A call that may have mutated state is never retried here — only the
      // connection is torn down so the NEXT operation reconnects and the
      // caller decides whether to submit the action again.
      const description = error instanceof Error ? error.message : String(error);
      if (REGISTRATION_ENDED_PATTERN.test(description) || CONNECTION_BROKEN_PATTERN.test(description) || !session) {
        disconnect();
        throw new Error('Local registration was replaced; submit the action again.');
      }
      throw error;
    }
  }

  await connect(cookie);

  return {
    get info() {
      return { connected: Boolean(session), workspaceId, conversationTitle: title, gadgetId: session?.gadgetId ?? null, expiresAt: session?.expiresAt ?? null };
    },
    handle,
    close() { disconnect(); }
  };
}

async function ensureConversation({ apiOrigin, frontendOrigin, cookie, statePath, title, fetchImpl }) {
  let existing = null;
  try { existing = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* first run */ }
  if (typeof existing?.workspaceId === 'string' && existing.workspaceId) {
    const probe = await fetchImpl(`${apiOrigin}/v2/workspaces/${encodeURIComponent(existing.workspaceId)}/messages`, {
      headers: apiHeaders({ cookie, frontendOrigin }),
      signal: AbortSignal.timeout(10_000)
    });
    if (probe.ok) return existing.workspaceId;
  }
  const started = await requestJson(`${apiOrigin}/v2/workspaces`, {
    frontendOrigin,
    cookie,
    method: 'POST',
    body: { title },
    fetchImpl
  });
  const workspaceId = started?.data?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('The API did not create a development conversation.');
  await writeFile(statePath, JSON.stringify({ workspaceId, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return workspaceId;
}

async function requestJson(url, { frontendOrigin, cookie, method, body, fetchImpl }) {
  const response = await fetchImpl(url, {
    method,
    headers: { ...apiHeaders({ cookie, frontendOrigin }), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message || value?.message || `API request failed (${response.status}).`);
  return value;
}

function apiHeaders({ cookie, frontendOrigin }) {
  return { accept: 'application/json', cookie, origin: frontendOrigin };
}

export function sourceDigest(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(name).update('\0').update(files[name]).update('\0');
  return hash.digest('hex');
}

export function socialMethodNames() {
  return [
    'summary', 'setConfig', 'addOpenSource', 'removeOpenSource', 'scanRuns', 'refresh', 'listItems',
    'getItem', 'getMedia', 'createBatch', 'getBatch', 'listBatches', 'listBatchSummaries', 'saveRevision',
    'savePoster', 'confirmRights', 'submitForReview', 'readPublishState', 'exportAs', 'exportJson',
    'exportHtml', 'markSeen', 'setSelection', 'clearSelection'
  ];
}
