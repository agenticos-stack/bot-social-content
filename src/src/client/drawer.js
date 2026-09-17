// The single-post "Saved localization" drawer — its four sections as pure
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
import { t } from "./i18n.js";
import { JPEG_ONLY_PROVIDERS } from "./image-acceptance.js";
import { computePosterLayout, drawPoster } from "./poster.js";
import { generationMark } from "../../model.js";

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
  const instructions = dirtyInstructionParts(item, buffers, ["image", "caption"], defaults).length > 0;
  // No `publication`: the footer's destination picks and a chosen schedule
  // time are transient — the intent is what was pressed, never a saved field.
  return { caption, altText, visual, instructions, any: caption || altText || visual || instructions };
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
  if (!dirty.caption && !dirty.visual && !dirty.altText && !dirty.publication) return null;
  return {
    batchItemId: item.id,
    expectedRevision: item.revision ?? 0,
    ...(dirty.caption ? { caption: buffers.caption } : {}),
    // An emptied alt text clears it (null); omitted carries the saved one forward.
    ...(dirty.altText ? { altText: buffers.altText.trim() ? buffers.altText : null } : {}),
    ...(dirty.visual
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
const pendingChoices = new WeakMap();
export function confirmDrawerChoice(dialog, { title, body, choices }) {
  const pending = pendingChoices.get(dialog);
  if (pending) return pending;
  let settle;
  const decision = new Promise((resolve) => { settle = resolve; });
  pendingChoices.set(dialog, decision);
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    dialog.removeEventListener("cancel", onCancel);
    dialog.removeEventListener("close", onClose);
    pendingChoices.delete(dialog);
    if (dialog.open) dialog.close();
    settle(value);
  };
  const onCancel = (event) => { event.preventDefault?.(); finish("cancel"); };
  /*
   * A `close` event is dispatched as a later task, after `close()` returns.
   * When one prompt resolves and the caller opens the next on the same dialog
   * straight away (replace a pending request, then decide about unsaved
   * instructions), the first prompt's close arrives while the dialog is open
   * again — and used to answer the second prompt "cancel", so Regenerate did
   * nothing and said nothing. Only a close that left the dialog closed is a
   * real dismissal.
   */
  const onClose = () => { if (dialog.open) return; finish("cancel"); };
  replace(dialog, [
    el("div", { class: "sl-preview-sheet" }, [
      el("header", { class: "sl-preview-head" }, [el("strong", null, title)]),
      el("div", { class: "sl-preview-scroll" }, (Array.isArray(body) ? body : [body]).filter(Boolean).map((line) => el("p", null, line))),
      el("footer", { class: "sl-preview-actions" }, choices.map((choice) =>
        el("button", { type: "button", class: choice.primary ? "sl-primary" : "sl-secondary", "data-choice": choice.value, onclick: () => finish(choice.value) }, choice.label)))
    ])
  ]);
  dialog.addEventListener("cancel", onCancel);
  dialog.addEventListener("close", onClose);
  if (!dialog.open) dialog.showModal();
  return decision;
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
  const staged = typeof buffers.imageId === "string" && buffers.imageId !== (item?.generatedImage?.id ?? null) ? buffers.imageId : null;
  const keepOriginal = buffers.visualMode === "keep_original" || item?.acceptedVisualMode === "keep_original";
  const legacyVisual = !item?.generatedImage && (item?.acceptedVisualMode === "text_poster" || keepOriginal || item?.posterStored);
  const hasImage = Boolean(staged) || Boolean(item?.generatedImage && item.generatedImage.ready === true) || legacyVisual;
  if (row.provider === "instagram" && !hasImage) return "drawerDestIgNeedsImage";
  // What actually ships: the staged pick once saved, else the accepted image.
  const shipped = staged
    ? ((item?.generatedCandidate?.id === staged ? item.generatedCandidate : null)
      ?? (item?.generatedHistory ?? []).find((media) => media?.id === staged) ?? null)
    : item?.generatedImage ?? null;
  const generatedShips = staged ? Boolean(shipped) : (item?.acceptedVisualMode ?? null) === "ai_refinement";
  if (JPEG_ONLY_PROVIDERS.has(row.provider) && generatedShips && shipped?.mimeType === "image/png") return "drawerDestNeedsJpeg";
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
  const staged = typeof buffers.imageId === "string" && buffers.imageId !== (item?.generatedImage?.id ?? null);
  const keepOriginal = buffers.visualMode === "keep_original" || item?.acceptedVisualMode === "keep_original";
  const legacyVisual = !item?.generatedImage && (item?.acceptedVisualMode === "text_poster" || keepOriginal || item?.posterStored);
  const img = imageState(item);
  const cap = captionState(item);
  // What the primary would actually file: the chosen set minus every option
  // that explains on its own row why it cannot take this post.
  const fileable = (picked ?? recordedBindings(item)).filter((binding) => !destinationBlock(item, buffers, destinations, binding));
  let review = { disabled: false, reason: null };
  if (saving) review = { disabled: true, reason: t(locale, "saving") };
  else if ((item?.revision ?? 0) === 0 && !caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsOutput") };
  else if (!caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsCaption") };
  else if (!staged && item?.generatedImage && item.generatedImage.ready !== true) review = { disabled: true, reason: t(locale, "drawerReviewImageNotArrived") };
  else if (!staged && !item?.generatedImage && !legacyVisual) review = { disabled: true, reason: t(locale, "drawerReviewNeedsImage") };
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
 * The ordered accepted set — one element today, because a revision accepts a
 * single generated image (`revisions.accepted_generated_media_id`). The array
 * is the Phase 2 contract: the strip renders whatever it holds, each picture
 * carries its own index, and every action names its own slot. `legacy` marks
 * a slot whose picture is not a generated image — the source media adopted
 * as-is, or an earlier text poster the revision kept.
 */
function imageSlots(item) {
  const image = item?.generatedImage ?? null;
  const legacy = image ? null
    : item?.acceptedVisualMode === "keep_original" ? "source"
      : item?.acceptedVisualMode === "text_poster" || (item?.acceptedVisualMode == null && item?.posterStored) ? "poster"
        : null;
  return [{ index: 1, image, legacy }];
}

const REGEN_CHIPS = ["drawerRegenC1", "drawerRegenC2", "drawerRegenC3", "drawerRegenC4", "drawerRegenC5"];

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
 * strip?: { menuOpen, regen, candidateDismissed, onToggleMenu(), onMenuGenerate(),
 *   onMenuUpload(), onMenuAdoptSource(), onRegenOpen(n), onRegenChip(key),
 *   onRegenOtherInput(value), onRegenOtherBlur(), onRegenToggleOther(),
 *   onRegenSubmit(), onRegenCancel(), onRemoveSlot(n), onViewSlot(n),
 *   onDismissCandidate() } }`.
 *
 * `buffers` = `{ caption?, altText?, imageId?, visualMode?, imageSource?,
 * instructions?, imageBrief? }` — `imageBrief` stages the NEXT Generate ask;
 * it is not content and is never part of a Save.
 */
export function renderOutputPanel(locale, item, ctx) {
  const buffers = ctx.buffers ?? {};
  const editable = ctx.editable === true;
  const accepted = item.generatedImage ?? null;
  const candidate = item.generatedCandidate ?? null;
  const staged = typeof buffers.imageId === "string" && buffers.imageId !== (accepted?.id ?? null) ? buffers.imageId : null;
  const imgState = imageState(item);
  const capState = captionState(item);
  const imageBusy = imgState === "requested" || imgState === "generating";
  const unsubmitted = ctx.unsubmitted === true;
  const overlayBusy = imageBusy && !unsubmitted;
  const strip = ctx.strip ?? {};
  const brief = ctx.imageBrief ?? { useSource: true, ratio: "4:5", oneOff: "", saveOneOff: false };
  const refsAvailable = ctx.imageRefsAvailable === true;
  const showCandidate = Boolean(candidate && candidate.ready === true && strip.candidateDismissed !== candidate.id);
  const uploadPreview = ctx.uploadPreview ?? null;

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
   * THE STRIP. One slot per accepted picture — one today. The actions that
   * belong to THAT picture live on it: hover reveals them on a fine pointer,
   * :focus-within reveals them for the keyboard, and a coarse pointer sees
   * them permanently (@media (hover: none)). Generating overlays the slot's
   * own frame — including an empty first slot — so a request never reads as
   * a second tile.
   *
   * ONE IMAGE IS NOT A SET. A number badge, a "Cover" caption and a second
   * empty tile are the furniture of an ordered collection; on a post that has
   * a single picture they name nothing, so the number and the cap appear only
   * when there is more than one slot.
   */
  const hasPicture = (slot) => Boolean(slot.image) || Boolean(slot.legacy);
  const slots = imageSlots(item);
  const isSet = slots.length > 1;
  const slotNode = (slot) => {
    const media = el("div", { class: "sl-slot-media" });
    media.appendChild(figure(slot.image, {
      extra: `sl-slot-frame${slot.image ? " sl-output-frame-accepted" : ""}`,
      legacy: slot.legacy,
      skel: overlayBusy
    }));
    if (isSet) media.appendChild(el("span", { class: "sl-slot-num", "aria-hidden": "true" }, String(slot.index)));
    if (editable && hasPicture(slot) && !overlayBusy) {
      media.appendChild(el("div", { class: "sl-hover" }, [
        el("button", { type: "button", class: "sl-hover-btn", disabled: ctx.saving || null, onclick: () => strip.onRegenOpen?.(slot.index) }, t(locale, "drawerHoverRegen")),
        slot.index === 1 ? null : el("button", { type: "button", class: "sl-hover-btn", disabled: ctx.saving || null, onclick: () => strip.onMakeCover?.(slot.index) }, t(locale, "drawerHoverCover")),
        el("button", { type: "button", class: "sl-hover-btn", disabled: ctx.saving || null, onclick: () => strip.onRemoveSlot?.(slot.index) }, t(locale, "drawerHoverRemove")),
        slot.image?.ready === true
          ? el("button", { type: "button", class: "sl-hover-btn", onclick: () => strip.onViewSlot?.(slot.index) }, t(locale, "drawerHoverView"))
          : null
      ].filter(Boolean)));
    }
    return el("div", { class: "sl-slot", role: "listitem" }, [
      media,
      isSet
        ? el("div", { class: "sl-slot-cap" }, [
            el("b", null, slot.index === 1 ? t(locale, "drawerCover") : t(locale, "drawerSlotN", { n: slot.index })),
            staged && slot.index === 1 ? [" ", el("span", { class: "sl-dest-tag" }, t(locale, "drawerCandidateStagedTag"))] : null
          ])
        : null
    ].filter(Boolean));
  };

  // Built in strip order: the accepted slot loads before the candidate beside
  // it. An EMPTY slot is not furniture — when the post can still be edited the
  // dashed `.sl-addplace` placeholder IS the add control, so the slot itself
  // only renders for a picture, a generating skeleton, or the locked view.
  const slotNodes = slots.filter((slot) => hasPicture(slot) || overlayBusy || !editable).map(slotNode);

  // The candidate sits BESIDE the slot it would replace — never in its place.
  // "Keep current" on an untouched candidate dismisses the proposal (the image
  // stays in History); on a staged one it unstages, the existing meaning.
  const candidateSlot = showCandidate
    ? el("div", { class: "sl-slot sl-slot-candidate", role: "listitem" }, [
        el("div", { class: "sl-slot-media" }, [
          figure(candidate, { extra: "sl-slot-frame sl-output-frame-candidate" })
        ]),
        el("div", { class: "sl-slot-cap" }, [
          el("b", null, t(locale, "drawerImgNew")),
          ` ${t(locale, staged === candidate.id ? "drawerCandidateStaged" : "drawerImgNewNote")}`
        ]),
        facts(candidate),
        candidate.status === "legacy" ? el("p", { class: "sl-field-note" }, t(locale, "drawerCandidateLegacy")) : null,
        editable
          ? el("div", { class: "sl-slot-acts" }, [
              staged === candidate.id
                ? el("button", { type: "button", class: "sl-secondary", disabled: ctx.saving || null, onclick: () => ctx.onStageImage?.(null) }, t(locale, "drawerKeepCurrent"))
                : el("button", { type: "button", class: "sl-primary sl-use-candidate", disabled: ctx.saving || null, onclick: () => ctx.onStageImage?.(candidate.id) }, t(locale, "drawerUseCandidate")),
              staged === candidate.id ? null : el("button", { type: "button", class: "sl-secondary", disabled: ctx.saving || null, onclick: () => strip.onDismissCandidate?.() }, t(locale, "drawerKeepCurrentShort"))
            ].filter(Boolean))
          : null
      ])
    : null;

  // One menu holds every way a picture joins the set — generate under the
  // resolved brief (its row says so), upload, or adopt the post's own picture
  // where one exists. It renders STATICALLY under the strip, never absolute:
  // a floating menu clipped inside the drawer's scroll port and could fall
  // behind the tile that opened it.
  const menuRow = (title, sub, onclick, disabled = false) =>
    el("button", { type: "button", role: "menuitem", class: "sl-menu-item", disabled: disabled || null, onclick }, [
      el("span", { class: "sl-menu-lead" }, title),
      sub ? el("span", { class: "sl-menu-sub" }, sub) : null
    ]);
  // The menu's Generate row carries the same pending honesty the old segment
  // did: a requested part names itself, another pending part is named too.
  const generateItem = menuRow(t(locale, "drawerAddGenerate"), t(locale, "drawerAddGenerateSub", {
    ref: t(locale, brief.useSource ? "drawerBriefOn" : "drawerBriefOff"),
    ratio: brief.ratio,
    price: t(locale, brief.useSource ? "drawerBriefPricedEdit" : "drawerBriefPricedNew")
  }), () => strip.onMenuGenerate?.());
  if (imageBusy) {
    generateItem.setAttribute("title", unsubmitted ? t(locale, "drawerRequestNotSubmitted") : t(locale, "drawerPartAlreadyRequested"));
    generateItem.setAttribute("data-requested", "true");
  } else if (outstanding.includes("caption")) {
    generateItem.setAttribute("title", t(locale, "drawerPartOtherPendingCaption"));
    generateItem.setAttribute("data-pending", "caption");
  }
  const addMenu = editable && strip.menuOpen
    ? el("div", { class: "sl-menu", role: "menu", "aria-label": t(locale, "drawerAddImage") }, [
        generateItem,
        el("div", { class: "sl-menu-sep", role: "separator" }),
        menuRow(t(locale, "drawerAddUpload"), t(locale, "drawerAddUploadSub"), () => strip.onMenuUpload?.()),
        menuRow(
          t(locale, "drawerAddSource"),
          refsAvailable ? t(locale, "drawerAddSourceSub") : t(locale, "drawerAddSourceNone"),
          () => strip.onMenuAdoptSource?.(),
          !refsAvailable || item.acceptedVisualMode === "keep_original"
        )
      ])
    : null;

  /*
   * THE EMPTY SLOT IS THE ADD CONTROL, and it is the size of the picture that
   * will land in it: a dashed placeholder at the frame's own aspect ratio
   * carries ＋ / Add image / the three ways one arrives. A text link under a
   * hollow frame moved everything below it the moment an image arrived; this
   * box never changes shape. Once a picture exists the quiet ＋ in the column
   * label takes over; a generating slot keeps its skeleton instead.
   */
  const emptyEditable = editable && !slots.some(hasPicture) && !overlayBusy && !showCandidate;
  const addPlace = emptyEditable
    ? el("button", {
        type: "button",
        class: "sl-addplace",
        "aria-haspopup": "menu",
        "aria-expanded": strip.menuOpen ? "true" : "false",
        disabled: ctx.saving || null,
        onclick: () => strip.onToggleMenu?.()
      }, [
        el("span", { class: "sl-addplace-plus" }, "＋"),
        el("span", null, t(locale, "drawerAddImage")),
        el("span", { class: "sl-addplace-hint" }, t(locale, "drawerAddPlaceHint"))
      ])
    : null;
  // The quiet way to add a picture once the placeholder is gone — it stays
  // on the label while a request generates (the menu rows still carry the
  // pending honesty), and never doubles as a second tile.
  const quietAdd = editable && !emptyEditable
    ? el("button", {
        type: "button",
        class: "sl-addquiet",
        "aria-haspopup": "menu",
        "aria-expanded": strip.menuOpen ? "true" : "false",
        disabled: ctx.saving || null,
        onclick: () => strip.onToggleMenu?.()
      }, t(locale, "drawerAddFirst"))
    : null;
  // A real second tile is the ordered-set affordance — Phase 2 only, never on
  // a post that holds one picture.
  const addSlot = editable && isSet && slots.length < 10
    ? el("button", {
        type: "button",
        class: "sl-addslot",
        "aria-label": t(locale, "drawerAddImage"),
        "aria-haspopup": "menu",
        "aria-expanded": strip.menuOpen ? "true" : "false",
        disabled: ctx.saving || null,
        onclick: () => strip.onToggleMenu?.()
      }, "＋")
    : null;

  /*
   * REGENERATE IS A CONVERSATION, not a blind rerun: name what should change
   * (a chip or your own words), see the plan and the price it will spend, then
   * Generate — and it generates once, never on a loop. Nothing is filed until
   * the owner says what is wrong.
   */
  const regen = strip.regen ?? null;
  const regenPanel = (() => {
    if (!editable || !regen) return null;
    if (regen.sent) {
      return el("div", { class: "sl-regen", role: "status" }, [
        el("p", { class: "sl-regen-ask" }, t(locale, "drawerRegenRunning", { n: regen.slot })),
        el("p", { class: "sl-regen-sub" }, t(locale, "drawerRegenRunningSub"))
      ]);
    }
    const named = regen.notes.length > 0 || Boolean(regen.other?.trim());
    const correction = [...regen.notes.map((key) => t(locale, key)), ...(regen.other?.trim() ? [regen.other.trim()] : [])];
    const other = regen.otherOpen
      ? (() => {
          const area = el("textarea", {
            id: "sl-regen-other",
            class: "sl-regen-other",
            rows: "2",
            placeholder: t(locale, "drawerRegenOtherPh"),
            "aria-label": t(locale, "drawerRegenOther")
          });
          area.value = regen.other ?? "";
          area.addEventListener("input", () => strip.onRegenOtherInput?.(area.value));
          // Re-render on blur: the plan line appears once something is named.
          area.addEventListener("blur", () => strip.onRegenOtherBlur?.());
          return area;
        })()
      : el("button", { type: "button", class: "sl-brief-link", onclick: () => strip.onRegenToggleOther?.() }, t(locale, "drawerRegenOther"));
    return el("div", { class: "sl-regen" }, [
      el("p", { class: "sl-regen-ask" }, t(locale, "drawerRegenAsk", { n: regen.slot })),
      el("p", { class: "sl-regen-sub" }, t(locale, "drawerRegenSub")),
      el("div", { class: "sl-regen-chips", role: "group" }, REGEN_CHIPS.map((key) =>
        el("button", {
          type: "button",
          class: "sl-regen-chip",
          "aria-pressed": regen.notes.includes(key) ? "true" : "false",
          onclick: () => strip.onRegenChip?.(key)
        }, t(locale, key)))),
      other,
      named
        ? el("div", { class: "sl-regen-plan" }, [
            el("p", { class: "sl-regen-plan-line" }, t(locale, "drawerRegenPlan", { n: regen.slot, notes: correction.join(" · "), ratio: brief.ratio })),
            el("p", { class: "sl-regen-cost" }, t(locale, "drawerRegenCost", { price: t(locale, brief.useSource ? "drawerBriefPricedEdit" : "drawerBriefPricedNew") })),
            el("div", { class: "sl-regen-acts" }, [
              el("button", { type: "button", class: "sl-primary sl-regen-go", disabled: ctx.saving || null, onclick: () => strip.onRegenSubmit?.() }, t(locale, "drawerRegenGo")),
              el("span", { class: "sl-grow" }),
              el("button", { type: "button", class: "sl-secondary", onclick: () => strip.onRegenCancel?.() }, t(locale, "drawerRegenCancel"))
            ])
          ])
        : el("p", { class: "sl-regen-sub sl-regen-need" }, t(locale, "drawerRegenNeedMore"))
    ]);
  })();

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

  // The server cannot vouch for which image this revision accepted: say so
  // under the strip and let the owner accept it again explicitly.
  const provenance = accepted && item.acceptedGeneratedMediaProvenance === "unknown"
    ? el("div", { class: "sl-guidance sl-provenance-unknown", role: "note" }, [
        el("p", null, t(locale, "reviewImageReviewRequired")),
        editable && accepted.ready === true
          ? el("button", { type: "button", class: "sl-secondary", "data-action": "reaccept-image", disabled: ctx.saving, onclick: () => ctx.onReacceptImage?.(accepted.id) }, t(locale, "reviewReacceptImage"))
          : null
      ])
    : null;

  // Alt text belongs to the revision: edited here, saved with Save, carried to Review.
  let altField = null;
  if (editable && (accepted || staged)) {
    const altInput = el("textarea", {
      id: "sl-drawer-alt-text",
      class: "sl-drawer-caption sl-alt-text-input",
      rows: "2",
      placeholder: t(locale, "drawerAltTextPlaceholder")
    });
    altInput.value = buffers.altText ?? item.altText ?? "";
    altInput.classList.toggle("sl-dirty", altInput.value !== (item.altText || ""));
    altInput.addEventListener("input", () => {
      altInput.classList.toggle("sl-dirty", altInput.value !== (item.altText || ""));
      ctx.onAltTextInput?.(altInput.value);
    });
    altField = el("div", { class: "sl-field sl-alt-text" }, [
      el("label", { for: "sl-drawer-alt-text" }, t(locale, "drawerAltTextLabel")),
      altInput,
      el("p", { class: "sl-field-note" }, t(locale, "drawerAltTextNote"))
    ]);
  } else if (item.altText) {
    altField = el("p", { class: "sl-field-note" }, t(locale, "drawerGeneratedAlt", { alt: item.altText }));
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
   * THE COLUMN PAIR BOTH TABS SHARE. Media on the left, words on the right —
   * `.sl-cols` fixes the media column's width (`--sl-colW`) so switching to
   * 參考 and back never reflows the sheet under the cursor. The strip stacks
   * inside the media column; the menu, the regen conversation and the status
   * lines belong to the column they act on.
   */
  return el("div", { class: "sl-drawer-panel-body" }, [
    el("div", { class: "sl-cols" }, [
      el("section", { class: "sl-cols-media", "aria-labelledby": "sl-output-images-title" }, [
        columnLabel(t(locale, "drawerImageSet"), quietAdd, "sl-output-images-title"),
        addPlace,
        el("div", { class: "sl-strip", role: "list" }, [...slotNodes, candidateSlot, addSlot].filter(Boolean)),
        addMenu,
        provenance,
        imageStatusLine,
        uploadBlock,
        regenPanel
      ]),
      el("section", { class: "sl-cols-side", "aria-labelledby": "sl-output-caption-title" }, [
        columnLabel(t(locale, "drawerOutputCaption"), rewriteAction, "sl-output-caption-title"),
        capState === "requested" && unsubmitted
          ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, "drawerRequestNotSubmitted"))
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
 * ctx: `{ stage: { node, strip } | null, editable, saving,
 *   imageRefsAvailable, onAdoptSource() }` — the existing carousel stage with
 *   its own recovery, plus the one adopt action the column carries under the
 *   source image (the same `onAdoptSource` the Post tab's add menu runs).
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
  // the Post tab's add menu and this column's quiet control under the image.
  // Both run the same `onAdoptSource`; it is disabled by the same rule.
  const adoptDisabled = ctx.saving || !refsAvailable || item.acceptedVisualMode === "keep_original";
  return el("section", { class: "sl-drawer-section sl-reference", "aria-labelledby": "sl-reference-img-title" }, [
    el("div", { class: "sl-cols" }, [
      el("div", { class: "sl-cols-media" }, [
        columnLabel(t(locale, "drawerRefImageLabel"), null, "sl-reference-img-title"),
        ctx.stage ? el("div", { class: "sl-preview-stage-wrap sl-reference-stage" }, [ctx.stage.node, ctx.stage.strip]) : null,
        hasVideo ? el("p", { class: "sl-field-note" }, t(locale, "drawerCoverOnly")) : null,
        ctx.editable
          ? el("button", {
              type: "button",
              class: "sl-secondary sl-ref-adopt",
              disabled: adoptDisabled || null,
              onclick: () => ctx.onAdoptSource?.()
            }, t(locale, "drawerAddSource"))
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
        el("dl", { class: "sl-drawer-facts" }, [
          el("div", { class: "sl-fact" }, [el("dt", null, t(locale, "drawerReferenceAccount")), el("dd", null, handle || t(locale, "stateUnknown"))]),
          source.sourceLabel && source.sourceLabel !== handle
            ? el("div", { class: "sl-fact" }, [el("dt", null, t(locale, "drawerReferenceWatch")), el("dd", null, source.sourceLabel)])
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
 * price line first, then the reference toggle, the ratio, and the one-off
 * instruction the next ask carries once.
 */
function renderBriefControls(locale, ctx) {
  const brief = ctx.imageBrief;
  const refsAvailable = ctx.imageRefsAvailable === true;
  const patch = (part) => ctx.onPatchImageBrief?.(part);
  const changed = () => ctx.onBriefChanged?.();
  const body = el("div", { class: "sl-brieftab" });
  body.appendChild(el("p", { class: "sl-field-note sl-brief-price" }, t(locale, brief.useSource ? "drawerBriefPricedEdit" : "drawerBriefPricedNew")));
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
  if (brief.oneOffOpen || brief.oneOff.trim()) {
    const area = el("textarea", {
      id: "sl-brief-once",
      class: "sl-drawer-caption sl-brief-once",
      rows: "2",
      placeholder: t(locale, "drawerBriefOncePlaceholder"),
      "aria-label": t(locale, "drawerBriefOnceLabel"),
      readonly: ctx.saving || null
    });
    area.value = brief.oneOff;
    area.addEventListener("input", () => patch({ oneOff: area.value }));
    // The in-effect note re-reads the buffer on redraw — a blur is when a
    // typing pause becomes the stated ask.
    area.addEventListener("blur", () => changed());
    body.appendChild(el("div", { class: "sl-brief-once-wrap" }, [
      area,
      el("p", { class: "sl-field-note" }, t(locale, "drawerBriefOnceSub")),
      el("label", { class: "sl-brief-save" }, [
        el("input", {
          type: "checkbox",
          checked: brief.saveOneOff || null,
          disabled: ctx.saving || null,
          onchange: (event) => patch({ saveOneOff: event.currentTarget.checked })
        }),
        el("span", null, t(locale, "drawerBriefOnceSave"))
      ])
    ]));
  } else {
    body.appendChild(el("button", {
      type: "button",
      class: "sl-brief-link",
      disabled: ctx.saving || null,
      onclick: () => { patch({ oneOffOpen: true }); changed(); }
    }, t(locale, "drawerBriefOnceOpen")));
  }
  const liveLayer = brief.oneOff.trim() ? "run" : (ctx.item?.effectiveInstructions?.image?.source ?? "default");
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
