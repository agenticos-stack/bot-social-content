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
 */
export function dirtyParts(item, buffers = {}) {
  const caption = buffers.caption !== undefined && buffers.caption !== (item?.caption || "");
  const altText = buffers.altText !== undefined && buffers.altText !== (item?.altText || "");
  const visualImage = typeof buffers.imageId === "string" && buffers.imageId !== (item?.generatedImage?.id ?? null);
  const visualMode = buffers.visualMode !== undefined && buffers.visualMode !== (item?.acceptedVisualMode ?? null);
  const visual = visualImage || visualMode;
  const instructions = dirtyInstructionParts(item, buffers).length > 0;
  const publication = buffers.publicationIntent !== undefined && !intentsEqual(buffers.publicationIntent, item?.publicationIntent);
  return { caption, altText, visual, instructions, publication, any: caption || altText || visual || instructions || publication };
}

/** Which instruction parts (of `parts`) carry an unsaved edit. */
export function dirtyInstructionParts(item, buffers = {}, parts = ["image", "caption"]) {
  const saved = item?.instructionOverrides ?? {};
  return parts.filter((part) => {
    const draft = buffers.instructions?.[part];
    if (draft === undefined) return false;
    return normalizeOverride(draft) !== normalizeOverride(saved[part]);
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

function intentOf(item, buffers = {}) {
  return buffers.publicationIntent ?? item?.publicationIntent ?? { publishMode: "save_draft", latePolicy: "hold" };
}

function intentsEqual(a, b) {
  const left = a ?? {};
  const right = b ?? {};
  return (left.publishMode ?? "save_draft") === (right.publishMode ?? "save_draft")
    && (left.publishLocalTime ?? null) === (right.publishLocalTime ?? null)
    && (left.timezone ?? null) === (right.timezone ?? null);
}

function recordedBindings(item) {
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
        : { acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: buffers.imageId }
      : {}),
    ...(dirty.publication ? { publicationIntent: buffers.publicationIntent } : {})
  };
}

/**
 * The `saveInstructionOverrides` input for this item's unsaved instruction
 * edits, or null. `parts` narrows it (generation saves only the parts it is
 * about to use, leaving an unrelated edit unsaved).
 */
export function instructionPatchFor(item, buffers = {}, parts = ["image", "caption"]) {
  const dirty = dirtyInstructionParts(item, buffers, parts);
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

export function footerState(locale, item, { buffers = {}, saving = false } = {}) {
  const dirty = dirtyParts(item, buffers);
  const save = saving
    ? { disabled: true, reason: t(locale, "saving") }
    : !dirty.any
      ? { disabled: true, reason: t(locale, "drawerSaveNoChanges") }
      : { disabled: false, reason: null };

  const caption = (buffers.caption ?? item?.caption ?? "").trim();
  const staged = typeof buffers.imageId === "string" && buffers.imageId !== (item?.generatedImage?.id ?? null);
  const keepOriginal = buffers.visualMode === "keep_original" || item?.acceptedVisualMode === "keep_original";
  const legacyVisual = !item?.generatedImage && (item?.acceptedVisualMode === "text_poster" || keepOriginal || item?.posterStored);
  const intent = intentOf(item, buffers);
  const mode = intent.publishMode === "schedule" ? "schedule" : intent.publishMode === "publish_now" ? "publish_now" : "save_draft";
  const img = imageState(item);
  const cap = captionState(item);
  let review = { disabled: false, reason: null };
  if (saving) review = { disabled: true, reason: t(locale, "saving") };
  else if ((item?.revision ?? 0) === 0 && !caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsOutput") };
  else if (!caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsCaption") };
  else if (!staged && item?.generatedImage && item.generatedImage.ready !== true) review = { disabled: true, reason: t(locale, "drawerReviewImageNotArrived") };
  else if (!staged && !item?.generatedImage && !legacyVisual) review = { disabled: true, reason: t(locale, "drawerReviewNeedsImage") };
  else if (img === "requested" || img === "generating") review = { disabled: true, reason: t(locale, "drawerPublishBusyImage") };
  else if (cap === "requested") review = { disabled: true, reason: t(locale, "drawerPublishBusyCaption") };
  else if (!recordedBindings(item).length) review = { disabled: true, reason: t(locale, "drawerPublishNeedsDestination") };
  else if (mode === "save_draft") review = { disabled: true, reason: t(locale, "drawerPublishKeepDraft") };
  else if (mode === "schedule" && !(intent.publishLocalTime && intent.timezone)) review = { disabled: true, reason: t(locale, "drawerPublishNeedsTime") };
  const primary = { ...review, label: t(locale, mode === "schedule" ? "drawerSchedulePost" : "drawerPublishPost") };
  return { save, review, primary };
}

// ---------------------------------------------------------------------------
// 1. Output
// ---------------------------------------------------------------------------

/**
 * ctx: `{ editable, saving, buffers, loadImage(generated, img, onFail), highlighted,
 * noteRef(el), onCaptionInput(value), onAltTextInput(value), onStageImage(id|null),
 * onRequestPart("image"|"caption"), onPickUpload(file?), onAdoptUpload(), onAdoptReference(),
 * imageBrief?: { open, useSource, ratio, oneOffOpen, oneOff, saveOneOff },
 * imageRefsAvailable?: bool, onPatchImageBrief(patch), onBriefChanged(), onShowInstructions(),
 * uploadPreview?: { name }, captionConflict?: { caption }, onResolveCaptionConflict("keep"|"use") }`.
 *
 * `buffers` = `{ caption?, altText?, imageId?, visualMode?, imageSource?, instructions?,
 * publicationIntent?, imageBrief? }` — `imageBrief` stages the NEXT Generate ask
 * (reference toggle, aspect ratio, the one-off instruction); it is not content and
 * is never part of a Save.
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
  const showCandidate = Boolean(candidate && candidate.ready === true);

  const figure = (generated, labelKey, extraClass) => {
    const frame = el("div", { class: `sl-output-frame sl-output-thumb ${extraClass}` });
    if (generated?.ready === true) {
      const img = el("img", { class: "sl-pc-canvas", alt: generated.altText || t(locale, "drawerGeneratedImageAlt") });
      frame.appendChild(img);
      ctx.loadImage?.(generated, img, () => {
        img.replaceWith(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerGeneratedImageFailed")));
      });
    } else if (generated) {
      frame.appendChild(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, labelKey === "drawerImageAccepted" ? "drawerImageArriving" : "drawerCandidatePending")));
    } else if (!String(extraClass).includes("sl-output-frame-skel")) {
      frame.appendChild(el("span", { class: "sl-pc-media-empty sl-output-empty", role: "status" }, t(locale, "drawerImageNone")));
    }
    if (String(extraClass).includes("sl-output-frame-skel")) {
      frame.appendChild(el("span", { class: "sl-skel-label" }, t(locale, "drawerCandidatePending")));
    }
    return frame;
  };

  const facts = (generated) => {
    if (!generated) return null;
    const lines = [];
    if (generated.altText) lines.push(t(locale, "drawerGeneratedAlt", { alt: generated.altText }));
    if (generated.mimeType) lines.push(t(locale, "drawerImageFormat", { format: formatLabel(generated.mimeType) }));
    return lines.length ? el("p", { class: "sl-field-note" }, lines.join(" · ")) : null;
  };

  // The accepted image — what publish files. Never the reference photo.
  // Generating overlays this same frame, including an empty first slot.
  // A ready candidate still sits beside it. Idle or never-submitted stays
  // a compact note so the next action stays visible.
  const unsubmitted = ctx.unsubmitted === true;
  const liveOverlay = imageBusy && unsubmitted !== true;
  const compactEmpty = !accepted && !showCandidate && !liveOverlay;
  const acceptedSkel = accepted && liveOverlay ? " sl-output-frame-skel" : "";
  const acceptedBlock = compactEmpty
    ? el("p", { class: "sl-field-note sl-output-empty", role: "status" }, t(locale, "drawerImageNone"))
    : el("div", { class: "sl-output-accepted" }, [
    accepted || showCandidate
      ? el("div", { class: "sl-output-label" }, [
          el("strong", null, t(locale, "drawerImageAccepted")),
          staged ? el("span", { class: "sl-dest-tag" }, t(locale, "drawerCandidateStagedTag")) : null
        ])
      : null,
    accepted
      ? figure(accepted, "drawerImageAccepted", `sl-output-frame-accepted${acceptedSkel}`)
      : figure(null, "drawerImageAccepted", liveOverlay ? "sl-output-frame-skel" : "sl-output-frame-empty"),
    facts(accepted),
    // The server cannot vouch for which image this revision accepted: say so
    // and let the owner accept it again explicitly (a new revision).
    accepted && item.acceptedGeneratedMediaProvenance === "unknown"
      ? el("div", { class: "sl-guidance sl-provenance-unknown", role: "note" }, [
          el("p", null, t(locale, "reviewImageReviewRequired")),
          editable && accepted.ready === true
            ? el("button", { type: "button", class: "sl-secondary", "data-action": "reaccept-image", disabled: ctx.saving, onclick: () => ctx.onReacceptImage?.(accepted.id) }, t(locale, "reviewReacceptImage"))
            : null
        ])
      : null,
    !accepted && item.acceptedVisualMode === "keep_original"
      ? el("p", { class: "sl-field-note" }, t(locale, "drawerLegacySource"))
      : !accepted && (item.acceptedVisualMode === "text_poster" || (item.acceptedVisualMode == null && item.posterStored))
        ? el("p", { class: "sl-field-note" }, t(locale, "drawerLegacyVisual"))
        : null
  ]);

  // A ready candidate sits BESIDE the accepted image — never in its place.
  // A not-ready candidate is generating: overlay the accepted/empty frame
  // instead of drawing a second empty tile.
  const candidateBlock = showCandidate
    ? el("div", { class: "sl-output-candidate", role: "group", "aria-label": t(locale, "drawerCandidateReady") }, [
        el("div", { class: "sl-output-label" }, [
          el("strong", null, t(locale, "drawerCandidateReady"))
        ]),
        figure(candidate, "drawerCandidatePending", "sl-output-frame-candidate"),
        facts(candidate),
        el("p", { class: "sl-field-note" }, t(locale, staged === candidate.id ? "drawerCandidateStaged" : candidate.status === "legacy" ? "drawerCandidateLegacy" : "drawerCandidateNote")),
        editable
          ? staged === candidate.id
            ? el("button", { type: "button", class: "sl-secondary", disabled: ctx.saving, onclick: () => ctx.onStageImage?.(null) }, t(locale, "drawerKeepCurrent"))
            : el("button", { type: "button", class: "sl-primary sl-use-candidate", disabled: ctx.saving, onclick: () => ctx.onStageImage?.(candidate.id) }, t(locale, "drawerUseCandidate"))
          : null
      ])
    : null;

  // A part the platform confirmed was never submitted is not "waiting for the
  // agent": the footer says saved-but-not-submitted, and this line agrees
  // with it rather than implying a queue this request cannot establish.
  // In-flight generation is the overlay, not a second homework line.
  const imageStatusLine =
    imgState === "requested" && unsubmitted
      ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, "drawerRequestNotSubmitted"))
      : null;

  // One request at a time per post: while a part is outstanding, the OTHER
  // part's button stays pressable but says what is pending, and pressing it
  // asks before anything replaces that request.
  const outstanding = pendingParts(item);
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
      "data-src": extra.src ?? null,
      "data-pending": other && !requested ? other : null,
      "data-requested": requested ? "true" : null,
      "aria-pressed": extra.pressed ?? null,
      disabled: ctx.saving,
      title: note,
      onclick: extra.onclick ?? (() => ctx.onRequestPart?.(part))
    }, t(locale, labelKey));
    return extra.bare ? button : el("div", { class: "sl-part-action" }, [button]);
  };

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

  const imageSource = buffers.imageSource ?? "generate";
  const sourceRow = editable
    ? el("div", { class: "sl-src-seg", role: "group", "aria-label": t(locale, "drawerSrcGroup") }, [
        partButton("image", "drawerRegenerateImage", "drawerRegenerateImageKeeps", imgState === "requested" || imgState === "generating", {
          bare: true,
          className: "sl-secondary sl-src-btn",
          src: "generate",
          pressed: imageSource === "generate" ? "true" : "false"
        }),
        el("button", {
          type: "button",
          class: "sl-secondary sl-src-btn",
          "data-src": "upload",
          "aria-pressed": imageSource === "upload" ? "true" : "false",
          disabled: ctx.saving,
          onclick: () => ctx.onPickUpload?.()
        }, t(locale, "drawerSrcUpload")),
        el("button", {
          type: "button",
          class: "sl-secondary sl-src-btn",
          "data-src": "reference",
          "aria-pressed": imageSource === "reference" || buffers.visualMode === "keep_original" || item.acceptedVisualMode === "keep_original" ? "true" : "false",
          disabled: ctx.saving,
          onclick: () => ctx.onAdoptReference?.()
        }, t(locale, "drawerSrcReference"))
      ])
    : null;
  // Arrow keys move along the segment — the same roving the tablist uses.
  sourceRow?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...sourceRow.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault?.();
    buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length].focus();
  });

  /*
   * The image brief — the settings a Generate ask is made under. It hangs
   * under the source segment and only exists while Generate is the picked
   * source: "Use reference" adopts the post's picture outright and "Upload"
   * stages a file, and neither is a generation. The block shows the RESOLVED
   * brief (the owner's staged choices over the configured defaults), so the
   * summary line always names exactly what a press of Generate would ask for.
   */
  const brief = ctx.imageBrief ?? { open: false, useSource: true, ratio: "4:5", oneOffOpen: false, oneOff: "", saveOneOff: false };
  const refsAvailable = ctx.imageRefsAvailable === true;
  let briefBlock = null;
  if (editable && imageSource === "generate") {
    const patch = (part) => ctx.onPatchImageBrief?.(part);
    const changed = () => ctx.onBriefChanged?.();
    const summaryLine = [
      brief.useSource ? t(locale, "drawerBriefOn") : t(locale, "drawerBriefOff"),
      brief.ratio,
      brief.oneOff.trim() ? t(locale, "drawerBriefOnceLabel") : null
    ].filter(Boolean).join(" · ");

    const details = el("details", { class: "sl-brief", open: brief.open || null });
    details.addEventListener("toggle", () => {
      if (details.open !== brief.open) patch({ open: details.open });
    });
    details.appendChild(el("summary", { class: "sl-brief-head" }, [
      el("span", { class: "sl-brief-caret", "aria-hidden": "true" }, "›"),
      el("span", { class: "sl-brief-title" }, `${t(locale, "drawerBriefTitle")} — ${summaryLine}`),
      el("span", { class: "sl-brief-chip" }, t(locale, brief.useSource ? "drawerBriefPricedEdit" : "drawerBriefPricedNew"))
    ]));

    const body = el("div", { class: "sl-brief-body" });
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
        class: "sl-drawer-caption sl-brief-once",
        rows: "2",
        placeholder: t(locale, "drawerBriefOncePlaceholder"),
        "aria-label": t(locale, "drawerBriefOnceLabel"),
        readonly: ctx.saving || null
      });
      area.value = brief.oneOff;
      area.addEventListener("input", () => patch({ oneOff: area.value }));
      // The summary and in-effect lines re-read the buffer on redraw — a blur
      // is when a typing pause becomes the stated ask.
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
    const liveLayer = brief.oneOff.trim() ? "run" : (item.effectiveInstructions?.image?.source ?? "default");
    const LAYER_KEYS = { run: "drawerLayerRun", post: "drawerLayerPost", default: "drawerLayerGadget", builtin: "drawerLayerBuiltin" };
    body.appendChild(el("p", { class: "sl-field-note" }, [
      `${t(locale, "drawerBriefInEffect")} ${t(locale, LAYER_KEYS[liveLayer] ?? "drawerLayerGadget")} · `,
      el("button", { type: "button", class: "sl-brief-link", onclick: () => ctx.onShowInstructions?.() }, t(locale, "drawerBriefEditIns"))
    ]));
    details.appendChild(body);
    briefBlock = details;
  }
  const uploadPreview = ctx.uploadPreview;
  const uploadBlock = imageSource === "upload" && uploadPreview
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
  // Rewrite caption is a quiet inline action beside the label, not a second
  // full-width button competing with the source segment below it.
  const captionSection = el("section", { class: "sl-drawer-section sl-output-copy", "aria-labelledby": "sl-output-caption-title" }, [
    el("div", { class: "sl-output-label" }, [
      el("h3", { id: "sl-output-caption-title" }, t(locale, "drawerOutputCaption")),
      partButton("caption", "drawerRewriteCaption", "drawerRewriteCaptionKeeps", capState === "requested", { bare: true, className: "sl-brief-link" })
    ]),
    capState === "requested" && unsubmitted
      ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, "drawerRequestNotSubmitted"))
      : null,
    ...captionBody
  ]);

  // Panel order follows the accepted mockup: compose, status, candidate
  // actions, source segment, brief, upload. Publication timing lives in the
  // sheet foot (renderPublicationControls), not the tab body.
  return el("div", { class: "sl-drawer-panel-body" }, [
    el("div", { class: "sl-output-compose" }, [
      el("div", { class: "sl-output-images" }, [acceptedBlock]),
      captionSection
    ]),
    imageStatusLine,
    candidateBlock,
    altField,
    sourceRow,
    briefBlock,
    uploadBlock
  ]);
}

