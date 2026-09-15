/**
 * Door consent between a sandboxed canvas and its host: requests, activation
 * retries and results.
 *
 * A gadget:grant-door message is a REQUEST for host consent, not consent.
 * A gadget:activate-door message asks the host to start a door the owner has
 * ALREADY granted in this conversation; it never grants anything. The host
 * answers either with one gadget:grant-result carrying the request's id.
 *
 * A gadget:doors-changed message is neither: it is the host telling this
 * canvas, UNPROMPTED, that a grant/revoke attempt happened SOMEWHERE ELSE —
 * Studio's own access popover, not this frame's own request (that one is
 * answered directly, correlated, through gadget:grant-result). It carries
 * only what kind of attempt it was (`reason`), never the outcome: this
 * canvas re-checks its own permission metadata to learn the truth, the same
 * way Studio's own Connections pane re-reads rather than trusting a guessed
 * status (F2, design-plans/evidence/social-content-841e2ca-review/README.md).
 *
 * Both Studio and the local Social Content preview implement this contract.
 * The host still presents confirmation in its own trusted UI, only for a
 * declared requirement, and only to messages from its own frame. The platform
 * still enforces membership and declarations.
 */

const REQUIREMENT_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What a result may say. `activated`: consent is saved and the running gadget
 * has the door. `activation_failed`: consent is saved, the runtime did not
 * start it. `cancelled`: the owner declined; nothing was written. `denied`:
 * nothing was saved (or, for activation, there was no grant to start).
 * `unconfirmed`: the host could not tell whether the write landed. `busy`:
 * another request is still open; this one was not queued.
 */
export const GRANT_OUTCOMES = Object.freeze(["activated", "activation_failed", "cancelled", "denied", "unconfirmed", "busy"]);

function requestIdOf(value) {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}

function requirementKeyOf(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return REQUIREMENT_KEY.test(key) ? key : null;
}

export function parseGadgetGrantDoorMessage(data) {
  if (!data || typeof data !== "object" || data.type !== "gadget:grant-door") return null;
  const requirementKey = requirementKeyOf(data.requirementKey);
  if (!requirementKey) return null;
  return { requirementKey, requestId: requestIdOf(data.requestId) };
}

/** An activation retry must carry an id: its answer is only useful correlated. */
export function parseGadgetActivateDoorMessage(data) {
  if (!data || typeof data !== "object" || data.type !== "gadget:activate-door") return null;
  const requirementKey = requirementKeyOf(data.requirementKey);
  const requestId = requestIdOf(data.requestId);
  if (!requirementKey || !requestId) return null;
  return { requirementKey, requestId };
}

export function gadgetGrantResultMessage({ requestId = null, requirementKey, outcome, message } = {}) {
  if (!GRANT_OUTCOMES.includes(outcome)) throw new Error(`Unknown grant outcome ${outcome}.`);
  return {
    type: "gadget:grant-result",
    requestId: requestIdOf(requestId),
    requirementKey,
    outcome,
    ...(typeof message === "string" && message ? { message } : {})
  };
}

export function parseGadgetGrantResultMessage(data) {
  if (!data || typeof data !== "object" || data.type !== "gadget:grant-result") return null;
  const requirementKey = requirementKeyOf(data.requirementKey);
  if (!requirementKey || !GRANT_OUTCOMES.includes(data.outcome)) return null;
  return {
    requestId: requestIdOf(data.requestId),
    requirementKey,
    outcome: data.outcome,
    message: typeof data.message === "string" ? data.message : null
  };
}

/** What a gadget:doors-changed notice may say happened. Never an outcome — see the file header. */
export const DOORS_CHANGED_REASONS = Object.freeze(["grant", "revoke"]);

/**
 * Parses a host's unprompted `gadget:doors-changed` notice. `type` and
 * `requirementKey` are validated the same way every other message here is;
 * an unrecognised `reason` is refused too, rather than passed through as an
 * arbitrary string this client would have to guess the meaning of.
 */
export function parseGadgetDoorsChangedMessage(data) {
  if (!data || typeof data !== "object" || data.type !== "gadget:doors-changed") return null;
  const requirementKey = requirementKeyOf(data.requirementKey);
  if (!requirementKey || !DOORS_CHANGED_REASONS.includes(data.reason)) return null;
  return { requirementKey, reason: data.reason };
}

/** A fresh id for one request, unguessable enough that a stale answer cannot collide. */
export function newGrantRequestId() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Canvas Grant is conversation-only unless the owner ticks the explained
 * assistant-wide choice. Omitting the flag on the API defaults organization
 * doors to persist — hosts must send this boolean.
 */
export function canvasGrantPersistToAgent(persistToAssistant) {
  return persistToAssistant === true;
}

export function consentAllowsFetch(env, key = "metered_fetch") {
  if (env && typeof env === "object" && env.__consent && typeof env.__consent === "object") {
    return env.__consent[key] === true;
  }
  return Boolean(env && typeof env === "object" && env[key]);
}
