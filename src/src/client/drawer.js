// The single-post "Saved draft" drawer — its four sections as pure
// renderers over one projected batch item.
//
// `client.js` owns the session (rpc, buffers, dialog, focus); this module
// only turns an item plus the owner's unsaved buffers into DOM and into the
// exact payloads a save sends. Nothing here reads `globalThis.gadget`, so a
// minimal DOM can render every section in a unit test.
//
// Output first (the accepted generated image and the caption), then the
// labelled reference, the instructions this post generates from, and the
// history of versions, requests and deliveries. States come from the
// projection only: a request is "waiting" until the item says otherwise, and
// no failure is ever shown that the projection did not report.

import { el, replace } from "./dom.js";
import { confirmDrawerChoice as confirmDrawerChoiceShared } from "@agenticos-dev/bot-shell/client/drawer.js";
import { t } from "./i18n.js";
import { CAROUSEL_PROVIDERS, JPEG_ONLY_PROVIDERS } from "./image-acceptance.js";
import { computePosterLayout, drawPoster } from "./poster.js";
import { defaultRevisionPages, effectiveRevisionPages, generationMark, MAX_PAGES_PER_POST } from "../../model.js";

export const DRAWER_TABS = Object.freeze(["output", "reference", "instructions", "history"]);

const TAB_LABEL_KEYS = {
  output: "drawerTabOutput",
  reference: "drawerTabReference",
  instructions: "drawerTabInstructions",
  history: "drawerTabHistory"
};

export const drawerTabId = (key) => `sl-drawer-tab-${key}`;
export const drawerPanelId = (key) => `sl-drawer-panel-${key}`;
export const DRAWER_FOOTER_HINT_ID = "sl-drawer-footer-hint";

/**
 * An ARIA tablist: one tab stop, arrow keys / Home / End move between tabs
 * (automatic activation), and each tab controls its panel by id.
 */