/*
 * The sheet foot's publication controls, per the accepted mockup: the
 * destination line (when destinations are connected), the three-way timing
 * segment, and the schedule field when Schedule is picked. Rendered by the
 * drawer's footer builder so the choice stays visible on every tab; the
 * matching hint sentence comes from publicationHint.
 */
export function renderPublicationControls(locale, item, ctx = {}) {
  const intent = intentOf(item, ctx.buffers ?? {});
  const dests = recordedBindings(item);
  const destLine = dests.map((binding) => ctx.destinationLabel?.(binding) || binding).join(" · ");
  return [
    destLine ? el("p", { class: "sl-pub-dest" }, destLine) : null,
    el("div", { class: "sl-pub-radios", role: "radiogroup", "aria-label": t(locale, "publicationTiming") },
      [["save_draft", "publicationDraft"], ["publish_now", "publicationNow"], ["schedule", "publicationSchedule"]].map(([mode, key]) =>
        el("label", { class: "sl-pub-choice" }, [
          el("input", {
            type: "radio",
            name: "publicationMode",
            value: mode,
            checked: (intent.publishMode ?? "save_draft") === mode,
            disabled: !ctx.editable || ctx.saving,
            onchange: () => ctx.onPublicationIntent?.({
              publishMode: mode,
              publishLocalTime: null,
              timezone: mode === "schedule" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
              utcOffsetMinutes: null,
              latePolicy: "hold"
            })
          }),
          t(locale, key)
        ]))),
    intent.publishMode === "schedule"
      ? el("label", { class: "sl-pub-when" }, [
          el("span", null, t(locale, "publicationLocalTime")),
          el("input", {
            type: "datetime-local",
            id: "sl-drawer-publish-when",
            value: intent.publishLocalTime || "",
            disabled: !ctx.editable || ctx.saving,
            // change, not input: the footer rebuilds on each patch, and an
            // input listener would rebuild the control mid-edit.
            onchange: (event) => ctx.onPublicationIntent?.({
              ...intent,
              publishMode: "schedule",
              publishLocalTime: event.currentTarget.value,
              timezone: intent.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
            })
          })
        ])
      : null
  ].filter(Boolean);
}

