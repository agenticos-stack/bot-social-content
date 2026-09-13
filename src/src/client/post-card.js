// The post card — ONE component both tabs render.
//
// Sources cards and Content cards deliberately share this shape so the two
// tabs scan the same way: a cover slot (bytes-only `blob:` image filled after
// mount), a kicker for the source label, a snapshot line, meta, and optional
// affordances (selection checkbox on Sources, state chip on Content). The
// variant lives in the card view-model the caller builds, not in a second
// DOM builder — two drifting card components is what this file exists to
// prevent.
import { el } from "./dom.js";
import { t } from "./i18n.js";

/**
 * REQ-016 — the mark comes from the glyph key the DOOR reports, never from a
 * table of providers kept here.
 *
 * A hardcoded `instagram -> "IG", facebook -> "FB"` is a second copy of the
 * provider registry living where it cannot see the registry change: the day
 * a third provider is pinned, this file silently renders a bullet for it and
 * nobody finds out until someone looks at the screen. The key is also set as
 * `data-glyph`, so a real brand mark can be styled per provider without this
 * function learning any provider's name.
 *
 * The provider fallback stays for the one case the requirement allows: a door
 * that reported nothing at all.
 */
export function glyphKeyFor(item, sources) {
  const source = Array.isArray(sources) ? sources.find((row) => row.binding === item.sourceBinding) : null;
  return typeof source?.glyphKey === "string" && source.glyphKey.trim() ? source.glyphKey.trim() : null;
}

export function providerGlyph(item, sources) {
  const glyphKey = glyphKeyFor(item, sources);
  if (glyphKey) return glyphKey.slice(0, 2).toUpperCase();
  return item.provider === "instagram" ? "IG" : item.provider === "facebook" ? "FB" : "•";
}

export function sourceLabel(locale, item) {
  return item.sourceLabel || (item.provider === "instagram" ? t(locale, "providerInstagram") : t(locale, "providerFacebook"));
}

/**
 * @param card — the card view-model:
 *   key            string    base for element ids (checkbox label wiring)
 *   cover          { itemId, mediaId } | null  — collected into `covers` for
 *                            the async fill; null leaves the glyph/kicker.
 *   glyphKey       string | null   door-reported mark (data-glyph attr)
 *   glyph          string          fallback text mark
 *   kicker         string          source label over the cover
 *   title          string          first line / heading
 *   body           string          snapshot text
 *   meta           Node | null     trailing meta line (Sources variant --
 *                            no chip); ignored when `chip` is set
 *   chip           { label, cls } | null  — state chip (Content variant)
 *   when           string | null   muted timestamp trailing the chip
 *                            (Content variant only, e.g. "edited 2m ago")
 *   badge          string | null   corner badge (e.g. duplicate)
 *   selectable     boolean         renders the Sources selection checkbox
 *   selected       boolean         checkbox state + selected styling
 *   onSelect       (checked) => void
 *   onOpen         () => void      the whole card's open affordance
 *   ariaLabel      string
 * @param covers — collector: [{slot, itemId, mediaId}] filled by fillCovers
 */
export function renderPostCard(locale, card, covers) {
  let coverSlot = null;
  const selectbox = card.selectable
    ? el("label", { class: "sl-selectbox", for: `sl-check-${card.key}` }, [
        el("input", {
          type: "checkbox",
          id: `sl-check-${card.key}`,
          class: "sl-post-check",
          checked: !!card.selected,
          "aria-label": card.ariaLabel || card.title || "post",
          onchange: (event) => card.onSelect?.(event.currentTarget.checked)
        })
      ])
    : null;

  const openButton = el(
    "button",
    { type: "button", class: "sl-post-open", "aria-label": card.ariaLabel || card.title || "post", onclick: () => card.onOpen?.() },
    [
      (coverSlot = el("span", { class: "sl-media" }, [
        el("span", { class: "sl-provider-glyph", "data-glyph": card.glyphKey || "" }, card.glyph || ""),
        el("span", { class: "sl-media-kicker" }, card.kicker || "")
      ])),
      el("span", { class: "sl-post-body" }, [
        el("strong", null, card.title || ""),
        // Callers dedupe a body that would only repeat the title (defect
        // 5) by passing "" -- an empty <p> would still hold its own fixed
        // height, so it is dropped rather than rendered blank.
        card.body ? el("p", null, card.body) : null,
        // The Content variant's chip and its trailing timestamp share one
        // row (defect-adjacent to 5: two separate lines said less than one
        // together); the Sources variant has no chip and keeps its own
        // meta line untouched.
        card.chip
          ? el("span", { class: "sl-card-foot" }, [
              el("span", { class: `sl-state-chip ${card.chip.cls || ""}` }, card.chip.label),
              card.when ? el("span", { class: "sl-card-when" }, card.when) : null
            ])
          : card.meta ?? null
      ])
    ]
  );

  // Collected while building rather than queried for afterwards: the card
  // holds its own slot, so nothing has to find it again by selector.
  if (covers && coverSlot && card.cover) covers.push({ slot: coverSlot, itemId: card.cover.itemId, mediaId: card.cover.mediaId });

  const article = el("article", { class: "sl-post" }, [
    selectbox,
    openButton,
    card.badge ? el("span", { class: "sl-duplicate-badge" }, card.badge) : null
  ]);
  article.classList.toggle("sl-post-selected", !!card.selected);
  return article;
}

/*
 * Grid covers: the canvas is served `img-src blob: data:` with
 * `connect-src 'none'`, so a cover cannot be a remote URL however convenient
 * that would be — it has to be bytes the gadget already holds, handed over
 * as a `blob:`. Cards only mark WHICH media they want; `fillCovers` draws it
 * afterwards, because the fetch is asynchronous and a grid must not wait on
 * fifteen of them before it appears.
 *
 * `COVER_FETCHES` matches the host's bounded call pool — asking for more
 * would only rebuild the queue on the other side of the wire. Workers share
 * one queue, so a slow cover holds up only itself.
 */
const COVER_FETCHES = 4;

export async function fillCovers(covers, loadCover) {
  const queue = [...covers];
  const draw = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { slot, itemId, mediaId } = next;
      try {
        const url = await loadCover(itemId, mediaId);
        if (url) slot.appendChild(el("img", { class: "sl-media-cover", src: url, alt: "", decoding: "async" }));
      } catch (error) {
        // A cover that cannot be fetched is not an error to put on the card: it
        // keeps the provider glyph it already had, which is what a post with no
        // media looks like anyway. But a silent `catch {}` here is how nine
        // timed-out covers looked identical to nine posts without pictures, so
        // the reason goes to the console where whoever is developing the gadget
        // can read it. `getMedia`'s refusal codes carry the same reason to the
        // preview dialog, where an owner sees it.
        console.warn(`cover ${itemId} ${mediaId}: ${error && error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_FETCHES, queue.length) }, draw));
}
