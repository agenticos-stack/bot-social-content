// Social Localization client — the source drawer's media stage.
//
// Owns which frame of the post is showing, what each frame's read is doing
// (fetching / held / refused, plus any recovery the owner started), and the
// lifetime of the blob URLs it mints.
//
// The stage never sees a provider URL. `img-src blob: data:` with
// `connect-src 'none'` means a picture reaches this document only as bytes the
// gadget already holds, handed over through `getMedia` (SEC-004 / CON-004).

import { el, replace } from "./dom.js";
import { loadMediaAsBlobUrl } from "./rpc.js";
import { t } from "./i18n.js";

/** A length, not a percentage: a percentage max-height on a centred item cut portrait frames. */
const FRAME_MAX = "min(600px, 68dvh)";

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
 * Builds the stage for one item and starts reading its first frame.
 *
 * `options.requestGrant()` / `options.requestActivation()` resolve to the
 * host's correlated `{ outcome, message }` (`grant-request.js` vocabulary).
 * `options.refreshSources()` is the owner's deliberate re-scan.
 * `options.recheckPermission()` (F2) is the owner's explicit "Check again"
 * on an unconfirmed-permission frame — a plain metadata read, never
 * `getMedia`, resolving to `{ state }`.
 *
 * `notifyPermission({ state })` (F2) is how the caller — never this module —
 * reports a fresh `metered_fetch` consent read, taken after an unprompted
 * host notice. This stage never reads permission metadata on its own
 * initiative and never infers consent from the notice itself. None of these
 * reads media; only a confirmed `activated` (or the owner's own click) leads
 * to a read, and only of the frame that asked.
 *
 * Returns `{ node, strip, frameCount, frameStates, notifyPermission, dispose }`.
 */
export function createMediaStage(rpc, item, locale, options = {}) {
  const frames = framesOf(item);
  const urls = new Map();      // media id -> blob URL
  const facts = new Map();     // media id -> { total }
  const states = new Map();    // media id -> { status, code, message, action, note }
  const inFlight = new Map();  // media id -> { token, promise }
  let tokens = 0;
  let index = 0;
  let live = true;

  const surface = el("div", { class: "sl-stage-surface" });
  const kindChip = el("span", { class: "sl-stage-chip sl-stage-kind" });
  const countChip = el("span", { class: "sl-stage-chip sl-stage-count" });
  const stage = el("div", { class: "sl-stage" }, [surface, kindChip, countChip]);
  const strip = el("div", { class: "sl-stage-strip", role: "tablist", "aria-label": t(locale, "drawerFrames") });
  const readNote = el("p", { class: "sl-stage-read", role: "status" });

  const keyAt = (at) => (frames[at] ? String(frames[at].id) : "");
  const isCurrent = (key) => live && keyAt(index) === key;

  function showFetching() {
    replace(surface, [
      el("div", { class: "sl-stage-state" }, [
        el("div", { class: "sl-stage-skeleton", "aria-hidden": "true" }),
        el("p", null, t(locale, "drawerMediaFetching"))
      ])
    ]);
  }

  function showRefusal(key) {
    const state = states.get(key);
    const shape = REFUSALS[state?.code] ?? DEFAULT_REFUSAL;
    // F2: an absent-consent read disables a permission-related action
    // outright — the read is authoritative, and a stale "Activate" pointed
    // at a grant that is gone would just fail again. `null` here means no
    // button at all, never a permanently-disabled one nobody can recover
    // from: a later `notifyPermission({ state: "granted" })` clears the flag
    // and restores it.
    const action = shape.action === "refresh" && typeof options.refreshSources !== "function" ? "retry" : shape.action;
    const label = shape.action === "refresh" && action === "retry" ? "drawerMediaCheckAgain" : shape.label;
    const pending = Boolean(state?.action);
    const pendingLabel = state?.action === "grant" ? "drawerMediaWaitingGrant" : state?.action === "activate" ? "drawerMediaStarting" : "drawerMediaFetching";
    replace(surface, [
      el("div", { class: "sl-stage-state", "aria-busy": String(pending) }, [
        el("strong", null, t(locale, shape.title)),
        el("p", null, shape.body ? t(locale, shape.body) : state?.message || t(locale, "drawerMediaRefusedBody")),
        state?.note ? el("p", { role: "status" }, state.note) : null,
        action
          ? el("button", {
              type: "button",
              class: "sl-stage-retry",
              disabled: pending,
              "aria-disabled": String(pending),
              onclick: () => act(key, action)
            }, t(locale, pending ? pendingLabel : label))
          : null
      ])
    ]);
  }

  function showEmpty() {
    stage.classList.add("sl-stage-empty");
    replace(surface, [
      el("div", { class: "sl-stage-empty-note" }, [
        el("strong", null, t(locale, "drawerMediaNoneTitle")),
        el("p", null, t(locale, "drawerMediaNoneBody"))
      ])
    ]);
  }

  function showFrame(url, frame) {
    replace(surface, [
      el("img", {
        class: "sl-stage-img",
        src: url,
        alt: item.text ? item.text.slice(0, 120) : t(locale, "drawerEyebrow"),
        style: `max-height: ${FRAME_MAX}`
      })
    ]);
    kindChip.textContent = frameLabel(frame);
  }

  /** A video is a cover image and nothing more: nothing here watched it or heard it. */
  function frameLabel(frame) {
    const parts = [t(locale, frame?.kind === "video" ? "drawerCoverOnly" : "drawerFormatImageShort")];
    const size = readableBytes(facts.get(String(frame?.id))?.total);
    if (size) parts.push(size);
    return parts.join(" · ");
  }

  function paintStates() {
    for (const [position, button] of [...strip.children].entries()) {
      const status = states.get(keyAt(position))?.status;
      const key = status === "held" ? "drawerFrameStateHeld" : status === "refused" ? "drawerFrameStateBlocked" : "drawerFrameStateUnread";
      button.setAttribute("aria-label", t(locale, key, { n: position + 1 }));
      button.setAttribute("data-state", status ?? "unread");
      button.setAttribute("aria-selected", String(position === index));
    }
    const held = [...states.values()].filter((entry) => entry.status === "held").length;
    readNote.textContent = frames.length > 1 ? t(locale, "drawerFramesRead", { read: held, total: frames.length }) : "";
  }

  function repaint(key) {
    paintStates();
    if (!isCurrent(key)) return;
    // Redrawing replaces the control the owner just used. Keep focus in the
    // stage (on its next action, else the state itself) instead of dropping it
    // to the document body.
    const doc = surface.ownerDocument;
    const hadFocus = Boolean(doc?.activeElement && doc.activeElement !== doc.body && surface.contains?.(doc.activeElement));
    if (urls.has(key)) showFrame(urls.get(key), frames[index]);
    else if (states.get(key)?.status === "refused") showRefusal(key);
    else showFetching();
    if (!hadFocus) return;
    const target = surface.querySelector?.("button:not([disabled])") ?? surface.querySelector?.(".sl-stage-state, .sl-stage-img");
    if (!target || typeof target.focus !== "function") return;
    if (target.tagName !== "BUTTON") target.setAttribute("tabindex", "-1");
    target.focus();
  }

  /**
   * One read per frame at a time. A second ask while one is running joins it
   * rather than discarding it; a completion is applied only if the stage is
   * live and the read is still the one this frame is waiting on.
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

  function show(at) {
    if (!live) return;
    if (!frames.length) { showEmpty(); return; }
    index = (at + frames.length) % frames.length;
    const frame = frames[index];
    const key = String(frame.id);
    countChip.textContent = t(locale, "drawerFrameCount", { n: index + 1, total: frames.length });
    kindChip.textContent = frameLabel(frame);
    // Navigating never re-reads: a held frame draws, a refused one keeps its
    // explanation, a running read keeps running. Only an unread frame reads.
    if (!urls.has(key) && !states.has(key)) startFetch(key);
    repaint(key);
  }

  if (frames.length > 1) {
    for (const [position] of frames.entries()) {
      const button = el("button", {
        type: "button",
        role: "tab",
        class: "sl-stage-thumb",
        "aria-selected": String(position === 0),
        "aria-label": t(locale, "drawerFrameStateUnread", { n: position + 1 }),
        onclick: () => show(position),
        onkeydown: (event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const next = (index + (event.key === "ArrowRight" ? 1 : -1) + frames.length) % frames.length;
          show(next);
          const target = strip.children[next];
          if (target && typeof target.focus === "function") target.focus();
        }
      }, [el("span", { class: "sl-stage-thumb-n" }, String(position + 1))]);
      strip.appendChild(button);
    }
    stage.appendChild(el("button", {
      type: "button", class: "sl-stage-nav sl-stage-prev",
      "aria-label": t(locale, "drawerFramePrev"), onclick: () => show(index - 1)
    }, "‹"));
    stage.appendChild(el("button", {
      type: "button", class: "sl-stage-nav sl-stage-next",
      "aria-label": t(locale, "drawerFrameNext"), onclick: () => show(index + 1)
    }, "›"));
    stage.appendChild(readNote);
  }

  if (frames.length) show(0);
  else showEmpty();

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
    node: stage,
    strip: frames.length > 1 ? strip : null,
    frameCount: frames.length,
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
