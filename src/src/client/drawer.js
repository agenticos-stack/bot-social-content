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
 * `buffers` = `{ caption?: string, altText?: string, imageId?: string, instructions?: { image?, caption? } }`
 * for ONE item. Returns which parts differ from the saved item.
 */
export function dirtyParts(item, buffers = {}) {
  const caption = buffers.caption !== undefined && buffers.caption !== (item?.caption || "");
  const altText = buffers.altText !== undefined && buffers.altText !== (item?.altText || "");
  const visual = typeof buffers.imageId === "string" && buffers.imageId !== (item?.generatedImage?.id ?? null);
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
    ...(dirty.visual ? { acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: buffers.imageId } : {}),
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
  const legacyVisual = !item?.generatedImage && (item?.acceptedVisualMode === "text_poster" || item?.acceptedVisualMode === "keep_original" || item?.posterStored);
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
 * onRequestPart("image"|"caption"), captionConflict?: { caption }, onResolveCaptionConflict("keep"|"use") }`.
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
    const frame = el("div", { class: `sl-output-frame ${extraClass}` });
    if (generated?.ready === true) {
      const img = el("img", { class: "sl-pc-canvas", alt: generated.altText || t(locale, "drawerGeneratedImageAlt") });
      frame.appendChild(img);
      ctx.loadImage?.(generated, img, () => {
        img.replaceWith(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerGeneratedImageFailed")));
      });
    } else if (generated) {
      frame.appendChild(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, labelKey === "drawerImageAccepted" ? "drawerImageArriving" : "drawerCandidatePending")));
    } else {
      frame.appendChild(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerImageNone")));
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
  // Generating overlays this same frame. A ready candidate still sits beside
  // it. With nothing accepted, nothing generating, and no candidate there is
  // nothing to frame: a compact note keeps the next action visible.
  const acceptedSkel = imageBusy ? " sl-output-frame-skel" : "";
  const acceptedBlock = !accepted && !showCandidate && !imageBusy
    ? el("p", { class: "sl-field-note sl-output-empty", role: "status" }, t(locale, "drawerImageNone"))
    : el("div", { class: "sl-output-accepted" }, [
    el("div", { class: "sl-output-label" }, [
      el("strong", null, t(locale, "drawerImageAccepted")),
      staged ? el("span", { class: "sl-dest-tag" }, t(locale, "drawerCandidateStagedTag")) : null
    ]),
    accepted
      ? figure(accepted, "drawerImageAccepted", `sl-output-frame-accepted${acceptedSkel}`)
      : figure(null, "drawerImageAccepted", `sl-output-frame-empty${acceptedSkel}`),
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
  // agent": the footer says saved-but-not-submitted, and these lines agree
  // with it rather than implying a queue this request cannot establish.
  const unsubmitted = ctx.unsubmitted === true;
  const imageStatusLine =
    imgState === "requested"
      ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, unsubmitted ? "drawerRequestNotSubmitted" : "drawerImageRequested"))
      : null;

  // One request at a time per post: while a part is outstanding, the OTHER
  // part's button stays pressable but says what is pending, and pressing it
  // asks before anything replaces that request.
  const outstanding = pendingParts(item);
  const partButton = (part, labelKey, keepsKey, requested) => {
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
    return el("div", { class: "sl-part-action" }, [
      el("button", {
        type: "button",
        class: "sl-secondary",
        "data-part": part,
        "data-pending": other && !requested ? other : null,
        "data-requested": requested ? "true" : null,
        disabled: ctx.saving,
        title: note,
        onclick: () => ctx.onRequestPart?.(part)
      }, t(locale, labelKey)),
      el("span", { class: "sl-field-note" }, note)
    ]);
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

  const imageSection = el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-output-image-title" }, [
    el("h3", { id: "sl-output-image-title" }, t(locale, "drawerOutputImage")),
    el("div", { class: "sl-output-images" }, [acceptedBlock, candidateBlock]),
    altField,
    imageStatusLine,
    partButton("image", "drawerRegenerateImage", "drawerRegenerateImageKeeps", imgState === "requested" || imgState === "generating")
  ]);

  let captionBody;
  if (editable) {
    const note = el("p", { class: "sl-field-note", role: "status" });
    ctx.noteRef?.(note);
    const textarea = el("textarea", {
      id: "sl-drawer-caption-input",
      class: capState === "requested" ? "sl-drawer-caption sl-skel" : "sl-drawer-caption",
      rows: "5",
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
  const captionSection = el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-output-caption-title" }, [
    el("h3", { id: "sl-output-caption-title" }, t(locale, "drawerOutputCaption")),
    capState === "requested"
      ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, unsubmitted ? "drawerRequestNotSubmitted" : ((item.revision ?? 0) > 0 ? "drawerCaptionRequestedKeep" : "drawerCaptionRequested")))
      : null,
    ...captionBody,
    partButton("caption", "drawerRewriteCaption", "drawerRewriteCaptionKeeps", capState === "requested")
  ]);

  const intent = intentOf(item, buffers);
  const dests = recordedBindings(item);
  const destLine = dests.map((binding) => ctx.destinationLabel?.(binding) || binding).join(" · ");
  const pubHint = intent.publishMode === "schedule"
    ? t(locale, "drawerPublishHintSchedule")
    : intent.publishMode === "publish_now"
      ? t(locale, "drawerPublishHintNow")
      : t(locale, "drawerPublishHintDraft");
  const publicationSection = el("section", { class: "sl-drawer-section sl-pub", "aria-labelledby": "sl-output-publish-title" }, [
    el("h3", { id: "sl-output-publish-title" }, t(locale, "drawerPublishSection")),
    destLine
      ? el("p", { class: "sl-pub-dest" }, destLine)
      : el("p", { class: "sl-field-note" }, t(locale, "drawerPublishNeedsDestination")),
    el("div", { class: "sl-pub-radios", role: "radiogroup", "aria-label": t(locale, "publicationTiming") },
      [["save_draft", "publicationDraft"], ["publish_now", "publicationNow"], ["schedule", "publicationSchedule"]].map(([mode, key]) =>
        el("label", { class: "sl-pub-choice" }, [
          el("input", {
            type: "radio",
            name: "publicationMode",
            value: mode,
            checked: (intent.publishMode ?? "save_draft") === mode,
            disabled: !editable || ctx.saving,
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
            disabled: !editable || ctx.saving,
            oninput: (event) => ctx.onPublicationIntent?.({
              ...intent,
              publishMode: "schedule",
              publishLocalTime: event.currentTarget.value,
              timezone: intent.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
            })
          })
        ])
      : null,
    el("p", { class: "sl-field-note" }, pubHint)
  ]);

  return el("div", { class: "sl-drawer-panel-body" }, [imageSection, captionSection, publicationSection]);
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
    el("p", { class: "sl-field-note" }, t(locale, "drawerSourceCaption")),
    el("p", { class: "sl-drawer-caption-preview sl-reference-text" }, source.text || t(locale, "inboxNoSource")),
    source.permalink
      ? el("a", { href: source.permalink, target: "_blank", rel: "noopener noreferrer", class: "sl-receipt" }, t(locale, "drawerViewOriginal"))
      : null
  ]);
}

// ---------------------------------------------------------------------------
// 3. Instructions
// ---------------------------------------------------------------------------

/** ctx: `{ editable, buffers, policy, onInput(part, value), onReset(part) }`. */
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
  // Three different snapshots, each only when the projection carries it:
  // what produced the ACCEPTED output (recorded on the accepted asset or its
  // revision), what the PENDING request was made under, and — when neither
  // names the accepted output — what the last completed request used.
  const snapshot = (instructions, heading) =>
    el("div", { class: "sl-instructions-used" }, [
      el("strong", null, heading),
      el("p", { class: "sl-field-note" }, `${t(locale, "drawerInstructionsImage")}: ${instructions.image || t(locale, "drawerInstructionsNoDefault")}`),
      el("p", { class: "sl-field-note" }, `${t(locale, "drawerInstructionsCaption")}: ${instructions.caption || t(locale, "drawerInstructionsNoDefault")}`)
    ]);
  const currentRevision = (Array.isArray(item.revisionHistory) ? item.revisionHistory : []).find((entry) => entry.revision === item.revision);
  const acceptedUsed = item.generatedImage?.instructions ?? currentRevision?.instructions ?? null;
  const pending = generationMark(item.generation);
  const last = generationMark(item.lastGeneration);
  // Saved text-poster wording is explained, never rewritten for the owner.
  const legacyWording = [saved.image, defaults.image].some((text) => typeof text === "string" && LEGACY_POSTER_WORDING.test(text));
  return el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-instructions-title" }, [
    el("h3", { id: "sl-instructions-title" }, t(locale, "drawerTabInstructions")),
    el("p", { class: "sl-field-note" }, t(locale, "drawerInstructionsNote")),
    legacyWording ? el("p", { class: "sl-guidance sl-instructions-legacy", role: "note" }, t(locale, "drawerInstructionsLegacyPoster")) : null,
    part("image", "drawerInstructionsImage"),
    part("caption", "drawerInstructionsCaption"),
    acceptedUsed ? snapshot(acceptedUsed, t(locale, "drawerInstructionsAcceptedUsed")) : null,
    pending?.instructions
      ? snapshot(pending.instructions, pending.at ? t(locale, "drawerInstructionsPendingAt", { time: whenLabel(locale, pending.at) }) : t(locale, "drawerInstructionsPending"))
      : null,
    !acceptedUsed && !pending && last?.instructions
      ? snapshot(last.instructions, last.at ? t(locale, "drawerInstructionsLastUsed", { time: whenLabel(locale, last.at) }) : t(locale, "drawerHistoryInstructions"))
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
 * A receipt link appears only when the delivery row carries `receiptUrl`;
 * nothing here builds a permalink.
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

  const deliveryCard = (delivery) => {
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
    return el("div", { class: "sl-target-row sl-history-delivery" }, [
      el("div", { class: "sl-who" }, [
        el("strong", null, label(delivery.destinationBinding)),
        (delivery.revision ?? 0) > 0 ? el("span", null, t(locale, "drawerRevision", { n: delivery.revision })) : null
      ]),
      el("span", { class: `sl-state-badge sl-state-${delivery.outcome}` }, stateLabel(delivery.outcome)),
      scheduleLine(intent) ? el("p", { class: "sl-field-note sl-history-schedule" }, scheduleLine(intent)) : null,
      approvalLine(delivery) ? el("p", { class: "sl-field-note" }, approvalLine(delivery)) : null,
      receiptUrl
        ? el("a", { class: "sl-receipt", href: receiptUrl, target: "_blank", rel: "noopener noreferrer" }, t(locale, "viewReceipt"))
        : receiptIds ? null : el("p", { class: "sl-field-note" }, t(locale, "drawerHistoryNoReceipt")),
      receiptIds ? el("p", { class: "sl-field-note sl-history-receipt" }, receiptIds) : null,
      checked ? el("p", { class: "sl-field-note" }, t(locale, "drawerHistoryChecked", { time: whenLabel(locale, checked) })) : null,
      !checked && delivery.filedAt ? el("p", { class: "sl-field-note" }, t(locale, "drawerHistoryFiledAt", { time: whenLabel(locale, delivery.filedAt) })) : null,
      guidance || fallbackGuidance ? el("p", { class: "sl-guidance" }, guidance || fallbackGuidance) : null
    ]);
  };

  const sections = [];
  if (deliveries.length || earlier.length) {
    sections.push(el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-history-deliveries" }, [
      el("h3", { id: "sl-history-deliveries" }, t(locale, "drawerHistoryDeliveries")),
      ...deliveries.map(deliveryCard),
      ...earlier.map((pub) => el("div", { class: "sl-target-row sl-history-earlier" }, [
        el("div", { class: "sl-who" }, [
          el("strong", null, label(pub.destinationBinding)),
          el("span", null, t(locale, "drawerRevision", { n: pub.revision }))
        ]),
        el("span", { class: `sl-state-badge sl-state-${pub.state}` }, `${t(locale, "drawerHistoryEarlier")} · ${stateLabel(pub.state)}`),
        scheduleLine(pub.intent) ? el("p", { class: "sl-field-note sl-history-schedule" }, scheduleLine(pub.intent)) : null,
        OUTCOME_GUIDANCE_KEYS[pub.state] ? el("p", { class: "sl-guidance" }, t(locale, OUTCOME_GUIDANCE_KEYS[pub.state])) : null
      ]))
    ]));
  }
  if (revisions.length) {
    sections.push(el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-history-revisions" }, [
      el("h3", { id: "sl-history-revisions" }, t(locale, "drawerHistoryRevisions")),
      el("ol", { class: "sl-history-list" }, [...revisions].reverse().map((entry) => el("li", null, [
        t(locale, "drawerHistoryVersionLine", { n: entry.revision, time: whenLabel(locale, entry.createdAt) }),
        " · ",
        t(locale, VISUAL_KEYS[entry.acceptedVisualMode] ?? "drawerHistoryVisualNone"),
        scheduleLine(entry.publicationIntent) ? ` · ${scheduleLine(entry.publicationIntent)}` : ""
      ].join(""))))
    ]));
  }
  if (request || images.length) {
    const parts = request?.needs
      ? request.needs.image && request.needs.caption ? "drawerHistoryPartBoth" : request.needs.image ? "drawerHistoryPartImage" : "drawerHistoryPartCaption"
      : null;
    sections.push(el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-history-generation" }, [
      el("h3", { id: "sl-history-generation" }, t(locale, "drawerHistoryGeneration")),
      request && parts
        ? el("p", { class: "sl-field-note" }, [
            t(locale, "drawerHistoryRequest", { parts: t(locale, parts), time: whenLabel(locale, request.at) }),
            " · ",
            t(locale, item.generation ? "drawerHistoryPending" : "drawerHistoryDone")
          ].join(""))
        : null,
      images.length
        ? el("ul", { class: "sl-history-list" }, images.map((image) => {
            const status = IMAGE_STATUS_KEYS[image.status] ? image.status : image.id === item.generatedImage?.id ? "accepted" : null;
            // An earlier image stays history; bringing it back is the owner's
            // explicit choice and becomes a new revision when saved.
            const reusable = ctx.editable === true && image.ready === true && (image.status === "superseded" || image.status === "legacy") && image.id !== item.generatedImage?.id;
            return el("li", { "data-image-status": status }, [
              t(locale, "drawerHistoryImageRow", {
                time: whenLabel(locale, image.createdAt),
                state: [
                  t(locale, image.ready ? "drawerHistoryImageReady" : "drawerHistoryImageWaiting"),
                  status ? t(locale, IMAGE_STATUS_KEYS[status]) : null,
                  image.stale ? t(locale, "drawerHistoryImageStale") : null
                ].filter(Boolean).join(" · ")
              }),
              reusable
                ? el("button", { type: "button", class: "sl-secondary sl-history-use-image", "data-image-id": image.id, onclick: () => ctx.onUseImage?.(image.id) }, t(locale, "drawerHistoryUseImage"))
                : null
            ]);
          }))
        : null
    ]));
  }
  const legacyPoster = posterCanvas(locale, item);
  if (legacyPoster) {
    sections.push(el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-history-poster" }, [
      el("h3", { id: "sl-history-poster" }, t(locale, "drawerHistoryLegacyPoster")),
      el("div", { class: "sl-pc-media-slot sl-history-poster" }, [legacyPoster])
    ]));
  }
  if (!sections.length) return el("p", { class: "sl-field-note" }, t(locale, "drawerHistoryNone"));
  return el("div", { class: "sl-drawer-panel-body" }, sections);
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
