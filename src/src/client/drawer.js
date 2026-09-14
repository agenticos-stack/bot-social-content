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

import { el } from "./dom.js";
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
 * `buffers` = `{ caption?: string, imageId?: string, instructions?: { image?, caption? } }`
 * for ONE item. Returns which parts differ from the saved item.
 */
export function dirtyParts(item, buffers = {}) {
  const caption = buffers.caption !== undefined && buffers.caption !== (item?.caption || "");
  const visual = typeof buffers.imageId === "string" && buffers.imageId !== (item?.generatedImage?.id ?? null);
  const saved = item?.instructionOverrides ?? {};
  const instructions = ["image", "caption"].some((part) => {
    const draft = buffers.instructions?.[part];
    if (draft === undefined) return false;
    return normalizeOverride(draft) !== normalizeOverride(saved[part]);
  });
  return { caption, visual, instructions, any: caption || visual || instructions };
}

function normalizeOverride(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The `saveRevisions` entry for this item's unsaved caption and staged image,
 * or null when neither changed. Accepting a candidate is a revision like any
 * other: `acceptedVisualMode: "ai_refinement"` pinned to that image's id.
 */
export function revisionEntryFor(item, buffers = {}) {
  const dirty = dirtyParts(item, buffers);
  if (!dirty.caption && !dirty.visual) return null;
  return {
    batchItemId: item.id,
    expectedRevision: item.revision ?? 0,
    ...(dirty.caption ? { caption: buffers.caption } : {}),
    ...(dirty.visual ? { acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: buffers.imageId } : {})
  };
}

/** The `saveInstructionOverrides` input for this item's unsaved instruction edits, or null. */
export function instructionPatchFor(item, buffers = {}) {
  if (!dirtyParts(item, buffers).instructions) return null;
  const patch = { batchItemId: item.id };
  for (const part of ["image", "caption"]) {
    const draft = buffers.instructions?.[part];
    if (draft !== undefined) patch[part] = normalizeOverride(draft);
  }
  return patch;
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
  let review = { disabled: false, reason: null };
  if (saving) review = { disabled: true, reason: t(locale, "saving") };
  else if ((item?.revision ?? 0) === 0 && !caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsOutput") };
  else if (!caption) review = { disabled: true, reason: t(locale, "drawerReviewNeedsCaption") };
  else if (!staged && item?.generatedImage && item.generatedImage.ready !== true) review = { disabled: true, reason: t(locale, "drawerReviewImageNotArrived") };
  else if (!staged && !item?.generatedImage && !legacyVisual) review = { disabled: true, reason: t(locale, "drawerReviewNeedsImage") };
  return { save, review };
}

// ---------------------------------------------------------------------------
// 1. Output
// ---------------------------------------------------------------------------

/**
 * ctx: `{ editable, saving, buffers, loadImage(generated, img, onFail), highlighted,
 * noteRef(el), onCaptionInput(value), onStageImage(id|null), onRequestPart("image"|"caption") }`.
 */
export function renderOutputPanel(locale, item, ctx) {
  const buffers = ctx.buffers ?? {};
  const editable = ctx.editable === true;
  const accepted = item.generatedImage ?? null;
  const candidate = item.generatedCandidate ?? null;
  const staged = typeof buffers.imageId === "string" && buffers.imageId !== (accepted?.id ?? null) ? buffers.imageId : null;
  const imgState = imageState(item);
  const capState = captionState(item);

  const figure = (generated, labelKey, extraClass) => {
    const frame = el("div", { class: `sl-output-frame ${extraClass}` });
    if (generated.ready === true) {
      const img = el("img", { class: "sl-pc-canvas", alt: generated.altText || t(locale, "drawerGeneratedImageAlt") });
      frame.appendChild(img);
      ctx.loadImage?.(generated, img, () => {
        img.replaceWith(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerGeneratedImageFailed")));
      });
    } else {
      frame.appendChild(el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, labelKey === "drawerImageAccepted" ? "drawerImageArriving" : "drawerCandidatePending")));
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

  // The accepted image — what review files. Never the reference photo.
  const acceptedBlock = el("div", { class: "sl-output-accepted" }, [
    el("div", { class: "sl-output-label" }, [
      el("strong", null, t(locale, "drawerImageAccepted")),
      staged ? el("span", { class: "sl-dest-tag" }, t(locale, "drawerCandidateStagedTag")) : null
    ]),
    accepted
      ? figure(accepted, "drawerImageAccepted", "sl-output-frame-accepted")
      : el("div", { class: "sl-output-frame sl-output-frame-empty" }, [
          el("span", { class: "sl-pc-media-empty", role: "status" }, t(locale, "drawerImageNone"))
        ]),
    facts(accepted),
    !accepted && item.acceptedVisualMode === "keep_original"
      ? el("p", { class: "sl-field-note" }, t(locale, "drawerLegacySource"))
      : !accepted && (item.acceptedVisualMode === "text_poster" || (item.acceptedVisualMode == null && item.posterStored))
        ? el("p", { class: "sl-field-note" }, t(locale, "drawerLegacyVisual"))
        : null
  ]);

  // A newer image, shown BESIDE the accepted one — never in its place.
  const candidateBlock = candidate
    ? el("div", { class: "sl-output-candidate", role: "group", "aria-label": t(locale, candidate.ready ? "drawerCandidateReady" : "drawerCandidatePending") }, [
        el("div", { class: "sl-output-label" }, [
          el("strong", null, t(locale, candidate.ready ? "drawerCandidateReady" : "drawerCandidatePending"))
        ]),
        figure(candidate, "drawerCandidatePending", "sl-output-frame-candidate"),
        facts(candidate),
        el("p", { class: "sl-field-note" }, t(locale, staged === candidate.id ? "drawerCandidateStaged" : "drawerCandidateNote")),
        candidate.ready && editable
          ? staged === candidate.id
            ? el("button", { type: "button", class: "sl-secondary", disabled: ctx.saving, onclick: () => ctx.onStageImage?.(null) }, t(locale, "drawerKeepCurrent"))
            : el("button", { type: "button", class: "sl-primary sl-use-candidate", disabled: ctx.saving, onclick: () => ctx.onStageImage?.(candidate.id) }, t(locale, "drawerUseCandidate"))
          : null
      ])
    : null;

  const imageStatusLine =
    imgState === "requested" ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, "drawerImageRequested")) : null;

  const partButton = (part, labelKey, keepsKey, requested) =>
    editable
      ? el("div", { class: "sl-part-action" }, [
          el("button", {
            type: "button",
            class: "sl-secondary",
            "data-part": part,
            disabled: ctx.saving || requested,
            title: requested ? t(locale, "drawerPartAlreadyRequested") : t(locale, keepsKey),
            onclick: () => ctx.onRequestPart?.(part)
          }, t(locale, labelKey)),
          el("span", { class: "sl-field-note" }, t(locale, requested ? "drawerPartAlreadyRequested" : keepsKey))
        ])
      : null;

  const imageSection = el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-output-image-title" }, [
    el("h3", { id: "sl-output-image-title" }, t(locale, "drawerOutputImage")),
    el("div", { class: "sl-output-images" }, [acceptedBlock, candidateBlock]),
    imageStatusLine,
    partButton("image", "drawerRegenerateImage", "drawerRegenerateImageKeeps", imgState === "requested" || imgState === "generating")
  ]);

  let captionBody;
  if (editable) {
    const note = el("p", { class: "sl-field-note", role: "status" });
    ctx.noteRef?.(note);
    const textarea = el("textarea", {
      class: "sl-drawer-caption",
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
    captionBody = [
      ctx.highlighted ? el("p", { class: "sl-drawer-caption-preview" }, [ctx.highlighted]) : null,
      el("div", { class: "sl-field sl-drawer-composer" }, [textarea, note])
    ];
  } else {
    captionBody = [el("p", { class: "sl-drawer-caption-preview" }, [ctx.highlighted || item.caption || t(locale, "drawerCaptionNone")])];
  }
  const captionSection = el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-output-caption-title" }, [
    el("h3", { id: "sl-output-caption-title" }, t(locale, "drawerOutputCaption")),
    capState === "requested"
      ? el("p", { class: "sl-field-note sl-part-status", role: "status" }, t(locale, (item.revision ?? 0) > 0 ? "drawerCaptionRequestedKeep" : "drawerCaptionRequested"))
      : null,
    ...captionBody,
    partButton("caption", "drawerRewriteCaption", "drawerRewriteCaptionKeeps", capState === "requested")
  ]);

  return el("div", { class: "sl-drawer-panel-body" }, [imageSection, captionSection]);
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
  const used = generationMark(item.generation)?.instructions ?? generationMark(item.lastGeneration)?.instructions ?? null;
  const usedAt = item.generation?.at ?? item.lastGeneration?.at ?? null;
  return el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-instructions-title" }, [
    el("h3", { id: "sl-instructions-title" }, t(locale, "drawerTabInstructions")),
    el("p", { class: "sl-field-note" }, t(locale, "drawerInstructionsNote")),
    part("image", "drawerInstructionsImage"),
    part("caption", "drawerInstructionsCaption"),
    used
      ? el("div", { class: "sl-instructions-used" }, [
          el("strong", null, usedAt ? t(locale, "drawerInstructionsLastUsed", { time: whenLabel(locale, usedAt) }) : t(locale, "drawerHistoryInstructions")),
          el("p", { class: "sl-field-note" }, `${t(locale, "drawerInstructionsImage")}: ${used.image || t(locale, "drawerInstructionsNoDefault")}`),
          el("p", { class: "sl-field-note" }, `${t(locale, "drawerInstructionsCaption")}: ${used.caption || t(locale, "drawerInstructionsNoDefault")}`)
        ])
      : null
  ]);
}

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