export function renderDrawerTablist(locale, { active, onSelect }) {
  const select = (key) => onSelect(key, { focus: true });
  return el(
    "div",
    { class: "sl-drawer-tablist", role: "tablist", "aria-label": t(locale, "drawerTabsLabel") },
    DRAWER_TABS.map((key, index) =>
      el(
        "button",
        {
          type: "button",
          role: "tab",
          id: drawerTabId(key),
          "aria-controls": drawerPanelId(key),
          "aria-selected": String(key === active),
          tabindex: key === active ? "0" : "-1",
          onclick: () => onSelect(key, { focus: false }),
          onkeydown: (event) => {
            const last = DRAWER_TABS.length - 1;
            const next =
              event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
              : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
              : event.key === "Home" ? 0
              : event.key === "End" ? last
              : null;
            if (next === null) return;
            event.preventDefault?.();
            select(DRAWER_TABS[next]);
          }
        },
        t(locale, TAB_LABEL_KEYS[key])
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Buffers: what the owner changed and has not saved
// ---------------------------------------------------------------------------

/**
 * `buffers` = `{ caption?: string, altText?: string, imageId?: string, visualMode?: string, instructions?: { image?, caption? } }`
 * for ONE item. Returns which parts differ from the saved item.
 * `defaults` is the workspace instruction defaults (`instructionDefaultsOf`),
 * needed because an instruction field is prefilled with the text that would
 * be used — a draft equal to that prefill is unchanged, not an override.
 */
export function dirtyParts(item, buffers = {}, defaults = {}) {
  const caption = buffers.caption !== undefined && buffers.caption !== (item?.caption || "");
  const altText = buffers.altText !== undefined && buffers.altText !== (item?.altText || "");
  const visualImage = typeof buffers.imageId === "string" && buffers.imageId !== (item?.generatedImage?.id ?? null);
  const visualMode = buffers.visualMode !== undefined && buffers.visualMode !== (item?.acceptedVisualMode ?? null);
  const visual = visualImage || visualMode;
  const pages = Array.isArray(buffers.pages) && pagesSignature(buffers.pages) !== pagesSignature(pagesOfItem(item));
  const instructions = dirtyInstructionParts(item, buffers, ["image", "caption"], defaults).length > 0;
  // No `publication`: the footer's destination picks and a chosen schedule
  // time are transient — the intent is what was pressed, never a saved field.
  return { caption, altText, visual, pages, instructions, any: caption || altText || visual || pages || instructions };
}

/** The workspace instruction defaults the fields are prefilled from. */
export function instructionDefaultsOf(policy) {
  return { image: policy?.posterPrompt ?? "", caption: policy?.contentPrompt ?? "" };
}

/**
 * Which instruction parts (of `parts`) carry an unsaved edit. A draft is
 * compared with the text the field was prefilled with — the saved override
 * when there is one, the workspace default otherwise — so retyping the
 * prefilled default verbatim is unchanged and writes no override. It must
 * also differ from the saved override: a cleared draft on a field that was
 * never overridden normalizes to the same null and is not a change.
 */
export function dirtyInstructionParts(item, buffers = {}, parts = ["image", "caption"], defaults = {}) {
  const saved = item?.instructionOverrides ?? {};
  return parts.filter((part) => {
    const draft = buffers.instructions?.[part];
    if (draft === undefined) return false;
    const prefilled = saved[part] ?? defaults[part] ?? "";
    const norm = normalizeOverride(draft);
    return norm !== normalizeOverride(prefilled) && norm !== normalizeOverride(saved[part]);
  });
}

/** The parts a pending generation request still owes, from the projection's mark. */
export function pendingParts(item) {
  const mark = generationMark(item?.generation);
  if (!mark) return [];
  return ["image", "caption"].filter((part) => mark.needs[part]);
}

/**
 * A generated caption that arrived while the owner holds an unsaved caption
 * of their own: `{ caption, revision }` when the saved caption changed under a
 * dirty buffer that differs from it, otherwise null. Never decides for the
 * owner — the buffer stays until they choose.
 */
export function captionConflictFor(previous, fresh, buffer = {}) {
  if (!fresh || buffer.caption === undefined) return null;
  const before = previous?.caption || "";
  const after = fresh.caption || "";
  if (before === after) return null;
  if (buffer.caption === before || buffer.caption === after) return null;
  return { caption: after, revision: fresh.revision ?? 0 };
}

function normalizeOverride(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/** The destination bindings recorded on the item — the picker's starting selection. */
export function recordedBindings(item) {
  return Array.isArray(item?.destinationBindings) ? item.destinationBindings.filter(Boolean) : [];
}

/**
 * The `saveRevisions` entry for this item's unsaved caption and staged image,
 * or null when neither changed. Accepting a candidate is a revision like any
 * other: `acceptedVisualMode: "ai_refinement"` pinned to that image's id.
 */
export function revisionEntryFor(item, buffers = {}) {
  const dirty = dirtyParts(item, buffers);
  if (!dirty.caption && !dirty.visual && !dirty.altText && !dirty.pages && !dirty.publication) return null;
  return {
    batchItemId: item.id,
    expectedRevision: item.revision ?? 0,
    ...(dirty.caption ? { caption: buffers.caption } : {}),
    // Pages carry their own alt text and fills — when the list itself is the
    // edit, the legacy singular fields stay out of the entry entirely.
    ...(dirty.pages ? { pages: buffers.pages.map(workingPage) } : {}),
    // An emptied alt text clears it (null); omitted carries the saved one forward.
    ...(!dirty.pages && dirty.altText ? { altText: buffers.altText.trim() ? buffers.altText : null } : {}),
    ...(!dirty.pages && dirty.visual
      ? buffers.visualMode === "keep_original"
        ? { acceptedVisualMode: "keep_original" }
        : buffers.visualMode === null
          ? { acceptedVisualMode: null }
          : { acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: buffers.imageId }
      : {})
  };
}

/**
 * The `saveInstructionOverrides` input for this item's unsaved instruction
 * edits, or null. `parts` narrows it (generation saves only the parts it is
 * about to use, leaving an unrelated edit unsaved).
 */
export function instructionPatchFor(item, buffers = {}, parts = ["image", "caption"], defaults = {}) {
  const dirty = dirtyInstructionParts(item, buffers, parts, defaults);
  if (!dirty.length) return null;
  const patch = { batchItemId: item.id };
  for (const part of dirty) patch[part] = normalizeOverride(buffers.instructions[part]);
  return patch;
}

/**
 * A small modal decision in the shared dialog: `choices` = `[{ value, label, primary? }]`.
 * Resolves to the chosen value, or `"cancel"` on Escape/close. One pending
 * decision per dialog — a second ask waits on the first.
 */
/*
 * The prompt machinery is the shared package's; this canvas's chrome is not.
 * `classes` carries the `sl-preview-*`/`sl-*` vocabulary the local stylesheet
 * owns, spelled with the `bot-*` partners the `el` adapter would have added —
 * so the emitted markup is byte-identical to the pre-extraction prompt.
 */
const CONFIRM_CLASSES = {
  sheet: "sl-preview-sheet bot-drawer-sheet",
  head: "sl-preview-head bot-drawer-head",
  body: "sl-preview-scroll bot-drawer-body",
  actions: "sl-preview-actions bot-drawer-actions",
  button: "sl-secondary bot-button",
  primary: "sl-primary bot-button"
};

export function confirmDrawerChoice(dialog, { title, body, choices }) {
  return confirmDrawerChoiceShared(dialog, { title, body, choices, classes: CONFIRM_CLASSES });
}

// ---------------------------------------------------------------------------
// Generation state, from the projection only
// ---------------------------------------------------------------------------

/**
 * The image part's state: `requested` (the mark asks for an image and nothing
 * has registered for it), `generating` (a candidate is registered, bytes not
 * arrived), `candidate_ready`, `arriving` (the accepted image's file has not
 * arrived), `ready`, or `none`.
 */
export function imageState(item) {
  const mark = generationMark(item?.generation);
  const candidate = item?.generatedCandidate ?? null;
  if (candidate && candidate.ready !== true) return "generating";
  if (candidate && candidate.ready === true) return "candidate_ready";
  if (mark?.needs.image) return "requested";
  if (item?.generatedImage) return item.generatedImage.ready === true ? "ready" : "arriving";
  return "none";
}

/** The caption part's state: `requested`, `ready` or `none`. */
export function captionState(item) {
  if (generationMark(item?.generation)?.needs.caption) return "requested";
  return typeof item?.caption === "string" && item.caption.trim() ? "ready" : "none";
}

// ---------------------------------------------------------------------------
// Footer: save / review, each with its specific reason when disabled
// ---------------------------------------------------------------------------

/**
 * Why one destination cannot take this post, said on its own option: a
 * revoked grant, a content rule the post does not meet, or a format the
 * destination cannot take. Returns the i18n key, or null when it can. A
 * recorded binding the destinations table does not describe is NOT blocked —
 * an absent row cannot prove the grant is gone, and the server adjudicates.
 */
export function destinationBlock(item, buffers, destinations, binding) {
  const row = (destinations ?? []).find((entry) => (entry.binding ?? entry.destinationBinding) === binding) ?? null;
  if (!row) return null;
  if (row.granted === false) return "publishAccessRevoked";
  const pages = workingPages(item, buffers);
  const filled = pages.filter((page) => page.kind);
  const textOnly = textOnlyPages(item, pages);
  // Instagram needs at least one image that actually ships — a generated
  // page whose bytes never landed counts for nothing.
  const shippedReady = filled.some((page) =>
    page.kind === "generated" ? generatedRowFor(item, page)?.ready === true : true
  );
  if (row.provider === "instagram" && !shippedReady) return "drawerDestIgNeedsImage";
  // An unfilled page blocks everywhere — the destination row names the block
  // and the strip numbers the slot; the last empty page of a text post is
  // the one shape that still files.
  if (pages.some((page) => !page.kind) && !textOnly) return "drawerDestEmptyPage";
  // Two or more filled pages file as ONE carousel — the destination must
  // take the album, not just an image.
  if (filled.length >= 2 && !CAROUSEL_PROVIDERS.has(row.provider)) return "drawerDestNoCarousel";
  // What actually ships: the staged page list once saved, else the saved
  // pages. Any generated page still carrying a PNG blocks a JPEG-only door —
  // re-render or pick the JPEG, the server refuses it either way.
  if (
    JPEG_ONLY_PROVIDERS.has(row.provider) &&
    filled.some((page) => page.kind === "generated" && generatedRowFor(item, page)?.mimeType === "image/png")
  ) {
    return "drawerDestNeedsJpeg";
  }
  return null;
}

/** A destination's display name from the summary table, falling back to the raw binding. */
function destinationName(destinations, binding) {
  return (destinations ?? []).find((entry) => (entry.binding ?? entry.destinationBinding) === binding)?.label ?? binding;
}

/**
 * `picked` = the picker's current selection (recorded bindings when untouched);
 * `scheduledAt` = the chosen local time once 排程… has one — its presence IS
 * the schedule intent, since the press itself carries the mode now.
 */
export function footerState(locale, item, { buffers = {}, saving = false, defaults = {}, destinations = [], picked = null, scheduledAt = null } = {}) {
  const dirty = dirtyParts(item, buffers, defaults);
  const save = saving
    ? { disabled: true, reason: t(locale, "saving") }
    : !dirty.any
      ? { disabled: true, reason: t(locale, "drawerSaveNoChanges") }
      : { disabled: false, reason: null };

  const caption = (buffers.caption ?? item?.caption ?? "").trim();
  const pages = workingPages(item, buffers);
  const emptyIndex = pages.findIndex((page) => !page.kind);
  const textOnly = textOnlyPages(item, pages);
  const filled = pages.filter((page) => page.kind);
  const arriving = filled.some((page) => page.kind === "generated" && generatedRowFor(item, page) && generatedRowFor(item, page).ready !== true);
  const img = imageState(item);
  const cap = captionState(item);
  // What the primary would actually file: the chosen set minus every option
  // that explains on its own row why it cannot take this post.
  const fileable = (picked ?? recordedBindings(item)).filter((binding) => !destinationBlock(item, buffers, destinations, binding));
  let review = { disabled: false, reason: null };
  if (saving) review = { disabled: true, reason: t(locale, "saving") };
  else if ((item?.revision ?? 0) === 0 && !caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsOutput") };
  else if (!caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsCaption") };
  else if (arriving) review = { disabled: true, reason: t(locale, "drawerReviewImageNotArrived") };
  else if (emptyIndex !== -1 && !textOnly) review = { disabled: true, reason: t(locale, "drawerReviewPageEmpty", { n: emptyIndex + 1 }) };
  else if (!filled.length && !textOnly) review = { disabled: true, reason: t(locale, "drawerReviewNeedsImage") };
  else if (img === "requested" || img === "generating") review = { disabled: true, reason: t(locale, "drawerPublishBusyImage") };
  else if (cap === "requested") review = { disabled: true, reason: t(locale, "drawerPublishBusyCaption") };
  else if (!fileable.length) review = { disabled: true, reason: t(locale, "drawerPublishNeedsDestination") };
  const primary = {
    ...review,
    label: scheduledAt
      ? t(locale, "drawerScheduleAt", { when: String(scheduledAt).replace("T", " ") })
      : fileable.length === 1
        ? t(locale, "drawerPublishToOne", { who: destinationName(destinations, fileable[0]) })
        : fileable.length > 1
          ? t(locale, "drawerPublishToMany", { n: fileable.length })
          : t(locale, "drawerPublishToOne", { who: "…" })
  };
  return { save, review, primary };
}

// ---------------------------------------------------------------------------
// 1. Output
// ---------------------------------------------------------------------------

/*
 * THE ORDERED PAGES — the unit the strip edits. One filled page publishes as
 * a single image, two or more as a carousel under one caption, one ratio and
 * one instruction. A page exists before it is filled: `kind: null` is the
 * durable empty slot a generation, an upload or a source image lands in, and
 * it blocks filing until filled or removed. A post always keeps at least one
 * page — the server refuses an empty list, so the last page's remove stays
 * disabled rather than offering a refusal.
 *
 * `pagesOfItem` reads the server's own projection. When an item predates it
 * (an older fixture), the shared derivation runs on the item's legacy fields
 * exactly as the server would; a never-saved post gets the source-bound
 * empty pages `defaultRevisionPages` describes.
 */
const WORKING_PAGE_KEYS = ["pageId", "kind", "mediaId", "sourceMediaId", "altText", "mediaDigest", "mediaProvenance", "mediaAcceptance"];

function workingPage(page) {
  return {
    pageId: page.pageId,
    kind: page.kind ?? null,
    mediaId: page.mediaId ?? null,
    sourceMediaId: page.sourceMediaId ?? null,
    altText: page.altText ?? null,
    mediaDigest: page.mediaDigest ?? null,
    mediaProvenance: page.mediaProvenance ?? null,
    mediaAcceptance: page.mediaAcceptance ?? null
  };
}

function legacyRevisionOf(item) {
  return {
    batchItemId: item?.id,
    revision: item?.revision ?? 0,
    acceptedVisualMode: item?.acceptedVisualMode ?? null,
    acceptedGeneratedMediaId: item?.generatedImage?.id ?? null,
    acceptedGeneratedMediaDigest: item?.generatedImage?.digest ?? null,
    acceptedGeneratedMediaProvenance: item?.acceptedGeneratedMediaProvenance ?? null,
    acceptanceSource: null,
    derivedMediaRefs: item?.derivedMediaRefs ?? [],
    altText: item?.altText ?? null
  };
}

export function pagesOfItem(item) {
  const raw =
    Array.isArray(item?.pages) && item.pages.length
      ? item.pages
      : (item?.revision ?? 0) > 0
        ? effectiveRevisionPages(legacyRevisionOf(item), item?.sourceItem, { hasPoster: item?.posterStored === true })
        : defaultRevisionPages(item?.sourceItem);
  return raw.map(workingPage);
}

/** The working page list — the staged edit where one exists, else the saved pages. */
export function workingPages(item, buffers = {}) {
  return Array.isArray(buffers.pages) ? buffers.pages.map(workingPage) : pagesOfItem(item);
}

function pagesSignature(pages) {
  return JSON.stringify((pages ?? []).map((page) => WORKING_PAGE_KEYS.map((key) => page[key] ?? null)));
}

/*
 * The generated row a page points at, wherever it lives in the projection —
 * the page's own `generatedMedia`, the accepted image, the candidate, or the
 * history list a staged pick came from.
 */
function generatedRowFor(item, page) {
  if (page?.kind !== "generated" || !page.mediaId) return null;
  const projected = (item?.pages ?? []).find((entry) => entry?.pageId === page.pageId)?.generatedMedia ?? null;
  if (projected?.id === page.mediaId) return projected;
  if (item?.generatedImage?.id === page.mediaId) return item.generatedImage;
  if (item?.generatedCandidate?.id === page.mediaId) return item.generatedCandidate;
  return (item?.generatedHistory ?? []).find((media) => media?.id === page.mediaId) ?? null;
}

/*
 * The text-post shape the server still files: exactly one empty page and no
 * bindable source media. Every other empty page blocks — the strip, the
 * destination list and the footer all read it through this one rule.
 */
function textOnlyPages(item, pages) {
  if (pages.length !== 1 || pages[0].kind) return false;
  return !(item?.sourceItem?.media ?? []).some((entry) => typeof entry?.id === "string" && entry.id);
}

/**
 * The one-tap answers the regenerate conversation offers — the client's copy
 * keys, resolved to the owner's language and carried on the agent intent so
 * any host can render the same chips without knowing this gadget's strings.
 */
export const REGEN_SUGGESTION_KEYS = Object.freeze(["drawerRegenC1", "drawerRegenC2", "drawerRegenC3", "drawerRegenC4", "drawerRegenC5"]);

/*
 * ONE SHAPE FOR BOTH TABS. Every column opens with the same label row — the
 * label on the left, its one quiet action on the right — then its content.
 * 帖文 and 參考 are then the same panel with different nouns in it, sharing
 * `.sl-cols`'s media-column width so switching tabs never reflows the sheet.
 */
function columnLabel(text, action, id = null) {
  return el("div", { class: "sl-collabel" }, [
    el("span", { class: "sl-field-label sl-grow", id }, text),
    action || null
  ].filter(Boolean));
}

/**
 * ctx: `{ editable, saving, buffers, loadImage(generated, img, onFail), highlighted,
 * noteRef(el), onCaptionInput(value), onAltTextInput(value), onStageImage(id|null),
 * onRequestPart("image"|"caption"), onReacceptImage(id), onAdoptUpload(),
 * imageBrief?: { useSource, ratio, oneOffOpen, oneOff, saveOneOff },
 * imageRefsAvailable?: bool, uploadPreview?: { name },
 * captionConflict?: { caption }, onResolveCaptionConflict("keep"|"use"),
 * strip?: { menuOpen, menuAnchor (the open ⋯ menu's pageId), agentIntent
 *   (host can carry an image intent into the conversation),
 *   dismissedCandidates (Set of candidate ids), onToggleMenu(pageId),
 *   onAddPage(), onMenuGenerate(slot), onMenuUpload(slot),
 *   onMenuAdoptSource(slot, sourceMediaId), onRegenIntent(slot),
 *   onRemoveSlot(slot), onViewSlot(slot), onDismissCandidate(candidateId) } }`.
 *
 * `buffers` = `{ caption?, altText?, pages?, imageSource?, instructions?,
 * imageBrief? }` — `pages` is the staged working page list (`{ pageId, kind,
 * mediaId, sourceMediaId, altText }`) until Save; `imageBrief` stages the
 * NEXT Generate ask and is never part of a Save.
 */
export function renderOutputPanel(locale, item, ctx) {
  const buffers = ctx.buffers ?? {};
  const editable = ctx.editable === true;
  const imgState = imageState(item);
  const capState = captionState(item);
  const unsubmitted = ctx.unsubmitted === true;
  // "Saved but never submitted" is not live work: its slots stay usable and
  // the add-page tile stays pressable — the status line names why instead.
  const imageBusy = (imgState === "requested" || imgState === "generating") && !unsubmitted;
  const strip = ctx.strip ?? {};
  const brief = ctx.imageBrief ?? { useSource: true, ratio: "4:5", oneOff: "", saveOneOff: false };
  const refsAvailable = ctx.imageRefsAvailable === true;
  const uploadPreview = ctx.uploadPreview ?? null;
  // The working page list — the saved pages, or the staged edit while one
  // is buffered. One filled page files as a single image; two or more as
  // one carousel. An empty page is a slot that still needs its image.
  const pages = workingPages(item, buffers);
  const skippedVideos = item?.skippedVideos ?? [];

  // One request at a time per post: while a part is outstanding, the OTHER
  // part's affordance says what is pending — never a silent replace.
  const outstanding = pendingParts(item);
  const figure = (generated, { extra = "", legacy = null, skel = false } = {}) => {
    const frame = el("div", { class: ["sl-output-frame", extra || null, skel ? "sl-output-frame-skel" : null].filter(Boolean).join(" ") });
    if (generated?.ready === true) {
      const img = el("img", { class: "sl-pc-canvas", alt: generated.altText || t(locale, "drawerGeneratedImageAlt") });
      frame.appendChild(img);
      ctx.loadImage?.(generated, img, () => {
        img.replaceWith(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerGeneratedImageFailed")));
      });
    } else if (generated) {
      frame.appendChild(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerImageArriving")));
    } else if (legacy) {
      frame.appendChild(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, legacy === "source" ? "drawerHistoryVisualSource" : "drawerHistoryVisualPoster")));
    } else if (!skel) {
      frame.appendChild(el("span", { class: "sl-pc-media-empty sl-output-empty", role: "status" }, t(locale, "drawerImageNone")));
    }
    if (skel) frame.appendChild(el("span", { class: "sl-skel-label" }, t(locale, "drawerCandidatePending")));
    return frame;
  };

  const facts = (generated) => {
    if (!generated) return null;
    const lines = [];
    if (generated.altText) lines.push(t(locale, "drawerGeneratedAlt", { alt: generated.altText }));
    if (generated.mimeType) lines.push(t(locale, "drawerImageFormat", { format: formatLabel(generated.mimeType) }));
    return lines.length ? el("p", { class: "sl-field-note" }, lines.join(" · ")) : null;
  };

  /*
   * THE STRIP — one slot per page, in page order. Every action on a page
   * lives on the page itself: one ⋯ opens that page's menu, so nothing
   * per-image sits in the column header. An empty page is a real slot — the
   * dashed frame that blocks filing, numbered like the rest. Generating
   * overlays the slot's own frame, so a request never reads as a second
   * tile, and a live slot carries no ⋯: a second ask during a live one is
   * the double spend the regenerate conversation exists to prevent.
   */
  const menuRow = (title, sub, onclick, disabled = false, warn = false, itemCls = null) =>
    el("button", { type: "button", role: "menuitem", class: `sl-menu-item${itemCls ? ` ${itemCls}` : ""}`, disabled: disabled || null, onclick }, [
      el("span", { class: "sl-menu-lead" }, title),
      sub ? el("span", { class: `sl-menu-sub${warn ? " sl-menu-warn" : ""}` }, sub) : null
    ]);

  const sourceImages = (item?.sourceItem?.media ?? []).filter(
    (media) => (media?.kind === "image" || media?.kind === "carousel_child") && typeof media?.id === "string" && media.id
  );
  const needsPages = new Set(generationMark(item?.generation)?.needs?.imagePages ?? []);
  // A mark written before page scope exists (needs.image with no imagePages)
  // names "the image" — every page is its unambiguous target, so every slot
  // is live while it runs.
  const unscopedImageNeed = Boolean(generationMark(item?.generation)?.needs?.image) && !needsPages.size;
  const projectedPages = new Map((item?.pages ?? []).map((entry) => [entry.pageId, entry]));
  const savedPages = new Map(pagesOfItem(item).map((entry) => [entry.pageId, entry]));
  const dismissed = strip.dismissedCandidates ?? null;

  const slots = pages.map((page, index) => {
    const projected = projectedPages.get(page.pageId) ?? null;
    const generated = generatedRowFor(item, page);
    const sourceChild = page.kind === "original" ? (item?.sourceItem?.media ?? []).find((media) => media?.id === page.mediaId) ?? null : null;
    // The page's own proposal, projected under it; on a one-page post the
    // legacy post-level `generatedCandidate` is the same row, so it stands
    // in for canvases whose projection predates per-page candidates (and
    // for a live arrival the read brought in after open).
    let candidate = projected?.candidate && projected.candidate.id !== page.mediaId ? projected.candidate : null;
    if (!candidate && pages.length === 1 && item?.generatedCandidate && item.generatedCandidate.id !== page.mediaId) {
      candidate = item.generatedCandidate;
    }
    // The page's own outstanding ask or a registration still waiting on its
    // bytes — either way the slot is live, never clickable.
    // "Requested but never submitted" is not live work: the slot stays
    // usable so the ask can be made again (the status line says why).
    const pending =
      (!unsubmitted && (unscopedImageNeed || needsPages.has(page.pageId))) ||
      Boolean(candidate && candidate.ready !== true);
    const saved = savedPages.get(page.pageId) ?? null;
    const staged = Boolean(page.kind === "generated" && page.mediaId && page.mediaId !== (saved?.mediaId ?? null));
    return { index: index + 1, page, generated, sourceChild, candidate, pending, staged };
  });
  const multi = slots.length > 1;

  /*
   * A page's figure: its generated image when ready, the "arriving" state
   * for a registered-but-undelivered one, the bound source photo for an
   * original page, the stored poster for a poster page — and the dashed
   * empty slot when nothing fills it yet. The page number rides on the
   * frame so an empty page names itself the way a refusal does.
   */
  const slotFigure = (slot) => {
    const page = slot.page;
    if (page.kind === "generated" && slot.generated) {
      return figure(slot.generated, {
        extra: `sl-slot-frame${slot.generated.ready === true ? " sl-output-frame-accepted" : ""}`,
        skel: slot.pending
      });
    }
    if (page.kind === "original" && slot.sourceChild) {
      const frame = el("div", { class: "sl-output-frame sl-slot-frame sl-output-frame-accepted" });
      const img = el("img", { class: "sl-pc-canvas", src: slot.sourceChild.url, alt: slot.sourceChild.alt || t(locale, "drawerPageSourceAlt", { n: slot.index }) });
      img.addEventListener("error", () => {
        img.replaceWith(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerHistoryVisualSource")));
      });
      frame.appendChild(img);
      if (slot.pending) frame.appendChild(el("span", { class: "sl-skel-label" }, t(locale, "drawerCandidatePending")));
      return frame;
    }
    if (page.kind === "poster") {
      const canvas = posterCanvas(locale, item);
      if (canvas) {
        const frame = el("div", { class: "sl-output-frame sl-slot-frame sl-output-frame-accepted" }, [canvas]);
        if (slot.pending) frame.appendChild(el("span", { class: "sl-skel-label" }, t(locale, "drawerCandidatePending")));
        return frame;
      }
      return figure(null, { extra: "sl-slot-frame", legacy: "poster", skel: slot.pending });
    }
    if (page.kind === "generated") {
      // A generated binding whose row is gone (or a legacy derived ref the
      // projection cannot show) still reads as a visual, never as empty.
      return figure(null, { extra: "sl-slot-frame sl-output-frame-accepted", legacy: "poster", skel: slot.pending });
    }
    // The empty page: the same frame size as the picture that will fill it,
    // dashed and named by number — the refusal `page N has no image` points
    // at exactly this slot.
    const frame = el("div", { class: "sl-output-frame sl-slot-frame sl-slot-frame-empty" }, [
      el("span", { class: "sl-pc-media-empty sl-output-empty", role: "status" }, t(locale, "drawerPageEmpty", { n: slot.index }))
    ]);
    if (slot.pending) frame.appendChild(el("span", { class: "sl-skel-label" }, t(locale, "drawerCandidatePending")));
    return frame;
  };

  /*
   * THE ⋯ ON A PAGE. Every action is done to THAT page: regenerate (hands
   * the page's context to the host's conversation on a filled page — never a
   * direct rerun, since a blind repeat of the same brief returns the same
   * picture), generate under the resolved brief on an empty one, upload a
   * file, adopt one of THIS post's own source images, view, remove. The
   * chip is legible at rest on any image — solid surface, dark glyph, a
   * small shadow — not a hover scrim.
   *
   * Regenerate is only offered when the host announced it can carry an agent
   * intent into the conversation (`strip.agentIntent`). On a host that never
   * said so, the row stays visible but disabled, naming the reason — there
   * is no inline fallback, because the conversation IS the regenerate
   * surface.
   */
  const captionEmpty = !String(buffers.caption ?? item.caption ?? "").trim();
  const pageMenuFor = (slot) => {
    const page = slot.page;
    const rows = [];
    if (page.kind) {
      rows.push(
        menuRow(
          t(locale, "drawerPicRegen"),
          strip.agentIntent ? t(locale, "drawerPicRegenSub") : t(locale, "drawerPicRegenOff"),
          () => strip.onRegenIntent?.(slot),
          !strip.agentIntent
        )
      );
    } else {
      const generate = menuRow(
        t(locale, "drawerAddGenerate"),
        captionEmpty
          ? t(locale, "drawerAddNoCaption")
          : t(locale, "drawerAddGenerateSub", {
              ref: t(locale, brief.useSource ? "drawerBriefOn" : "drawerBriefOff"),
              ratio: brief.ratio
            }),
        () => strip.onMenuGenerate?.(slot),
        false,
        captionEmpty
      );
      if (imageBusy) {
        generate.setAttribute("title", unsubmitted ? t(locale, "drawerRequestNotSubmitted") : t(locale, "drawerPartAlreadyRequested"));
        generate.setAttribute("data-requested", "true");
      } else if (outstanding.includes("caption")) {
        generate.setAttribute("title", t(locale, "drawerPartOtherPendingCaption"));
        generate.setAttribute("data-pending", "caption");
      }
      rows.push(generate);
    }
    rows.push(
      menuRow(
        t(locale, page.kind ? "drawerPicUpload" : "drawerAddUpload"),
        t(locale, "drawerAddUploadSub"),
        () => strip.onMenuUpload?.(slot)
      )
    );
    for (const [childIndex, child] of sourceImages.entries()) {
      const bound = page.kind === "original" && page.mediaId === child.id;
      rows.push(
        menuRow(
          t(locale, sourceImages.length === 1 ? "drawerPicSource" : "drawerPageSourceN", { n: childIndex + 1 }),
          bound ? t(locale, "drawerPageSourceInUse") : child.id === page.sourceMediaId ? t(locale, "drawerPageSourceBound") : null,
          () => strip.onMenuAdoptSource?.(slot, child.id),
          bound || !refsAvailable
        )
      );
    }
    if (!sourceImages.length) {
      rows.push(menuRow(t(locale, "drawerPicSource"), t(locale, "drawerAddSourceNone"), () => {}, true));
    }
    rows.push(el("div", { class: "sl-menu-sep", role: "separator" }));
    if (page.kind) {
      rows.push(menuRow(t(locale, "drawerPicView"), null, () => strip.onViewSlot?.(slot), page.kind === "generated" && slot.generated?.ready !== true));
    }
    rows.push(
      menuRow(
        t(locale, "drawerPageRemove"),
        slots.length === 1 ? t(locale, "drawerPageRemoveLast") : null,
        () => strip.onRemoveSlot?.(slot),
        slots.length === 1,
        false,
        "sl-menu-danger"
      )
    );
    return el("div", { class: "sl-menu", role: "menu", "aria-label": t(locale, "drawerImgActions") }, rows);
  };
  const picControls = (slot) =>
    el("span", { class: "sl-addwrap sl-addwrap-pic", "data-addanchor": slot.page.pageId }, [
      el("button", {
        type: "button",
        class: "sl-picbtn",
        "aria-haspopup": "menu",
        "aria-expanded": strip.menuOpen && strip.menuAnchor === slot.page.pageId ? "true" : "false",
        "aria-label": t(locale, multi ? "drawerPageActions" : "drawerImgActions", { n: slot.index }),
        disabled: ctx.saving || null,
        onclick: () => strip.onToggleMenu?.(slot.page.pageId)
      }, "⋯"),
      strip.menuOpen && strip.menuAnchor === slot.page.pageId ? pageMenuFor(slot) : null
    ].filter(Boolean));

  const slotNode = (slot) => {
    const media = el("div", { class: "sl-slot-media" });
    media.appendChild(slotFigure(slot));
    if (multi) media.appendChild(el("span", { class: "sl-slot-num", "aria-hidden": "true" }, String(slot.index)));
    if (editable && !slot.pending) media.appendChild(picControls(slot));
    const node = el("div", { class: "sl-slot", role: "listitem" }, media);
    // An original page names which of the post's own source photos it keeps —
    // the strip is honest about what is generated and what came with the post.
    if (slot.page.kind === "original" && slot.sourceChild) {
      const n = sourceImages.findIndex((child) => child.id === slot.sourceChild.id) + 1;
      node.appendChild(
        el("div", { class: "sl-slot-cap" }, t(locale, multi ? "drawerPageSourceN" : "drawerRefImageLabel", { n: Math.max(n, 1) }))
      );
    }
    return node;
  };

  // A page's delivered proposal sits UNDER its own slot — never in its
  // place — so "new image" is always read against the page it answers.
  // "Keep current" on an untouched candidate dismisses it (it stays in
  // History); on a staged one it unstages, the existing meaning.
  const candidateCard = (slot) => {
    const candidate = slot.candidate;
    if (!candidate || candidate.ready !== true) return null;
    if (dismissed && dismissed.has(candidate.id)) return null;
    const stagedHere = slot.staged && slot.page.mediaId === candidate.id;
    return el("div", { class: "sl-slot sl-slot-candidate", role: "listitem" }, [
      el("div", { class: "sl-slot-media" }, [figure(candidate, { extra: "sl-slot-frame sl-output-frame-candidate" })]),
      el("div", { class: "sl-slot-cap" }, [
        el("b", null, t(locale, multi ? "drawerImgNewPage" : "drawerImgNew", { n: slot.index })),
        ` ${t(locale, stagedHere ? "drawerCandidateStaged" : "drawerImgNewNote")}`
      ]),
      facts(candidate),
      candidate.status === "legacy" ? el("p", { class: "sl-field-note" }, t(locale, "drawerCandidateLegacy")) : null,
      editable
        ? el("div", { class: "sl-slot-acts" }, [
            stagedHere
              ? el("button", { type: "button", class: "sl-secondary", disabled: ctx.saving || null, onclick: () => ctx.onStageImage?.(slot.page.pageId, null) }, t(locale, "drawerKeepCurrent"))
              : el("button", { type: "button", class: "sl-primary sl-sm sl-use-candidate", disabled: ctx.saving || null, onclick: () => ctx.onStageImage?.(slot.page.pageId, candidate.id) }, t(locale, "drawerUseCandidate")),
            stagedHere ? null : el("button", { type: "button", class: "sl-secondary", disabled: ctx.saving || null, onclick: () => strip.onDismissCandidate?.(candidate.id) }, t(locale, "drawerKeepCurrentShort"))
          ].filter(Boolean))
        : null
    ]);
  };

  // Built in strip order: each page's slot, then its candidate card. An
  // explicit "Add a page" tile follows the last slot — growth is a decision
  // the owner makes here, never a side effect of another action.
  const slotNodes = slots.flatMap((slot) => [slotNode(slot), candidateCard(slot)]).filter(Boolean);
  const addPage = editable && slots.length < MAX_PAGES_PER_POST
    ? el("button", {
        type: "button",
        class: "sl-addpage",
        disabled: ctx.saving || imageBusy || null,
        onclick: () => strip.onAddPage?.()
      }, [
        el("span", { class: "sl-addplace-plus", "aria-hidden": "true" }, "＋"),
        el("span", null, t(locale, "drawerAddPage"))
      ])
    : null;

  /*
   * NO INLINE REGENERATE PANEL. The correction conversation lives in the
   * host's chat — the ⋯ row posts a gadget:agent-intent carrying this page's
   * context and the drawer never re-runs a brief itself. A canvas whose host
   * never announced the contract shows the row disabled with the reason; it
   * does not grow a second regenerate surface here.
   */

  // A part the platform confirmed was never submitted is not "waiting for the
  // agent": the footer says saved-but-not-submitted, and this line agrees
  // with it rather than implying a queue this request cannot establish.
  // In-flight generation is the overlay, not a second homework line.
  const imageStatusLine =
    imgState === "requested" && unsubmitted
      ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, "drawerRequestNotSubmitted"))
      : null;

  const partButton = (part, labelKey, keepsKey, requested, extra = {}) => {
    if (!editable) return null;
    // A pending request (including the one every new post starts with) is
    // never replaced silently: the button stays pressable and asks first.
    const other = outstanding.find((entry) => entry !== part) ?? null;
    const note = requested && unsubmitted
      ? t(locale, "drawerRequestNotSubmitted")
      : requested
        ? t(locale, "drawerPartAlreadyRequested")
        : other
          ? t(locale, other === "image" ? "drawerPartOtherPendingImage" : "drawerPartOtherPendingCaption")
          : t(locale, keepsKey);
    const button = el("button", {
      type: "button",
      class: extra.className ?? "sl-secondary",
      "data-part": part,
      "data-pending": other && !requested ? other : null,
      "data-requested": requested ? "true" : null,
      disabled: ctx.saving,
      title: note,
      onclick: () => ctx.onRequestPart?.(part)
    }, t(locale, labelKey));
    return extra.bare ? button : el("div", { class: "sl-part-action" }, [button]);
  };

  // The server cannot vouch for which image a page accepted: say so under
  // the strip and let the owner accept it again explicitly. Re-accepting
  // marks every unknown-provenance generated page owner-explicit — the same
  // act the singular re-accept performed. Read through `pagesOfItem` so a
  // pre-pages projection's derived page keeps the fact its legacy columns
  // carried.
  const unknownPages = pagesOfItem(item).filter((page) => page.kind === "generated" && page.mediaProvenance === "unknown");
  const provenance = unknownPages.length
    ? el("div", { class: "sl-guidance sl-provenance-unknown", role: "note" }, [
        el("p", null, t(locale, "reviewImageReviewRequired")),
        editable && unknownPages.some((page) => generatedRowFor(item, page)?.ready === true)
          ? el("button", { type: "button", class: "sl-secondary", "data-action": "reaccept-image", disabled: ctx.saving, onclick: () => ctx.onReacceptImage?.() }, t(locale, "reviewReacceptImage"))
          : null
      ])
    : null;

  // Alt text is per page — each filled page gets its own field, numbered
  // when the post has more than one. Edits land in the page list and save
  // with Save, exactly like the caption.
  let altField = null;
  const altPages = pages.filter((page) => page.kind);
  if (editable && altPages.length) {
    const inputs = altPages.map((page) => {
      const index = pages.indexOf(page) + 1;
      const saved = (item?.pages ?? []).find((entry) => entry.pageId === page.pageId) ?? null;
      const input = el("textarea", {
        id: altPages.length === 1 ? "sl-drawer-alt-text" : `sl-drawer-alt-text-${page.pageId}`,
        class: "sl-drawer-caption sl-alt-text-input",
        rows: "2",
        placeholder: t(locale, "drawerAltTextPlaceholder")
      });
      input.value = page.altText ?? "";
      input.classList.toggle("sl-dirty", input.value !== (saved?.altText || ""));
      input.addEventListener("input", () => {
        input.classList.toggle("sl-dirty", input.value !== (saved?.altText || ""));
        ctx.onAltTextInput?.(page.pageId, input.value);
      });
      return el("div", { class: "sl-field sl-alt-text" }, [
        el("label", { for: `sl-drawer-alt-text-${page.pageId}` }, t(locale, altPages.length > 1 ? "drawerAltForPage" : "drawerAltTextLabel", { n: index })),
        input,
        index === 1 ? el("p", { class: "sl-field-note" }, t(locale, "drawerAltTextNote")) : null
      ].filter(Boolean));
    });
    altField = el("div", { class: "sl-alt-group" }, inputs);
  } else if (!editable && (item?.pages ?? []).some((page) => page.altText)) {
    const first = (item.pages ?? []).find((page) => page.altText);
    altField = el("p", { class: "sl-field-note" }, t(locale, "drawerGeneratedAlt", { alt: first.altText }));
  }

  const uploadBlock = buffers.imageSource === "upload" && uploadPreview
    ? el("div", { class: "sl-upload-row" }, [
        el("p", { class: "sl-field-note" }, uploadPreview.name),
        el("button", { type: "button", class: "sl-primary", disabled: ctx.saving, onclick: () => ctx.onAdoptUpload?.() }, t(locale, "drawerUseCandidate"))
      ])
    : null;

  let captionBody;
  if (editable) {
    const note = el("p", { class: "sl-field-note", role: "status" });
    ctx.noteRef?.(note);
    const textarea = el("textarea", {
      id: "sl-drawer-caption-input",
      class: capState === "requested" ? "sl-drawer-caption sl-skel" : "sl-drawer-caption",
      rows: "4",
      "aria-labelledby": "sl-output-caption-title",
      placeholder: t(locale, "drawerCaptionPlaceholder")
    });
    textarea.value = buffers.caption ?? item.caption ?? "";
    textarea.classList.toggle("sl-dirty", textarea.value !== (item.caption || ""));
    textarea.addEventListener("input", () => {
      textarea.classList.toggle("sl-dirty", textarea.value !== (item.caption || ""));
      ctx.onCaptionInput?.(textarea.value);
    });
    const conflict = ctx.captionConflict
      ? el("div", { class: "sl-caption-conflict", role: "status" }, [
          el("strong", null, t(locale, "drawerCaptionConflictTitle")),
          el("p", { class: "sl-field-note" }, t(locale, "drawerCaptionConflictBody")),
          el("p", { class: "sl-drawer-caption-preview sl-caption-conflict-text" }, ctx.captionConflict.caption),
          el("div", { class: "sl-drawer-footer-actions" }, [
            el("button", { type: "button", class: "sl-secondary", "data-conflict": "keep", onclick: () => ctx.onResolveCaptionConflict?.("keep") }, t(locale, "drawerCaptionConflictKeep")),
            el("button", { type: "button", class: "sl-primary", "data-conflict": "use", onclick: () => ctx.onResolveCaptionConflict?.("use") }, t(locale, "drawerCaptionConflictUse"))
          ])
        ])
      : null;
    captionBody = [
      conflict,
      ctx.highlighted ? el("p", { class: "sl-drawer-caption-preview" }, [ctx.highlighted]) : null,
      el("div", { class: "sl-field sl-drawer-composer" }, [textarea, note])
    ];
  } else {
    captionBody = [el("p", { class: "sl-drawer-caption-preview" }, [ctx.highlighted || item.caption || t(locale, "drawerCaptionNone")])];
  }
  // Rewrite caption is a quiet action on the shared label row.
  const rewriteAction = partButton("caption", "drawerRewriteCaption", "drawerRewriteCaptionKeeps", capState === "requested", { bare: true, className: "sl-brief-link" });
  /*
   * THE MODE THE REWRITE RUNS UNDER, NAMED NEXT TO THE ACTION. A live
   * request carries the mode it was stamped with; an idle post previews
   * the same rule the server will stamp — no caption derives one from
   * the reference, an existing caption gets improved. The unsaved buffer
   * counts because choosing "use it" saves before the ask is stamped.
   */
  const captionMode = generationMark(item?.generation)?.captionMode
    ?? (captionEmpty ? "derive" : "enhance");

  /*
   * THE COLUMN PAIR BOTH TABS SHARE. Media on the left, words on the right —
   * `.sl-cols` fixes the media column's width (`--sl-colW`) so switching to
   * 參考 and back never reflows the sheet under the cursor. The strip stacks
   * inside the media column; the menu, the regen conversation and the status
   * lines belong to the column they act on.
   */
  return el("div", { class: "sl-drawer-panel-body" }, [
    el("div", { class: "sl-cols" }, [
      el("section", { class: "sl-cols-media", "aria-labelledby": "sl-output-images-title" }, [
        columnLabel(t(locale, "drawerImageSet"), null, "sl-output-images-title"),
        el("div", { class: "sl-strip", role: "list" }, slotNodes),
        addPage,
        // The carousel's one rule, said once under the strip — the caption
        // and the look belong to the post, never to a page.
        multi
          ? el("p", { class: "sl-field-note sl-pages-rule" }, t(locale, "drawerPagesRule"))
          : null,
        // Source videos nothing carried — disclosed, never silently dropped.
        skippedVideos.length
          ? el("p", { class: "sl-field-note" }, t(locale, "drawerSourceVideosNote", { n: skippedVideos.length }))
          : null,
        provenance,
        imageStatusLine,
        uploadBlock
      ]),
      el("section", { class: "sl-cols-side", "aria-labelledby": "sl-output-caption-title" }, [
        columnLabel(t(locale, "drawerOutputCaption"), rewriteAction, "sl-output-caption-title"),
        el("p", { class: "sl-field-note sl-caption-mode" }, t(locale, captionMode === "derive" ? "drawerCaptionModeDerive" : "drawerCaptionModeEnhance")),
        capState === "requested"
          ? el("p", { class: "sl-field-note sl-part-status", role: "status" },
              unsubmitted
                ? t(locale, "drawerRequestNotSubmitted")
                : t(locale, item.caption?.trim() ? "drawerCaptionRequestedKeep" : "drawerCaptionRequested"))
          : null,
        ...captionBody,
        altField
      ])
    ])
  ]);
}

/*
 * The sheet foot's publish row, per the accepted mockup: 發佈至 and the
 * destination picker, then the schedule field while a time is being chosen.
 * The timing radios are gone — which button was pressed IS the intent, so
 * "publication mode" is never a stored field. A destination that cannot take
 * the post explains itself on its own option (a revoked grant, a content rule
 * unmet, a format it cannot take) instead of failing at the server.
 *
 * ctx: `{ editable, saving, buffers, destinations, destinationLabel(binding),
 *        picked, menuOpen, picking, scheduledAt, onToggleMenu(),
 *        onToggleDestination(binding), onScheduleChange(value),
 *        onScheduleCancel() }`.
 */
export function renderPublishControls(locale, item, ctx = {}) {
  const destinations = Array.isArray(ctx.destinations) ? ctx.destinations : [];
  const buffers = ctx.buffers ?? {};
  const recorded = recordedBindings(item);
  const known = new Set(destinations.map((row) => row.binding ?? row.destinationBinding));
  const options = [
    ...destinations.map((row) => ({
      binding: row.binding ?? row.destinationBinding,
      label: row.label ?? ctx.destinationLabel?.(row.binding ?? row.destinationBinding) ?? (row.binding ?? row.destinationBinding),
      row
    })),
    // A recorded binding no destination row describes stays pickable — an
    // absent row cannot prove the grant is gone.
    ...recorded.filter((binding) => !known.has(binding)).map((binding) => ({ binding, label: ctx.destinationLabel?.(binding) || binding, row: null }))
  ];
  const picked = ctx.picked ?? recorded;
  const face = picked.length ? picked.map((binding) => ctx.destinationLabel?.(binding) || binding).join(" · ") : t(locale, "drawerPubNoDest");
  const menu = ctx.menuOpen === true && options.length > 0;
  const dests = el("div", { class: "sl-dests" }, [
    `${t(locale, "drawerPublishTo")} `,
    options.length
      ? el("span", { class: "sl-destwrap" }, [
          el("button", {
            type: "button",
            class: "sl-destbtn",
            "aria-haspopup": "menu",
            "aria-expanded": menu ? "true" : "false",
            "aria-label": t(locale, "drawerDestPick"),
            disabled: !ctx.editable || ctx.saving || null,
            onclick: () => ctx.onToggleMenu?.()
          }, `${face} ▾`),
          menu
            ? el("div", { class: "sl-destmenu", role: "menu" }, options.map((entry) => {
                const blocked = destinationBlock(item, buffers, destinations, entry.binding);
                return el("label", { class: "sl-destopt" }, [
                  el("input", {
                    type: "checkbox",
                    checked: picked.includes(entry.binding) || null,
                    disabled: Boolean(blocked) || !ctx.editable || ctx.saving || null,
                    onchange: () => ctx.onToggleDestination?.(entry.binding)
                  }),
                  el("span", { class: "sl-destopt-text" }, [
                    entry.label,
                    el("span", { class: blocked ? "sl-dest-sub sl-dest-blocked" : "sl-dest-sub" },
                      blocked ? t(locale, blocked) : (entry.row?.providerLabel ?? entry.row?.provider ?? ""))
                  ])
                ]);
              }))
            : null
        ])
      : el("span", { class: "sl-field-note" }, face)
  ]);
  const when = ctx.picking === true && !ctx.scheduledAt
    ? el("div", { class: "sl-whenrow" }, [
        el("input", {
          type: "datetime-local",
          id: "sl-drawer-publish-when",
          "aria-label": t(locale, "drawerScheduleField"),
          disabled: !ctx.editable || ctx.saving || null,
          // change, not input: the footer rebuilds on each patch, and an
          // input listener would rebuild the control mid-edit.
          onchange: (event) => ctx.onScheduleChange?.(event.currentTarget.value)
        }),
        el("button", { type: "button", class: "sl-brief-link", onclick: () => ctx.onScheduleCancel?.() }, t(locale, "drawerCancelSchedule"))
      ])
    : null;
  return [dests, when].filter(Boolean);
}

/* The footer's note line when no stronger reason takes the slot: what the
   pending press means, in owner words. */
export function publicationHint(locale, { scheduledAt = null } = {}) {
  return scheduledAt ? t(locale, "drawerPublishHintSchedule") : t(locale, "drawerPublishHintNow");
}

function formatLabel(mimeType) {
  const known = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
  return known[mimeType] ?? mimeType;
}

// ---------------------------------------------------------------------------
// 2. Reference
// ---------------------------------------------------------------------------

/**
 * ctx: `{ rail: { node } | null, editable, saving,
 *   imageRefsAvailable, onAdoptSource() }` — the source-media rail with its
 *   own per-frame reads and recovery (the Post tab's slot vocabulary), plus
 *   the one adopt action the column carries under it (the same
 *   `onAdoptSource` the Post tab's add menu runs).
 */
export function renderReferencePanel(locale, item, ctx = {}) {
  const source = item.sourceItem;
  if (!source) return el("p", { class: "sl-field-note" }, t(locale, "drawerReferenceNoSource"));
  const handle = typeof source.authorHandle === "string" && source.authorHandle.trim()
    ? (source.authorHandle.startsWith("@") ? source.authorHandle : `@${source.authorHandle}`)
    : source.sourceLabel || "";
  const hasVideo = (source.media ?? []).some((media) => media?.kind === "video");
  const refsAvailable = ctx.imageRefsAvailable === true;
  // Adopting the source picture is one action, reachable from two places:
  // the Post tab's page menus and this column's quiet control under the
  // image. It is disabled by the same rule the menus apply: nothing left to
  // adopt when every bindable child is already an original page.
  const bound = new Set(pagesOfItem(item).filter((page) => page.kind === "original").map((page) => page.mediaId));
  const adoptable = (source.media ?? []).some(
    (media) => (media?.kind === "image" || media?.kind === "carousel_child") && typeof media?.id === "string" && media.id && !bound.has(media.id)
  );
  const adoptDisabled = ctx.saving || !refsAvailable || !adoptable;
  return el("section", { class: "sl-drawer-section sl-reference", "aria-labelledby": "sl-reference-img-title" }, [
    el("div", { class: "sl-cols" }, [
      el("div", { class: "sl-cols-media" }, [
        columnLabel(t(locale, "drawerRefImageLabel"), null, "sl-reference-img-title"),
        ctx.rail?.node ?? null,
        hasVideo ? el("p", { class: "sl-field-note" }, t(locale, "drawerCoverOnly")) : null,
        ctx.editable
          ? el("button", {
              type: "button",
              class: "sl-secondary sl-sm sl-ref-adopt",
              disabled: adoptDisabled || null,
              onclick: () => ctx.onAdoptSource?.()
            }, t(locale, "drawerUseOriginal"))
          : null
      ].filter(Boolean)),
      el("div", { class: "sl-cols-side" }, [
        columnLabel(
          t(locale, "drawerSourceCaption"),
          source.permalink
            ? el("a", { href: source.permalink, target: "_blank", rel: "noopener noreferrer", class: "sl-brief-link" }, t(locale, "drawerViewOriginal"))
            : null,
          "sl-reference-text-title"
        ),
        el("p", { class: "sl-drawer-caption-preview sl-reference-text" }, source.text || t(locale, "inboxNoSource")),
        // One quiet line, still a <dl>: the pairing is right for a screen
        // reader; it just stopped pretending to be a data table.
        el("dl", { class: "sl-drawer-facts" }, [
          el("div", { class: "sl-fact" }, [el("dt", null, t(locale, "drawerReferenceAccount")), el("dd", null, handle || t(locale, "stateUnknown"))]),
          source.sourceLabel && source.sourceLabel !== handle
            ? el("div", { class: "sl-fact" }, [el("dt", null, t(locale, "drawerReferenceWatch")), el("dd", null, source.sourceLabel)])
            : null,
          source.publishedAt
            ? el("div", { class: "sl-fact" }, [el("dt", null, t(locale, "drawerPosted")), el("dd", null, String(source.publishedAt).slice(0, 10))])
            : null
        ])
      ])
    ])
  ]);
}

// ---------------------------------------------------------------------------
// 3. Instructions
// ---------------------------------------------------------------------------

/*
 * The generation settings a Generate ask is made under — the resolved brief
 * (the owner's staged choices over the configured defaults) sits on the
 * Instructions tab with the instructions it amends, per the accepted mockup:
 * the reference toggle, the ratio, and the one-off instruction the next ask
 * carries once. No price line — the owner does not weigh image cost; the
 * funding surface is the top-up a paused run asks for.
 */
function renderBriefControls(locale, ctx) {
  const brief = ctx.imageBrief;
  const refsAvailable = ctx.imageRefsAvailable === true;
  const patch = (part) => ctx.onPatchImageBrief?.(part);
  const changed = () => ctx.onBriefChanged?.();
  const body = el("div", { class: "sl-brieftab" });
  body.appendChild(el("label", { class: "sl-brief-switch" }, [
    el("input", {
      type: "checkbox",
      checked: brief.useSource || null,
      disabled: ctx.saving || null,
      onchange: (event) => { patch({ useSource: event.currentTarget.checked }); changed(); }
    }),
    el("span", { class: "sl-brief-switch-text" }, [
      el("span", { class: "sl-brief-switch-label" }, t(locale, "drawerBriefRefTitle")),
      el("span", { class: "sl-field-note" }, t(locale, "drawerBriefRefSub"))
    ])
  ]));
  if (brief.useSource && !refsAvailable) {
    body.appendChild(el("p", { class: "sl-field-note sl-brief-warn", role: "note" }, t(locale, "drawerBriefRefMissing")));
  }
  body.appendChild(el("div", { class: "sl-brief-ratios", role: "group", "aria-label": t(locale, "drawerBriefRatioLead") }, [
    el("span", { class: "sl-brief-ratios-lead" }, t(locale, "drawerBriefRatioLead")),
    ...[["4:5", "drawerRatioMatch"], ["1:1", "drawerRatioSquare"], ["9:16", "drawerRatioStory"]].map(([value, key]) =>
      el("button", {
        type: "button",
        class: "sl-brief-ratio",
        "aria-pressed": brief.ratio === value ? "true" : "false",
        disabled: ctx.saving || null,
        onclick: () => { patch({ ratio: value }); changed(); }
      }, t(locale, key)))
  ]));
  /*
   * NO "ADJUST FOR THIS RUN" FIELD HERE. A correction for a single run
   * belongs to the moment the owner asks for that run — the regenerate
   * conversation collects it, states the plan and spends once. A second
   * field here invited a correction nothing was about to act on. The
   * `runInstructions` contract is untouched: it still travels on the
   * request the regenerate conversation submits.
   */
  const liveLayer = ctx.item?.effectiveInstructions?.image?.source ?? "default";
  body.appendChild(el("p", { class: "sl-field-note sl-brief-in-effect" },
    `${t(locale, "drawerBriefInEffect")} ${instructionSourceName(locale, liveLayer)}`));
  return body;
}

/**
 * ctx: `{ editable, saving, buffers, policy, onInput(part, value), onReset(part),
 *        imageBrief?, imageRefsAvailable?, onPatchImageBrief?, onBriefChanged? }`.
 *
 * The generation brief, then two prefilled fields: each carries the text the
 * next request would actually use — this post's own override when there is
 * one, the workspace default otherwise. The state line under each says which,
 * and Reset clears the post's own so it follows the default again. Typing
 * back the prefilled text writes no override (dirtyInstructionParts compares
 * against that same prefill). The four-layer resolution, the pending
 * request's snapshot, and what produced the accepted output all live on the
 * History tab.
 */
export function renderInstructionsPanel(locale, item, ctx = {}) {
  const buffers = ctx.buffers ?? {};
  const saved = item.instructionOverrides ?? {};
  const defaults = instructionDefaultsOf(ctx.policy);
  const part = (key, labelKey, placeholderKey) => {
    const prefilled = saved[key] ?? defaults[key];
    const draft = buffers.instructions?.[key];
    const differs = draft !== undefined && normalizeOverride(draft) !== normalizeOverride(prefilled);
    // The override the pending edit lands: a differing draft wins, otherwise
    // the saved one stands. `own` is therefore true for a live custom edit
    // too, which is also what enables Reset.
    const pending = differs ? normalizeOverride(draft) : normalizeOverride(saved[key]);
    const own = pending !== null;
    const inputId = `sl-instructions-${key}`;
    const textarea = el("textarea", {
      id: inputId,
      class: "sl-drawer-caption sl-instructions-input",
      rows: "4",
      placeholder: t(locale, placeholderKey),
      readonly: ctx.editable ? null : true
    });
    textarea.value = differs && pending !== null ? draft : (pending ?? defaults[key]);
    const stateLine = el("span", { class: "sl-instructions-state" }, t(locale, own ? "drawerInstructionsPost" : "drawerInstructionsDefault"));
    const reset = ctx.editable
      ? el("button", {
          type: "button",
          class: "sl-secondary sl-instructions-reset",
          "data-part": key,
          disabled: !own,
          onclick: () => ctx.onReset?.(key)
        }, t(locale, "drawerInstructionsReset"))
      : null;
    // The panel does not redraw while a field is being edited (focus), so the
    // foot mirrors the live draft: a cleared or default-equal edit still reads
    // "default", anything else reads "own" — matching the save rule.
    textarea.addEventListener("input", () => {
      ctx.onInput?.(key, textarea.value);
      const live = normalizeOverride(textarea.value);
      const liveOwn = live !== null && live !== normalizeOverride(defaults[key]);
      stateLine.textContent = t(locale, liveOwn ? "drawerInstructionsPost" : "drawerInstructionsDefault");
      if (reset) reset.disabled = !liveOwn;
    });
    return el("div", { class: "sl-field sl-instructions-part" }, [
      el("label", { class: "sl-field-label", for: inputId }, t(locale, labelKey)),
      textarea,
      el("div", { class: "sl-instructions-foot" }, [stateLine, reset])
    ]);
  };
  // Saved text-poster wording is explained, never rewritten for the owner —
  // and only warned about when the text that would be used still asks for one.
  const pendingImage = buffers.instructions?.image !== undefined
    ? normalizeOverride(buffers.instructions.image)
    : normalizeOverride(saved.image);
  const legacyWording = LEGACY_POSTER_WORDING.test(pendingImage ?? defaults.image ?? "");
  return el("section", { class: "sl-drawer-section", "aria-label": t(locale, "drawerTabInstructions") }, [
    ctx.editable && ctx.imageBrief ? renderBriefControls(locale, { ...ctx, item }) : null,
    part("image", "drawerInstructionsImage", "drawerInstructionsImagePlaceholder"),
    part("caption", "drawerInstructionsCaption", "drawerInstructionsContentPlaceholder"),
    legacyWording ? el("p", { class: "sl-guidance sl-instructions-legacy", role: "note" }, t(locale, "drawerInstructionsLegacyPoster")) : null
  ]);
}

/** The layer an instruction snapshot's part came from, named for the owner. */
function instructionSourceName(locale, source) {
  return t(locale, { run: "drawerLayerRun", post: "drawerLayerPost", builtin: "drawerLayerBuiltin", default: "drawerLayerGadget" }[source] ?? "drawerLayerGadget");
}

/**
 * The instructions a request was made under, recorded on its mark — plus the
 * layer each part came from and the brief it carried (ratio always explicit;
 * references only when the post's own image was the basis). Shared by the
 * Instructions pending snapshot and the History feed.
 */
function instructionSnapshot(locale, instructions, heading, mark) {
  return el("div", { class: "sl-instructions-used" }, [
    el("strong", null, heading),
    el("p", { class: "sl-field-note" }, `${t(locale, "drawerInstructionsImage")}: ${instructions.image || t(locale, "drawerInstructionsNoDefault")}${mark?.instructionSources?.image ? ` · ${instructionSourceName(locale, mark.instructionSources.image)}` : ""}`),
    el("p", { class: "sl-field-note" }, `${t(locale, "drawerInstructionsCaption")}: ${instructions.caption || t(locale, "drawerInstructionsNoDefault")}${mark?.instructionSources?.caption ? ` · ${instructionSourceName(locale, mark.instructionSources.caption)}` : ""}`),
    mark?.imageBrief
      ? el("p", { class: "sl-field-note" }, t(locale, "drawerSnapshotBrief", {
          ratio: mark.imageBrief.aspectRatio,
          ref: t(locale, mark.imageBrief.references !== undefined ? "drawerBriefOn" : "drawerBriefOff")
        }))
      : null
  ]);
}

// Display-only: whether saved instruction text still asks for the retired
// text-poster output, so the owner is told to rewrite it. Never routes or
// decides anything.
const LEGACY_POSTER_WORDING = /text[\s_-]*poster|文字海報/i;

// ---------------------------------------------------------------------------
// 4. History
// ---------------------------------------------------------------------------

/** An absolute instant in UTC, labelled — the same convention the source drawer uses. */
export function whenLabel(locale, iso) {
  if (typeof iso !== "string" || !iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const text = when.toLocaleString(locale === "zh-HK" ? "zh-HK" : "en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC"
  });
  return `${text} UTC`;
}

const VISUAL_KEYS = {
  ai_refinement: "drawerHistoryVisualGenerated",
  text_poster: "drawerHistoryVisualPoster",
  keep_original: "drawerHistoryVisualSource"
};

// Only `failed_safe` is a confirmed "nothing went out"; a plain failure or an
// unknown outcome never claims that.
const OUTCOME_GUIDANCE_KEYS = {
  held: "drawerHistoryOutcomeHeld",
  failed: "drawerHistoryOutcomeFailed",
  failed_safe: "drawerHistoryOutcomeFailedSafe",
  unknown: "drawerHistoryOutcomeUnknown"
};

const IMAGE_STATUS_KEYS = {
  accepted: "drawerHistoryImageAccepted",
  candidate: "drawerHistoryImageCandidate",
  superseded: "drawerHistoryImageSuperseded",
  legacy: "drawerHistoryImageLegacy"
};

/**
 * ctx: `{ destinationLabel(binding), stateLabel(outcome), editable?, onUseImage?(id) }`.
 *
 * ONE reverse-chronological feed — every filing, version, request and image is
 * a timestamped event in a single list, newest first; an event with no
 * recorded time trails the dated ones. A delivery's receipt stays inline in
 * its event line, and a missing receipt simply renders nothing.
 */
export function renderHistoryPanel(locale, item, ctx = {}) {
  const label = ctx.destinationLabel ?? ((binding) => binding);
  const stateLabel = ctx.stateLabel ?? ((outcome) => outcome);
  const publications = Array.isArray(item.publications) ? item.publications : [];
  const byId = new Map(publications.map((pub) => [pub.id, pub]));
  const deliveries = (Array.isArray(item.deliveries) ? item.deliveries : []).filter((entry) => entry.outcome !== "bound");
  const earlier = publications.filter((pub) => pub.state === "superseded" || pub.state === "failed");
  const revisions = Array.isArray(item.revisionHistory) ? item.revisionHistory : [];
  const images = Array.isArray(item.generatedHistory) ? item.generatedHistory : [];
  const request = item.generation ?? item.lastGeneration ?? null;

  const scheduleLine = (intent) => {
    if (!intent || typeof intent !== "object") return null;
    if (intent.publishMode === "schedule" && intent.publishLocalTime) {
      return t(locale, "drawerHistorySchedule", {
        time: String(intent.publishLocalTime).replace("T", " "),
        timezone: intent.timezone || t(locale, "stateUnknown")
      });
    }
    if (intent.publishMode === "publish_now") return t(locale, "drawerHistoryNow");
    return null;
  };

  const approvalLine = (delivery) => {
    const approval = item.approval;
    if (!approval) return null;
    if ((approval.currentRevision ?? 0) > (approval.approvedRevision ?? 0) && delivery.revision === approval.approvedRevision) {
      return t(locale, "drawerHistoryApproval", { state: t(locale, "drawerHistoryApprovalOutdated") });
    }
    if (["review_requested", "submitted", "awaiting_approval"].includes(delivery.outcome)) {
      return t(locale, "drawerHistoryApproval", { state: t(locale, "drawerHistoryApprovalWaiting") });
    }
    return t(locale, "drawerHistoryApproval", { state: t(locale, "drawerHistoryApprovalSubmitted", { n: delivery.revision }) });
  };

  const events = [];
  // `at` is the event's own instant; it leads the line. Nodes are the event's
  // content — title row first, then any notes.
  const add = (at, nodes) => {
    const stamp = typeof at === "string" && at && !Number.isNaN(Date.parse(at)) ? Date.parse(at) : null;
    events.push({
      stamp,
      order: events.length,
      node: el("li", { class: "sl-history-event" }, [
        el("span", { class: "sl-history-when" }, stamp !== null ? whenLabel(locale, at) : ""),
        el("div", { class: "sl-history-body" }, nodes.filter(Boolean))
      ])
    });
  };

  for (const delivery of deliveries) {
    const publication = byId.get(delivery.publicationId);
    const intent = publication?.intent;
    const guidance = [delivery.detail && delivery.detail !== delivery.outcome ? delivery.detail : null, delivery.guidance]
      .filter(Boolean)
      .join(" — ");
    const fallbackGuidance = OUTCOME_GUIDANCE_KEYS[delivery.outcome] ? t(locale, OUTCOME_GUIDANCE_KEYS[delivery.outcome]) : null;
    const checked = delivery.checkedAt ?? delivery.lastCheckedAt ?? publication?.lastCheckedAt ?? null;
    const receipt = publication?.receipt ?? null;
    const receiptUrl = delivery.receiptUrl ?? receipt?.url ?? null;
    const receiptIds = receipt && (receipt.postId || receipt.version != null)
      ? [
          receipt.postId ? t(locale, "drawerHistoryReceiptPost", { id: receipt.postId }) : null,
          receipt.version != null ? t(locale, "drawerHistoryReceiptVersion", { version: receipt.version }) : null,
          receipt.providerId ? t(locale, "drawerHistoryReceiptProvider", { id: receipt.providerId }) : null
        ].filter(Boolean).join(" · ")
      : null;
    add(checked ?? delivery.filedAt, [
      el("div", { class: "sl-history-line" }, [
        el("strong", null, [
          label(delivery.destinationBinding),
          (delivery.revision ?? 0) > 0 ? ` · ${t(locale, "drawerRevision", { n: delivery.revision })}` : ""
        ]),
        el("span", { class: `sl-state-badge sl-state-${delivery.outcome}` }, stateLabel(delivery.outcome)),
        receiptUrl
          ? el("a", { class: "sl-receipt", href: receiptUrl, target: "_blank", rel: "noopener noreferrer" }, t(locale, "viewReceipt"))
          : null
      ]),
      scheduleLine(intent) ? el("p", { class: "sl-field-note sl-history-schedule" }, scheduleLine(intent)) : null,
      approvalLine(delivery) ? el("p", { class: "sl-field-note" }, approvalLine(delivery)) : null,
      receiptIds ? el("p", { class: "sl-field-note sl-history-receipt" }, receiptIds) : null,
      guidance || fallbackGuidance ? el("p", { class: "sl-guidance" }, guidance || fallbackGuidance) : null
    ]);
  }

  for (const pub of earlier) {
    add(pub.filedAt, [
      el("div", { class: "sl-history-line" }, [
        el("strong", null, `${label(pub.destinationBinding)} · ${t(locale, "drawerRevision", { n: pub.revision })}`),
        el("span", { class: `sl-state-badge sl-state-${pub.state}` }, `${t(locale, "drawerHistoryEarlier")} · ${stateLabel(pub.state)}`)
      ]),
      scheduleLine(pub.intent) ? el("p", { class: "sl-field-note sl-history-schedule" }, scheduleLine(pub.intent)) : null,
      OUTCOME_GUIDANCE_KEYS[pub.state] ? el("p", { class: "sl-guidance" }, t(locale, OUTCOME_GUIDANCE_KEYS[pub.state])) : null
    ]);
  }

  if (request?.needs) {
    const parts = request.needs.image && request.needs.caption ? "drawerHistoryPartBoth" : request.needs.image ? "drawerHistoryPartImage" : "drawerHistoryPartCaption";
    add(request.at, [
      el("div", { class: "sl-history-line" }, [
        el("strong", null, t(locale, "drawerHistoryRequestTitle")),
        el("span", { class: "sl-history-detail" }, [
          t(locale, parts),
          ` · ${t(locale, item.generation ? "drawerHistoryPending" : "drawerHistoryDone")}`,
          request.imageBrief
            ? ` · ${t(locale, "drawerSnapshotBrief", {
                ratio: request.imageBrief.aspectRatio,
                ref: t(locale, request.imageBrief.references !== undefined ? "drawerBriefOn" : "drawerBriefOff")
              })}`
            : ""
        ])
      ])
    ]);
  }

  for (const image of images) {
    const status = IMAGE_STATUS_KEYS[image.status] ? image.status : image.id === item.generatedImage?.id ? "accepted" : null;
    // An earlier image stays history; bringing it back is the owner's
    // explicit choice and becomes a new revision when saved.
    const reusable = ctx.editable === true && image.ready === true && (image.status === "superseded" || image.status === "legacy") && image.id !== item.generatedImage?.id;
    add(image.createdAt, [
      el("div", { class: "sl-history-line", "data-image-status": status }, [
        el("strong", null, t(locale, "drawerHistoryImageTitle")),
        el("span", { class: "sl-history-detail" }, [
          t(locale, image.ready ? "drawerHistoryImageReady" : "drawerHistoryImageWaiting"),
          status ? ` · ${t(locale, IMAGE_STATUS_KEYS[status])}` : "",
          image.stale ? ` · ${t(locale, "drawerHistoryImageStale")}` : ""
        ].join("")),
        reusable
          ? el("button", { type: "button", class: "sl-brief-link sl-history-use-image", "data-image-id": image.id, onclick: () => ctx.onUseImage?.(image.id) }, t(locale, "drawerHistoryUseImage"))
          : null
      ])
    ]);
  }

  for (const entry of revisions) {
    add(entry.createdAt, [
      el("div", { class: "sl-history-line" }, [
        el("strong", null, t(locale, "drawerRevision", { n: entry.revision })),
        el("span", { class: "sl-history-detail" }, [
          t(locale, VISUAL_KEYS[entry.acceptedVisualMode] ?? "drawerHistoryVisualNone"),
          scheduleLine(entry.publicationIntent) ? ` · ${scheduleLine(entry.publicationIntent)}` : ""
        ].join(""))
      ])
    ]);
  }

  // What produced the accepted output and what the last completed request ran
  // under are history, not the pending ask — they moved here from
  // Instructions. Both render only when the projection carries the snapshot.
  const currentRevision = revisions.find((entry) => entry.revision === item.revision);
  const acceptedUsed = item.generatedImage?.instructions ?? currentRevision?.instructions ?? null;
  const pending = generationMark(item.generation);
  const last = generationMark(item.lastGeneration);
  if (acceptedUsed) {
    add(currentRevision?.createdAt ?? item.generatedImage?.deliveredAt ?? null, [
      instructionSnapshot(locale, acceptedUsed, t(locale, "drawerInstructionsAcceptedUsed"), null)
    ]);
  }
  if (!acceptedUsed && last?.instructions && last.id !== pending?.id) {
    add(last.at, [
      instructionSnapshot(locale, last.instructions, t(locale, "drawerHistoryInstructions"), last)
    ]);
  }

  const legacyPoster = posterCanvas(locale, item);
  if (legacyPoster) {
    add(null, [
      el("p", { class: "sl-field-note" }, t(locale, "drawerHistoryLegacyPoster")),
      el("div", { class: "sl-pc-media-slot sl-history-poster" }, [legacyPoster])
    ]);
  }

  if (!events.length) return el("p", { class: "sl-field-note" }, t(locale, "drawerHistoryNone"));
  events.sort((a, b) => (b.stamp ?? -Infinity) - (a.stamp ?? -Infinity) || a.order - b.order);
  return el("div", { class: "sl-drawer-panel-body" }, [
    el("ul", { class: "sl-history-feed" }, events.map((event) => event.node))
  ]);
}

/** A stored text poster, drawn for inspection only — never offered as a new output. */
function posterCanvas(locale, item) {
  const layout = item.posterLayout;
  if (!layout?.template) return null;
  const canvas = el("canvas", { class: "sl-pc-canvas", "aria-label": t(locale, "drawerHistoryLegacyPoster") });
  const computed = computePosterLayout({ template: layout.template, headline: layout.headline, subline: layout.subline, align: layout.align });
  canvas.width = computed.width;
  canvas.height = computed.height;
  const ctx2d = canvas.getContext("2d");
  if (ctx2d) drawPoster(ctx2d, computed, { headline: layout.headline, subline: layout.subline, background: { value: layout.background?.value }, textColor: layout.textColor });
  return canvas;
}
