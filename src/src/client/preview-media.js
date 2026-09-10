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
 * The rule this replaces was `height: clamp(140px, 28dvh, 260px)` on the
 * container with `width/height: 100%` on the image, and it did not do what it
 * reads like: the image kept its intrinsic ratio (measured live at 589x1045
 * inside a 591x246 box), `object-fit: contain` never had anything to fit, and
 * the container's `overflow: hidden` cut a band out of the middle. Nine of the
 * twelve posts a real account produced are portrait, so the band was usually a
 * horizontal slice through the subject's face.
 *
 * A percentage max-height on a centred flex or grid item resolves against a
 * containing block that depends on the item, which is exactly how that
 * happened. A length cannot fail that way, so the cap is stated in `px` and
 * `dvh` and the stage sizes itself around it.
 */
const FRAME_MAX = "min(520px, 62dvh)";

/** Bytes as an owner would say them. `getMedia` reports the exact count. */
function readableBytes(total) {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${Math.round(total / 1024)} KB`;
  return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One post's frames, in the order the provider listed them.
 *
 * `item.media[0]` was the whole of this. Two of the twelve posts in a real
 * account are carousels of three and five frames, and the owner was choosing
 * between posts by looking at the first frame of each.
 */
function framesOf(item) {
  const list = Array.isArray(item?.media) ? item.media : [];
  return list.filter((entry) => entry && entry.id !== undefined && entry.id !== null);
}

/**
 * Builds the stage for one item and starts fetching its first frame.
 *
 * Returns `{ node, strip, dispose }`. `dispose()` revokes every blob URL this
 * stage minted — one per frame that was actually fetched, not one per stage,
 * which is what the single `activePreviewBlobUrl` in client.js could hold.
 */
export function createMediaStage(rpc, item, locale) {
  const frames = framesOf(item);
  const urls = new Map();     // media id -> blob URL, for frames already fetched
  const facts = new Map();    // media id -> { total, mime }, reported by getMedia
  const inFlight = new Map(); // media id -> promise, so a re-click does not refetch
  let index = 0;
  let live = true;

  const surface = el("div", { class: "sl-stage-surface" });
  const kindChip = el("span", { class: "sl-stage-chip sl-stage-kind" });
  const countChip = el("span", { class: "sl-stage-chip sl-stage-count" });
  const stage = el("div", { class: "sl-stage" }, [surface, kindChip, countChip]);
  const strip = el("div", { class: "sl-stage-strip", role: "tablist", "aria-label": t(locale, "drawerFrames") });

  /*
   * FETCHING IS NOT UNAVAILABLE.
   *
   * This drawer used to be built holding the sentence "Preview not available"
   * and only replaced it when the bytes arrived, with a bare
   * `.catch(console.error)` behind it. A fetch in progress, a fetch that
   * failed, and a post with no picture at all were three different things
   * rendering as one — and the one they rendered as was a lie about two of
   * them. Each has its own state here, and a refusal carries the sentence
   * `getMedia` returned rather than a generic one.
   */
  function showFetching() {
    replace(surface, [
      el("div", { class: "sl-stage-state" }, [
        el("div", { class: "sl-stage-skeleton", "aria-hidden": "true" }),
        el("p", null, t(locale, "drawerMediaFetching"))
      ])
    ]);
  }

  function showRefusal(message) {
    replace(surface, [
      el("div", { class: "sl-stage-state" }, [
        el("strong", null, t(locale, "drawerMediaRefusedTitle")),
        el("p", null, message || t(locale, "drawerMediaRefusedBody")),
        el("button", {
          type: "button",
          class: "sl-stage-retry",
          onclick: () => { inFlight.delete(frameKey(index)); show(index); }
        }, t(locale, "drawerMediaRetry"))
      ])
    ]);
  }

  function showEmpty() {
    replace(surface, [
      el("div", { class: "sl-stage-state" }, [
        el("strong", null, t(locale, "drawerMediaNoneTitle")),
        el("p", null, t(locale, "drawerMediaNoneBody"))
      ])
    ]);
  }

  /*
   * The frame, whole, on a neutral ground.
   *
   * The blurred copy behind it is the same blob — no second fetch — and exists
   * so a 9:16 reel does not sit between two empty panels. It is decorative and
   * `aria-hidden`; the readable image is the one in front.
   */
  function showFrame(url, frame) {
    const picture = el("img", {
      class: "sl-stage-img",
      src: url,
      alt: item.text ? item.text.slice(0, 120) : t(locale, "drawerEyebrow"),
      style: `max-height: ${FRAME_MAX}`
    });
    replace(surface, [
      el("img", { class: "sl-stage-backdrop", src: url, alt: "", "aria-hidden": "true" }),
      picture
    ]);
    kindChip.textContent = frameLabel(frame);
  }

  function frameKey(at) {
    const frame = frames[at];
    return frame ? String(frame.id) : "";
  }

  /** What this frame is, in the provider's own terms plus what was fetched. */
  function frameLabel(frame) {
    const parts = [];
    if (frame?.kind === "video") parts.push(t(locale, "drawerStillFrame"));
    else parts.push(t(locale, "drawerFormatImageShort"));
    const size = readableBytes(facts.get(String(frame?.id))?.total);
    if (size) parts.push(size);
    return parts.join(" · ");
  }

  async function show(at) {
    if (!frames.length) { showEmpty(); return; }
    index = (at + frames.length) % frames.length;
    const frame = frames[index];
    const key = String(frame.id);
    countChip.textContent = t(locale, "drawerFrameCount", { n: index + 1, total: frames.length });
    for (const [position, button] of [...strip.children].entries()) {
      button.setAttribute("aria-selected", String(position === index));
    }

    if (urls.has(key)) { showFrame(urls.get(key), frame); return; }
    kindChip.textContent = frameLabel(frame);
    showFetching();

    if (!inFlight.has(key)) {
      inFlight.set(key, loadMediaAsBlobUrl(rpc, item.id, key, "preview"));
    }
    const requested = index;
    try {
      const { url, total } = await inFlight.get(key);
      if (!live) { URL.revokeObjectURL(url); return; }
      urls.set(key, url);
      facts.set(key, { total });
      // The owner may have moved on while this was in flight; keep the bytes,
      // draw only if this is still the frame on screen.
      if (index === requested) showFrame(url, frame);
    } catch (error) {
      inFlight.delete(key);
      if (!live || index !== requested) return;
      showRefusal(error instanceof Error ? error.message : String(error));
    }
  }

  /*
   * The strip says which frames the gadget is holding.
   *
   * Each frame is its own round trip through the door, so a five-frame
   * carousel is five fetches and they are not made up front. A frame that has
   * not been fetched says so rather than showing an empty box that reads like
   * a frame with nothing in it.
   */
  if (frames.length > 1) {
    for (const [position, frame] of frames.entries()) {
      const button = el("button", {
        type: "button",
        role: "tab",
        class: "sl-stage-thumb",
        "aria-selected": String(position === 0),
        "aria-label": t(locale, "drawerFrameNumber", { n: position + 1 }),
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
  }

  if (frames.length) show(0);
  else showEmpty();

  return {
    node: stage,
    strip: frames.length > 1 ? strip : null,
    frameCount: frames.length,
    dispose() {
      live = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    }
  };
}
