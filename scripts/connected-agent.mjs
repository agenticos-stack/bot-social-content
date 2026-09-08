import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';

const SESSION_FILE = 'agent-session.json';
const MAX_MESSAGE_LENGTH = 16_000;

/**
 * The host-side half of the local development bridge.
 *
 * The browser never receives the API cookie or the capnweb ticket. This
 * process mints the ticket with the authenticated cookie, owns the socket,
 * and hands the API a callback capability for the working source. The
 * runtime's DO and this agent session are deliberately separate identities.
 */
export async function createConnectedAgent({
  apiOrigin,
  frontendOrigin,
  cookie,
  stateDirectory,
  title,
  sourceHash,
  methods,
  callLocal
}) {
  const api = new URL(apiOrigin);
  const frontend = new URL(frontendOrigin);
  if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(api.hostname))
    throw new Error('Connected agent requires a loopback HTTP API origin.');
  if (frontend.protocol !== 'http:' || !['social.localhost', '127.0.0.1', 'localhost'].includes(frontend.hostname))
    throw new Error('Connected agent requires a local frontend origin.');
  if (typeof cookie !== 'string' || !cookie) throw new Error('An authenticated local session is required.');
  if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('Invalid source digest.');

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const sessionPath = resolve(stateDirectory, SESSION_FILE);
  const workspaceId = await ensureConversation({ apiOrigin, frontendOrigin, cookie, statePath: sessionPath, title });
  const ticket = await requestJson(`${apiOrigin}/v2/workspaces/${encodeURIComponent(workspaceId)}/rpc-ticket`, {
    frontendOrigin,
    cookie,
    method: 'POST',
    body: {}
  });
  if (typeof ticket?.data?.ticket !== 'string' || !ticket.data.ticket) throw new Error('The API returned no agent-session ticket.');

  const socketUrl = `${apiOrigin.replace(/^http:/, 'ws:')}/v2/workspaces/${encodeURIComponent(workspaceId)}/rpc?ticket=${encodeURIComponent(ticket.data.ticket)}`;
  const socket = new WebSocket(socketUrl);
  const stub = newWebSocketRpcSession(socket);
  const events = [];
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

  await stub.subscribe(new Subscriber());
  const registration = await stub.registerDevelopmentGadget({
    title,
    sourceHash,
    methods
  }, new LocalHost());

  async function handle(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid agent request.');
    const operation = input.operation;
    if (operation === 'run') {
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (!message || message.length > MAX_MESSAGE_LENGTH) throw new Error('Enter a message up to 16,000 characters.');
      const result = await stub.runTurn(message);
      return { result, events: drainEvents() };
    }
    if (operation === 'pending') return { asks: await stub.pendingAsks(), events: drainEvents() };
    if (operation === 'answer') {
      if (typeof input.actionId !== 'string' || typeof input.approve !== 'boolean') throw new Error('An action id and decision are required.');
      const result = await stub.answerAsk(input.actionId, { approve: input.approve });
      return { result, events: drainEvents() };
    }
    if (operation === 'history') return { actions: await stub.conversationActions(), events: drainEvents() };
    throw new Error('Unsupported agent operation.');
  }

  function drainEvents() {
    return events.splice(0, events.length);
  }

  return {
    info: {
      connected: true,
      workspaceId,
      conversationTitle: title,
      gadgetId: registration.gadgetId,
      expiresAt: registration.expiresAt
    },
    handle,
    close() {
      stub[Symbol.dispose]?.();
      socket.close();
    }
  };
}

async function ensureConversation({ apiOrigin, frontendOrigin, cookie, statePath, title }) {
  let existing = null;
  try { existing = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* first run */ }
  if (typeof existing?.workspaceId === 'string' && existing.workspaceId) {
    const probe = await fetch(`${apiOrigin}/v2/workspaces/${encodeURIComponent(existing.workspaceId)}/messages`, {
      headers: apiHeaders({ cookie, frontendOrigin }),
      signal: AbortSignal.timeout(10_000)
    });
    if (probe.ok) return existing.workspaceId;
  }
  const started = await requestJson(`${apiOrigin}/v2/workspaces`, {
    frontendOrigin,
    cookie,
    method: 'POST',
    body: { title }
  });
  const workspaceId = started?.data?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('The API did not create a development conversation.');
  await writeFile(statePath, JSON.stringify({ workspaceId, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return workspaceId;
}

async function requestJson(url, { frontendOrigin, cookie, method, body }) {
  const response = await fetch(url, {
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