const OUTCOME_GUIDANCE_KEYS = {
  held: "drawerHistoryOutcomeHeld",
  failed: "drawerHistoryOutcomeFailed",
  failed_safe: "drawerHistoryOutcomeFailed",
  unknown: "drawerHistoryOutcomeUnknown"
};

/**
 * ctx: `{ destinationLabel(binding), stateLabel(outcome), posterCanvas? }`.
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
    const checked = delivery.checkedAt ?? delivery.lastCheckedAt ?? null;
    return el("div", { class: "sl-target-row sl-history-delivery" }, [
      el("div", { class: "sl-who" }, [
        el("strong", null, label(delivery.destinationBinding)),
        (delivery.revision ?? 0) > 0 ? el("span", null, t(locale, "drawerRevision", { n: delivery.revision })) : null
      ]),
      el("span", { class: `sl-state-badge sl-state-${delivery.outcome}` }, stateLabel(delivery.outcome)),
      scheduleLine(intent) ? el("p", { class: "sl-field-note sl-history-schedule" }, scheduleLine(intent)) : null,
      approvalLine(delivery) ? el("p", { class: "sl-field-note" }, approvalLine(delivery)) : null,
      delivery.receiptUrl
        ? el("a", { class: "sl-receipt", href: delivery.receiptUrl, target: "_blank", rel: "noopener noreferrer" }, t(locale, "viewReceipt"))
        : el("p", { class: "sl-field-note" }, t(locale, "drawerHistoryNoReceipt")),
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
        ? el("ul", { class: "sl-history-list" }, images.map((image) => el("li", null, t(locale, "drawerHistoryImageRow", {
            time: whenLabel(locale, image.createdAt),
            state: [
              t(locale, image.ready ? "drawerHistoryImageReady" : "drawerHistoryImageWaiting"),
              image.id === item.generatedImage?.id ? t(locale, "drawerHistoryImageAccepted") : null,
              image.stale ? t(locale, "drawerHistoryImageStale") : null
            ].filter(Boolean).join(" · ")
          }))))
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