/* What the picked timing means, in owner words — the footer's note line when
   no stronger reason (a disabled action's explanation) takes the slot. */
export function publicationHint(locale, item, buffers = {}) {
  const intent = intentOf(item, buffers);
  return intent.publishMode === "schedule"
    ? t(locale, "drawerPublishHintSchedule")
    : intent.publishMode === "publish_now"
      ? t(locale, "drawerPublishHintNow")
      : t(locale, "drawerPublishHintDraft");
}

function formatLabel(mimeType) {
  const known = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
  return known[mimeType] ?? mimeType;
}

// ---------------------------------------------------------------------------
// 2. Reference
// ---------------------------------------------------------------------------

/** ctx: `{ stage: { node, strip } | null }` — the existing carousel stage with its own recovery. */
export function renderReferencePanel(locale, item, ctx = {}) {
  const source = item.sourceItem;
  if (!source) return el("p", { class: "sl-field-note" }, t(locale, "drawerReferenceNoSource"));
  const handle = typeof source.authorHandle === "string" && source.authorHandle.trim()
    ? (source.authorHandle.startsWith("@") ? source.authorHandle : `@${source.authorHandle}`)
    : source.sourceLabel || "";
  const hasVideo = (source.media ?? []).some((media) => media?.kind === "video");
  return el("section", { class: "sl-drawer-section sl-reference", "aria-labelledby": "sl-reference-title" }, [
    el("div", { class: "sl-output-label" }, [
      el("h3", { id: "sl-reference-title" }, t(locale, "drawerSourceReference")),
      el("span", { class: "sl-reference-badge" }, t(locale, "drawerReferenceOnly"))
    ]),
    el("dl", { class: "sl-drawer-facts" }, [
      el("div", { class: "sl-fact" }, [el("dt", null, t(locale, "drawerReferenceAccount")), el("dd", null, handle || t(locale, "stateUnknown"))]),
      source.sourceLabel && source.sourceLabel !== handle
        ? el("div", { class: "sl-fact" }, [el("dt", null, t(locale, "drawerReferenceWatch")), el("dd", null, source.sourceLabel)])
        : null
    ]),
    ctx.stage ? el("div", { class: "sl-preview-stage-wrap sl-reference-stage" }, [ctx.stage.node, ctx.stage.strip]) : null,
    hasVideo ? el("p", { class: "sl-field-note" }, t(locale, "drawerCoverOnly")) : null,
    // Adopting the source image happens in exactly one place: the Post tab's
    // "Use reference" source control. This panel is inspection only.
    el("span", { class: "sl-field-label" }, t(locale, "drawerSourceCaption")),
    el("p", { class: "sl-drawer-caption-preview sl-reference-text" }, source.text || t(locale, "inboxNoSource")),
    source.permalink
      ? el("a", { href: source.permalink, target: "_blank", rel: "noopener noreferrer", class: "sl-receipt" }, t(locale, "drawerViewOriginal"))
      : null
  ]);
}

