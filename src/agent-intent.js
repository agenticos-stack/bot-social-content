/**
 * The canvas ↔ conversation contract behind regenerate-by-chat and the
 * in-place top-up ask. Three message kinds, plus one announcement:
 *
 * - `gadget:host-features` (host → canvas): the host names the contracts it
 *   honours. A canvas that never hears it cannot assume a conversation or a
 *   top-up surface exists — the affordance stays visible, disabled, with the
 *   reason, rather than falling back to drawing inside the drawer or failing
 *   silently. The message may arrive again; the latest set wins.
 * - `gadget:agent-intent` (canvas → host): the canvas asks the host's
 *   conversation to take an owner-visible intent. `image.regenerate` is the
 *   only intent today. The message carries everything the conversation needs
 *   to never ask which image is meant: the post, the batch item, the current
 *   media id, the brief's aspect ratio and reference basis, a thumbnail, and
 *   one-tap suggested replies already in the owner's language. The canvas
 *   posts it and keeps its layout; the host decides what the conversation
 *   does next. Nothing in this message runs a generation — filing stays a
 *   durable requestGeneration through the gadget's own method surface.
 * - `gadget:topup` / `gadget:topup-result` (canvas → host → canvas): the
 *   canvas asks the host to open its funding surface for the named post.
 *   The host answers `topped_up`, `cancelled`, or `unsupported`, correlated
 *   by requestId. On `topped_up` the paused run resumes on its own — the
 *   owner is not asked to ask again.
 *
 * Both Studio and the local Social Content preview implement this contract.
 * The host still decides whether the conversation is open, still owns the
 * funding surface, and still answers only messages from its own frame.
 */

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FEATURE_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const ASPECT_RATIO = /^[0-9]{1,3}:[0-9]{1,3}$/;
const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{8,}$/i;
const BATCH_ITEM = /^[A-Za-z0-9_-]{1,96}$/;

export const AGENT_INTENT_MESSAGE_TYPE = "gadget:agent-intent";
export const HOST_FEATURES_MESSAGE_TYPE = "gadget:host-features";
export const TOPUP_MESSAGE_TYPE = "gadget:topup";
export const TOPUP_RESULT_MESSAGE_TYPE = "gadget:topup-result";

/** The feature keys a host may declare; unknown keys are dropped, not read. */
export const HOST_FEATURES = Object.freeze(["agent-intent", "topup"]);

/** The only intent kind today — the picture's ⋯ → Regenerate… hand-off. */
export const AGENT_INTENTS = Object.freeze(["image.regenerate"]);

export const TOPUP_OUTCOMES = Object.freeze(["topped_up", "cancelled", "unsupported"]);

const MAX_SUGGESTED_REPLIES = 6;
const MAX_REPLY_LENGTH = 160;

function requestIdOf(value) {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}

function featureSetOf(value) {
  if (!Array.isArray(value)) return null;
  const features = new Set();
  for (const entry of value) {
    if (typeof entry === "string" && FEATURE_KEY.test(entry)) features.add(entry);
  }
  return features;
}

function postOf(value) {
  if (!value || typeof value !== "object") return null;
  const batchId = typeof value.batchId === "string" && BATCH_ITEM.test(value.batchId) ? value.batchId : null;
  const batchItemId = typeof value.batchItemId === "string" && BATCH_ITEM.test(value.batchItemId) ? value.batchItemId : null;
  if (!batchId || !batchItemId) return null;
  return {
    batchId,
    batchItemId,
    title: typeof value.title === "string" ? value.title.slice(0, 200) : null
  };
}

function imageOf(value) {
  if (!value || typeof value !== "object") return null;
  const aspectRatio = typeof value.aspectRatio === "string" && ASPECT_RATIO.test(value.aspectRatio) ? value.aspectRatio : null;
  const references = value.references === "source" || value.references === "none" ? value.references : null;
  if (!aspectRatio || !references) return null;
  const mediaId = typeof value.mediaId === "string" && BATCH_ITEM.test(value.mediaId) ? value.mediaId : null;
  const thumbnail = typeof value.thumbnail === "string" && DATA_URL.test(value.thumbnail) ? value.thumbnail : null;
  return { mediaId, aspectRatio, references, thumbnail };
}

function suggestedRepliesOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .slice(0, MAX_SUGGESTED_REPLIES)
    .map((entry) => entry.trim().slice(0, MAX_REPLY_LENGTH));
}

/**
 * The host's feature announcement. Unknown or absent features mean the canvas
 * must not post that kind of message — the affordance explains instead.
 */
export function parseGadgetHostFeaturesMessage(data) {
  if (!data || typeof data !== "object" || data.type !== HOST_FEATURES_MESSAGE_TYPE) return null;
  const features = featureSetOf(data.features);
  if (!features) return null;
  return { features };
}

export function gadgetHostFeaturesMessage(features) {
  const set = featureSetOf(features) ?? new Set();
  return { type: HOST_FEATURES_MESSAGE_TYPE, features: [...set] };
}

/**
 * Builds one intent message. `post` and `image` are validated the same way
 * the parser reads them — a canvas that cannot describe the image does not
 * send a half-context the conversation would have to guess at.
 */
export function gadgetAgentIntentMessage({ intent, post, image, suggestedReplies = [], locale = null, requestId = null } = {}) {
  if (!AGENT_INTENTS.includes(intent)) throw new Error(`Unknown agent intent ${intent}.`);
  const postValue = postOf(post);
  const imageValue = imageOf(image);
  if (!postValue || !imageValue) throw new Error("An agent intent needs a post and an image it can name.");
  return {
    type: AGENT_INTENT_MESSAGE_TYPE,
    requestId: requestIdOf(requestId) ?? newAgentIntentRequestId(),
    intent,
    post: postValue,
    image: imageValue,
    suggestedReplies: suggestedRepliesOf(suggestedReplies),
    locale: locale === "zh-HK" ? "zh-HK" : "en"
  };
}

export function parseGadgetAgentIntentMessage(data) {
  if (!data || typeof data !== "object" || data.type !== AGENT_INTENT_MESSAGE_TYPE) return null;
  if (!AGENT_INTENTS.includes(data.intent)) return null;
  const post = postOf(data.post);
  const image = imageOf(data.image);
  if (!post || !image) return null;
  return {
    requestId: requestIdOf(data.requestId),
    intent: data.intent,
    post,
    image,
    suggestedReplies: suggestedRepliesOf(data.suggestedReplies),
    locale: data.locale === "zh-HK" ? "zh-HK" : "en"
  };
}

export function gadgetTopupMessage({ post, requestId = null } = {}) {
  const postValue = postOf(post);
  if (!postValue) throw new Error("A top-up ask needs the post it paused on.");
  return { type: TOPUP_MESSAGE_TYPE, requestId: requestIdOf(requestId) ?? newTopupRequestId(), post: postValue };
}

export function parseGadgetTopupMessage(data) {
  if (!data || typeof data !== "object" || data.type !== TOPUP_MESSAGE_TYPE) return null;
  const post = postOf(data.post);
  const requestId = requestIdOf(data.requestId);
  if (!post || !requestId) return null;
  return { requestId, post };
}

export function gadgetTopupResultMessage({ requestId, outcome, message = null } = {}) {
  if (!TOPUP_OUTCOMES.includes(outcome)) throw new Error(`Unknown top-up outcome ${outcome}.`);
  return {
    type: TOPUP_RESULT_MESSAGE_TYPE,
    requestId: requestIdOf(requestId),
    outcome,
    ...(typeof message === "string" && message ? { message: message.slice(0, 300) } : {})
  };
}

export function parseGadgetTopupResultMessage(data) {
  if (!data || typeof data !== "object" || data.type !== TOPUP_RESULT_MESSAGE_TYPE) return null;
  const requestId = requestIdOf(data.requestId);
  if (!requestId || !TOPUP_OUTCOMES.includes(data.outcome)) return null;
  return {
    requestId,
    outcome: data.outcome,
    message: typeof data.message === "string" ? data.message : null
  };
}

/** Fresh ids, unguessable enough that a stale answer cannot collide. */
export function newAgentIntentRequestId() {
  return randomId("ai");
}

export function newTopupRequestId() {
  return randomId("tu");
}

function randomId(prefix) {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
