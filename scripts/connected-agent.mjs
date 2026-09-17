import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';
import {
  agentSocketUrl,
  assertGadgetDevWorkspaceId,
  assertLocalApiOrigin,
  assertLocalFrontendOrigin,
  assertRemoteApiOrigin
} from './platform-origin.mjs';
import { refuse } from './door-certainty.mjs';

const SESSION_FILE = 'agent-session.json';
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_INSTRUCTIONS_LENGTH = 64_000;

/**
 * The text of one agent turn, from what a person typed and, separately, the
 * gadget's own instructions.
 *
 * The 16,000-character cap is for the MESSAGE — what the owner (or the host,
 * speaking for the owner) asks. A development registration carries no files
 * the agent can read, so the host hands the gadget's `agent.md` over with the
 * turn; that document is not the owner's message and is bounded on its own.
 * Folding it into the message made every draft exceed the cap once the notes
 * grew past it, and no turn started at all.
 */
export function composeRunMessage(input) {
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE_LENGTH) throw new Error('Enter a message up to 16,000 characters.');
  if (input?.instructions === undefined || input?.instructions === null) return message;
  if (typeof input.instructions !== 'string') throw new Error('Gadget instructions must be text.');
  const instructions = input.instructions.trim();
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) throw new Error('Gadget instructions exceed 64,000 characters.');
  return instructions ? `${message}\n\n${instructions}` : message;
}

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
 * The browser never receives the API cookie, the gadget-dev token, or the
 * capnweb ticket. This process mints the ticket (cookie on loopback, bearer
 * token against production/staging), owns the socket, and hands the API a
 * callback capability for the working source. The runtime's DO and this
 * agent session are deliberately separate identities.
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
  devToken,
  workspaceId: boundWorkspaceId,
  stateDirectory,
  title,
  sourceHash: initialSourceHash,
  methods: initialMethods,
  /**
   * What this source declares it needs, so the platform can resolve its doors
   * (REQ-008). Declaring grants nothing — consent is the owner's, read
   * server-side on every call — so a requirement nobody granted simply yields
   * no door.
   */
  requirements: initialRequirements = [],
  /**
   * The source's `server.js`, so the platform reads which methods are reads
   * (`static readMethods`) with the scanner it uses for an installed gadget.
   * Sent as source rather than a list: the API refuses a host naming its own
   * reads.
   */
  serverSource: initialServerSource,
  callLocal,
  now = Date.now,
  fetchImpl = fetch,
  openSocket = (url) => new WebSocket(url),
  openSession = (socket) => newWebSocketRpcSession(socket)
}) {
  const remote = Boolean(devToken);
  if (remote) {
    if (cookie) throw new Error('A gadget-dev token cannot be combined with a session cookie.');
    assertRemoteApiOrigin(apiOrigin);
    assertGadgetDevWorkspaceId(boundWorkspaceId);
  } else {
    assertLocalApiOrigin(apiOrigin);
    assertLocalFrontendOrigin(frontendOrigin);
  }
  /*
   * What the platform's registration is pinned to. Mutable, because a reload
   * REGISTERS AGAIN rather than reconnecting: `registerDevelopmentGadget`
   * revokes the previous binding and mints a fresh `dev:<uuid>` by design, so
   * new source becomes the live one without dropping the socket, the
   * conversation, or the granted doors.
   */
  let sourceHash = initialSourceHash;
  let methods = initialMethods;
  let requirements = initialRequirements;
  let serverSource = initialServerSource;
  if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('Invalid source digest.');

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const sessionPath = resolve(stateDirectory, SESSION_FILE);

  function registrationMetadata() {
    return { title, sourceHash, methods, requirements, ...(typeof serverSource === 'string' ? { serverSource } : {}) };
  }

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

  async function connect(credential) {
    if (typeof credential !== 'string' || !credential)
      throw new Error(remote ? 'A gadget development token is required.' : 'An authenticated local session is required.');
    const resolvedWorkspaceId = remote
      ? boundWorkspaceId
      : await ensureConversation({ apiOrigin, frontendOrigin, cookie: credential, statePath: sessionPath, title, fetchImpl });
    const ticket = remote
      ? await requestJson(`${apiOrigin}/v2/gadget-dev/rpc-ticket`, {
          authorization: `Bearer ${credential}`, method: 'POST', body: { workspaceId: resolvedWorkspaceId }, fetchImpl
        })
      : await requestJson(`${apiOrigin}/v2/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/rpc-ticket`, {
          frontendOrigin, cookie: credential, method: 'POST', body: {}, fetchImpl
        });
    if (typeof ticket?.data?.ticket !== 'string' || !ticket.data.ticket) throw new Error('The API returned no agent-session ticket.');
    const socketUrl = agentSocketUrl(apiOrigin, resolvedWorkspaceId, ticket.data.ticket);
    const socket = openSocket(socketUrl);
    const stub = openSession(socket);
    await stub.subscribe(new Subscriber());
    const registration = await stub.registerDevelopmentGadget(registrationMetadata(), new LocalHost());
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

  /**
   * A renewal or reload that returns a DIFFERENT gadget id is a registration
   * replacement: every pending ask/decision captured against the old id is
   * dead server-side, so the events the host still holds would show an
   * approval card nobody can honour. Drop them and mark the snapshot so the
   * host can say approvals must be re-requested — never silently carry an
   * old approval onto replacement code.
   */
  function noteRegistration(registration) {
    if (session && registration.gadgetId && registration.gadgetId !== session.gadgetId) {
      drainEvents();
      session.replacedFrom = session.gadgetId;
    }
    session.gadgetId = registration.gadgetId;
    session.expiresAt = registration.expiresAt;
  }

  /** Never renews mid-turn; a race with the server's own guard is swallowed and retried later. */
  async function maybeRenew() {
    if (!session || turnInFlight) return;
    if (now() < session.expiresAt - RENEW_WINDOW_MS) return;
    try {
      // The SAME metadata builder as initial registration and reload — a
      // renewal that drops `serverSource` un-marks the read methods, and
      // every subsequent getBatch starts asking the owner for approval.
      const registration = await session.stub.registerDevelopmentGadget(registrationMetadata(), new LocalHost());
      noteRegistration(registration);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (TURN_RUNNING_PATTERN.test(message)) return;
      disconnect();
    }
  }

  function statusSnapshot() {
    return {
      connected: Boolean(session),
      workspaceId,
      gadgetId: session?.gadgetId ?? null,
      expiresAt: session?.expiresAt ?? null,
      replacedFrom: session?.replacedFrom ?? null
    };
  }

  async function handle(input, currentCookie) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid agent request.');
    const operation = input.operation;
    if (!['run', 'pending', 'answer', 'history'].includes(operation)) throw new Error('Unsupported agent operation.');
    let message;
    if (operation === 'run') message = composeRunMessage(input);
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

  await connect(remote ? devToken : cookie);

  /**
   * Validate the fields used by doors() and grantedDoorKeys().
   * Any malformed row leaves the inventory unconfirmed; a valid empty list
   * proves absence. Additional fields are accepted for compatibility.
   */
  function validateDoorInventory(listed) {
    if (!Array.isArray(listed)) throw new Error('The platform door inventory could not be read.');
    for (const door of listed) {
      if (
        !door || typeof door !== 'object' ||
        typeof door.requirementKey !== 'string' || !door.requirementKey ||
        typeof door.envKey !== 'string' || !door.envKey ||
        typeof door.granted !== 'boolean'
      ) throw new Error('The platform door inventory could not be read.');
    }
    return listed;
  }

  /**
   * The doors this session can reach, as the local runtime wants them.
   *
   * `spec` is what the isolate turns into `env.<door>.<method>`, and it lists
   * only doors the owner has actually GRANTED — an ungranted one is absent
   * from `env`, which is the same absence an installed gadget sees and what
   * lets the gadget's own code treat a missing door as configuration rather
   * than failure.
   *
   * `call` forwards to the platform, which delegates to the same door object
   * an installed gadget reaches. Nothing here decides anything: the grant
   * check, the authority ladder, the refusal and the audit record all live on
   * the far side.
   */
  async function doors(methodsByDoor) {
    await ensureConnected(remote ? devToken : cookie);
    const granted = validateDoorInventory(await session.stub.developmentDoors());
    const spec = {};
    for (const door of granted) {
      if (!door?.granted) continue;
      // A connector family member is named by the owner's choice of account,
      // so the source cannot list it in advance; its methods are the
      // connector door's, as the platform reports them.
      const names = methodsByDoor?.[door.envKey] ?? (typeof door.family === 'string' && Array.isArray(door.methods) ? door.methods : undefined);
      if (!Array.isArray(names) || names.length === 0) continue;
      spec[door.envKey] = names;
    }
    if (Object.keys(spec).length === 0) return null;
    return {
      spec,
      call: async (envKey, method, args) => {
        await ensureConnected(remote ? devToken : cookie);
        return session.stub.callDevelopmentDoor(envKey, method, args);
      }
    };
  }

  /**
   * Record the owner's yes to one door this source declared, for this
   * conversation.
   *
   * The canvas only ASKS (`gadget:grant-door`); the owner answered in the
   * host's own dialog before this runs. `persistToAgent` is required and
   * sent explicitly, because the API reads an omitted flag as "also save it
   * for the assistant" for an organization-scoped door, and the dialog's
   * default is this conversation only.
   *
   * Remote mode grants over the socket: there is no cookie to reach the REST
   * route with, and a gadget-dev conversation has no assistant to persist to
   * anyway, so the grant is conversation-only either way. The dev token binds
   * the member who minted it — `grantedBy` records them, the same attribution
   * a Studio grant gets — and the platform re-verifies their membership on
   * every socket ticket.
   */
  /** The requirement keys the platform lists as granted in this conversation — read, never inferred. */
  async function grantedDoorKeys() {
    await ensureConnected(remote ? devToken : cookie);
    // Malformed rows must not become evidence that permission is absent.
    const listed = validateDoorInventory(await session.stub.developmentDoors());
    return listed.filter((door) => door.granted === true).map((door) => door.requirementKey);
  }

  async function grantDoor(input, currentCookie) {
    const requirementKey = input?.requirementKey;
    if (typeof requirementKey !== 'string' || !requirements.some((row) => row?.requirementKey === requirementKey))
      throw refuse('That door is not one this gadget declared.', 'not_declared');
    if (typeof input?.persistToAgent !== 'boolean') throw refuse('Say whether this grant is for this conversation only.', 'invalid_request');
    if (remote) {
      await ensureConnected(devToken);
      const result = await session.stub.grantDevelopmentDoor(requirementKey);
      // The platform's own confirmation must name the requested requirement.
      // Substituting `requirementKey` for a missing/mismatched answer (F02a)
      // let a malformed or empty response read as though the platform had
      // confirmed exactly what was asked for — it never did.
      if (result?.requirementKey !== requirementKey) throw new Error('The platform did not confirm which door was granted.');
      return { requirementKey: result.requirementKey, persistedToAgent: false };
    }
    await ensureConnected(currentCookie);
    const result = await requestJson(`${apiOrigin}/v2/workspaces/${encodeURIComponent(workspaceId)}/door-grants`, {
      frontendOrigin, cookie: currentCookie, method: 'POST', body: { requirementKey, persistToAgent: input.persistToAgent }, fetchImpl
    });
    const confirmedKey = result?.data?.grant?.requirementKey;
    // Same rule over REST: `requestJson` already rejects a body it cannot
    // parse, but a well-formed body that simply omits or misnames the grant
    // is just as unconfirmed. Never fall back to the requested key — that is
    // the requested identity standing in for a confirmed one.
    if (confirmedKey !== requirementKey) throw new Error('The platform did not confirm which door was granted.');
    return {
      requirementKey: confirmedKey,
      persistedToAgent: result?.data?.persistedToAgent === true
    };
  }

  /** Each connector family this source declared, what it holds, and what the owner could add. */
  async function connectionChoices() {
    await ensureConnected(remote ? devToken : cookie);
    const families = await session.stub.developmentConnectionChoices();
    return Array.isArray(families) ? families : [];
  }

  /**
   * The owner's choice of one existing account for a declared family. The
   * platform checks the account, the family's size and consent; this only
   * refuses what it can already see is wrong.
   *
   * The socket is the ONLY surface this can go through: the REST grant route
   * finds a family through the conversation's installed gadgets, and a
   * development gadget is attached nowhere — so Studio could never grant it.
   * That holds in remote mode exactly as in local: the dev token binds the
   * member who minted it, the grant lands under `grantedBy: <that member>`,
   * and the same member could grant this account to this conversation from
   * Studio were a family grant reachable there at all.
   */
  async function grantConnection(input) {
    const requirementKey = input?.requirementKey;
    if (typeof requirementKey !== 'string' || !requirements.some((row) => row?.requirementKey === requirementKey && row?.kind === 'connector_resource'))
      throw new Error('That connection family is not one this gadget declared.');
    if (typeof input?.resolvedId !== 'string' || !input.resolvedId) throw new Error('Choose an account to connect.');
    await ensureConnected(remote ? devToken : cookie);
    const result = await session.stub.grantDevelopmentConnection({ requirementKey, resolvedId: input.resolvedId });
    if (!result?.ok) throw new Error(result?.message || 'That connection could not be granted.');
    return { requirementKey: result.requirementKey, env: result.env, label: result.label ?? null };
  }

  return {
    connectionChoices,
    grantConnection,
    get info() {
      return {
        connected: Boolean(session),
        workspaceId,
        conversationTitle: title,
        gadgetId: session?.gadgetId ?? null,
        expiresAt: session?.expiresAt ?? null,
        replacedFrom: session?.replacedFrom ?? null
      };
    },
    doors,
    grantDoor,
    grantedDoorKeys,
    handle,
    /**
     * Point the live session at new source.
     *
     * `registerDevelopmentGadget` is already built to be called again: it
     * revokes the previous binding, bumps a generation so a superseded
     * registration throws rather than racing, and mints a fresh `dev:<uuid>`
     * so action arguments captured against the old id can never resolve to
     * the replacement. That is exactly the semantics a reload wants, so this
     * re-registers instead of reconnecting — the socket, the conversation and
     * the granted doors all survive.
     */
    async reload(next) {
      if (typeof next?.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(next.sourceHash)) {
        throw new Error('Invalid source digest.');
      }
      sourceHash = next.sourceHash;
      if (Array.isArray(next.methods)) methods = next.methods;
      if (Array.isArray(next.requirements)) requirements = next.requirements;
      if (typeof next.serverSource === 'string') serverSource = next.serverSource;
      await ensureConnected(remote ? devToken : cookie);
      const registration = await session.stub.registerDevelopmentGadget(registrationMetadata(), new LocalHost());
      noteRegistration(registration);
      return { gadgetId: registration.gadgetId, sourceHash, replacedFrom: session?.replacedFrom ?? null };
    },
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

async function requestJson(url, { frontendOrigin, cookie, authorization, method, body, fetchImpl }) {
  const response = await fetchImpl(url, {
    method,
    headers: { ...apiHeaders({ cookie, frontendOrigin, authorization }), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  let value = null;
  let readable = true;
  try { value = await response.json(); } catch { readable = false; }
  if (!response.ok) {
    const message = value?.error?.message || value?.message;
    // A 4xx that explained itself is the API's refusal. A 5xx, a timeout-ish
    // 408, or a body nobody can read may have written before failing.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && typeof message === 'string' && message) {
      throw refuse(message, typeof value?.error?.code === 'string' ? value.error.code : 'upstream_refused');
    }
    throw new Error(message || `API request failed (${response.status}).`);
  }
  // HTTP 200 with a body nobody can parse is not a successful answer — it is
  // an upstream that may have written before failing to respond. Returning
  // null here let a caller (F02a) read the absence of every field as
  // confirmed, including a field the caller then filled in with the
  // REQUESTED value rather than a confirmed one. Throw instead, so an
  // unreadable success is never distinguishable from "nothing came back".
  if (!readable) throw new Error(`The API response for ${new URL(url).pathname} could not be read.`);
  return value;
}

function apiHeaders({ cookie, frontendOrigin, authorization }) {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (frontendOrigin) headers.origin = frontendOrigin;
  if (authorization) headers.authorization = authorization;
  return headers;
}

export function sourceDigest(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) hash.update(name).update('\0').update(files[name]).update('\0');
  return hash.digest('hex');
}

export function socialMethodNames() {
  return [
    'summary', 'setConfig', 'saveSetup', 'setMonitoring', 'refreshGrants', 'addOpenSource', 'removeOpenSource', 'scanRuns', 'refresh', 'listItems',
    'getItem', 'getMedia', 'createBatch', 'getBatch', 'addBatchItem', 'removeBatchItem', 'renameBatchItem', 'listBatches', 'listBatchSummaries', 'saveRevision',
    'saveRevisions', 'savePoster', 'saveGeneratedImage', 'deliverGeneratedImage', 'getGeneratedImage', 'pendingGeneratedImages',
    'dismissGenerationAsk', 'requestGeneration', 'saveInstructionOverrides', 'submitForReview', 'readPublishState',
    'exportAs', 'exportJson', 'exportHtml', 'markSeen', 'setSelection', 'clearSelection'
  ];
}
