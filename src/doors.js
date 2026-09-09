// Social Localization blueprint — every door call in one file.
//
// `server.js` never reads `this.env.<door>` directly; it calls a function
// here. A contract change on any door — the connector door's method naming
// (TASK-101, `cc/connector-door`), the Social Hub door's shape (TASK-103), or
// `workspace.notify` (TASK-104) — touches this one file, not every method
// that happens to use a door.
//
// TOLERANT OF ABSENCE. Every door here may be missing from `env`: a gadget
// instance the owner has not finished granting, or a door kind this
// deployment does not yet implement. Every function below checks for the
// door and its method before calling it, and reports rather than throws,
// except where the caller has no sensible fallback (arming a schedule,
// submitting for review) — those throw a clear, owner-facing message.
//
// OUTCOME ENVELOPE (REQ-020, SEC-007). A connector call returns
// `{ outcome: "confirmed" | "failed_safe" | "unknown", data?, message? }`.
// Never retried automatically on `unknown` — the caller decides whether to
// try again on the next scan.
//
// REFUSAL ENVELOPE. A `send`/`generate`-authority door method that the
// gatekeeper gates (`socialSubmitForReview`, and every connector write —
// though nothing in this file calls one) answers a direct call with a VALUE,
// not a throw: `{ refused: true, code, message, authority? }`. `isDoorRefusal`
// below is the one place that shape is recognised.
//
// ENV KEY CASING (Finding D, design-plans/evidence/social-localization-
// gadget-1/verification.md). `this.env`'s keys are never this blueprint's
// to invent: the platform builds them from each door's own requirement key
// through `gatekeeperEnvKey` (`workers/api/src/domains/gadgets/
// connector-door.ts`) — verbatim, unchanged case, for anything that is not a
// connector-prefixed key (`workspace-room.ts`'s `wrapGadgetEnv`, generated
// per isolate from the `DOOR_SPEC` `gatekeeperEnv` builds, is what actually
// turns a grant into `env.<key>`). This blueprint's three fixed capability
// doors are declared with LOWERCASE requirement keys —
// `modules/gadgets/src/definitions/social-localization.ts`'s
// `requirements`: `{ requirementKey: "social", kind: "capability" }`, and
// likewise `"schedule"` / `"workspace"` — so `gatekeeperEnvKey` (identity
// for a non-connector kind) resolves each to `env.social` / `env.schedule` /
// `env.workspace`, never the uppercase form a bare Node/JS instinct reaches
// for. `FIXED_DOOR_KEYS` below is the one place that mapping is written
// down; `server.js` imports it rather than repeating the three strings, so a
// future requirement-key rename only has to change here. A connector door's
// env key is different in kind, not just case — it is the label the OWNER
// chose at grant time (`slugifyConnectorLabel`, upper-cased) — and this
// blueprint already resolves and stores THAT one correctly: it arrives as
// `sources[].binding` / `destinations[].binding` from the door grant itself
// (`server.js`'s `deriveBindingsFromGrants`), never guessed or reconstructed
// here.

/**
 * This blueprint's three fixed single-binding capability doors, keyed
 * exactly as the platform binds them (see the header note above). The one
 * declaration every other reference to a fixed door's env key — here and in
 * `server.js`'s `FIXED_DOOR_KEYS` / `availableConnectorBindings` — resolves
 * against, so the key strings exist in exactly one place.
 */
export const FIXED_DOOR_KEYS = Object.freeze(["social", "schedule", "workspace", "fetch"]);

/**
 * The door that fetches a PUBLIC account's posts, when the owner granted it.
 *
 * Separate from `FIXED_DOOR_KEYS`'s membership because it is the only one that
 * is OPTIONAL (`min: 0`): a workspace whose sources are all authorised
 * connector bindings never needs it, so its absence is a configuration, not a
 * fault. Everything that reads it must treat "not granted" as "this workspace
 * does not watch open accounts", never as an error.
 */
