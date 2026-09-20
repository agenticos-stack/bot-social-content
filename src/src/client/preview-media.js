// Social Content client — source-media reads and the surfaces that draw them.
//
// `createMediaReads` owns which frames a source post has, what each frame's
// read is doing (fetching / held / refused, plus any recovery the owner
// started), and the lifetime of the blob URLs it mints. The rail — the Post
// tab's numbered slot strip, every frame at once — is the renderer on it.
//
// The rail never sees a provider URL. `img-src blob: data:` with
// `connect-src 'none'` means a picture reaches this document only as bytes the
// gadget already holds, handed over through `getMedia` (SEC-004 / CON-004).

import { el, replace } from "./dom.js";
import { loadMediaAsBlobUrl } from "./rpc.js";
import { t } from "./i18n.js";

function readableBytes(total) {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${Math.round(total / 1024)} KB`;
  return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

function framesOf(item) {
  const list = Array.isArray(item?.media) ? item.media : [];
  return list.filter((entry) => entry && entry.id !== undefined && entry.id !== null);
}

/**
 * What a refused frame offers, chosen from the server's `code` — never from
 * its sentence.
 *
 * - `grant`: ask the host for consent (the host confirms; the canvas only asks).
 * - `activate`: consent is saved, the running gadget lacks the door; ask the
 *   host to start the door it already holds. Grants nothing.
 * - `refresh`: the stored media link is stale; the owner may refresh sources.
 * - `retry`: read this one frame again.
 * - `recheck`: read consent metadata again (never `getMedia`).
 * - `null`: nothing to do from here (the file cannot be used).
 */
const REFUSALS = {
  fetch_permission_required: { title: "drawerMediaPermissionTitle", body: "drawerMediaPermissionBody", action: "grant", label: "drawerMediaGrant" },
  fetch_activation_failed: { title: "drawerMediaActivationTitle", body: "drawerMediaActivationBody", action: "activate", label: "drawerMediaActivationRetry" },
  // The host could not confirm whether consent was saved. Not "permission
  // saved": activation checks what is actually held before starting anything.
  // The host reported a grant made outside this canvas. Nothing was read; the
  // owner's check reads this frame once under the current permission.
  fetch_permission_changed: { title: "drawerMediaPermissionChangedTitle", body: "drawerMediaPermissionChangedBody", action: "retry", label: "drawerMediaCheckAgain" },
  fetch_grant_unconfirmed: { title: "drawerMediaGrantUnconfirmedTitle", body: "drawerMediaGrantUnconfirmedBody", action: "activate", label: "drawerMediaActivationRetry" },
  fetch_transient: { title: "drawerMediaTransientTitle", body: null, action: "retry", label: "drawerMediaRetry" },
  reference_media_stale: { title: "drawerMediaStaleTitle", body: "drawerMediaStaleBody", action: "refresh", label: "drawerMediaRefreshSources" },
  media_unusable: { title: "drawerMediaUnusableTitle", body: null, action: null, label: null },
  fetch_uncertain: { title: "drawerMediaUncertainTitle", body: "drawerMediaUncertainBody", action: "retry", label: "drawerMediaCheckAgain" },
  // F2: the notice's own read came back unreadable (thrown), not merely
  // "not granted" — distinct from `fetch_grant_unconfirmed`, which is the
  // owner's OWN activation attempt failing to confirm. `recheck` re-reads
  // metadata only, never `getMedia`.
  fetch_permission_unknown: { title: "drawerMediaPermissionUnknownTitle", body: "drawerMediaPermissionUnknownBody", action: "recheck", label: "drawerMediaCheckAgain" }
};
const DEFAULT_REFUSAL = { title: "drawerMediaRefusedTitle", body: null, action: "retry", label: "drawerMediaRetry" };

/** The refused codes that mean "this frame is waiting on `metered_fetch` consent", not on media transport. */
function isPermissionCode(code) {
  return code === "fetch_permission_required" || code === "fetch_activation_failed" || code === "fetch_grant_unconfirmed"
    || code === "fetch_permission_changed" || code === "fetch_permission_unknown";
}

/** What a fresh `metered_fetch` read means for a permission-refused frame — never the notice's own attempted-operation reason. */
function permissionCodeFor(state) {
  if (state === "granted") return "fetch_permission_changed"; // consent is live; the owner's own check reads once, nothing here auto-fetches
  if (state === "absent") return "fetch_permission_required";
  return "fetch_permission_unknown"; // the read failed or came back unreadable
}

/**
 * The per-frame read engine both renderers share: the frame list, each
 * read's state (unread / fetching / held / refused, plus any recovery the
 * owner started), and the blob URLs it mints.
 *
 * `options.requestGrant()` / `options.requestActivation()` resolve to the
 * host's correlated `{ outcome, message }` (`grant-request.js` vocabulary).
 * `options.refreshSources()` is the owner's deliberate re-scan.
 * `options.recheckPermission()` (F2) is the owner's explicit "Check again"
 * on an unconfirmed-permission frame — a plain metadata read, never
 * `getMedia`, resolving to `{ state }`.
 *
 * `repaint(key)` is the renderer's hook, called whenever one frame's display
 * state may have changed; the rail repaints the matching slot.
 *
 * Returns `{ frames, urls, facts, states, read, readAll, act, refusalShape,
 * frameLabel, frameStates, isLive, notifyPermission, dispose }`.
 */
function createMediaReads(rpc, item, locale, options, repaint) {
  const frames = framesOf(item);
  const urls = new Map();      // media id -> blob URL
  const facts = new Map();     // media id -> { total }
  const states = new Map();    // media id -> { status, code, message, action, note }
  const inFlight = new Map();  // media id -> { token, promise }
  let tokens = 0;
  let live = true;

  /** A video is a cover image and nothing more: nothing here watched it or heard it. */
  function frameLabel(frame) {
    const parts = [t(locale, frame?.kind === "video" ? "drawerCoverOnly" : "drawerFormatImageShort")];
    const size = readableBytes(facts.get(String(frame?.id))?.total);
    if (size) parts.push(size);
    return parts.join(" · ");
  }

  /**
   * What a refused frame offers, resolved for this canvas's wiring: a
   * `refresh` offer with no re-scan function falls back to a plain retry of
   * the frame, and a pending recovery swaps the label for its in-flight one.
   */
  function refusalShape(state) {
    const shape = REFUSALS[state?.code] ?? DEFAULT_REFUSAL;
    const action = shape.action === "refresh" && typeof options.refreshSources !== "function" ? "retry" : shape.action;
    const label = shape.action === "refresh" && action === "retry" ? "drawerMediaCheckAgain" : shape.label;
    const pending = Boolean(state?.action);
    const pendingLabel = state?.action === "grant" ? "drawerMediaWaitingGrant" : state?.action === "activate" ? "drawerMediaStarting" : "drawerMediaFetching";
    return { shape, action, label, pending, pendingLabel };
  }

  /**
   * One read per frame at a time. A second ask while one is running joins it
   * rather than discarding it; a completion is applied only if the surface
   * is live and the read is still the one this frame is waiting on.
   */
  function startFetch(key) {
    if (!live || !key || urls.has(key)) return;
    if (inFlight.has(key)) return;
    const token = ++tokens;
    const promise = loadMediaAsBlobUrl(rpc, item.id, key, "preview");
    inFlight.set(key, { token, promise });
    states.set(key, { status: "fetching" });
    repaint(key);
    promise.then(
      ({ url, total }) => {
        if (inFlight.get(key)?.token !== token) { URL.revokeObjectURL(url); return; }
        inFlight.delete(key);
        if (!live) { URL.revokeObjectURL(url); return; }
        urls.set(key, url);
        facts.set(key, { total });
        states.set(key, { status: "held" });
        repaint(key);
      },
      (error) => {
        if (inFlight.get(key)?.token !== token) return;
        inFlight.delete(key);
        if (!live) return;
        const code = error && typeof error === "object" ? error.code ?? null : null;
        states.set(key, { status: "refused", code, message: error instanceof Error ? error.message : String(error), action: null, note: null });
        repaint(key);
      }
    );
  }

  /** The owner's recovery click. One pending action per frame; stale answers ignored. */
  async function act(key, action) {
    const state = states.get(key);
    if (!live || !state || state.status !== "refused" || state.action) return;
    if (action === "retry") { states.delete(key); startFetch(key); return; }
    if (action === "recheck") {
      const attempt = { ...state, action, note: null };
      states.set(key, attempt);
      repaint(key);
      let result;
      try {
        result = await options.recheckPermission?.();
      } catch (error) {
        result = { state: "unknown" };
      }
      // Closed, replaced (a notice already answered this frame) or moved on.
      if (!live || states.get(key) !== attempt) return;
      applyPermissionState(key, result?.state ?? "unknown");
      return;
    }
    const request =
      action === "grant" ? options.requestGrant
        : action === "activate" ? options.requestActivation
          : action === "refresh" ? options.refreshSources
            : null;
    if (typeof request !== "function") return;
    const attempt = { ...state, action, note: null };
    states.set(key, attempt);
    repaint(key);
    let answer;
    try {
      answer = await request();
    } catch (error) {
      answer = { outcome: "unconfirmed", message: error instanceof Error ? error.message : String(error) };
    }
    // Closed, replaced or already moved on: this answer belongs to nobody.
    if (!live || states.get(key) !== attempt) return;
    if (action === "refresh") {
      // A deliberate re-scan changed what the reference points at; read the
      // frame once, because the owner asked for exactly that.
      states.delete(key);
      startFetch(key);
      return;
    }
    settle(key, attempt, answer ?? { outcome: "unconfirmed" });
  }

  /** Applies a fresh `metered_fetch` read to one frame — only if it is currently refused for permission; a held frame, a transient refusal, etc. are untouched. */
  function applyPermissionState(key, state) {
    const current = states.get(key);
    if (!current || current.status !== "refused" || !isPermissionCode(current.code)) return;
    states.set(key, { ...current, code: permissionCodeFor(state), action: null, note: null, message: null });
    repaint(key);
  }

  function settle(key, attempt, { outcome, message }) {
    const next = { ...attempt, action: null, note: null };
    switch (outcome) {
      case "activated":
        states.delete(key);
        startFetch(key);
        /*
         * ONE ANSWER OPENS THE DOOR FOR EVERY WAITING FRAME. The grant was
         * for the surface, not for the one slot the owner happened to press —
         * every frame still refused for a permission reason may now read.
         */
        for (const [other, entry] of [...states.entries()]) {
          if (entry.status === "refused" && isPermissionCode(entry.code)) {
            states.delete(other);
            startFetch(other);
          }
        }
        return;
      case "activation_failed":
        states.set(key, { ...next, code: "fetch_activation_failed", message: message || attempt.message });
        break;
      case "cancelled":
        states.set(key, { ...next, note: t(locale, "drawerMediaCancelled") });
        break;
      case "denied":
        states.set(key, { ...next, note: message || t(locale, "drawerMediaDenied") });
        break;
      case "busy":
        states.set(key, { ...next, note: t(locale, "drawerMediaBusy") });
        break;
      default:
        // Unconfirmed: the grant may have landed. Offer activation of what may
        // already be held, which verifies before starting anything.
        states.set(key, { ...next, code: "fetch_grant_unconfirmed", message: message || null });
    }
    repaint(key);
  }

  /**
   * The read one navigation makes — an unread frame only. A held frame keeps
   * its bytes, a refused one keeps its explanation, a running read keeps
   * running.
   */
  function read(key) {
    if (!live || !key || urls.has(key) || states.has(key)) return;
    startFetch(key);
  }

  /** The rail's read: every frame on show, each through the same door. */
  function readAll() {
    for (const frame of frames) read(String(frame.id));
  }

  /**
   * The host told this canvas an operation was ATTEMPTED elsewhere (Studio's
   * own access popover) — never whether it succeeded (grant-request.js).
   * `state` is the caller's own fresh read of `metered_fetch` consent, taken
   * after the notice; it is what every currently permission-refused frame
   * moves to. A failed or lost revoke with consent still live must not read
   * as "permission gone", and an unreadable read must not read as either —
   * that is why this takes a read's outcome, never the notice's reason.
   * Held frames, selection and the strip are untouched.
   */
  function notifyPermission({ state }) {
    if (!live) return;
    for (const key of states.keys()) applyPermissionState(key, state);
  }

  return {
    frames,
    urls,
    facts,
    states,
    read,
    readAll,
    act,
    refusalShape,
    frameLabel,
    isLive: () => live,
    frameStates() {
      return frames.map((frame) => ({ id: String(frame.id), status: states.get(String(frame.id))?.status ?? "unread" }));
    },
    notifyPermission,
    dispose() {
      live = false;
      inFlight.clear();
      states.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    }
  };
}

/**
 * THE RAIL — the Reference tab's media surface, drawn in the Post tab's
 * own vocabulary: one numbered `sl-slot` per source frame, in source order,
 * every frame reading at once because every frame is on show.
 *
 * The slot keeps the read's honesty per frame: a held frame draws its
 * bytes, a fetching one shimmers with the same skeleton the Post tab's
 * arriving page wears, and a refused one names the refusal inside the frame
 * and carries its own recovery action — the same per-frame `getMedia` door,
 * the same grant/activate/recheck/refresh recovery, never a provider URL.
 *
 * Returns `{ node, frameCount, frameStates, notifyPermission, dispose }`.
 */
export function createMediaRail(rpc, item, locale, options = {}) {
  const rail = el("div", { class: "sl-strip sl-ref-strip", role: "list", "aria-label": t(locale, "drawerFrames") });
  const slots = new Map(); // media id -> { frameEl, tail, position }

  const reads = createMediaReads(rpc, item, locale, options, repaint);
  const { frames, urls, states } = reads;
  const multi = frames.length > 1;

  for (const [position, frame] of frames.entries()) {
    const frameEl = el("div", { class: "sl-output-frame sl-slot-frame" });
    const media = el("div", { class: "sl-slot-media" }, [frameEl]);
    // The frame number rides on the picture, the way a page number does —
    // a refusal naming "frame 2" points at this slot.
    if (multi) media.appendChild(el("span", { class: "sl-slot-num", "aria-hidden": "true" }, String(position + 1)));
    const tail = el("div", { class: "sl-slot-tail", hidden: true });
    rail.appendChild(el("div", { class: "sl-slot", role: "listitem" }, [media, tail]));
    slots.set(String(frame.id), { frameEl, tail, position });
  }

  // A source with no readable frames still gets the one honest slot: the
  // same dashed frame an empty page wears, saying nothing was lost.
  if (!frames.length) {
    rail.appendChild(el("div", { class: "sl-slot", role: "listitem" }, [
      el("div", { class: "sl-slot-media" }, [
        el("div", { class: "sl-output-frame sl-slot-frame sl-slot-frame-empty" }, [
          el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerMediaNoneTitle"))
        ])
      ]),
      el("div", { class: "sl-slot-cap" }, t(locale, "drawerMediaNoneBody"))
    ]));
  }

  function repaint(key) {
    const slot = slots.get(key);
    if (!slot) return;
    const frame = frames[slot.position];
    const url = urls.get(key);
    const state = states.get(key);
    let tailKids = [];
    if (url) {
      slot.frameEl.classList.remove("sl-output-frame-skel");
      replace(slot.frameEl, [
        el("img", {
          class: "sl-pc-canvas",
          src: url,
          alt: frame?.alt || (item.text ? item.text.slice(0, 120) : t(locale, "drawerFrameNumber", { n: slot.position + 1 }))
        })
      ]);
      tailKids = [el("div", { class: "sl-slot-cap" }, reads.frameLabel(frame))];
    } else if (state?.status === "refused") {
      slot.frameEl.classList.remove("sl-output-frame-skel");
      const { shape, action, label, pending, pendingLabel } = reads.refusalShape(state);
      replace(slot.frameEl, [
        el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, shape.title))
      ]);
      tailKids = [
        el("div", { class: "sl-slot-cap" }, shape.body ? t(locale, shape.body) : state?.message || t(locale, "drawerMediaRefusedBody"))
      ];
      const acts = [
        action
          ? el("button", {
              type: "button",
              class: "sl-secondary sl-sm",
              disabled: pending || null,
              "aria-disabled": String(pending),
              onclick: () => reads.act(key, action)
            }, t(locale, pending ? pendingLabel : label))
          : null,
        state?.note ? el("p", { class: "sl-field-note", role: "status" }, state.note) : null
      ].filter(Boolean);
      if (acts.length) tailKids.push(el("div", { class: "sl-slot-acts" }, acts));
    } else {
      // Fetching, or not yet read: the same shimmer-and-label an arriving
      // generated page wears.
      slot.frameEl.classList.add("sl-output-frame-skel");
      replace(slot.frameEl, [el("span", { class: "sl-skel-label" }, t(locale, "drawerMediaFetching"))]);
    }
    replace(slot.tail, tailKids);
    slot.tail.hidden = tailKids.length === 0;
  }

  // Every slot is on show, so every frame reads — one `getMedia` door, one
  // read per frame, in source order.
  reads.readAll();

  return {
    node: rail,
    frameCount: frames.length,
    frameStates: reads.frameStates,
    notifyPermission: reads.notifyPermission,
    dispose: reads.dispose
  };
}