// ---------------------------------------------------------------------------
// 3. Instructions
// ---------------------------------------------------------------------------

/** ctx: `{ editable, buffers, policy, builtinImage?, runInstruction?, onInput(part, value), onReset(part) }`. */
export function renderInstructionsPanel(locale, item, ctx = {}) {
  const buffers = ctx.buffers ?? {};
  const saved = item.instructionOverrides ?? {};
  const defaults = { image: ctx.policy?.posterPrompt ?? "", caption: ctx.policy?.contentPrompt ?? "" };
  const part = (key, labelKey) => {
    const draft = buffers.instructions?.[key];
    const value = draft !== undefined ? draft : (saved[key] ?? "");
    const own = normalizeOverride(value) !== null;
    const inputId = `sl-instructions-${key}`;
    const textarea = el("textarea", {
      id: inputId,
      class: "sl-drawer-caption sl-instructions-input",
      rows: "4",
      placeholder: t(locale, "drawerInstructionsPlaceholder"),
      readonly: ctx.editable ? null : true
    });
    textarea.value = value;
    textarea.addEventListener("input", () => ctx.onInput?.(key, textarea.value));
    return el("div", { class: "sl-field sl-instructions-part" }, [
      el("div", { class: "sl-output-label" }, [
        el("label", { for: inputId }, t(locale, labelKey)),
        el("span", { class: "sl-dest-tag" }, t(locale, own ? "drawerInstructionsPost" : "drawerInstructionsDefault"))
      ]),
      textarea,
      el("p", { class: "sl-field-note" }, defaults[key]
        ? t(locale, "drawerInstructionsDefaultText", { text: defaults[key] })
        : t(locale, "drawerInstructionsNoDefault")),
      ctx.editable
        ? el("button", {
            type: "button",
            class: "sl-secondary sl-instructions-reset",
            "data-part": key,
            disabled: !own,
            onclick: () => ctx.onReset?.(key)
          }, t(locale, "drawerInstructionsReset"))
        : null
    ]);
  };
  /*
   * The image instruction's four layers, made visible. Each row names the
   * layer and what it currently says ("Not set — the layer above applies");
   * the "In effect" chip sits on the layer the next Generate ask would
   * actually use — the staged one-off first, then this post's override, then
   * the saved default, then the built-in floor.
   */
  const imageDraft = buffers.instructions?.image !== undefined ? buffers.instructions.image : (saved.image ?? "");
  const layerRows = [
    { key: "builtin", label: "drawerLayerBuiltin", text: ctx.builtinImage ?? "" },
    { key: "default", label: "drawerLayerGadget", text: defaults.image },
    { key: "post", label: "drawerLayerPost", text: normalizeOverride(imageDraft) ?? "" },
    { key: "run", label: "drawerLayerRun", text: typeof ctx.runInstruction === "string" ? ctx.runInstruction.trim() : "" }
  ];
  const liveKey = [...layerRows].reverse().find((row) => row.text)?.key ?? "builtin";
  const layerStack = el("div", { class: "sl-layers", "aria-label": t(locale, "drawerInstructionsImage") }, layerRows.map((row) =>
    el("div", { class: `sl-layer${row.key === liveKey ? " sl-layer-live" : ""}` }, [
      el("div", { class: "sl-layer-top" }, [
        el("span", { class: "sl-layer-name" }, t(locale, row.label)),
        row.key === liveKey ? el("span", { class: "sl-dest-tag sl-layer-chip" }, t(locale, "drawerLayerInEffect")) : null
      ]),
      el("p", { class: `sl-layer-text${row.text ? "" : " sl-layer-none"}` }, row.text || t(locale, "drawerLayerNone"))
    ])
  ));
  /*
   * The panel is the layer stack, one image editor, the caption editor behind
   * a disclosure, and the pending request's snapshot — nothing else. Snapshots
   * of what produced the accepted output and of the last completed request
   * are history; they render on the History tab (renderHistoryPanel).
   */
  const pending = generationMark(item.generation);
  const captionDraft = buffers.instructions?.caption !== undefined ? buffers.instructions.caption : (saved.caption ?? "");
  const captionOwn = normalizeOverride(captionDraft) !== null;
  // Saved text-poster wording is explained, never rewritten for the owner.
  const legacyWording = [saved.image, defaults.image].some((text) => typeof text === "string" && LEGACY_POSTER_WORDING.test(text));
  return el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-instructions-title" }, [
    el("h3", { id: "sl-instructions-title" }, t(locale, "drawerTabInstructions")),
    el("p", { class: "sl-field-note" }, t(locale, "drawerInstructionsNote")),
    legacyWording ? el("p", { class: "sl-guidance sl-instructions-legacy", role: "note" }, t(locale, "drawerInstructionsLegacyPoster")) : null,
    layerStack,
    part("image", "drawerInstructionsImage"),
    el("details", { class: "sl-brief sl-instructions-disclosure" }, [
      el("summary", { class: "sl-brief-head" }, [
        el("span", { class: "sl-brief-caret", "aria-hidden": "true" }, "›"),
        el("span", { class: "sl-brief-title" }, t(locale, "drawerInstructionsCaption")),
        el("span", { class: "sl-dest-tag" }, t(locale, captionOwn ? "drawerInstructionsPost" : "drawerInstructionsDefault"))
      ]),
      el("div", { class: "sl-brief-body" }, [part("caption", "drawerInstructionsCaptionEdit")])
    ]),
    pending?.instructions
      ? instructionSnapshot(locale, pending.instructions, pending.at ? t(locale, "drawerInstructionsPendingAt", { time: whenLabel(locale, pending.at) }) : t(locale, "drawerInstructionsPending"), pending)
      : null
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