export const FETCH_DOOR_KEY = "fetch";

/**
 * Whether each fixed capability door is currently granted — `env.<key>`
 * present — for `summary()`'s status block (Finding D: absence must read as
 * "not granted" somewhere the owner can see, never a silent `unknown` only a
 * console.warn ever recorded).
 */
export function doorGrantStatus(env) {
  const status = {};
  for (const key of FIXED_DOOR_KEYS) {
    status[key] = Boolean(env && typeof env === "object" && env[key]);
  }
  return status;
}

/**
 * Calls one pinned action on a granted connector door.
 *
 * `binding` is the owner-chosen label slug the door was granted under
 * (`env.IG_ESSENTIAL_FOODS`, TASK-101, PR #1484); `method` is the pinned
 * action's own name. As shipped, the only READ actions are
 * `instagram_list_media` and `facebook_list_page_posts` (full underscored
 * slugs, not `list_media`/`list_page_posts`) — see `listInstagramMedia` /
 * `listFacebookPagePosts` below, which wrap this with the right method name
 * and response shape. Write actions on the same door exist but refuse when
 * called directly (`{ refused: true, code: "submission_required", authority:
 * "send" }`) rather than running inline, so nothing in the scan path may call
 * one — `callConnector` is generic and does not stop a caller from trying,
 * but no caller here does.
 */
export async function callConnector(env, binding, method, args = []) {
  const door = env && typeof env === "object" ? env[binding] : undefined;
  if (!door) {
    return { outcome: "unknown", message: `The ${binding} connector is not granted to this gadget.` };
  }
  const fn = typeof door[method] === "function" ? door[method] : null;
  if (!fn) {
    return { outcome: "unknown", message: `The ${binding} connector does not offer ${method}.` };
  }
  try {
    const result = await fn.apply(door, args);
    if (result && typeof result === "object" && typeof result.outcome === "string") {
      return result;
    }
    // A door that answers with bare data instead of the outcome envelope is
    // still a successful call — normalize rather than reject the shape.
    return { outcome: "confirmed", data: result };
  } catch (error) {
    return { outcome: "failed_safe", message: errorMessage(error) };
  }
}

/**
 * `env.<binding>.instagram_list_media({ limit, after })` ->
 * `{ outcome, message, data?: { media, nextCursor } }` (PR #1484). Adapted
 * here into the `{ data, paging: { cursors: { after } } }` shape
 * `model.js`'s `normalizeInstagramMedia` expects — a Composio/Graph-API
 * convention `model.js` was written against before this door's final
 * response shape landed, kept as the normalizer's contract rather than
 * touching `model.js` for a transport detail.
 */
export async function listInstagramMedia(env, binding, { limit, after } = {}) {
  const response = await callConnector(env, binding, "instagram_list_media", [{ limit, after: after ?? null }]);
  if (response.outcome !== "confirmed") return response;
  const media = Array.isArray(response.data?.media) ? response.data.media : [];
  const nextCursor = response.data?.nextCursor ?? null;
  return { ...response, page: { data: media, paging: nextCursor ? { cursors: { after: nextCursor } } : {} } };
}

/**
 * `env.<binding>.facebook_list_page_posts({ limit, after })` ->
 * `{ outcome, message, data?: { posts, nextCursor } }` (PR #1484). Raw feed
 * page, unfiltered — the `is_published` / Page-author filter lives in
 * `model.js`'s `normalizeFacebookPagePosts`, not here. Any `pageId` this
 * blueprint stores is not sent: the door already injects the granted Page.
 * Adapted into the same `{ data, paging }` shape as `listInstagramMedia`.
 */
export async function listFacebookPagePosts(env, binding, { limit, after } = {}) {
  const response = await callConnector(env, binding, "facebook_list_page_posts", [{ limit, after: after ?? null }]);
  if (response.outcome !== "confirmed") return response;
  const posts = Array.isArray(response.data?.posts) ? response.data.posts : [];
  const nextCursor = response.data?.nextCursor ?? null;
  return { ...response, page: { data: posts, paging: nextCursor ? { cursors: { after: nextCursor } } : {} } };
}

