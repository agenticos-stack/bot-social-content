// Social Localization client — the source drawer's media stage.
//
// Split out of client.js because it owns three things that were tangled
// together there and each got one of them wrong: which frame of the post is
// showing, what the stage is doing right now (fetching / showing / refused),
// and the lifetime of the blob URLs it mints.
//
// The stage never sees a provider URL. `img-src blob: data:` with
// `connect-src 'none'` means a picture reaches this document only as bytes the
// gadget already holds, handed over through `getMedia` (SEC-004 / CON-004).

import { el, replace } from "./dom.js";
import { loadMediaAsBlobUrl } from "./rpc.js";
import { t } from "./i18n.js";

/**
 * How tall a frame may draw, as a LENGTH.
 *
 * A percentage max-height on a centred flex or grid item resolves against a
 * containing block that depends on the item, which cut a band out of the
 * middle of portrait frames. A length cannot fail that way.
 */
const FRAME_MAX = "min(600px, 68dvh)";

/** Bytes as an owner would say them. `getMedia` reports the exact count. */
function readableBytes(total) {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${Math.round(total / 1024)} KB`;
  return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

/** One post's frames, in the order the provider listed them. */
function framesOf(item) {
  const list = Array.isArray(item?.media) ? item.media : [];
  return list.filter((entry) => entry && entry.id !== undefined && entry.id !== null);
}

/**
 * What a refused frame offers, chosen from the server's `code` — never from
 * its sentence. Permission and activation are different owner situations: one
 * needs a yes, the other already has one and needs the session to start.
 * A gone source is explained, not retried. An uncertain answer is re-checked
 * without claiming anything was denied.
 */
const REFUSALS = {
  fetch_permission_required: { title: "drawerMediaPermissionTitle", body: "drawerMediaPermissionBody", action: "grant", label: "drawerMediaGrant" },
  fetch_activation_failed: { title: "drawerMediaActivationTitle", body: "drawerMediaActivationBody", action: "recheck", label: "drawerMediaActivationRetry" },
  fetch_transient: { title: "drawerMediaTransientTitle", body: null, action: "retry", label: "drawerMediaRetry" },
  source_unavailable: { title: "drawerMediaUnavailableTitle", body: "drawerMediaUnavailableBody", action: "retry", label: "drawerMediaCheckAgain" },
  fetch_uncertain: { title: "drawerMediaUncertainTitle", body: "drawerMediaUncertainBody", action: "retry", label: "drawerMediaCheckAgain" }
};
const DEFAULT_REFUSAL = { title: "drawerMediaRefusedTitle", body: null, action: "retry", label: "drawerMediaRetry" };

/**
 * Builds the stage for one item and starts fetching its first frame.
 *
 * `options.onGrantFetch()` asks the host for public-fetch consent (the canvas
 * only asks; the host confirms). `options.onRecheck()` re-reads the runtime's
 * door status. Neither fetches anything by itself.
 *
 * Returns `{ node, strip, frameCount, onDoorsChanged, frameStates, dispose }`.
 * `onDoorsChanged()` retries ONLY the frame the owner asked permission for,
 * and only when it is still waiting on that answer — never every frame of the
 * carousel, because each one is a metered read.
 */
export function createMediaStage(rpc, item, locale, options = {}) {
  const frames = framesOf(item);
  const urls = new Map();     // media id -> blob URL, for frames already fetched
  const facts = new Map();    // media id -> { total }, reported by getMedia
  const states = new Map();   // media id -> { status: "fetching"|"held"|"refused", code, message }
  const inFlight = new Map(); // media id -> promise, so a re-click does not refetch
  let index = 0;
  let live = true;
  let awaitingGrantFor = null;

  const surface = el("div", { class: "sl-stage-surface" });
  const kindChip = el("span", { class: "sl-stage-chip sl-stage-kind" });
  const countChip = el("span", { class: "sl-stage-chip sl-stage-count" });
  const stage = el("div", { class: "sl-stage" }, [surface, kindChip, countChip]);
  const strip = el("div", { class: "sl-stage-strip", role: "tablist", "aria-label": t(locale, "drawerFrames") });
  const readNote = el("p", { class: "sl-stage-read", role: "status" });

  function showFetching() {
    replace(surface, [
      el("div", { class: "sl-stage-state" }, [
        el("div", { class: "sl-stage-skeleton", "aria-hidden": "true" }),
        el("p", null, t(locale, "drawerMediaFetching"))
      ])
    ]);
  }

  function showRefusal(key, code, message) {
    const shape = REFUSALS[code] ?? DEFAULT_REFUSAL;
    const waiting = awaitingGrantFor === key;
    const run = () => {
      if (shape.action === "grant") {
        awaitingGrantFor = key;
        options.onGrantFetch?.();
        showRefusal(key, code, message);
        return;
      }
      if (shape.action === "recheck") {
        awaitingGrantFor = key;
        Promise.resolve(options.onRecheck?.()).finally(() => retry(key));
        return;
      }
      retry(key);
    };
    replace(surface, [
      el("div", { class: "sl-stage-state" }, [
        el("strong", null, t(locale, shape.title)),
        el("p", null, shape.body ? t(locale, shape.body) : message || t(locale, "drawerMediaRefusedBody")),
        waiting && shape.action === "grant"
          ? el("p", { role: "status" }, t(locale, "drawerMediaWaitingGrant"))
          : null,
        el("button", { type: "button", class: "sl-stage-retry", onclick: run }, t(locale, shape.label))
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

  /**
   * What this frame is. A video is a cover image and nothing more: the stage
   * draws a still, and nothing here (or in the agent) has watched the motion
   * or heard the audio, so the label says so rather than "video".
   */
  function frameLabel(frame) {
    const parts = [t(locale, frame?.kind === "video" ? "drawerCoverOnly" : "drawerFormatImageShort")];
    const size = readableBytes(facts.get(String(frame?.id))?.total);
    if (size) parts.push(size);
    return parts.join(" · ");
  }

  /** The strip and the read count say which frames this session actually holds. */
  function paintStates() {
    for (const [position, button] of [...strip.children].entries()) {
      const state = states.get(String(frames[position]?.id))?.status;
      const key = state === "held" ? "drawerFrameStateHeld" : state === "refused" ? "drawerFrameStateBlocked" : "drawerFrameStateUnread";
      button.setAttribute("aria-label", t(locale, key, { n: position + 1 }));
      button.setAttribute("data-state", state ?? "unread");
      button.setAttribute("aria-selected", String(position === index));
    }
    const held = [...states.values()].filter((entry) => entry.status === "held").length;
    readNote.textContent = frames.length > 1 ? t(locale, "drawerFramesRead", { read: held, total: frames.length }) : "";
  }

  function retry(key) {
    inFlight.delete(key);
    states.delete(key);
    const at = frames.findIndex((frame) => String(frame.id) === key);
    if (at >= 0) show(at);
  }

  async function show(at) {
    if (!frames.length) { showEmpty(); return; }
    index = (at + frames.length) % frames.length;
    const frame = frames[index];
    const key = String(frame.id);
    countChip.textContent = t(locale, "drawerFrameCount", { n: index + 1, total: frames.length });
    paintStates();

    if (urls.has(key)) { showFrame(urls.get(key), frame); return; }
    const known = states.get(key);
    kindChip.textContent = frameLabel(frame);
    // A refused frame stays refused until the owner acts — moving between
    // frames must not quietly spend another metered read.
    if (known?.status === "refused") { showRefusal(key, known.code, known.message); return; }
    showFetching();

    if (!inFlight.has(key)) {
      states.set(key, { status: "fetching" });
      inFlight.set(key, loadMediaAsBlobUrl(rpc, item.id, key, "preview"));
    }
    const requested = index;
    try {
      const { url, total } = await inFlight.get(key);
      if (!live) { URL.revokeObjectURL(url); return; }
      urls.set(key, url);
      facts.set(key, { total });
      states.set(key, { status: "held" });
      if (awaitingGrantFor === key) awaitingGrantFor = null;
      paintStates();
      if (index === requested) showFrame(url, frame);
    } catch (error) {
      inFlight.delete(key);
      if (!live) return;
      const code = error && typeof error === "object" ? error.code ?? null : null;
      const message = error instanceof Error ? error.message : String(error);
      states.set(key, { status: "refused", code, message });
      paintStates();
      if (index !== requested) return;
      showRefusal(key, code, message);
    }
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
    // Beside the frames, not among them: the strip holds one control per frame.
    stage.appendChild(readNote);
  }

  if (frames.length) show(0);
  else showEmpty();

  return {
    node: stage,
    strip: frames.length > 1 ? strip : null,
    frameCount: frames.length,
    /** Consent or activation changed: retry the one frame waiting on it, nothing else. */
    onDoorsChanged() {
      if (!live || !awaitingGrantFor) return false;
      const key = awaitingGrantFor;
      const state = states.get(key);
      if (state?.status !== "refused") return false;
      retry(key);
      return true;
    },
    frameStates() {
      return frames.map((frame) => ({ id: String(frame.id), status: states.get(String(frame.id))?.status ?? "unread" }));
    },
    dispose() {
      live = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    }
  };
}