/**
 * A PUBLIC account's posts, through the metered fetch door.
 *
 * `env.fetch.socialPostsForAccount({ platform, accountKey, cursor })` ->
 * `{ ok, posts, miss, servedBy, costUsd, credits }` or `{ ok: false, code }`.
 * Adapted into the same `{ outcome, message, page }` shape the two connector
 * readers above produce, so `scanOneSource` does not learn that some sources
 * arrive differently.
 *
 * THE MISS IS THE POINT. The door reports `miss: true` when the broker
 * answered 200 with no posts, which is NOT the same as an account that
 * published nothing. Only one of those is a successful read of an account, and
 * a scan that filed the first as the second would report a clean run while
 * fetching nothing. It comes back as its own outcome, `no_answer`, so the run
 * ledger can count it apart from `confirmed`.
 *
 * A door that is not granted is not an error: the fetch requirement is
 * optional, so `env.fetch` being absent means this workspace does not watch
 * open accounts.
 */
export async function listOpenAccountPosts(env, source, { after } = {}) {
  const door = env && typeof env === "object" ? env[FETCH_DOOR_KEY] : null;
  if (!door || typeof door.socialPostsForAccount !== "function") {
    return {
      outcome: "failed_safe",
      message: "Public account fetching is not granted for this workspace.",
      page: { data: [], paging: {} }
    };
  }

  let result;
  try {
    result = await door.socialPostsForAccount({
      platform: source.platform,
      accountKey: source.accountKey,
      cursor: after ?? null
    });
  } catch (error) {
    // The door refuses by value, so reaching here means the RPC itself broke.
    return {
      outcome: "failed_safe",
      message: error instanceof Error ? error.message : String(error),
      page: { data: [], paging: {} }
    };
  }

  if (!result || result.ok !== true) {
    return {
      outcome: "failed_safe",
      message: (result && result.message) || "The fetch door refused.",
      page: { data: [], paging: {} }
    };
  }

  const nextCursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
  return {
    outcome: result.miss ? "no_answer" : "confirmed",
    message: null,
    // The provider's short name, which is what a person reads on a source row;
    // `servedBy` carries the full endpoint id for when the question is which
    // capability answered.
    servedBy: result.provider ?? result.servedBy ?? null,
    credits: typeof result.credits === "number" ? result.credits : 0,
    page: {
      data: Array.isArray(result.posts) ? result.posts : [],
      // Same `{ cursors: { after } }` shape the connector readers produce, so
      // the scan loop pages an open account exactly as it pages a granted one.
      paging: nextCursor ? { cursors: { after: nextCursor } } : {}
    }
  };
}

/**
 * Media bytes for a source item's cache (SEC-004, CON-007, RISK-002).
 *
 * `env.<binding>.fetch_media({ url, rendition })` -> `{ outcome, message,
 * data?: { mime, bytes, byteLength } }` (TASK-107, PR #1492, stacked on
 * #1489/#1484): a generic read action gated by the provider's own CDN host
 * allowlist, not a free URL. Only `url` and `rendition` cross — no `kind`,
 * which the door never accepted and `model.js`'s media entries do not need
 * to send for a byte fetch. A provider whose descriptor declares no media
 * hosts (or a binding still ungranted) simply has no `fetch_media` method,
 * so `callConnector` reports the same "does not offer fetch_media" `unknown`
 * this always fell back to — no special-casing needed here either way.
 */
export async function fetchMedia(env, binding, media, rendition) {
  return callConnector(env, binding, "fetch_media", [{ url: media?.url, rendition }]);
}

/** `env.workspace.notify({ title, body, href })` — TASK-104. Never throws; logs and continues. */
export async function notify(env, payload) {
  const workspace = env && env.workspace;
  if (!workspace || typeof workspace.notify !== "function") {
    console.warn("social-localization: workspace.notify is not granted; skipping", payload && payload.title);
    return { outcome: "unknown", message: "The workspace door is not granted." };
  }
  try {
    await workspace.notify(payload);
    return { outcome: "confirmed" };
  } catch (error) {
    console.warn("social-localization: workspace.notify failed:", errorMessage(error));
    return { outcome: "failed_safe", message: errorMessage(error) };
  }
}

/** `env.schedule.list()` — read authority, tolerant of absence. */
export async function scheduleList(env) {
  const schedule = env && env.schedule;
  if (!schedule || typeof schedule.list !== "function") return [];
  return schedule.list();
}

/**
 * `env.schedule.create(hook, cadence)` — `deploy` authority (gatekeeper-kinds.ts):
 * the door raises this as a submission the owner approves rather than running
 * it inline, so a resolved call here means the schedule was armed, and an
 * unresolved one is the owner's decision still pending. No fallback: setup
 * cannot silently skip arming the hook, so a missing door is a clear error.
 */
export async function scheduleCreate(env, hook, cadence) {
  const schedule = env && env.schedule;
  if (!schedule || typeof schedule.create !== "function") {
    throw new Error("The schedule door is not granted. Ask the owner to grant it during setup.");
  }
  return schedule.create(hook, cadence);
}

/** `env.schedule.cancel(scheduleId)` — `operate` authority. */
export async function scheduleCancel(env, scheduleId) {
  const schedule = env && env.schedule;
  if (!schedule || typeof schedule.cancel !== "function") {
    return { cancelled: false };
  }
  return schedule.cancel(scheduleId);
}

/**
 * `env.social.createDraft(input)` — TASK-103, `generate` authority: writes an
 * immutable version 1 post in `draft` status and returns `{ postId,
 * versionId, versionNumber, contentHash, targets }`. This is the FIRST of
 * the door's two review calls (see `socialSubmitForReview` below) — nothing
 * about a draft leaves the workspace, so unlike `submitForReview` it runs
 * inline and a direct call succeeds. Throws a clear, owner-facing message
 * when the door is absent: REQ-009 forbids a second publish path, so there
 * is no fallback to run.
 */
export async function socialCreateDraft(env, input) {
  const social = env && env.social;
  if (!social || typeof social.createDraft !== "function") {
    throw new Error("The Social Hub door is not granted. Ask the owner to grant it during setup.");
  }
  return social.createDraft(input);
}

/**
 * `env.social.submitForReview({ versionId, expectedContentHash })` —
 * TASK-103, `send` authority. THIS ALWAYS COMES BACK REFUSED when called
 * directly from gadget code, by design (`gatekeepers.ts`'s
 * `authorityProceeds`): `{ refused: true, code: "submission_required",
 * message, authority: "send" }`. That refusal IS the ask — it is what makes
 * the post appear on the existing Approvals surface. The real result
 * (`approvalId`, per-target status) only exists once the owner approves, and
 * this call's own return value never carries it; `socialReadStatus` below is
 * how a caller learns what happened after. Throws a clear, owner-facing
 * message only when the door itself is absent: REQ-009 forbids a second
 * publish path, so there is no fallback to run.
 */
export async function socialSubmitForReview(env, input) {
  const social = env && env.social;
  if (!social || typeof social.submitForReview !== "function") {
    throw new Error("The Social Hub door is not granted. Ask the owner to grant it during setup.");
  }
  return social.submitForReview(input);
}

/** `env.social.readStatus({ versionId })` — read authority. Null when the door is absent. */
export async function socialReadStatus(env, versionId) {
  const social = env && env.social;
  if (!social || typeof social.readStatus !== "function") return null;
  return social.readStatus({ versionId });
}

/** True for a door's refusal envelope (`{ refused: true, code, message }`) — every gated door answers with this shape, never a throw. */
export function isDoorRefusal(value) {
  return Boolean(value) && typeof value === "object" && value.refused === true;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
