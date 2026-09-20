// Social Content client — the sandboxed gadget entry point (TASK-203).
//
// Bundled by scripts/pack-social-content-client.mjs into the single
// `client.js` the archive ships (PAT-002). Runs inside the sandbox iframe
// gadget-sandbox-html.ts composes: opaque origin, `connect-src 'none'`
// (SEC-002), `globalThis.gadget` is the capnweb stub to this instance's
// facet server, theme tokens and `<html lang>` are injected by the host
// before this script runs.
//
// This module is the only one that touches `document`/`globalThis.gadget`
// at the top level; every other module either holds pure state
// (collection.js, steps.js) or draws into an element it is handed
// (poster.js, steps.js render functions).

import {
  applySelection,
  clearNotice,
  clearSelection as clearCollectionSelection,
  createCollectionState,
  mergeScanResult,
  renderCollection,
  selectedIds,
  setContinuing,
  setFilter,
  setItems,
  setLastCheckedAt,
  setLoading,
  setNotice,
  setSearch,
  setSourceFilter
} from "./collection.js";
import { el, icon, relativeLabel, replace } from "./dom.js";
import { resolveLocale, t } from "./i18n.js";
import { classifyRefreshOutcome } from "../../refresh-outcome.js";
import { createRpc, loadGeneratedImageAsBlobUrl, loadMediaAsBlobUrl } from "./rpc.js";
import { createMediaRail } from "./preview-media.js";
import { createImageAcceptance } from "./image-acceptance.js";
import { newGrantRequestId, parseGadgetDoorsChangedMessage, parseGadgetGrantResultMessage } from "../../grant-request.js";
import {
  gadgetAgentIntentMessage,
  gadgetTopupMessage,
  newTopupRequestId,
  parseGadgetHostFeaturesMessage,
  parseGadgetTopupResultMessage
} from "../../agent-intent.js";
import { renderPosterImage } from "./poster.js";
import { confirmReviewSubset, confirmUnsavedNavigation } from "./navigation.js";
import {
  DRAWER_FOOTER_HINT_ID,
  captionConflictFor,
  confirmDrawerChoice,
  destinationBlock,
  dirtyInstructionParts,
  dirtyParts,
  pendingParts,
  drawerPanelId,
  drawerTabId,
  footerState,
  instructionDefaultsOf,
  instructionPatchFor,
  publicationHint,
  recordedBindings,
  renderDrawerTablist,
  renderHistoryPanel,
  renderInstructionsPanel,
  renderOutputPanel,
  renderPublishControls,
  renderReferencePanel,
  revisionEntryFor,
  pagesOfItem,
  workingPages,
  REGEN_SUGGESTION_KEYS
} from "./drawer.js";
import { detectProtectedLiterals, generationDisplayStage, generationMark, itemPresentation, platformStage, postFiled, sourceImageReferences } from "../../model.js";
import {
  classifyReviewSelection,
  clearCardMenu,
  clearInboxSelection,
  createInboxState,
  isEditableItem,
  renderInbox,
  selectedInboxItems,
  setCardMenu,
  setCardMenuConfirm,
  setInboxFilter,
  setInboxLoading,
  setInboxNotice,
  setInboxSourceItems,
  setInboxSummaries,
  toggleInboxItem
} from "./inbox.js";
import {
  applyPublishState,
  createSetupDraft,
  draftFromConfig,
  createWizardState,
  goToStep as goToWizardStep,
  isRefusalResult,
  publicationStateSummary,
  refusalMessage,
  renderPublish,
  releaseReviewImages,
  renderSetup,
  resumeBatch,
  setPublishError,
  setPublishIntent,
  setSubmitting,
  setWizardError,
  toConfigPayload,
  togglePublishBinding
} from "./steps.js";

const WIZARD_BACK_TARGET = { publish: "select" };

// Phase → i18n key for the drawer's state line (the shared policy's phases).
const PHASE_STATE_KEYS = {
  queued: "stateQueued",
  regenerating: "stateRegenerating",
  draft: "stateDraft",
  in_review: "stateInReview",
  scheduled: "stateScheduled",
  published: "statePublished",
  attention: "stateAttention"
};

import sharedTokens from '@agenticos-dev/bot-shell/tokens.css';
import sharedComponents from '@agenticos-dev/bot-shell/components.css';
import { createToaster } from '@agenticos-dev/bot-shell/client/toast.js';

const BASE_STYLE = `${sharedTokens}\n${sharedComponents}
/*
 * Settings — the accepted v2 contract: borderless sections separated by
 * spacing, a 150px-label fieldrow grid, one monitoring switch, rounded
 * controls. Structure carries no rules; borders stay on controls and data.
 */
.sl-setup-fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.sl-setup-fields:disabled { opacity: 1; }
.sl-setup { display: flex; flex-direction: column; gap: 22px; max-width: 640px; }
.sl-setup-desc { margin: 2px 0 0; font-size: 11.5px; color: var(--sl-ink-2); }
.sl-setup-section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.sl-setup-sect-title { margin: 0; font-size: 12.5px; font-weight: 600; }
.sl-setup-sect-hint { margin: 0; font-size: 11.5px; color: var(--sl-ink-2); }
.sl-setup .sl-field { display: flex; flex-direction: column; gap: 5px; margin: 0; }
.sl-setup .sl-field label { font-size: 11.5px; font-weight: 500; color: var(--sl-ink-2); }
.sl-setup .sl-field-note { font-size: 11px; }
.sl-setup-rows { display: flex; flex-direction: column; gap: 6px; }
.sl-setup-row { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--sl-ink-2); }
.sl-setup-dot { width: 6px; height: 6px; border-radius: 100%; background: var(--sl-success); flex: none; }
.sl-setup-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sl-setup-row .sl-chip { flex: none; }
.sl-setup-acts { display: flex; align-items: center; gap: 8px; }
.sl-fieldrow { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; align-items: center; }
.sl-fieldrow[hidden] { display: none; }
.sl-fieldrow-label { font-size: 11.5px; color: var(--sl-ink-2); }
.sl-fieldrow-ctrl { min-width: 0; }
.sl-ctl { width: 100%; min-height: 38px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); padding: 0 11px; background: var(--sl-surface); font-size: 13.5px; }
select.sl-ctl { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--sl-ink-4) 50%), linear-gradient(135deg, var(--sl-ink-4) 50%, transparent 50%); background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 32px; }
textarea.sl-ctl { min-height: 84px; padding: 10px 11px; resize: vertical; line-height: 1.5; }
input[type="time"].sl-ctl { width: 120px; }
.sl-switchrow { display: flex; align-items: center; gap: 12px; padding: 2px 0; }
.sl-switchrow-lab { font-size: 12.5px; font-weight: 600; }
.sl-switchrow-sub { display: block; font-size: 11.5px; font-weight: 400; color: var(--sl-ink-2); margin-top: 2px; }
.sl-toggle { position: relative; width: 40px; height: 23px; border-radius: 999px; border: 1px solid var(--sl-line-strong); background: var(--sl-surface-2); flex: none; padding: 0; }
.sl-toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 100%; background: var(--sl-surface); box-shadow: var(--sl-e-1); transition: translate .15s ease; }
.sl-toggle[aria-checked="true"] { background: var(--sl-ink); border-color: var(--sl-ink); }
.sl-toggle[aria-checked="true"]::after { translate: 17px 0; }
.sl-toggle:disabled { opacity: .45; cursor: not-allowed; }
.sl-quiet { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sl-quiet-switch { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; }
.sl-note { margin: 0; font-size: 11.5px; color: var(--sl-ink-2); }
.sl-note-warn { margin: 0; padding: 6px 9px; font-size: 11.5px; color: var(--sl-warning); background: color-mix(in srgb, var(--sl-warning) 10%, var(--sl-surface)); border-radius: var(--sl-radius-chip); }
@media (max-width: 560px) { .sl-fieldrow { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
:root {
  color-scheme: light;
  --sl-bg: var(--color-bg, #fafafa);
  --sl-surface: var(--color-surface, #fff);
  --sl-surface-2: var(--color-surface-2, #f4f4f5);
  --sl-line: var(--color-line, #e7e7ea);
  --sl-line-strong: var(--color-line-strong, #d9d9de);
  --sl-ink: var(--color-ink, #18181b);
  --sl-ink-2: var(--studio-v2-ink-2, #52525b);
  --sl-muted: var(--color-muted, #71717a);
  --sl-ink-4: var(--studio-v2-ink-4, #a1a1aa);
  --sl-accent: var(--color-accent, #f5b544);
  --sl-accent-strong: var(--color-accent-strong, #e09a2e);
  --sl-accent-soft: var(--color-accent-soft, #fdf5e4);
  --sl-danger: var(--color-danger, #df1b41);
  --sl-warning: var(--color-warning, #b26b00);
  --sl-success: var(--color-success, #0e8a5f);
  --sl-success-soft: var(--studio-v2-success-soft, #d8f6e8);
  --sl-selected: var(--studio-v2-selected, #f1f1f1);
  --sl-hover: var(--studio-v2-hover, #f6f6f6);
  --sl-radius-card: var(--studio-v2-radius-card, 12px);
  --sl-radius-panel: var(--studio-v2-radius-panel, 16px);
  --sl-radius-control: var(--studio-v2-radius-control, 8px);
  --sl-radius-chip: var(--studio-v2-radius-chip, 6px);
  --sl-e-1: 0 1px 2px rgba(24,24,27,.05);
  --sl-e-3: 0 2px 6px rgba(24,24,27,.08), 0 32px 64px -24px rgba(24,24,27,.35);
  /*
   * THE control scale. Every button, input, chip and tab in this sheet sizes
   * off one of these three -- nothing below declares a height of its own.
   * --bot-control-height is bot-shell's own hook for .bot-button/.bot-input;
   * it is pointed at the same scale instead of carrying a second number
   * that can drift from it.
   *
   * (No backticks anywhere in this stylesheet: it is a template literal.)
   */
  --sl-h-control: 36px;
  --sl-h-compact: 28px;
  --sl-h-touch: 44px;
  --bot-control-height: var(--sl-h-control);
  --sl-radius-row: var(--studio-v2-radius-row, 8px);
  --sl-focus: var(--gadget-focus, var(--sl-ink));
  --sl-font: var(--font-sans, system-ui, sans-serif);
}
/* Coarse pointers fold control and compact into the one touch size, so a
   28px chip and a 36px input alike grow to 44px without a second override
   anywhere else in this file. */
@media (pointer: coarse) {
  :root { --sl-h-control: var(--sl-h-touch); --sl-h-compact: var(--sl-h-touch); }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--sl-bg); color: var(--sl-ink); font: 13.5px/1.55 var(--sl-font); }
/* The canvas root sits on the surface token (white), not the page's own
   off-white --sl-bg -- ships in the gadget's own stylesheet so it applies
   wherever the archive runs, not only in the preview host's chrome.
   min-height keeps the surface filling the viewport even when .sl-app's
   content is shorter, so there is no seam of --sl-bg below it. */
#gadget-root { background: var(--sl-surface); min-height: 100dvh; }
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--sl-focus); outline-offset: 2px;
}
.sl-app { max-width: 1080px; margin: 0 auto; padding: 20px clamp(16px, 3vw, 36px) 96px; }
.sl-titleline { margin-bottom: 18px; }
.sl-titleline h1 { margin: 0 0 6px; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
.sl-main-nav { display:flex; align-items:center; gap:16px; border-bottom:1px solid var(--sl-line); margin-bottom:20px; }
.sl-main-nav > button { min-height:var(--sl-h-control); padding:8px 0; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--sl-muted); font-weight:600; }
.sl-main-nav > button[aria-pressed=true] { border-bottom-color:var(--sl-ink); color:var(--sl-ink); }
.sl-main-actions { margin-left:auto; display:flex; gap:4px; }
/*
 * The BUTTON carries its own size, not the row it happens to sit in.
 *
 * These rules lived on a .sl-main-actions .sl-icon-action selector, so the
 * same class used anywhere else -- the drawer's close, for one -- came out
 * unsized. A component that only works inside one parent is not a component.
 *
 * (No backticks anywhere in this stylesheet: it is a template literal.)
 */
.sl-icon-action { width:var(--sl-h-control); height:var(--sl-h-control); border:0; border-radius:var(--sl-radius-control); background:transparent; color:var(--sl-muted); display:grid; place-items:center; cursor:pointer; flex-shrink:0; }
.sl-icon-action svg { width:18px; height:18px; display:block; }
.sl-icon-action.is-busy svg { animation: sl-spin 900ms linear infinite; }
.sl-icon-action.is-busy:disabled { color:var(--sl-ink-soft, currentColor); cursor:progress; }
@keyframes sl-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sl-icon-action.is-busy svg { animation: none; opacity: .55; } }
.sl-icon-action:hover:not(:disabled) { background:var(--sl-hover); color:var(--sl-ink); }
.sl-icon-action:disabled { color:var(--sl-line-strong); cursor:not-allowed; }
.sl-titleline p { margin: 0; color: var(--sl-muted); font-size: 12px; max-width: 620px; }
.sl-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.sl-search { flex: 1 1 200px; }
.sl-search-input { width: 100%; height: var(--sl-h-control); padding: 0 12px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); }
.sl-filter-btn { display: inline-flex; align-items: center; gap: 7px; height: var(--sl-h-control); padding: 0 12px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); color: var(--sl-muted); font-size: 11px; white-space: nowrap; }
.sl-filter-btn.sl-filter-active { background: var(--sl-selected); color: var(--sl-ink); font-weight: 650; }
/* The count is a reading of the filter, not part of its name: it stays legible
   at a glance and stops "New" and "3" reading as one word. */
.sl-filter-count { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--sl-surface-2); color: var(--sl-muted); font: 600 9.5px/18px var(--sl-font); font-variant-numeric: tabular-nums; text-align: center; }
.sl-filter-active .sl-filter-count { background: var(--sl-ink); color: var(--sl-surface); }
.sl-sync-refresh { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--sl-muted); font-size: 10.5px; }
.sl-sync-refresh button { height: var(--sl-h-compact); padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); font-size: 11px; }
.sl-chip-row { display: flex; flex-wrap: wrap; gap: 7px; margin: 0 0 16px; }
.sl-chip { display: inline-flex; align-items: center; gap: 6px; height: var(--sl-h-compact); padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: 999px; background: var(--sl-surface); font-size: 10.5px; }
.sl-chip-active { background: var(--sl-selected); font-weight: 650; }
.sl-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sl-success); }
.sl-chip-degraded { border-color: var(--sl-warning); color: var(--sl-warning); background: color-mix(in srgb, var(--sl-warning) 10%, var(--sl-surface)); }
.sl-chip-degraded .sl-chip-dot { background: var(--sl-warning); }
.sl-collection { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.sl-mobile-panes { display: none; }
.sl-inbox { margin: 0 0 24px; padding: 0 0 20px; border-bottom: 1px solid var(--sl-line); background: var(--sl-surface); }
.sl-inbox-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.sl-inbox-tabs button { min-height: var(--sl-h-compact); padding: 6px 10px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--sl-muted); white-space: nowrap; font-size: 12px; }
.sl-inbox-tabs button.sl-filter-active { color: var(--sl-ink); border-bottom-color: var(--sl-ink); font-weight: 650; }
.sl-inbox-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.sl-inbox-card { display: grid; gap: 6px; min-height: 142px; padding: 13px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-row); background: var(--sl-surface); }
.sl-inbox-card:focus-within, .sl-inbox-card:focus { outline: 2px solid var(--sl-focus); outline-offset: 2px; }
.sl-inbox-card-meta { display: flex; justify-content: space-between; color: var(--sl-muted); font-size: 9px; }
.sl-inbox-card .sl-secondary.sl-secondary { min-height: var(--sl-h-compact); font-size: 10.5px; }
.sl-state-chip { display: inline-block; margin: 2px 0 6px; padding: 2px 8px; border-radius: 999px; font: 600 8.5px var(--sl-font); letter-spacing: .03em; text-transform: uppercase; background: var(--sl-surface-2); color: var(--sl-muted); }
.sl-chip-queued { background: var(--sl-selected, var(--sl-surface-2)); color: var(--sl-ink); }
.sl-chip-attention { background: rgba(176,84,42,.12); color: var(--sl-warn, #a0522d); }
.sl-chip-submitted, .sl-chip-scheduled { background: rgba(46,122,74,.12); color: var(--sl-ok, #2e7a4a); }
/* Content card foot: chip leading, a muted timestamp trailing -- one row,
   not the chip and a separate two-line meta block underneath it. */
.sl-card-foot { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.sl-card-foot .sl-state-chip { margin: 0; }
.sl-card-when { margin-left: auto; color: var(--sl-muted); font-size: 9.5px; white-space: nowrap; }

/* Section content gaps come from the flex layout, not per-child margins —
   the same spacing contract the mockup's .sheet-body/.layers use. */
.sl-drawer-section { display: flex; flex-direction: column; gap: 10px; }
.sl-drawer-section > * { margin-block: 0; }
.sl-drawer-panel-body { display: flex; flex-direction: column; gap: 12px; }
.sl-drawer-panel-body > * { margin-block: 0; }
.sl-drawer-tablist { display: flex; gap: 16px; overflow-x: auto; scrollbar-width: none; }
.sl-drawer-tablist [role="tab"] { flex: 0 0 auto; min-height: 32px; padding: 6px 0; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--sl-muted); font-size: 12.5px; font-weight: 600; box-shadow: none; }
.sl-drawer-tablist [role="tab"][aria-selected="true"] { color: var(--sl-ink); border-bottom-color: var(--sl-ink); }
.sl-drawer-meta { font-size: 10.5px; color: var(--sl-muted); letter-spacing: .02em; margin-bottom: 3px; }
.sl-drawer-state { display: block; }
.sl-output-copy { padding-top: 0; }
.sl-output-copy h3 { margin-top: 0; }
/* THE IMAGE STRIP — one slot per accepted picture (one today; the ordered
   array is the Phase 2 contract). Fixed thumb, index on the frame, the cap
   names slot 1 the cover; the candidate joins as a dashed slot and the +
   tile ends the row. */
/* ONE COLUMN PAIR FOR THE WHOLE SHEET. 帖文 and 參考 share the same media
   column width, so switching tabs does not reflow the panel under the cursor. */
/* The columns share the row's height (stretch, not start): on a post whose
 * media side is short — a skeleton or a placeholder — the caption side
 * growing past it read as a half-empty panel. The caption textarea grows
 * into the space; a generating skeleton fills its column to the bottom. */
.sl-cols { display: grid; grid-template-columns: var(--sl-colW, 176px) minmax(0, 1fr); gap: 16px; align-items: stretch; }
.sl-cols-media { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.sl-cols-side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.sl-cols-side .sl-drawer-composer { flex: 1; display: flex; flex-direction: column; }
.sl-cols-side .sl-drawer-composer .sl-drawer-caption { flex: 1; min-height: 0; }
.sl-cols-media .sl-strip:has(.sl-output-frame-skel) { flex: 1; }
.sl-cols-media .sl-slot:has(.sl-output-frame-skel) { flex: 1; }
.sl-cols-media .sl-slot-media:has(.sl-output-frame-skel) { flex: 1; display: flex; flex-direction: column; }
.sl-output-frame.sl-output-frame-skel { aspect-ratio: auto; height: 100%; }
@media (max-width: 520px) { .sl-cols { grid-template-columns: minmax(0, 1fr); } }
/* Every column opens with the same label row — the label on the left, its
   one quiet action on the right. */
.sl-collabel { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.sl-collabel .sl-grow { flex: 1; min-width: 0; }
.sl-strip { display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
.sl-slot { display: flex; flex-direction: column; gap: 5px; }
.sl-slot-media { position: relative; }
.sl-slot-cap { font-size: 11px; color: var(--sl-ink-2); line-height: 1.35; }
.sl-slot-cap b { font-weight: 600; color: var(--sl-ink); }
.sl-slot-candidate .sl-output-frame { border-style: dashed; border-color: var(--sl-ink); }
.sl-slot-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.sl-slot-acts .sl-primary, .sl-slot-acts .sl-secondary { min-height: 30px; padding: 0 11px; font-size: 11.5px; }
/* Every action on an existing picture lives ON the picture: one ⋯ opens the
   merged menu. The chip rests visible — legible on any image and on touch
   screens that have no hover to reveal it. */
.sl-addwrap-pic { position: absolute; top: 8px; left: 8px; z-index: 3; }
/* The menu drops from the ⋯ inside the panel's own scroller: cap it to the
   space below the trigger and let it scroll internally, so the Remove row is
   never clipped off the sheet on a short viewport. */
.sl-addwrap-pic .sl-menu { max-height: calc(100dvh - 300px); overflow-y: auto; overscroll-behavior: contain; }
/* The ⋯ chip is legible at rest on any image — a solid surface, a dark
   glyph, the e-1 shadow — never a hover-only scrim over the picture. */
.sl-picbtn { width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--sl-radius-control); background: var(--sl-surface); color: var(--sl-ink); font-size: 15px; font-weight: 700; line-height: 1; box-shadow: var(--sl-e-1); cursor: pointer; }
.sl-picbtn:hover:not(:disabled) { background: var(--sl-hover); }
.sl-slot-media .sl-picbtn:disabled { opacity: .5; }
@media (prefers-reduced-motion: reduce) { .sl-picbtn { transition: none; } }
/* The page number rides on the frame — an empty page names itself the way
   the refusal does ("page 3 has no image" points at this slot). */
.sl-slot-num { position: absolute; top: 8px; right: 8px; z-index: 2; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: rgba(255,255,255,.92); border: 1px solid var(--sl-line); color: var(--sl-ink-2); font-size: 11px; font-weight: 650; line-height: 20px; text-align: center; box-shadow: var(--sl-e-1); }
/* An unfilled page: the same frame size as the picture that will fill it,
   dashed — the slot that blocks filing until it has an image. */
.sl-slot-frame-empty { border-style: dashed; border-color: var(--sl-line-strong); background: var(--sl-surface-2); display: flex; align-items: center; justify-content: center; }
/* "Add a page" is the strip's only growth control — a quiet dashed tile the
   size of a page, never a menu: growth is the one thing it does. */
.sl-addpage { width: 100%; min-height: 44px; border: 1.5px dashed var(--sl-line-strong); border-radius: var(--sl-radius-card); background: transparent; color: var(--sl-ink-2); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12.5px; font-weight: 600; padding: 8px 10px; cursor: pointer; }
.sl-addpage:hover:not(:disabled) { background: var(--sl-hover); color: var(--sl-ink); }
.sl-addpage:disabled { opacity: .5; }
.sl-pages-rule { margin: 0; }
/* Per-page alt text fields stack under the caption — each labelled by page. */
.sl-alt-group { display: flex; flex-direction: column; gap: 8px; }
.sl-alt-group .sl-alt-text + .sl-alt-text { margin-top: 2px; }
/* The empty slot is the add control — a dashed placeholder the exact size of
   the picture that will replace it, so the panel never jumps when one lands. */
.sl-addplace { width: 100%; aspect-ratio: 4 / 5; border: 1.5px dashed var(--sl-line-strong); border-radius: var(--sl-radius-card); background: transparent; color: var(--sl-ink-2); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; font-size: 12.5px; font-weight: 600; text-align: center; padding: 10px; cursor: pointer; }
.sl-addplace:hover:not(:disabled) { background: var(--sl-hover); color: var(--sl-ink); }
.sl-addplace:disabled { opacity: .5; }
.sl-addplace-plus { font-size: 20px; line-height: 1; font-weight: 400; }
.sl-addplace-hint { font-size: 11px; font-weight: 400; color: var(--sl-ink-2); }
/* The add menu is a POPOVER on its control, not a block inside the media
 * column — trapped in a 176px column every row wrapped to three lines. It
 * sizes to its own content and may overhang the column. .sl-addwrap is the
 * anchor; the -end modifier marks a control that hugs the column's right
 * edge, and under 520px (single column, full-width label) its menu flips to
 * the right edge so it stays inside the sheet. */
.sl-addwrap { position: relative; display: block; }
.sl-menu { position: absolute; z-index: 40; left: 0; top: calc(100% + 6px); display: flex; flex-direction: column; width: max-content; min-width: 238px; max-width: 300px; padding: 5px; background: var(--sl-surface); border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); box-shadow: var(--sl-e-2, 0 8px 24px rgba(0,0,0,.12)); }
@media (max-width: 520px) { .sl-addwrap-end .sl-menu { left: auto; right: 0; } }
.sl-menu-item { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 9px 10px; border: 0; border-radius: var(--sl-radius-control); background: transparent; text-align: left; cursor: pointer; font: inherit; color: var(--sl-ink); }
.sl-menu-item:hover:not(:disabled) { background: var(--sl-hover); }
.sl-menu-item:disabled { opacity: .55; cursor: not-allowed; }
.sl-menu-lead { font-size: 12.5px; font-weight: 600; }
.sl-menu-sub { font-size: 11px; color: var(--sl-ink-2); line-height: 1.35; }
.sl-menu-sub.sl-menu-warn { color: var(--sl-warning); }
.sl-menu-item.sl-menu-danger .sl-menu-lead { color: var(--sl-danger); }
.sl-menu-sep { height: 1px; background: var(--sl-line); margin: 5px 4px; }
.sl-drawer-footer-actions .sl-grow { flex: 1; }
/* The 增值 row on a credits-paused run: the funding action in place, not a
   dead-end sentence. A host with no top-up surface leaves it disabled with
   the reason; topped_up resumes the paused run on its own. */
.sl-topup { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); background: var(--sl-surface-2); }
.sl-topup-note { margin: 0; flex: 1; font-size: 11.5px; color: var(--sl-ink-2); line-height: 1.4; }
.sl-topup-btn { flex: none; }
/* The image brief on the Instructions tab — a flat block, not a
   collapsible: the fields a Generate ask is made under. */
.sl-brieftab { display: flex; flex-direction: column; gap: 12px; padding-bottom: 4px; }
.sl-brieftab > * { margin-block: 0; }
.sl-brief-switch, .sl-brief-save { display: flex; gap: 10px; align-items: flex-start; font-size: 12.5px; font-weight: 600; color: var(--sl-ink); cursor: pointer; }
.sl-brief-switch input, .sl-brief-save input { margin-top: 2px; flex: none; width: 15px; height: 15px; accent-color: var(--sl-ink); }
.sl-brief-switch-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-weight: 400; }
.sl-brief-switch-label { font-weight: 600; color: var(--sl-ink); }
.sl-brief-switch .sl-field-note { font-weight: 400; }
.sl-brief-warn { color: var(--sl-warning); }
.sl-brief-ratios { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.sl-brief-ratios-lead { font-size: 11.5px; color: var(--sl-ink-2); }
.sl-brief-ratio { min-height: 30px; padding: 0 11px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-chip); background: transparent; font-size: 11.5px; color: var(--sl-ink-2); }
.sl-brief-ratio[aria-pressed="true"] { background: var(--sl-surface-2); color: var(--sl-ink); font-weight: 600; }
.sl-brief-once-wrap { display: flex; flex-direction: column; gap: 6px; }
.sl-brief-once-wrap > * { margin-block: 0; }
.sl-brief-once.sl-drawer-caption { min-height: 58px; height: auto; }
.sl-brief-link { border: 0; background: transparent; padding: 0; color: var(--sl-ink-2); font-size: 11.5px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; min-height: 0; text-align: left; }
.sl-brief-link:hover:not(:disabled) { color: var(--sl-ink); }
.sl-brief-link:disabled { color: var(--sl-line-strong); cursor: not-allowed; text-decoration: none; }
/* The staged upload row — the mockup's dashed drop slot. */
.sl-upload-row { display: flex; align-items: center; gap: 10px; border: 1px dashed var(--sl-line-strong); border-radius: var(--sl-radius-control); padding: 8px 10px; font-size: 12.5px; color: var(--sl-ink-2); }
.sl-upload-row .sl-field-note { flex: 1; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; }
.sl-upload-row .sl-primary { flex: 0 0 auto; min-height: 32px; padding: 0 11px; font-size: 11.5px; }
.sl-output-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.sl-output-frame { display: grid; place-items: center; aspect-ratio: 4 / 5; max-width: 100%; background: var(--sl-surface-2); border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); overflow: hidden; padding: 0; position: relative; }
.sl-output-frame img { width: 100%; height: 100%; object-fit: contain; }
.sl-output-frame .sl-pc-media-empty { padding: 12px; text-align: center; }
.sl-output-frame-skel::before { content: ""; position: absolute; inset: 0; background: rgba(255,255,255,.32); pointer-events: none; }
.sl-output-frame-skel::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, rgba(255,255,255,0) 36%, rgba(255,255,255,.5) 50%, rgba(255,255,255,0) 64%); background-size: 220% 100%; animation: sl-skel-sweep 1.6s linear infinite; pointer-events: none; }
/* The label wraps inside the frame — a nowrap pill in a 128px frame clipped
   mid-word. Inset both sides instead of left:50% + translateX so shrink-to-fit
   measures against the full frame, not the half-width region. */
.sl-skel-label { position: absolute; z-index: 2; top: 50%; left: 8px; right: 8px; width: fit-content; margin-inline: auto; transform: translateY(-50%); font-size: 11.5px; font-weight: 600; padding: 4px 9px; border-radius: var(--sl-radius-chip); background: rgba(255,255,255,.95); box-shadow: var(--sl-e-1); color: var(--sl-ink); max-width: 100%; text-align: center; line-height: 1.35; overflow-wrap: anywhere; }
@keyframes sl-skel-sweep { from { background-position: 120% 0; } to { background-position: -120% 0; } }
@media (prefers-reduced-motion: reduce) { .sl-output-frame-skel::after { animation: none; } }
.sl-drawer-caption.sl-skel { color: transparent; }
/* The footer's publish row: "Publishes to" + a picker button whose face is
   the current selection; the menu opens UPWARD off the foot. A destination
   that cannot take the post says so on its own row. */
.sl-dests { margin: 0; font-size: 12px; color: var(--sl-ink-2); display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
.sl-destwrap { position: relative; display: inline-block; }
.sl-destbtn { border: 0; background: transparent; padding: 0 2px; font: inherit; font-weight: 600; color: var(--sl-ink); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.sl-destbtn:hover:not(:disabled) { color: var(--sl-ink); }
.sl-destbtn:disabled { color: var(--sl-ink-2); text-decoration: none; cursor: not-allowed; }
.sl-destmenu { position: absolute; z-index: 6; bottom: calc(100% + 6px); left: 0; min-width: 240px; padding: 5px; background: var(--sl-surface); border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); box-shadow: var(--sl-e-2, 0 8px 24px rgba(0,0,0,.12)); display: flex; flex-direction: column; }
.sl-destopt { display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px; border-radius: var(--sl-radius-control); cursor: pointer; }
.sl-destopt:hover { background: var(--sl-hover); }
.sl-destopt input { margin-top: 2px; flex: none; width: 15px; height: 15px; accent-color: var(--sl-ink); }
.sl-destopt-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; font-size: 12.5px; color: var(--sl-ink); }
.sl-dest-sub { font-size: 11px; color: var(--sl-ink-2); }
.sl-dest-blocked { color: var(--sl-warning); }
.sl-whenrow { display: flex; align-items: center; gap: 10px; }
.sl-whenrow input { height: 38px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); padding: 0 10px; font: inherit; color: var(--sl-ink); background: var(--sl-surface); }
.sl-output-frame-skel .sl-pc-media-empty { display: none; }
.sl-reference-badge { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: var(--sl-radius-chip); border: 1px solid var(--sl-line); font-size: 11.5px; font-weight: 500; color: var(--sl-ink-2); }
.sl-reference-text { color: var(--sl-ink-2); font-size: 12.5px; }
.sl-field-label { font-size: 11.5px; font-weight: 500; color: var(--sl-ink-2); }
/* The two prefilled instruction fields: label, textarea, then a state row —
   which text applies — with Reset docked right. */
.sl-instructions-part { display: flex; flex-direction: column; gap: 6px; }
.sl-instructions-foot { display: flex; align-items: center; gap: 10px; }
.sl-instructions-state { flex: 1; min-width: 0; font-size: 11.5px; color: var(--sl-ink-2); }
.sl-instructions-used { padding: 11px 12px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-control); }
.sl-instructions-used > strong { font-size: 12.5px; font-weight: 600; display: block; }
.sl-instructions-used > * { margin-block: 0; }
.sl-instructions-used > * + * { margin-top: 6px; }
.sl-instructions-reset.sl-secondary { min-height: 32px; padding: 0 11px; font-size: 11.5px; justify-self: start; }
/* History is one time-ordered feed: the instant leads, then the event. */
.sl-history-feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.sl-history-event { display: flex; gap: 10px; align-items: baseline; }
.sl-history-when { flex: 0 0 auto; min-width: 8em; font-size: 10.5px; color: var(--sl-muted); font-variant-numeric: tabular-nums; }
.sl-history-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sl-history-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; margin: 0; }
.sl-history-line strong { font-size: 12.5px; font-weight: 600; }
.sl-history-detail { color: var(--sl-ink-2); font-size: 11.5px; }
.sl-history-use-image { flex-shrink: 0; }
/* The batch foot is a column: status, the publication segment, the note,
   then right-aligned small actions — the mockup's .sheet-foot. The tripled
   class outranks the shared .sl-preview-actions.sl-preview-actions rule. */
.sl-preview-actions.sl-drawer-footer.sl-drawer-footer { flex-direction: column; align-items: stretch; gap: 10px; }
.sl-drawer-stage-note { margin: 0; font-size: 11.5px; color: var(--sl-ink-2); }
.sl-drawer-footer-actions { display: flex; gap: 8px; }
.sl-drawer-footer .sl-drawer-footer-actions { justify-content: flex-end; }
.sl-drawer-footer .sl-drawer-footer-actions button { flex: 0 0 auto; min-height: 32px; padding: 0 11px; font-size: 11.5px; white-space: normal; }
.sl-drawer-footer-hint { margin: 0; font-size: 11.5px; color: var(--sl-ink-2); }
.sl-drawer-footer-hint:empty { display: none; }
.sl-drawer-section h3 { margin: 0; font-size: 12.5px; font-weight: 600; }
.sl-drawer-regen-row { margin: 0 0 16px; }
.sl-drawer-poster { display: block; max-width: 200px; width: 40%; height: auto; margin-top: 10px; border-radius: var(--sl-radius-control); border: 1px solid var(--sl-line); }
.sl-drawer-poster-dl.sl-secondary.sl-secondary { display: inline-flex; min-height: var(--sl-h-compact); padding: 0 10px; margin-top: 6px; font-size: 10px; margin-left: 0; }
.sl-drawer-section p { margin: 0; }
.sl-post { position: relative; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); background: var(--sl-surface); overflow: hidden; }
.sl-post-selected { border-color: var(--sl-ink); background: var(--sl-selected); }
.sl-selectbox { position: absolute; z-index: 2; top: 10px; right: 10px; width: 26px; height: 26px; border-radius: 8px; background: rgba(255,255,255,.9); display: grid; place-items: center; cursor: pointer; }
.sl-post-open { display: block; width: 100%; padding: 0; border: 0; background: transparent; text-align: left; }
.sl-media { display: block; position: relative; aspect-ratio: 1.15/1; background: var(--sl-surface-2); border-bottom: 1px solid var(--sl-line); }
/* The "no accepted output" note sits in the open middle of the media box.
   It had no rule at all, so it rendered as inline text on top of the
   absolutely positioned account kicker in the top-left corner. */
.sl-media-placeholder { position: absolute; inset: 32px 12px 32px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 12px; line-height: 1.4; color: var(--sl-muted); }
.sl-media-cover { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sl-provider-glyph { position: absolute; left: 10px; bottom: 10px; padding: 3px 6px; border-radius: 6px; background: rgba(255,255,255,.92); font: 700 9px var(--sl-font); }
.sl-media-kicker { position: absolute; left: 10px; top: 10px; font: 600 8px var(--sl-font); letter-spacing: .04em; color: var(--sl-muted); text-transform: uppercase; }
.sl-post-body { display: block; padding: 16px; }
.sl-inbox-card.bot-card { padding: 16px; gap: 10px; }
.sl-inbox-card p { margin: 4px 0; line-height: 1.65; }
.sl-app .bot-button.bot-button { font-size: 12px; padding: 6px 10px; }
.sl-post-body strong { display: block; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Two lines, ellipsised -- a fixed height cut a line off mid-glyph;
   line-clamp stops at a whole line instead. */
.sl-post-body p { margin: 4px 0 8px; color: var(--sl-muted); font-size: 10.5px; line-height: 1.55; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.sl-meta { display: flex; justify-content: space-between; font: 8.5px var(--sl-font); color: var(--sl-muted); }
.sl-meta-unavail { color: var(--sl-warning); font-weight: 650; }
.sl-duplicate-badge { display: block; padding: 6px 13px 10px; color: var(--sl-muted); font-size: 9.5px; }
.sl-empty { padding: 60px 20px; text-align: center; color: var(--sl-muted); }
.sl-empty strong { display: block; color: var(--sl-ink); font-size: 13px; margin-bottom: 6px; }
.sl-notice { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 10px 12px; border: 1px solid var(--sl-warning); border-radius: 8px; background: color-mix(in srgb, var(--sl-warning) 8%, transparent); }
.sl-notice p { flex: 1; margin: 0; font-size: 10.5px; line-height: 1.5; }
.sl-notice-action { padding: 5px 10px; border: 1px solid var(--sl-line); border-radius: 6px; background: var(--sl-surface); font: 600 10px var(--sl-font); }
.sl-notice-dismiss { padding: 2px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--sl-muted); font: 700 12px var(--sl-font); }
/* A dock rather than a bar: it pulls in from the canvas edges and floats over
   the list it acts on, so the action follows the reader without a full-bleed
   band cutting the page in two. It is only as wide as its own buttons.

   Fixed, not sticky. Sticky can only hold an element inside its own containing
   block, and the view host is exactly as tall as its content — so on a list
   shorter than the canvas the dock parked at the end of the content with dead
   space beneath it, instead of above the bottom edge. The canvas is its own
   iframe, so the viewport this pins to is the gadget's, not the page's. The
   bottom padding on .sl-app is what lets the last row scroll clear of it.

   Reserved for a live SELECTION's own transient action -- it exists
   because the owner selected something, it summarises that selection,
   and the action it carries consumes it (the Sources tray is the
   reference use). It is not a generic screen footer: the Publish step's
   plain Back/View-summary navigation used to live here, tied to no
   selection, floating over a card whose own submit row was the screen's
   actual action -- moved to .sl-page-nav (below) instead. Reach for
   .sl-page-nav for ordinary end-of-page navigation. */
.sl-selection { position: fixed; bottom: clamp(10px, 2vh, 18px); left: 50%; translate: -50% 0; z-index: 5; width: fit-content; max-width: calc(100% - 32px); padding: 8px; border: 1px solid var(--sl-line); border-radius: calc(var(--sl-radius-card) + 4px); background: color-mix(in srgb, var(--sl-surface) 80%, transparent); backdrop-filter: blur(16px) saturate(180%); box-shadow: 0 1px 2px rgba(24,24,27,.04), 0 14px 30px -14px rgba(24,24,27,.3); }
.sl-selection-inner { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* The footer container owns alignment, not the buttons in it: whichever
   action is last in a footer row is the one pushed to the far end. */
.sl-selection-inner > *:last-child { margin-left: auto; }
/* Ordinary in-flow end-of-page navigation -- quiet, secondary, not tied to
   a selection and not fixed over the content. */
.sl-page-nav { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
/* :not(:only-child) -- with a lone Back button (Publish's own row, since the
   Batch summary screen and its "View summary" partner were removed), this
   must not push the one child to the far edge the way it correctly pushes a
   second child in a row that still has one. */
.sl-page-nav > *:last-child:not(:only-child) { margin-left: auto; }
.sl-selected-copy { padding-inline: 8px 4px; }
.sl-selected-copy strong { display: block; font-size: 11.5px; }
.sl-selected-copy span { display: block; color: var(--sl-muted); font-size: 9.5px; }
.sl-clear { border: 0; background: transparent; color: var(--sl-muted); font-size: 11px; border-radius: var(--sl-radius-control); height: var(--sl-h-control); padding: 0 10px; }
.sl-clear:hover { background: var(--sl-hover); color: var(--sl-ink); }
/* Appearance only -- alignment belongs to the footer container (see
   .sl-selection-inner and .sl-preview-actions above/below), not this class.
   v2 button contract (component study): the primary action is ink; gold is
   the restrained brand variant for creation calls-to-action. The doubled
   selectors outrank the shell's bot-button[data-variant] rules. */
.sl-primary, .sl-secondary, .sl-brand { padding: 0 15px; border-radius: var(--sl-radius-control); font-size: 12px; font-weight: 650; }
/* sm — the compact variant for row-level actions (adopt, use-candidate). */
.sl-primary.sl-sm, .sl-secondary.sl-sm { min-height: 28px; padding: 0 10px; font-size: 11.5px; }
/* Dialogs are appended to body, not .sl-app — both roots are covered. */
.sl-app .sl-primary.sl-primary, .sl-preview-dialog .sl-primary.sl-primary { border: 1px solid var(--sl-ink); background: var(--sl-ink); color: var(--sl-surface); }
.sl-app .sl-primary.sl-primary:hover:not(:disabled), .sl-preview-dialog .sl-primary.sl-primary:hover:not(:disabled) { background: #36363d; border-color: #36363d; }
.sl-app .sl-brand.sl-brand, .sl-preview-dialog .sl-brand.sl-brand { border: 1px solid var(--sl-accent-strong); background: var(--sl-accent); color: #1a1a1a; }
.sl-app .sl-brand.sl-brand:hover:not(:disabled), .sl-preview-dialog .sl-brand.sl-brand:hover:not(:disabled) { background: var(--sl-accent-strong); }
/* A faded fill reads as a broken button. An unavailable action is inert,
   so it drops the fill entirely instead of wearing a washed-out version. */
.sl-primary:disabled, .sl-brand:disabled, .sl-app .sl-primary.sl-primary:disabled, .sl-app .sl-brand.sl-brand:disabled,
.sl-preview-dialog .sl-primary.sl-primary:disabled, .sl-preview-dialog .sl-brand.sl-brand:disabled {
  border-color: var(--sl-line); background: var(--sl-surface-2); color: var(--sl-muted); opacity: 1; cursor: not-allowed;
}
.sl-secondary { border: 1px solid var(--sl-line-strong); background: var(--sl-surface); }
.sl-secondary:hover:not(:disabled) { background: var(--sl-hover); }
.sl-open-source-field { display: grid; gap: 6px; }
.sl-open-source-input { height: 38px; padding: 0 11px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); font-size: 13.5px; }
.sl-open-source-list { display: grid; gap: 6px; }
.sl-open-source { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--sl-ink-2); }
.sl-open-source-name { font-weight: 550; }
.sl-open-source-meta { margin-left: auto; color: var(--sl-muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.sl-open-source-remove { border: 0; background: none; color: var(--sl-muted); font-size: 14px; line-height: 1; padding: 0 2px; }
/* THE CARD ⋯ — the post's actions live on the board card that owns them.
   The chip sits on the media's top corner beside the selection box; its
   popover is the CARD's overlay — a sibling of the chip, positioned to
   .sl-post — spanning the card's inner width below the corner row, so no
   card is ever narrow enough to clip it. */
.sl-cardmenu { position: absolute; z-index: 3; top: 10px; right: 44px; }
.sl-cardbtn { width: 26px; height: 26px; border: 0; border-radius: 8px; background: rgba(255,255,255,.9); color: var(--sl-ink); display: grid; place-items: center; font-size: 14px; line-height: 1; cursor: pointer; }
.sl-cardbtn:hover { background: var(--sl-surface); }
.sl-cardmenu-pop { position: absolute; z-index: 3; top: 46px; left: 10px; right: 10px; width: auto; min-width: 0; max-width: none; }
/* The confirm replaces the row in place — no modal over a menu, and the post
   being removed stays named while the question is asked. */
.sl-rowconfirm { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 8px 10px; border-radius: var(--sl-radius-control); background: var(--sl-danger-soft, #fae9e7); font-size: 12.5px; }
.sl-rowconfirm .sl-pm-grow { flex: 1 1 100%; min-width: 0; color: var(--sl-danger, #b3261e); font-weight: 600; }
.sl-rowconfirm button { min-height: 26px; padding: 0 9px; border-radius: var(--sl-radius-control); border: 1px solid transparent; font-size: 11px; font-weight: 600; cursor: pointer; }
.sl-rowconfirm .sl-pm-yes { background: var(--sl-danger, #b3261e); color: #fff; }
.sl-rowconfirm .sl-pm-no { background: transparent; color: var(--sl-ink-2); border-color: var(--sl-line-strong); margin-left: auto; }
/* The drawer's title is the post's own name, edited where it is read — a
   heading until it is touched. */
.sl-titlefield { width: 100%; font: inherit; font-size: 15px; font-weight: 600; color: var(--sl-ink); border: 1px solid transparent; border-radius: var(--sl-radius-control); background: transparent; padding: 2px 6px; margin: 0 -6px; min-height: 30px; }
.sl-titlefield:hover:not(:read-only) { background: var(--sl-hover); }
.sl-titlefield:focus { background: var(--sl-surface); border-color: var(--sl-line-strong); outline: none; box-shadow: var(--sl-e-1); }
.sl-titlefield::placeholder { color: var(--sl-muted); font-weight: 500; }
.sl-titlefield:read-only { cursor: default; }
.sl-dual { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 14px; }
.sl-dual-pane { border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); overflow: hidden; }
.sl-dual-pane header { padding: 9px 13px; background: var(--sl-surface-2); border-bottom: 1px solid var(--sl-line); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; display: flex; justify-content: space-between; align-items: center; }
.sl-dual-body { padding: 14px; }
.sl-src-text { margin: 0; font-size: 12.5px; line-height: 1.85; }
.sl-lit { background: var(--sl-accent-soft); border-bottom: 1px solid var(--sl-accent-strong); border-radius: 4px; padding: 1px 4px; font-weight: 600; color: inherit; }
.sl-legend { margin: 10px 0 0; color: var(--sl-muted); font-size: 9.5px; }
.sl-zh-edit { width: 100%; min-height: 130px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); padding: 10px; font-size: 12.5px; line-height: 1.85; resize: vertical; }
.sl-revision-badge { font: 9.5px var(--sl-font); color: var(--sl-muted); }
.sl-issue-list { list-style: none; margin: 0 0 16px; padding: 0; display: grid; gap: 8px; }
.sl-issue { display: flex; gap: 9px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-row); }
.sl-issue-block { border-color: var(--sl-danger); }
.sl-issue-confirm { border-color: var(--sl-warning); }
.sl-issue-badge { flex: 0 0 auto; font: 650 8.5px var(--sl-font); text-transform: uppercase; padding: 3px 6px; border-radius: 999px; background: var(--sl-surface-2); }
.sl-issue p { margin: 0; flex: 1; font-size: 11.5px; }
.sl-mark-btn { border: 1px solid var(--sl-line-strong); border-radius: 7px; background: var(--sl-surface); font-size: 10px; padding: 4px 8px; }
.sl-poster-editor { border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); padding: 16px; margin-bottom: 16px; }
.sl-poster-grid { display: grid; grid-template-columns: 140px 1fr 160px; gap: 16px; margin-top: 12px; }
.sl-template-pick { display: grid; gap: 8px; align-content: start; }
.sl-tpl-btn { border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-row); background: var(--sl-surface-2); padding: 8px; font-size: 10px; }
.sl-tpl-btn[aria-pressed="true"] { border-color: var(--sl-ink); background: var(--sl-selected); }
.sl-field { display: grid; gap: 4px; margin-bottom: 10px; }
.sl-field label { font-size: 10.5px; color: var(--sl-muted); font-weight: 650; }
.sl-field input, .sl-field select { height: 38px; padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); }
.sl-field-note { margin: 2px 0 0; color: var(--sl-muted); font-size: 10px; }
.sl-setup-error, .sl-wizard-error { margin: 0 0 10px; padding: 9px 12px; border: 1px solid var(--sl-danger); border-radius: var(--sl-radius-row); background: color-mix(in srgb, var(--sl-danger) 10%, var(--sl-surface)); color: var(--sl-danger); font-size: 11px; }
.sl-poster-preview { display: grid; place-items: center; }
.sl-poster-canvas { max-width: 100%; max-height: 220px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-row); }
/* One card per item, full width -- a two-column card has too much of its
   own internal structure to also share a row with a sibling. */
.sl-review-grid { display: grid; gap: 16px; margin-bottom: 18px; }
.sl-preview-card { border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); background: var(--sl-surface); overflow: hidden; }
.sl-preview-card header { padding: 10px 13px; border-bottom: 1px solid var(--sl-line); font-size: 11px; font-weight: 650; }
/* Poster on the secondary surface, everything that decides publication on
   the primary one -- so the decisions read as the active half. One column
   below 760px (poster first), two at and above it. */
.sl-pc-grid { display: grid; }
@media (min-width: 760px) { .sl-pc-grid { grid-template-columns: 264px 1fr; } }
/* align-content: start, not the grid default (stretch/center) -- a grid
   column stretches to the row's height by default, and with a tall
   decision column beside it this became ~700px of grey with the slot
   floating dead centre. The column's job is only to hold the slot at the
   top; it does not grow to match it. The tint lives on the slot itself
   (below), not this column, so it ends where the poster ends instead of
   running the height of the card. */
.sl-pc-media { display: grid; justify-items: center; align-content: start; padding: 18px; gap: 10px; text-align: center; border-bottom: 1px solid var(--sl-line); }
@media (min-width: 760px) { .sl-pc-media { border-bottom: 0; border-right: 1px solid var(--sl-line); } }
/* The reserved slot, not the (top-aligned, but still full-column-height)
   surface around it: this is what actually carries the aspect-ratio and
   the secondary-surface tint, so the poster/placeholder keeps the shape
   it ships in -- and the grey stops exactly where the poster does --
   regardless of how tall the decision column beside it grows. */
.sl-pc-media-slot { width: 100%; display: grid; place-items: center; background: var(--sl-surface-2); border-radius: var(--sl-radius-control); }
/* The slot already reserves the exact ratio the template draws at (see
   steps.js's mediaAspect), so the canvas fills it edge to edge — there is
   no variable-ratio mismatch here to guard. */
.sl-pc-canvas { display: block; width: 100%; height: 100%; object-fit: contain; border-radius: var(--sl-radius-control); border: 1px solid var(--sl-line); }
.sl-pc-media-empty { color: var(--sl-muted); font-size: 11px; }
.sl-pc-body { padding: 18px; display: grid; gap: 16px; align-content: start; }
.sl-pc-caption { display: grid; gap: 8px; align-items: start; }
.sl-pc-caption p { margin: 0; font-size: 13.5px; line-height: 1.65; white-space: pre-wrap; }
.sl-pc-caption .sl-cta { justify-self: start; }
/* Quiet grouping labels, same register as .sl-preview-kicker below. */
.sl-pc-field { display: grid; gap: 8px; }
.sl-pc-field-label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--sl-muted); font-weight: 700; }
/* One step down from .sl-pc-field-label's section register -- sentence
   case, no letter-spacing, no uppercase, so a field inside a section
   reads as subordinate to it rather than a second section of its own. */
.sl-pc-subfield { display: grid; gap: 4px; margin-top: 10px; }
.sl-pc-subfield-label { font-size: 11px; color: var(--sl-muted); font-weight: 600; }
.sl-pc-subfield input { height: var(--sl-h-control); padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); font: inherit; }
.sl-dest { display: grid; gap: 7px; }
.sl-dest-row { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border: 1px solid var(--sl-line); border-radius: 10px; font-size: 12.5px; cursor: pointer; }
.sl-dest-row:hover { background: var(--sl-surface-2); }
.sl-dest-row-selected { border-color: var(--sl-accent-strong); background: var(--sl-accent-soft); }
.sl-dest-row input { accent-color: var(--sl-accent-strong); width: 15px; height: 15px; flex-shrink: 0; }
/* Stored destination whose grant is gone: kept visible (history), muted and
   unfocusable — the tag names why it cannot be ticked. */
.sl-dest-row-revoked { border-style: dashed; color: var(--sl-muted); cursor: default; }
.sl-dest-row-revoked:hover { background: none; }
.sl-dest-row-revoked.sl-dest-row-selected { border-color: var(--sl-line-strong); background: var(--sl-surface-2); }
.sl-dest-tag { margin-left: auto; display: inline-flex; align-items: center; padding: 3px 9px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-chip); color: var(--sl-ink-2); font-size: 11.5px; font-weight: 500; }
/* Pill segments, the active one filled in ink -- not radio dots. The input
   stays for keyboard/screen-reader semantics; it is visually hidden, not
   display:none, so it keeps its place in the tab order. */
.sl-timing { display: flex; gap: 7px; flex-wrap: wrap; }
.sl-seg { position: relative; display: inline-flex; align-items: center; height: var(--sl-h-compact); padding: 0 12px; border-radius: 999px; border: 1px solid var(--sl-line-strong); font-size: 11.5px; background: var(--sl-surface); cursor: pointer; }
.sl-seg input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.sl-seg:has(input:focus-visible) { outline: 2px solid var(--sl-focus); outline-offset: 2px; }
.sl-seg-on { background: var(--sl-ink); border-color: var(--sl-ink); color: #fff; }
/* The hairline separates the decision from the act of sending it; the
   button is the last child, so it takes the same push-to-end rule as
   every other footer here. */
.sl-submit-row { display: flex; align-items: center; gap: 12px; border-top: 1px solid var(--sl-line); padding-top: 16px; }
.sl-submit-row > *:last-child { margin-left: auto; }
.sl-submit-hint { font-size: 11px; color: var(--sl-muted); }
.sl-bind-label { display: inline-flex; margin-top: 9px; padding: 4px 8px; border-radius: 999px; background: var(--sl-selected); color: var(--sl-muted); font: 9px var(--sl-font); }
/* One quiet block, on the card it describes, not a screen before it. */
.sl-approval-note { display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px; border: 1px solid var(--sl-line-strong); border-radius: 10px; background: var(--sl-accent-soft); font-size: 11.5px; line-height: 1.55; color: var(--sl-ink); }
.sl-approval-mark { flex-shrink: 0; color: var(--sl-accent-strong); }
.sl-approval-expired { border-color: var(--sl-warning); background: color-mix(in srgb, var(--sl-warning) 8%, var(--sl-surface)); }
.sl-hash { font: 10px var(--sl-font); color: var(--sl-muted); word-break: break-all; }
.sl-target-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 12px 14px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-row); margin-bottom: 8px; }
.sl-who strong { display: block; font-size: 12px; }
.sl-who span { display: block; color: var(--sl-muted); font-size: 10px; }
.sl-state-badge { display: inline-flex; height: 24px; padding: 0 10px; border-radius: 999px; align-items: center; font-size: 10px; font-weight: 650; }
.sl-state-scheduled { background: var(--sl-selected); }
.sl-state-published { background: color-mix(in srgb, var(--sl-success) 16%, var(--sl-surface)); color: var(--sl-success); }
.sl-state-failed_safe { background: color-mix(in srgb, var(--sl-danger) 12%, var(--sl-surface)); color: var(--sl-danger); }
.sl-state-unknown { background: color-mix(in srgb, var(--sl-warning) 14%, var(--sl-surface)); color: var(--sl-warning); }
.sl-cta { height: var(--sl-h-compact); padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: 7px; background: var(--sl-surface); font-size: 10.5px; }
.sl-guidance { grid-column: 1/-1; margin: 6px 0 0; padding: 10px 12px; border-radius: var(--sl-radius-row); background: var(--sl-surface-2); color: var(--sl-ink-2); font-size: 11.5px; line-height: 1.55; }
.sl-receipt { color: var(--sl-ink-2); font-size: 11.5px; text-decoration: underline; text-underline-offset: 3px; }
.sl-receipt:hover { color: var(--sl-ink); }

.sl-radio { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 4px; }
/*
 * FLOATING PANEL, per the accepted workbench mockup.
 *
 * The dialog is a rounded card that floats over the page — border, radius and
 * elevation on all four sides, never an edge dock. The two sheet dialogs
 * (the source preview and the batch drawer) also carry .sl-drawer: right-
 * docked, inset 12px, 535px wide, full height minus the inset. The small
 * confirm dialog keeps this shared chrome with the default centered
 * placement. An earlier revision argued for a slim edge-docked sheet at
 * 440px because the media is portrait; the owner chose the workbench
 * geometry instead — do not "fix" this back.
 */
/* Doubled class: inside the real shell every preview dialog also carries the
   SDK's bot-drawer class, whose dialog.bot-drawer rule still describes the
   old edge dock — the doubled class outranks it so the panel really floats. */
.sl-preview-dialog.sl-preview-dialog { margin: auto; padding: 0; max-width: calc(100vw - 30px); max-height: calc(100dvh - 30px); border: 1px solid var(--sl-line); border-radius: var(--sl-radius-panel); background: var(--sl-surface); color: var(--sl-ink); box-shadow: var(--sl-e-3); overflow: hidden; translate: 0 0; opacity: 1; transition: translate .3s cubic-bezier(.32,.72,0,1), opacity .24s ease, display .3s allow-discrete, overlay .3s allow-discrete; }
.sl-preview-dialog.sl-drawer { margin: 12px 12px 12px auto; width: 535px; height: calc(100dvh - 24px); max-height: none; }
/* The drawer slides in from the edge it is docked to. The display and overlay
   properties have to transition discretely or the closing frames are never
   painted: a dialog leaves the top layer the instant close() runs. The
   starting-style rule carries the pre-open frame, which an element entering the
   top layer cannot otherwise express, having no previous style to start from. */
.sl-preview-dialog:not([open]) { translate: 100% 0; opacity: 0; }
@starting-style { .sl-preview-dialog[open] { translate: 100% 0; opacity: 0; } }
/*
 * Dimmed and blurred, per the same mockup. The panel floats, so the page
 * behind it recedes; the click-to-close on the backdrop still works, and
 * showModal still traps focus and Escape. An earlier revision kept the
 * backdrop transparent so the grid stayed fully visible while the owner
 * moved along it; the owner chose the dimmed treatment.
 */
.sl-preview-dialog::backdrop { background: #18181b38; backdrop-filter: blur(2px); opacity: 1; transition: opacity .3s ease, display .3s allow-discrete, overlay .3s allow-discrete; }
.sl-preview-dialog:not([open])::backdrop { opacity: 0; }
@starting-style { .sl-preview-dialog[open]::backdrop { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .sl-preview-dialog, .sl-preview-dialog::backdrop { transition-duration: 1ms; } }
/* The elevation lives on the dialog now that it floats — the sheet inside is
   just the grid that portions it into head / tabs / body / footer. */
.sl-preview-sheet { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.sl-preview-sheet.sl-sheet-drawer { grid-template-rows: auto auto minmax(0, 1fr) auto; }
.sl-sheet-drawer .sl-drawer-tabs { padding: 6px 18px 0; display: grid; gap: 8px; }
.sl-sheet-drawer .sl-drawer-tabs:empty { padding: 0; }
/* Inside the floating shell there are no structural rules: spacing separates
   head, tabs, body and footer; only the selected tab keeps its underline.
   The zeros are explicit — the host shell's bot-drawer-head/-actions classes
   still carry their rules, so removing the value is not enough. */
.sl-preview-head.sl-preview-head { min-height: 0; padding: 16px 18px 4px; border-bottom: 0; display: flex; align-items: flex-start; gap: 10px; }
.sl-preview-who { flex: 1 1 auto; min-width: 0; }
.sl-preview-head-actions { position: relative; margin-left: auto; display: flex; gap: 4px; align-self: flex-start; }
.sl-preview-head .sl-icon-action { width: 32px; height: 32px; }
/*
 * Scoped to the eyebrow, not to every span in the header.
 *
 * A .sl-preview-head span rule styled ANY span the header grew, so the
 * 'via your watch on ...' line came out as a second 9px uppercase kicker, and
 * the .sl-preview-via rule meant to fix it lost on specificity (0,1,0 against
 * 0,1,1). An element selector inside a container is a rule about a shape
 * nobody declared; it holds only until the shape changes.
 *
 * (No backticks in here: this stylesheet is a template literal.)
 */
.sl-preview-head strong { display: block; margin: 0; font-size: 15px; font-weight: 600; }
.sl-preview-kicker { display: block; color: var(--sl-muted); font-size: 10.5px; letter-spacing: .02em; margin-bottom: 3px; }

.sl-preview-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px 18px 18px; overflow-wrap: anywhere; }
/* The reference rail's under-slot block: the cap line and any recovery
   action stack below the frame (preview-media.js renders both inside
   .sl-slot-tail, hidden when a slot has nothing to say). */
.sl-slot-tail { display: flex; flex-direction: column; gap: 5px; }
.sl-slot-tail[hidden] { display: none; }
/* Provenance and metrics read as ONE quiet wrapping line, not a data
 * table — the <dl> stays because the pairing is right for a screen
 * reader; each fact is "label value" inline. */
.sl-drawer-facts { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 0; font-size: 11px; }
.sl-fact { display: inline-flex; gap: 5px; }
.sl-fact dt { font-size: 11px; font-weight: 400; color: var(--sl-muted); }
.sl-fact dd { margin: 0; font-size: 11px; font-weight: 500; color: var(--sl-ink-2); }
.sl-preview-who { display: flex; flex-direction: column; gap: 1px; }
.sl-preview-via { font-size: 11.5px; color: var(--sl-muted); text-transform: none; letter-spacing: 0; }
.sl-announce { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 60; max-width: min(520px, calc(100vw - 32px)); pointer-events: none; }
.sl-announce-card { pointer-events: auto; display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; background: var(--sl-surface); border: 1px solid var(--sl-line-strong, var(--sl-line)); border-radius: var(--sl-radius-card); box-shadow: 0 10px 28px rgba(0,0,0,.16); }
.sl-announce-card strong { font-size: 13px; }
.sl-announce-card span { font-size: 12.5px; color: var(--sl-muted); line-height: 1.55; }
.sl-announce-card > strong + span { margin-left: 0; }
.sl-announce-card { flex-wrap: wrap; }
.sl-announce-card strong { flex: 1 1 100%; }
.sl-announce-card span { flex: 1 1 100%; }
.sl-announce-action { flex: 0 0 auto; min-height: 32px; padding: 0 12px; font-size: 12.5px; cursor: pointer; background: var(--sl-accent, #f5b544); border: 1px solid var(--sl-accent, #f5b544); color: #1a1a1a; border-radius: var(--sl-radius-control); }
.sl-announce-dismiss { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; cursor: pointer; border: 0; background: transparent; color: var(--sl-muted); font-size: 17px; line-height: 1; }
.sl-announce-card { position: relative; padding-right: 34px; }
.sl-needs-setup { white-space: normal; }
/* Drawer-scoped compact type, per the accepted mockup's one scale —
   meta 10.5 / label 11.5 / compact 12.5 / body 13.5. The earlier overrides
   inflated every section paragraph to 14px; the components now carry their
   own sizes. */
.sl-preview-scroll .sl-field-note { margin: 2px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--sl-ink-2); }
.sl-preview-scroll .sl-field label { font-size: 11.5px; font-weight: 500; color: var(--sl-ink-2); }
.sl-preview-scroll .sl-output-copy .sl-output-label h3 { font-size: 11.5px; font-weight: 500; color: var(--sl-ink-2); }
/* One footer rule for both drawers -- the single-post preview and the batch
   drawer each carry exactly one action now, so there is no second, opposing
   system to keep in sync with this one. */
.sl-preview-actions.sl-preview-actions { padding: 8px 18px 16px; border-top: 0; display: flex; gap: 8px; }
.sl-preview-actions button { flex: 1; min-height: var(--sl-h-control); white-space: normal; }
/* What the composer below it must not lose, marked read-only -- a
   textarea cannot carry inline marks of its own. */
.sl-drawer-caption-preview { margin: 0; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; }
.sl-drawer-caption { width: 100%; resize: vertical; font: inherit; font-size: 13.5px; line-height: 1.55; padding: 10px 12px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); color: var(--sl-ink); }
.sl-drawer-caption[readonly] { background: var(--sl-surface-2); color: var(--sl-ink-2); }
.sl-drawer-caption:focus { outline: none; border-color: var(--sl-ink); }
.sl-drawer-caption.sl-dirty { border-color: var(--sl-ink); }
.sl-drawer-caption::placeholder { color: var(--sl-muted); }
.sl-drawer-composer .sl-drawer-caption { height: 126px; min-height: 42px; }
${globalThis.String.fromCharCode(64)}media (max-width: 700px) {
  .sl-mobile-panes { display: flex; gap: 6px; margin-bottom: 10px; }
  .sl-mobile-panes button { flex: 1; min-height: 44px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); font-size: 11px; }
  .sl-mobile-panes button[aria-selected="true"] { background: var(--sl-selected); font-weight: 650; }
  .sl-mobile-pane-source .sl-dual-pane:nth-child(2), .sl-mobile-pane-draft .sl-dual-pane:nth-child(1) { display: none; }
  .sl-mobile-pane-preview { display: none; }
  .sl-mobile-poster-host:not(.sl-mobile-pane-visible) { display: none; }
  .sl-inbox { margin-left: -2px; margin-right: -2px; padding: 10px; }
  .sl-inbox-grid { grid-template-columns: 1fr; }
  .sl-dual { grid-template-columns: 1fr; }
  .sl-poster-grid { grid-template-columns: 1fr; }
  .sl-preview-dialog.sl-drawer { margin: 7px; width: calc(100vw - 14px); max-width: none; height: calc(100dvh - 14px); max-height: none; border-radius: 12px; }
  .sl-preview-actions { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  .sl-zh-edit, .sl-field input, .sl-field select { font-size: 16px; }
}
`;

function buildShell() {
  const style = document.createElement("style");
  style.textContent = BASE_STYLE;
  document.head.appendChild(style);
  const root = el("main", { class: "sl-app" });
  const viewHost = el("div", { class: "sl-view-host" });
  root.append(viewHost);
  document.getElementById("gadget-root").appendChild(root);
  return { root, viewHost };
}

function buildPreviewDialog(onDismiss) {
  const dialog = el("dialog", { class: "sl-preview-dialog", "aria-labelledby": "sl-preview-title" });
  /*
   * A click on what is NOT the sheet closes it.
   *
   * With the dim gone the grid behind the drawer is legible, and a legible
   * thing that ignores clicks reads as a frozen page. `showModal` puts a
   * transparent backdrop over it, so the click lands on the dialog element
   * itself rather than on any of its content — which is exactly the test for
   * "outside".
   */
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (typeof onDismiss === "function") onDismiss();
    else dialog.close();
  });
  document.body.appendChild(dialog);
  return dialog;
}

function providerFormatKey(item) {
  const kind = item?.media?.[0]?.kind;
  if (kind === "video") return "drawerFormatVideo";
  if (kind === "carousel_child") return "drawerFormatCarousel";
  return "drawerFormatImage";
}

/** The handle that posted it, `@`-prefixed once, falling back to the watch it arrived on. */
function authorLabel(item) {
  const handle = typeof item?.authorHandle === "string" ? item.authorHandle.trim() : "";
  if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
  return item?.sourceLabel || "";
}

/** An absolute instant an owner can quote, plus the relative one they scan by. */
function postedLabel(locale, item) {
  if (!item?.publishedAt) return null;
  const when = new Date(item.publishedAt);
  if (Number.isNaN(when.getTime())) return null;
  const absolute = when.toLocaleString(locale === "zh-HK" ? "zh-HK" : "en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC"
  });
  const ago = relativeLabel(locale, item.publishedAt);
  return ago ? `${absolute} UTC · ${ago}` : `${absolute} UTC`;
}

/**
 * The facts the record actually holds.
 *
 * This was one line — "Format: Video post · Engagement: 3" — where
 * "engagement" was `metrics.likes` alone and nothing else on the record
 * reached the screen. The posting time, the comment count and the number of
 * frames all bear on whether this is the post to draft. Anything the
 * record does not carry is left out rather than rendered as zero (GUD-003).
 */
function drawerFacts(locale, item, frameCount) {
  const cells = [];
  const posted = postedLabel(locale, item);
  if (posted) cells.push([t(locale, "drawerPosted"), posted]);
  cells.push([t(locale, "drawerFormat"), t(locale, providerFormatKey(item))]);
  if (frameCount > 1) cells.push([t(locale, "drawerFrames"), String(frameCount)]);
  const number = (value) => typeof value === "number"
    ? value.toLocaleString(locale === "zh-HK" ? "zh-HK" : "en-US")
    : null;
  const likes = number(item?.metrics?.likes);
  if (likes !== null) cells.push([t(locale, "drawerLikes"), likes]);
  const comments = number(item?.metrics?.comments);
  if (comments !== null) cells.push([t(locale, "drawerComments"), comments]);

  return el("dl", { class: "sl-drawer-facts" }, cells.map(([label, value]) => el("div", { class: "sl-fact" }, [
    el("dt", null, label),
    el("dd", null, value)
  ])));
}

function App() {
  const gadget = globalThis.gadget;
  const rpc = createRpc(gadget);

  /*
   * The canvas does NOT record the filing outcome.
   *
   * The room stamps the platform's own acknowledgement on the durable mark
   * before the method result reaches the browser, so there is nothing for a
   * page to add — and a browser-authored receipt would be a claim it cannot
   * support. A page may ask for a status check; it may not assert that the
   * platform filed, refused or executed anything (audit correction, F4).
   */

  /*
   * A grid cover: cached bytes, as a `blob:` the canvas is allowed to show.
   *
   * Remote URLs are refused here — `img-src blob: data:` — so this is the only
   * shape a picture can take. Blob URLs are kept per media id and reused
   * across re-renders: the grid rebuilds on every selection change, and
   * minting a fresh URL each time would leak one per card per keystroke.
   */
  /*
   * The PROMISE is what is kept, not the finished URL.
   *
   * A re-render can start a second fill while the first is still running —
   * a selection change rebuilds the grid — and a map of finished URLs is
   * empty for everything still in flight, so the second pass would refetch
   * every one of them down a transport that runs one call at a time. Keyed on
   * the promise, a second asker waits on the first fetch instead of starting
   * another. A failure is dropped from the map so the next render may retry.
   */
  const coverUrls = new Map();
  function loadCover(itemId, mediaId) {
    const key = `${itemId}::${mediaId}`;
    const existing = coverUrls.get(key);
    if (existing) return existing;
    const pending = loadMediaAsBlobUrl(rpc, itemId, mediaId, "thumb")
      .then(({ url }) => url)
      .catch((error) => { coverUrls.delete(key); throw error; });
    coverUrls.set(key, pending);
    return pending;
  }
  // Content covers that show accepted OUTPUT come from the gadget's generated
  // store, cached by promise for the same reason as source covers.
  const generatedCoverUrls = new Map();
  function loadGeneratedCover(generatedMediaId) {
    const existing = generatedCoverUrls.get(generatedMediaId);
    if (existing) return existing;
    const pending = loadGeneratedImageAsBlobUrl(rpc, generatedMediaId)
      .then(({ url }) => url)
      .catch((error) => { generatedCoverUrls.delete(generatedMediaId); throw error; });
    generatedCoverUrls.set(generatedMediaId, pending);
    return pending;
  }

  const locale = resolveLocale(document.documentElement.lang);
  const announceRegion = el("div", { class: "sl-announce", role: "status", "aria-live": "polite" });
  const { root: shellRoot, viewHost } = buildShell();
  shellRoot.appendChild(announceRegion);
  // The two sheets get the right-docked drawer geometry; the confirm dialog
  // stays a small centered panel (same chrome, no .sl-drawer).
  const previewDialog = buildPreviewDialog(() => closePreview());
  const batchDialog = buildPreviewDialog();
  const leaveDialog = buildPreviewDialog();
  previewDialog.classList.add("sl-drawer");
  batchDialog.classList.add("sl-drawer");
  /*
   * The drawer dialog is shared across opens, so its listeners register ONCE
   * and delegate to the current session — a per-open `cancel` listener would
   * accumulate, and Escape would stack one unsaved-changes guard per drawer
   * ever opened.
   */
  let drawerSession = null; // { requestClose, refresh, dispose, previous } for the open drawer
  batchDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    // An open drawer popover (add-image or the picture's ⋯ menu) takes the
    // first Escape; the sheet asks next.
    if (drawerSession?.closeAddMenu?.(true)) return;
    drawerSession?.requestClose();
  });
  batchDialog.addEventListener("click", (event) => {
    // A drawer popover closes on any click outside its control and menu;
    // the sheet itself never closes on a stray click.
    if (event.target?.closest?.(".sl-addwrap")) return;
    drawerSession?.closeAddMenu?.(false);
  });
  batchDialog.addEventListener("close", () => {
    const session = drawerSession;
    session?.dispose?.();
    drawerSession = null;
    if (session?.previous instanceof HTMLElement) session.previous.focus();
  });

  let summary = null;
  let activeSection = null;
  let policy = {};
  let collectionState = createCollectionState();
  let inboxState = createInboxState();
  let wizard = createWizardState();
  let activePreviewItem = null;
  let activePreviewRail = null;
  // Every media rail still on screen (preview dialog and drawer panels), so a
  // host door notice reaches each one; a rail leaves the set when disposed.
  const liveMediaRails = new Set();
  let lastFocusedBeforePreview = null;
  let drawerRequest = 0;
  // Every summary read takes the next number; only the most recently started
  // read may write shared `summary`/`policy` (see `readSummaryInOrder`).
  let summaryReadSeq = 0;

  /**
   * PUT IT ON THE SCREEN.
   *
   * This was `console.log`, and nothing else — so the four outcomes routed
   * through it were invisible to the only person who needed them. Pressing
   * Continue with no destination configured wrote "createBatch needs at least
   * one destination binding" to a console the owner never opens, and on screen
   * absolutely nothing happened: no error, no movement, a button that did not
   * work and did not say why.
   *
   * `role="status"` with `aria-live="polite"` so a screen reader hears it
   * without the interruption an alert would cause. The console line stays —
   * the sandbox forwards it to the host, which is how a developer sees it —
   * but it is no longer the only place the sentence exists.
   */
  // Refresh is re-rendered on every state change; keep keyboard focus on it.
  let refreshBusy = false;
  function refocusRefresh(hadFocus) {
    if (!hadFocus) return;
    const next = viewHost.querySelector?.(".sl-refresh-action");
    if (next && typeof next.focus === "function") next.focus();
  }

  /*
   * The host's answers to door requests, correlated by request id and
   * requirement key. Only the parent window speaks for the host; an answer
   * nobody is waiting for is dropped, so a grant for another door (or an old
   * request's late reply) cannot start work here.
   */
  const pendingDoorRequests = new Map();
  /*
   * What the host announced it can carry — the agent-intent hand-off and
   * the top-up ask. A canvas hears it once at load (and again if the host
   * re-announces); until then nothing is assumed. The regenerate row and
   * the 增值 affordance stay visible but disabled with the reason, never
   * replaced by an inline fallback — the conversation IS the surface.
   */
  const hostFeatures = new Set();
  const hostFeatureListeners = new Set();
  const pendingTopupRequests = new Map();
  /*
   * The board card's ⋯ menu is a popover like the drawer's: a click anywhere
   * outside its wrapper closes it, Escape closes it and returns focus to the
   * ⋯ that opened it. The listeners sit on the canvas DOCUMENT — they cover
   * every focus position inside the gadget, which is also the boundary an
   * iframe makes of them (the host's own Escape can never reach in). Both
   * delegate to inboxState so they register once rather than per render.
   */
  if (typeof document.addEventListener === "function") document.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-cardmenu]")) return;
    if (!inboxState.cardMenu) return;
    inboxState = clearCardMenu(inboxState);
    renderCurrentView();
  });
  if (typeof document.addEventListener === "function") document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !inboxState.cardMenu) return;
    const id = inboxState.cardMenu.batchItemId;
    inboxState = clearCardMenu(inboxState);
    renderCurrentView();
    viewHost.querySelector(`.sl-cardmenu[data-cardmenu="${id}"] .sl-cardbtn`)?.focus?.();
  });
  // A sandboxed canvas always has a window to listen on; guarded so the
  // client still boots where there is none (unit shims, a detached render).
  if (typeof window.addEventListener === "function") window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    // The host's contract announcement: re-render any open drawer so the
    // row it governs flips between offered and disabled-with-reason.
    const features = parseGadgetHostFeaturesMessage(event.data);
    if (features) {
      hostFeatures.clear();
      for (const key of features.features) hostFeatures.add(key);
      for (const notify of hostFeatureListeners) notify();
      return;
    }
    // A top-up ask's answer, correlated by request id; the drawer's handler
    // owns what "topped_up" does next (the paused run resumes on its own).
    const topup = parseGadgetTopupResultMessage(event.data);
    if (topup?.requestId) {
      const pending = pendingTopupRequests.get(topup.requestId);
      if (!pending) return;
      pendingTopupRequests.delete(topup.requestId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ outcome: topup.outcome, message: topup.message });
      return;
    }
    // F2: an unprompted "something about this door may have changed" notice
    // — Studio's own access popover, not a reply to anything this canvas
    // asked (those go through gadget:grant-result below, correlated by
    // requestId). Handled first and returns either way: a doors-changed
    // message is never also a grant-result.
    const notice = parseGadgetDoorsChangedMessage(event.data);
    if (notice) {
      if (notice.requirementKey === "metered_fetch") onDoorsChanged();
      return;
    }
    const result = parseGadgetGrantResultMessage(event.data);
    if (!result?.requestId) return;
    const pending = pendingDoorRequests.get(result.requestId);
    if (!pending || pending.requirementKey !== result.requirementKey) return;
    pendingDoorRequests.delete(result.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({ outcome: result.outcome, message: result.message });
  });
  /**
   * A host door notice says an operation was attempted elsewhere, never that it
   * succeeded. Re-read consent (metadata only: no getMedia, provider call or
   * generation) and give live media rails the read's outcome. An obsolete read
   * changes nothing.
   */
  async function onDoorsChanged() {
    const state = await readMeteredFetchConsent();
    if (state === null) return;
    for (const rail of liveMediaRails) rail.notifyPermission({ state });
  }

  /** The owner's "Check again": the same ordered read; an obsolete one reports the committed state. */
  async function recheckMeteredFetchConsent() {
    const state = await readMeteredFetchConsent();
    return { state: state ?? meteredFetchConsentOf(summary) };
  }

  /**
   * Current `metered_fetch` consent from an ordered summary read: "granted",
   * "absent", "unknown" when the current read failed, or null when a newer read
   * started meanwhile (that read owns shared state and the answer).
   */
  async function readMeteredFetchConsent() {
    const read = await readSummaryInOrder();
    if (!read.current) return null;
    if (read.error) {
      console.error(read.error);
      return "unknown";
    }
    return meteredFetchConsentOf(read.snapshot);
  }

  /** The same derivation Settings uses for `fetchGranted`. */
  function meteredFetchConsentOf(snapshot) {
    return Boolean(snapshot?.doors?.metered_fetch) ? "granted" : "absent";
  }

  /**
   * Reads the summary, then commits it to shared `summary`/`policy` only if no
   * newer read started while this one was pending. A stale success or failure
   * leaves the newer state untouched.
   */
  async function readSummaryInOrder() {
    const seq = ++summaryReadSeq;
    try {
      const snapshot = await rpc.summary();
      const current = seq === summaryReadSeq;
      if (current) commitSummary(snapshot);
      return { snapshot, current };
    } catch (error) {
      return { error, current: seq === summaryReadSeq };
    }
  }

  function commitSummary(snapshot) {
    summary = snapshot;
    policy = snapshot?.config || {};
  }

  /** Existing callers: an ordered read that throws on failure and returns the snapshot. */
  async function refreshSummary() {
    const read = await readSummaryInOrder();
    if (read.error) throw read.error;
    return read.snapshot;
  }

  function askHost(type, requirementKey, timeoutMs) {
    const requestId = newGrantRequestId();
    return new Promise((resolve) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            if (!pendingDoorRequests.delete(requestId)) return;
            resolve({ outcome: "unconfirmed", message: null });
          }, timeoutMs)
        : null;
      pendingDoorRequests.set(requestId, { requirementKey, resolve, timer });
      window.parent.postMessage({ type, requirementKey, requestId }, "*");
    });
  }
  // Consent waits on the owner, so it has no deadline; activation is a
  // machine answer and is unconfirmed if it does not arrive in time.
  const requestDoorGrant = (requirementKey) => askHost("gadget:grant-door", requirementKey, 0);
  const requestDoorActivation = (requirementKey) => askHost("gadget:activate-door", requirementKey, 45_000);

  /*
   * The Reference tab and the source preview both draw the post's frames in
   * the Post tab's own vocabulary — one numbered slot per frame, every frame
   * reading at once through the same consented `getMedia` door. The rail
   * owns nothing new: grant, activation, recheck and refresh are the
   * callbacks it needs from here.
   */
  function mediaRailFor(target) {
    const rail = createMediaRail(rpc, target, locale, {
      requestGrant: () => requestDoorGrant("metered_fetch"),
      requestActivation: () => requestDoorActivation("metered_fetch"),
      refreshSources: () => collectionHandlers.onRefresh(),
      // The owner's own "Check again" on an unconfirmed-permission frame:
      // the same metadata-only read as a notice, never `getMedia`.
      recheckPermission: () => recheckMeteredFetchConsent()
    });
    liveMediaRails.add(rail);
    const dispose = rail.dispose;
    rail.dispose = () => {
      liveMediaRails.delete(rail);
      dispose();
    };
    return rail;
  }

  const toaster = createToaster(announceRegion, {
    duration: 12000,
    dismissLabel: t(locale, "dismiss"),
    onLog: (title, body) => console.log(`[social-content] ${title}: ${body || ""}`),
    // The `sl-announce-*` chrome is this canvas's own — the card markup stays
    // byte-identical to the pre-extraction toast.
    classes: { card: "sl-announce-card", action: "sl-announce-action", dismiss: "sl-announce-dismiss" }
  });
  // Long enough to read a refusal, and it can be dismissed sooner — a notice
  // that vanishes before it is read is the same as no notice (the toaster's
  // own duration).
  function announce(title, body, action) {
    toaster.show({ title, body, action });
  }
  announce.clear = toaster.clear;

  async function loadCollection(filter = collectionState.filter) {
    collectionState = setLoading(collectionState, true);
    renderCurrentView();
    try {
      const page = await rpc.listItems({ filter, sourceBinding: collectionState.sourceFilter || undefined, query: collectionState.search || undefined });
      collectionState = setItems(collectionState, { items: page.items || [], nextCursor: page.nextCursor || null });
      inboxState = setInboxSourceItems(inboxState, page.items || []);
      // Read-only inbox projection is fetched independently from source
      // selection. It is never used to create a batch or infer approval.
      try {
        const summaries = await rpc.listBatchSummaries({ limit: 50 });
        inboxState = setInboxSummaries(inboxState, summaries);
        if (activeSection === null) activeSection = inboxState.summaries.some(b => b.draftCount || b.reviewCount || b.attentionCount) ? 'content' : 'sources';
      } catch (error) {
        inboxState = { ...inboxState, loading: false, error: error instanceof Error ? error.message : t(locale, "batchLoadFailed") };
      }
      collectionState = setLastCheckedAt(collectionState, new Date().toISOString());
    } catch (error) {
      console.error(error);
      collectionState = setLoading(collectionState, false);
    }
    renderCurrentView();
  }

  // --- Preview drawer (REQ-021 / PAT-005) ---------------------------------
  async function openPreview(item) {
    lastFocusedBeforePreview = document.activeElement;
    activePreviewItem = item;
    const body = el("div", { class: "sl-preview-scroll" });

    if (activePreviewRail) activePreviewRail.dispose();
    activePreviewRail = mediaRailFor(item);

    /*
     * Same column pair as the drawer's 帖文 and 參考 panels: media under a
     * quiet label on the left, caption + facts on the right. Inspecting a
     * source post is the same act as checking the reference a draft kept.
     */
    replace(body, [
      el("section", { class: "sl-drawer-section", "aria-labelledby": "sl-source-media-label" }, [
        el("div", { class: "sl-cols" }, [
          el("div", { class: "sl-cols-media" }, [
            el("div", { class: "sl-collabel" }, [
              el("span", { class: "sl-field-label sl-grow", id: "sl-source-media-label" }, t(locale, "drawerRefImageLabel"))
            ]),
            activePreviewRail.node
          ]),
          el("div", { class: "sl-cols-side" }, [
            el("div", { class: "sl-collabel" }, [
              el("span", { class: "sl-field-label sl-grow" }, t(locale, "drawerSourceCaption")),
              item.permalink
                ? el("a", { href: item.permalink, target: "_blank", rel: "noopener noreferrer", class: "sl-brief-link" }, t(locale, "drawerViewOriginal"))
                : null
            ].filter(Boolean)),
            el("p", { class: "sl-drawer-caption-preview sl-reference-text" }, item.text || ""),
            drawerFacts(locale, item, activePreviewRail.frameCount),
            item.duplicateOf ? el("p", { class: "sl-field-note" }, t(locale, "duplicateNote")) : null
          ].filter(Boolean))
        ])
      ])
    ]);

    /*
     * RELABEL THE FOOTER; DO NOT REBUILD THE DRAWER.
     *
     * Selecting used to call `openPreview` again, which disposes the media
     * rail and builds a new one — so pressing "Select post" threw away the
     * picture and refetched it, and the only visible result of the press was
     * that the image vanished for several seconds and came back. Nothing else
     * on screen acknowledged the action at all.
     *
     * The footer is the only part that depends on `selected`, so the footer is
     * the only part that is redrawn, and the selection is confirmed where the
     * owner is looking rather than only in the grid behind the drawer.
     */
    /*
     * ONE ACTION.
     *
     * The footer offered "Select post" beside "Select & continue", which are
     * the same decision asked twice: both select, and the difference is only
     * whether the drawer stays open. Two buttons of near-identical weight is
     * a choice the owner has to read before making the one that matters.
     *
     * Deselecting does not belong here either — the card's own checkbox and
     * the tray's Clear are where a selection is taken back, and this drawer is
     * open on the post you are deciding about.
     */
    const actions = el("footer", { class: "sl-preview-actions sl-drawer-footer" });
    const drawActions = (isSelected) => replace(actions, [
      el("div", { class: "sl-drawer-footer-actions" }, [
        el(
          "button",
          {
            type: "button",
            class: "sl-primary",
            onclick: async () => {
              if (!activePreviewItem.selected) {
                await handleSelect(item.id, true);
                activePreviewItem = { ...activePreviewItem, selected: true };
              }
              closePreview();
            }
          },
          isSelected ? t(locale, "drawerContinueSelected") : t(locale, "drawerSelectAndContinue")
        )
      ])
    ]);
    drawActions(!!item.selected);

    replace(previewDialog, [
      el("div", { class: "sl-preview-sheet" }, [
        el("header", { class: "sl-preview-head" }, [
          /*
           * WHO POSTED IT, then which watch it arrived on.
           *
           * This showed `item.sourceLabel` first, which is the account being
           * watched — so four of the twelve posts a real account produced were
           * headed with the watched account while belonging to four other
           * authors it had reposted or tagged. Those
           * are precisely the posts whose authors are somebody else — the
           * one screen that has to get the author right had it wrong.
           */
          el("div", { class: "sl-preview-who" }, [
            el("span", { class: "sl-preview-kicker" }, t(locale, "drawerEyebrow")),
            el("strong", { id: "sl-preview-title" }, authorLabel(item)),
            item.sourceLabel && authorLabel(item) !== item.sourceLabel
              ? el("span", { class: "sl-preview-via" }, t(locale, "drawerVia", { source: item.sourceLabel }))
              : null
          ]),
          el("div", { class: "sl-preview-head-actions" }, [
            el("button", {
              type: "button", class: "sl-icon-action",
              title: t(locale, "close"), "aria-label": t(locale, "close"),
              onclick: () => closePreview()
            }, icon("close"))
          ])
        ]),
        body,
        actions
      ])
    ]);
    previewDialog.showModal();
  }

  /**
   * The Saved drawer is ONE post. `{ id, itemId }` arrives from the clicked
   * card: `id` is the containing batch (fetched for provenance and sibling
   * navigation), `itemId` the batch item that is the drawer's actual
   * subject. Generated output — the poster image and the draft caption
   * — is the primary content; the source post sits in a labelled reference
   * section below it. Every save/regenerate/review action scopes to the
   * viewed item: an action taken on one post never writes a sibling.
   */
  async function openBatchDrawer({ id, itemId }) {
    const request = ++drawerRequest;
    const previous = document.activeElement;
    let batch;
    try { batch = await rpc.getBatch(id); } catch (error) {
      if (request !== drawerRequest) return;
      collectionState = setNotice(collectionState, { message: error instanceof Error ? error.message : t(locale, "batchLoadFailed") });
      renderCurrentView();
      return;
    }
    if (!batch) {
      collectionState = setNotice(collectionState, { message: t(locale, "batchUnavailable") });
      renderCurrentView();
      return;
    }
    if (request !== drawerRequest) return;

    const destinationLabel = (binding) =>
      (summary?.destinations || []).find((d) => d.destinationBinding === binding || d.binding === binding)?.label || binding;

    let items = Array.isArray(batch.items) ? batch.items : [];
    let activeId = items.find((item) => item.id === itemId)?.id ?? items[0]?.id ?? null;
    const activeItem = () => items.find((item) => item.id === activeId) ?? null;
    // Always recompute — a cached `item.phase` taken before a save left a
    // saved draft labelled "queued" once its generation mark cleared.
    const phaseOf = (item) =>
      itemPresentation({
        state: item?.state,
        revision: item?.revision ?? 0,
        generation: item?.generation,
        publications: item?.publications ?? [],
        targets: item?.targets ?? []
      }).phase;

    // The owner's unsaved work, per post, never applied to a sibling:
    // `{ caption?, imageId?, instructions?: { image?, caption? } }`. A post's
    // buffer is committed only by that post's own Save/Review, or by the
    // close guard's explicit "save and leave".
    const buffers = new Map(); // batchItemId -> buffer
    const ownerUploads = new Map(); // batchItemId -> File
    const bufferOf = (id) => buffers.get(id) ?? {};
    /**
     * The image brief a Generate press would send, resolved: the staged
     * buffer choices over the configured defaults, so the block and the
     * request can never disagree about what "the default" is. `useSource`
     * means "the post's own image is the basis" (an edit); `ratio` is never
     * unset. The one-off fields stage the this-generation instruction layer.
     */
    const imageBriefOf = (item) => {
      const stored = bufferOf(item.id).imageBrief ?? {};
      return {
        useSource: stored.useSource ?? policy?.posterReferences !== "none",
        ratio: stored.ratio ?? policy?.posterAspectRatio ?? "4:5",
        oneOffOpen: stored.oneOffOpen === true,
        oneOff: stored.oneOff ?? "",
        saveOneOff: stored.saveOneOff === true
      };
    };
    /**
     * The ⋯ row's whole job: hand THIS image to the host's conversation. The
     * intent carries enough context — post, item, media id, the brief's ratio
     * and reference basis, a thumbnail of what is on screen, and the one-tap
     * answers already in the owner's language — that the conversation never
     * asks which image is meant. The canvas posts it and its layout does not
     * move; the host owns what the conversation does next. Nothing here runs
     * a generation — filing stays the durable requestGeneration the agent
     * submits after the owner approves the plan.
     */
    const postAgentIntent = (item, slot = null) => {
      if (!hostFeatures.has("agent-intent")) return;
      const brief = imageBriefOf(item);
      try {
        window.parent.postMessage(gadgetAgentIntentMessage({
          intent: "image.regenerate",
          post: { batchId: batch.id, batchItemId: item.id, title: item.title ?? null },
          image: {
            // The image the conversation corrects is the SLOT's picture, not
            // the post's first one — page 2's regen talks about page 2.
            mediaId: slot?.generated?.id ?? item.generatedImage?.id ?? null,
            aspectRatio: brief.ratio,
            references: brief.useSource ? "source" : "none",
            thumbnail: intentThumbnail()
          },
          page: slot ? { pageId: slot.page.pageId, index: slot.index } : null,
          suggestedReplies: REGEN_SUGGESTION_KEYS.map((key) => t(locale, key)),
          locale
        }), "*");
      } catch (error) {
        console.error("agent intent could not be posted", error);
      }
    };
    /**
     * A small JPEG of the picture on screen so the conversation's intent
     * card shows the actual image being discussed — drawn from the rendered
     * <img>, never fetched again. When it cannot be drawn (still loading, a
     * shim without canvas) the card simply renders without it.
     */
    const intentThumbnail = () => {
      try {
        const img = batchDialog.querySelector?.(".sl-output-frame-accepted .sl-pc-canvas");
        if (!img?.naturalWidth || !img?.naturalHeight) return null;
        const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.72);
      } catch {
        return null;
      }
    };
    /**
     * The 增值 ask on a credits-paused run. The host owns the funding surface;
     * this canvas asks and hears the answer. `topped_up` resumes the paused
     * run on its own — the drawer's handler calls retryStart, which re-files
     * the SAME request (mark's needs + brief + run instructions), so nothing
     * the owner already agreed to is re-asked or re-decided.
     */
    const requestTopup = (item) => {
      const requestId = newTopupRequestId();
      const reply = new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pendingTopupRequests.delete(requestId)) return;
          resolve({ outcome: "unconfirmed", message: null });
        }, 120_000);
        pendingTopupRequests.set(requestId, { resolve, timer });
      });
      window.parent.postMessage(gadgetTopupMessage({
        post: { batchId: batch.id, batchItemId: item.id, title: item.title ?? null },
        requestId
      }), "*");
      return reply;
    };
    /*
     * Per-post sheet state that is NOT content and never saved: the add
     * menu, the publish picker's open state, the transient destination
     * picks, the schedule field's chosen local time, and the top-up ask's
     * in-flight/outcome flags. Like the buffers, one entry per post.
     */
    const drawerUi = new Map(); // batchItemId -> { menuOpen?, menuAnchor? (a pageId), destOpen?, picking?, scheduledAt?, picked?, dismissedCandidates? (Set), topupPending?, topupDone?, topupCancelled? }
    const uiOf = (id) => drawerUi.get(id) ?? {};
    const patchUi = (id, patch) => drawerUi.set(id, { ...uiOf(id), ...patch });
    // Every change to a buffered field bumps that field's edit version, so a
    // Save acknowledgment can tell "still what I submitted" from "typed
    // since" — including typing the same text back after changing it.
    // Keys: caption, altText, imageId, instructions.image, instructions.caption.
    const editVersions = new Map(); // batchItemId -> { [fieldKey]: n }
    const bumpVersions = (id, keys) => {
      const held = { ...(editVersions.get(id) ?? {}) };
      for (const key of keys) held[key] = (held[key] ?? 0) + 1;
      editVersions.set(id, held);
    };
    const bufferKeys = (patch) => Object.entries(patch).flatMap(([key, value]) =>
      key === "instructions" ? Object.keys(value ?? {}).map((part) => `instructions.${part}`) : [key]);
    const patchBuffer = (id, patch) => {
      const before = bufferOf(id);
      const keys = new Set(bufferKeys(patch));
      if ("instructions" in patch) for (const part of Object.keys(before.instructions ?? {})) keys.add(`instructions.${part}`);
      const changed = [...keys].filter((key) => {
        const [head, part] = key.split(".");
        return part ? before.instructions?.[part] !== patch.instructions?.[part] : before[head] !== patch[head];
      });
      if (changed.length) bumpVersions(id, changed);
      buffers.set(id, { ...before, ...patch });
    };
    /** Drop buffered fields (a discard, not a save): later snapshots must not match them. */
    const dropBufferFields = (id, keys) => {
      const next = { ...bufferOf(id) };
      for (const key of keys) delete next[key];
      bumpVersions(id, bufferKeys(Object.fromEntries(keys.map((key) => [key, bufferOf(id)[key]]))));
      buffers.set(id, next);
    };
    /** What a Save submits for one post: each buffered field's value and edit version. */
    const snapshotBuffer = (id) => {
      const buffer = bufferOf(id);
      return {
        buffer: { ...buffer, instructions: buffer.instructions ? { ...buffer.instructions } : undefined },
        versions: { ...(editVersions.get(id) ?? {}) }
      };
    };
    /**
     * After an acknowledged save, clear only the fields still exactly as
     * submitted (same edit version). A field edited while the save was in
     * flight keeps its newer buffer and stays dirty.
     */
    const acknowledgeFields = (id, snapshot, keys) => {
      const current = editVersions.get(id) ?? {};
      const next = { ...bufferOf(id) };
      const instructions = { ...(next.instructions ?? {}) };
      for (const key of keys) {
        if ((current[key] ?? 0) !== (snapshot.versions[key] ?? 0)) continue;
        const [head, part] = key.split(".");
        if (part) delete instructions[part];
        else delete next[head];
      }
      if (keys.some((key) => key.startsWith("instructions."))) {
        if (Object.keys(instructions).length) next.instructions = instructions;
        else delete next.instructions;
      }
      if (Object.keys(next).length) buffers.set(id, next);
      else buffers.delete(id);
    };
    const itemNotes = new Map();     // batchItemId -> live note element (current render)
    const generatedUrls = new Map(); // generatedMediaId -> live blob: URL (revoked on redraw/close)
    // One reference rail per post for this drawer session, kept across
    // section switches (its node is re-attached, never rebuilt) so the frame
    // reads, loaded/blocked state and any recovery in progress survive.
    // Disposed when the post leaves the drawer, its source item changes, or
    // the drawer ends.
    const rails = new Map(); // batchItemId -> { key, rail }
    // A generated caption that arrived over the owner's unsaved caption.
    const captionConflicts = new Map(); // batchItemId -> { caption, revision }
    // What the PLATFORM says happened to a request, read through Check status.
    // The mark's own dispatch is a filing record; only the platform can say an
    // approval was answered, declined or executed, so this is what the footer
    // shows once it is known. batchItemId -> { status, actionId, at }.
    const canonicalStatus = new Map();
    // Which posts already have a status read in flight, so an automatic check
    // runs once per render rather than on every redraw.
    const statusChecked = new Set();
    // Which outcome-bearing requests already had their pushed outcome read
    // back, keyed by post and request — one re-check per outcome, never a poll.
    const outcomeRechecked = new Set();
    // A status check and a resume have their OWN busy state. Using the save
    // state for them disabled every unrelated control for the duration and left
    // the body rendered busy when only the footer was redrawn (F2).
    let statusChecking = false;
    let resuming = false;
    let activeTab = "output";
    let closing = false;
    let saving = false;
    let live = true;      // false once this drawer closed or another replaced it
    let readToken = 0;    // monotonically increasing: only the newest read may land
    let session = null;

    const sourceKeyOf = (item) => {
      const source = item?.sourceItem;
      return source ? `${source.id ?? ""}::${(source.media ?? []).map((media) => media?.id).join(",")}` : null;
    };
    const railFor = (item) => {
      const key = sourceKeyOf(item);
      const held = rails.get(item.id);
      if (held && held.key === key) return held.rail;
      held?.rail.dispose();
      const rail = mediaRailFor(item.sourceItem);
      rails.set(item.id, { key, rail });
      return rail;
    };

    /** Merge a fresh read: saved output replaces the projection, owner buffers stay. */
    const applyFresh = (freshItems) => {
      for (const next of freshItems) {
        const previous = items.find((entry) => entry.id === next.id);
        const conflict = captionConflictFor(previous, next, bufferOf(next.id));
        if (conflict) captionConflicts.set(next.id, conflict);
        else if (captionConflicts.has(next.id)) {
          const draft = bufferOf(next.id).caption;
          if (draft === undefined || draft === (next.caption || "")) captionConflicts.delete(next.id);
        }
      }
      items = freshItems;
      if (!items.some((entry) => entry.id === activeId)) activeId = items[0]?.id ?? null;
      for (const [id, held] of rails) {
        const owner = items.find((entry) => entry.id === id);
        if (!owner || sourceKeyOf(owner) !== held.key) {
          held.rail.dispose();
          rails.delete(id);
        }
      }
    };

    /*
     * What must survive a rewrite, marked where the owner is looking at the
     * caption — not a fact the owner has to already know to check for.
     */
    const highlightedCaption = (text) => {
      const value = text || "";
      const spans = detectProtectedLiterals(value, policy).sort((a, b) => a.start - b.start);
      if (!spans.length) return null;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const span of spans) {
        if (span.start > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, span.start)));
        frag.appendChild(el("mark", { class: "sl-lit" }, value.slice(span.start, span.end)));
        cursor = Math.max(cursor, span.end);
      }
      if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
      return frag;
    };

    /**
     * Legacy poster bytes exist only when the client renders them. Only a
     * revision whose recorded pick ships the poster (or a pre-picker revision
     * with a stored layout) needs them; new content never has a layout.
     */
    const materializePoster = async (item) => {
      if (item.acceptedVisualMode === "ai_refinement" || item.acceptedVisualMode === "keep_original") {
        return { ok: true, revision: item.revision ?? 0 };
      }
      if (!item.posterLayout) return { ok: true, revision: item.revision ?? 0 };
      if (item.posterStored && item.posterMimeType === "image/jpeg") return { ok: true, revision: item.revision ?? 0 };
      let png;
      try {
        png = await renderPosterImage(item.posterLayout.template, {
          headline: item.posterLayout.headline, subline: item.posterLayout.subline,
          background: { value: item.posterLayout.background?.value },
          textColor: item.posterLayout.textColor, align: item.posterLayout.align
        });
      } catch (error) {
        return { ok: false, error };
      }
      const stored = await rpc.savePoster({
        batchItemId: item.id, expectedRevision: item.revision ?? 0,
        template: item.posterLayout.template, png
      });
      if (stored && stored.ok === false) return { ok: false, refusal: stored };
      return { ok: true, revision: stored?.revision ?? null };
    };

    const refetchItems = async () => {
      const token = ++readToken;
      try {
        const fresh = await rpc.getBatch(batch.id);
        // A newer read started, or the drawer ended: this answer is stale.
        if (!live || token !== readToken) return false;
        if (fresh?.items) { applyFresh(fresh.items); return true; }
      } catch (error) {
        console.error(error);
      }
      return false;
    };

    const revisionIssue = (result) => {
      const one = result?.results?.[0] ?? result;
      if (one?.ok !== false && one?.ok !== undefined) return null;
      if (one?.ok === true) return null;
      return (one?.issues || []).map((issue) => issue.message).join(" ") || refusalMessage(one ?? {}) || t(locale, "saveFailed");
    };

    const applyVisual = async (item, patch) => {
      if (saving) return false;
      saving = true;
      redrawFooter();
      let result;
      try {
        result = await rpc.saveRevisions({
          revisions: [{ batchItemId: item.id, expectedRevision: item.revision ?? 0, ...patch }]
        });
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      } finally {
        saving = false;
      }
      const failed = revisionIssue(result);
      if (failed) announce(failed, "");
      if (!live) return false;
      if (!failed) {
        dropBufferFields(item.id, ["imageId", "visualMode", "imageSource", "pages"]);
        ownerUploads.delete(item.id);
      }
      await refetchItems();
      redraw();
      return !failed;
    };

    /**
     * The visual commits that are decisions, not drafts: page structure
     * (add/remove/fill), source adoption, visual mode. They save at once —
     * exactly what `acceptedVisualMode` did before pages existed — so an
     * empty page the owner made persists and blocks filing until filled.
     * The staged `pages` buffer is reserved for edits that go through Save:
     * a staged candidate pick and per-page alt text.
     */
    const applyPages = (item, nextPages) => applyVisual(item, { pages: nextPages });

    /** A fresh durable page id — unique inside this post's list. */
    const newPageId = (item) => {
      const taken = new Set(workingPages(item, bufferOf(item.id)).map((page) => page.pageId));
      for (let n = 1; ; n += 1) {
        const id = `pg_own_${Date.now().toString(36)}_${n}`;
        if (!taken.has(id)) return id;
      }
    };

    const pickOwnerUpload = (item, pageId = null, file = null) => {
      if (file) {
        ownerUploads.set(item.id, { file, pageId });
        patchBuffer(item.id, { imageSource: "upload" });
        redraw();
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg";
      input.addEventListener("change", () => {
        const chosen = input.files?.[0];
        if (!chosen) return;
        ownerUploads.set(item.id, { file: chosen, pageId });
        patchBuffer(item.id, { imageSource: "upload" });
        redraw();
      });
      input.click();
    };

    const adoptOwnerUpload = async (item) => {
      const upload = ownerUploads.get(item.id);
      const file = upload?.file ?? upload ?? null;
      const pageId = upload?.pageId ?? null;
      if (!file || saving) return;
      saving = true;
      redrawFooter();
      let failed = null;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // The upload answers the PAGE it was picked for — the row carries
        // the binding, so the save pins it into exactly that slot and a
        // delivery for another page can never fill this one.
        const registered = await rpc.saveGeneratedImage({
          batchItemId: item.id,
          pageId,
          altText: file.name.replace(/\.[^.]+$/, "") || null,
          mimeType: file.type || null
        });
        if (!registered?.id) {
          failed = revisionIssue(registered);
        } else {
          const delivered = await rpc.deliverGeneratedImage({ id: registered.id, bytes });
          if (delivered?.ok === false) failed = revisionIssue(delivered);
          else {
            const pages = workingPages(item, bufferOf(item.id)).map((page) =>
              page.pageId === pageId ? { ...page, kind: "generated", mediaId: registered.id } : page
            );
            const result = pageId
              ? await rpc.saveRevisions({ revisions: [{ batchItemId: item.id, expectedRevision: item.revision ?? 0, pages }] })
              : await rpc.saveRevisions({
                    revisions: [{
                      batchItemId: item.id,
                      expectedRevision: item.revision ?? 0,
                      acceptedVisualMode: "ai_refinement",
                      acceptedGeneratedMediaId: registered.id
                    }]
                  });
            failed = revisionIssue(result);
          }
        }
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
      } finally {
        saving = false;
      }
      if (failed) announce(failed, "");
      if (!live) return;
      if (!failed) {
        dropBufferFields(item.id, ["imageId", "visualMode", "imageSource", "pages"]);
        ownerUploads.delete(item.id);
      }
      await refetchItems();
      redraw();
    };

    /**
     * Save the named posts: one `saveRevisions` for caption edits and staged
     * images (accepting a candidate pins its id), then each post's
     * instruction overrides. Per-item issues land on that item's note line;
     * a failed part keeps its buffer.
     */
    const saveItems = async (ids) => {
      const work = ids
        .map((idToSave) => items.find((entry) => entry.id === idToSave))
        .filter(Boolean)
        .map((item) => ({ item, snapshot: snapshotBuffer(item.id) }))
        .map((job) => ({ ...job, entry: revisionEntryFor(job.item, job.snapshot.buffer), patch: instructionPatchFor(job.item, job.snapshot.buffer, ["image", "caption"], instructionDefaultsOf(policy)) }))
        .filter((job) => job.entry || job.patch);
      if (!work.length) return true;
      saving = true;
      redrawFooter();
      for (const job of work) {
        const note = itemNotes.get(job.item.id);
        if (note) note.textContent = t(locale, "saving");
      }
      let allOk = true;
      try {
        const revisionJobs = work.filter((job) => job.entry);
        if (revisionJobs.length) {
          const result = await rpc.saveRevisions({ revisions: revisionJobs.map((job) => job.entry) });
          // This drawer ended (closed, or replaced by another) while saving:
          // its buffers and view are gone; the acknowledgment has nowhere to land.
          if (!live) return false;
          for (const [index, job] of revisionJobs.entries()) {
            const one = result?.results?.[index];
            const note = itemNotes.get(job.item.id);
            if (one?.ok) {
              // A live read may have replaced the item object mid-save: apply
              // to the post by id, never to a sibling.
              for (const target of new Set([job.item, items.find((entry) => entry.id === job.item.id)].filter(Boolean))) {
                target.revision = one.revision;
                if (job.entry.caption !== undefined) target.caption = job.entry.caption;
                if (job.entry.altText !== undefined) target.altText = job.entry.altText;
                if (job.entry.publicationIntent) target.publicationIntent = job.entry.publicationIntent;
                target.generation = one.generation ?? null;
                target.phase = null;
              }
              acknowledgeFields(job.item.id, job.snapshot, ["caption", "imageId", "altText", "pages", "publicationIntent"]);
              captionConflicts.delete(job.item.id);
              if (note) note.textContent = t(locale, "drawerRevisionSaved", { n: one.revision });
            } else {
              allOk = false;
              // The note line is rebuilt by the re-read's redraw; announce too,
              // so the reason the save failed stays visible to the owner.
              const message = (one?.issues || []).map((issue) => issue.message).join(" ") || t(locale, "saveFailed");
              if (note) note.textContent = message;
              announce(message, "");
            }
          }
        }
        for (const job of work.filter((entry) => entry.patch)) {
          const saved = await rpc.saveInstructionOverrides(job.patch);
          if (!live) return false;
          if (saved?.ok) {
            for (const target of new Set([job.item, items.find((entry) => entry.id === job.item.id)].filter(Boolean))) {
              target.instructionOverrides = saved.instructionOverrides;
              target.effectiveInstructions = saved.effectiveInstructions;
            }
            acknowledgeFields(job.item.id, job.snapshot, ["image", "caption"].map((part) => `instructions.${part}`));
          } else {
            allOk = false;
            announce(refusalMessage(saved ?? {}) || t(locale, "saveFailed"), "");
          }
        }
      } catch (error) {
        allOk = false;
        announce(error instanceof Error ? error.message : t(locale, "saveFailed"), "");
      } finally {
        saving = false;
      }
      // The saved rows are canonical (a pinned candidate becomes the accepted
      // image); keep what the save acknowledged when the reread fails.
      await refetchItems();
      if (allOk) {
        try { inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 })); } catch (error) { console.error(error); }
      }
      return allOk;
    };

    const dirtyItemIds = () => items.filter((item) => dirtyParts(item, bufferOf(item.id), instructionDefaultsOf(policy)).any).map((item) => item.id);

    /**
     * The one exit guard every drawer dismissal runs — Close, Escape and
     * Publish call it. Unsaved caption, staged image and instruction edits
     * are one decision: keep editing, discard, or save and leave.
     *
     * One policy for every continuation (Close, Publish, generation): a save
     * acknowledges only the field versions it submitted, so an edit typed
     * while it was in flight stays buffered and dirty. After every await the
     * guard looks again; a newer edit is shown and asked about afresh — an
     * earlier "save and leave" never authorizes discarding later input.
     * Resolves true only when nothing unsaved remains and this drawer is live.
     */
    const requestExit = async () => {
      if (closing || saving) return false;
      for (;;) {
        if (!live) return false;
        const dirty = dirtyItemIds();
        if (!dirty.length) return true;
        const decision = await confirmUnsavedNavigation(leaveDialog, locale);
        if (!live || decision === "keep") return false;
        // "discard" must actually drop the buffers, so a later save (Review's
        // own) cannot resurrect what the owner threw away.
        if (decision === "discard") {
          for (const id of dirty) dropBufferFields(id, Object.keys(bufferOf(id)));
          continue;
        }
        const saved = await saveItems(dirty);
        if (!live) return false;
        // Show what the acknowledgment left: newer edits, still dirty.
        redrawPreserving();
        if (!saved) return false;
      }
    };

    /** After an await: a drawer holding newer unsaved edits stays open and asks again. */
    const settleNewerEdits = async () => {
      if (!live) return false;
      if (!dirtyItemIds().length) return true;
      redrawPreserving();
      return requestExit();
    };

    /**
     * Publish or schedule this ONE post from the sheet: save its buffer,
     * materialize a legacy poster when one is still what ships, then file
     * through submitForReview. The click is the grant — no wizard hop, no
     * second approve-elsewhere to-do. Edits typed during those awaits stop
     * the submit; they stay dirty and are asked about.
     */
    const submitFromDrawer = async (item) => {
      if (saving) return;
      if (dirtyItemIds().some((id) => id !== item.id) && !(await requestExit())) return;
      if (!live) return;
      if (!(await saveItems([item.id]))) {
        if (live) redrawPreserving();
        return;
      }
      const note = () => itemNotes.get(item.id);
      const readFailed = () => {
        const line = note();
        if (line) line.textContent = t(locale, "drawerReviewReadFailed");
        announce(t(locale, "drawerReviewReadFailed"), "");
      };
      let fresh;
      let current;
      for (;;) {
        if (!(await settleNewerEdits())) return;
        try { fresh = await rpc.getBatch(batch.id); } catch { fresh = null; }
        if (!live) return;
        current = fresh?.items?.find((entry) => entry.id === item.id);
        if (!current) { readFailed(); return; }
        if (!isEditableItem(current)) {
          applyFresh(fresh.items);
          redraw();
          announce(t(locale, "batchUnavailable"), "");
          return;
        }
        const materialized = await materializePoster(current);
        if (!live) return;
        if (!materialized.ok) {
          const message = materialized.refusal ? refusalMessage(materialized.refusal) : materialized.error?.message ?? t(locale, "genericError");
          const line = note();
          if (line) line.textContent = message;
          announce(message, "");
          return;
        }
        try { fresh = await rpc.getBatch(batch.id); } catch { fresh = null; }
        if (!live) return;
        current = fresh?.items?.find((entry) => entry.id === item.id) ?? null;
        if (!current || (materialized.revision != null && (current.revision ?? 0) < materialized.revision)) {
          readFailed();
          return;
        }
        if (!dirtyItemIds().length) break;
      }
      /*
       * Which button was pressed IS the intent — there is no stored
       * publication mode. A chosen schedule time makes this a schedule;
       * otherwise it is publish-now. And what the press files is exactly the
       * picker's selection minus every destination that explained on its own
       * row why it cannot take this post — never the recorded set silently.
       */
      const scheduledAt = uiOf(item.id).scheduledAt ?? null;
      const intent = scheduledAt
        ? { publishMode: "schedule", publishLocalTime: scheduledAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffsetMinutes: null, latePolicy: "hold" }
        : { publishMode: "publish_now", latePolicy: "hold" };
      const fileable = (uiOf(item.id).picked ?? recordedBindings(current))
        .filter((binding) => !destinationBlock(current, bufferOf(item.id), summary?.destinations ?? [], binding));
      if (!fileable.length) { announce(t(locale, "drawerPublishNeedsDestination"), ""); return; }
      try {
        const result = await rpc.submitForReview({
          batchItemId: current.id,
          expectedRevision: current.revision ?? 0,
          destinationBindings: fileable,
          intent
        });
        if (!live) return;
        if (result && result.ok === false) {
          const message = refusalMessage(result) || t(locale, "genericError");
          const line = note();
          if (line) line.textContent = message;
          announce(message, "");
          return;
        }
        const dest = fileable.map((binding) => destinationLabel(binding)).join(" · ");
        const when = scheduledAt ? String(scheduledAt).replace("T", " ") : "";
        announce(
          intent.publishMode === "schedule"
            ? t(locale, "drawerScheduleFiled", { when })
            : t(locale, "drawerPublishFiled", { dest }),
          ""
        );
        // Consumed: a post that comes back editable starts untimed again.
        patchUi(item.id, { scheduledAt: null, picking: false, destOpen: false });
        if (result?.warnings?.length) announce(result.warnings[0].message, "");
      } catch (error) {
        announce(error instanceof Error ? error.message : t(locale, "genericError"), "");
        return;
      }
      await refetchItems();
      if (live) redrawPreserving();
    };

    const requestClose = async () => {
      if (!(await requestExit())) return;
      // requestExit rechecked after its last await; nothing unsaved remains.
      if (!live || dirtyItemIds().length) return;
      closing = true;
      buffers.clear();
      session.dispose();
      batchDialog.close();
    };

    /*
     * A drawer menu is a popover on its control: Escape closes the menu
     * and puts focus back on that control — it never reaches the sheet. A
     * click anywhere else closes it too, and the click itself owns the focus.
     */
    const closeAddMenu = (focusTrigger) => {
      const item = activeItem();
      if (!item || uiOf(item.id).menuOpen !== true) return false;
      const anchor = uiOf(item.id).menuAnchor;
      patchUi(item.id, { menuOpen: false });
      redraw();
      if (focusTrigger) {
        const control = anchor
          ? bodyEl.querySelector(`.sl-addwrap[data-addanchor="${anchor}"] > button`)
          : bodyEl.querySelector(".sl-addwrap > button");
        control?.focus?.();
      }
      return true;
    };

    const partName = (part) => t(locale, part === "image" ? "drawerPartImage" : "drawerPartCaption");

    /*
     * A turn outcome code in readable words — never the raw code. The drawer
     * names why a turn ended; `credits_exhausted` inside a zh-HK sentence is
     * a defect, not information. Unknown codes fall back to a generic reason
     * rather than leaking the wire value.
     */
    const outcomeReasonText = (code) => {
      switch (code) {
        case "credits_exhausted":
          return t(locale, "drawerReasonOutOfCredits");
        case "reference_unavailable":
          return t(locale, "drawerReasonRefUnavailable");
        case "turn_cancelled":
          return t(locale, "drawerReasonTurnCancelled");
        case "turn_crashed":
          return t(locale, "drawerReasonTurnCrashed");
        case "succeeded":
          return t(locale, "drawerReasonTurnEnded");
        default:
          return t(locale, "drawerReasonUnknown");
      }
    };

    /*
     * A request the platform has finished with — stopped, declined or failed
     * to execute — is not pending, even though its needs are still
     * outstanding. Re-asking it replaces nothing, so no replace confirm is
     * owed and the server takes it without `replace`.
     */
    const canonicalFinal = (item) => {
      const stage = canonicalStatus.get(item.id)?.stage;
      return stage === "stopped" || stage === "declined" || stage === "execution_failed";
    };

    /** Explicit consent before a new request supersedes an outstanding one. */
    const confirmReplacePending = async (pendingList) => {
      const replacesImage = pendingList.includes("image");
      const choice = await confirmDrawerChoice(leaveDialog, {
        title: t(locale, "drawerReplacePendingTitle"),
        body: t(locale, "drawerReplacePendingBody", { part: partName(replacesImage ? "image" : "caption") }),
        choices: [
          { value: "cancel", label: t(locale, "drawerDecisionCancel") },
          { value: "replace", label: t(locale, replacesImage ? "drawerReplacePendingImage" : "drawerReplacePendingCaption"), primary: true }
        ]
      });
      return choice === "replace";
    };

    /**
     * "Regenerate image" / "Rewrite caption": a scoped request for ONE part
     * of THIS post. Before anything is requested:
     * - an outstanding request for another part is replaced only on an
     *   explicit confirm (`replace: true`), never silently;
     * - unsaved instructions for the requested part are saved first, or the
     *   owner explicitly generates with the saved ones (edits kept), or cancels;
     * - rewriting the caption over an unsaved caption edit asks.
     * Unrelated unsaved work is left alone.
     *
     * `runInstruction` is the regenerate conversation's named correction: it
     * is sent as the run layer and nothing else — the staged one-off is left
     * alone and its save-as-post checkbox does not apply to it. `null` (the
     * menu's Generate) means the staged brief's own one-off rules apply.
     * Returns true only when a request was actually filed.
     */
    const requestPart = async (item, part, runInstruction = null, scopePages = null) => {
      if (saving) return;
      const parts = [part];
      // Any outstanding part — the other one, the same one, or the request a
      // new post starts with — is replaced only on an explicit confirm. A
      // request the platform already finished with asks for no confirm: there
      // is nothing live left to replace.
      const outstanding = pendingParts(item);
      // A request the platform already finished with asks for no confirm:
      // for a dead one (declined or failed, which nothing stamps onto the
      // mark) the re-ask replaces, since there is nothing live left to
      // retire; a stopped one re-asks cleanly on its recorded outcome. After
      // a final outcome the other outstanding part stays owed — re-asking one
      // part must not silently drop it.
      const itemFinal = canonicalFinal(item);
      const deadFinal =
        itemFinal &&
        (canonicalStatus.get(item.id)?.stage === "declined" ||
          canonicalStatus.get(item.id)?.stage === "execution_failed");
      let supersede = Boolean(deadFinal);
      const needs = { [part]: true };
      if (itemFinal) {
        for (const other of outstanding) needs[other] = true;
      }
      if (outstanding.length && !itemFinal) {
        if (!(await confirmReplacePending(outstanding))) return;
        supersede = true;
      }
      const unsavedInstructions = dirtyInstructionParts(item, bufferOf(item.id), parts, instructionDefaultsOf(policy));
      if (unsavedInstructions.length) {
        const choice = await confirmDrawerChoice(leaveDialog, {
          title: t(locale, "drawerInstructionsDecisionTitle"),
          body: t(locale, "drawerInstructionsDecisionBody", { part: partName(part) }),
          choices: [
            { value: "cancel", label: t(locale, "drawerDecisionCancel") },
            { value: "saved", label: t(locale, "drawerInstructionsUseSaved") },
            { value: "save", label: t(locale, "drawerInstructionsSaveAndGenerate"), primary: true }
          ]
        });
        if (choice !== "save" && choice !== "saved") return;
        if (choice === "save") {
          // The submitted snapshot: generation runs on exactly what this
          // save acknowledged; instructions typed meanwhile stay dirty.
          const snapshot = snapshotBuffer(item.id);
          const patch = instructionPatchFor(item, snapshot.buffer, parts, instructionDefaultsOf(policy));
          let saved;
          saving = true;
          redrawFooter();
          try { saved = await rpc.saveInstructionOverrides(patch); } catch (error) {
            saved = { ok: false, message: error instanceof Error ? error.message : String(error) };
          } finally {
            saving = false;
          }
          if (!live) return;
          if (!saved?.ok) {
            // The edits stay; nothing is requested.
            redrawPreserving();
            announce(refusalMessage(saved ?? {}) || t(locale, "drawerInstructionsSaveFailed"), "");
            return;
          }
          const { batchItemId: _id, ...savedParts } = patch;
          for (const target of new Set([item, items.find((entry) => entry.id === item.id)].filter(Boolean))) {
            target.instructionOverrides = saved.instructionOverrides ?? { ...(target.instructionOverrides ?? {}), ...savedParts };
            if (saved.effectiveInstructions) target.effectiveInstructions = saved.effectiveInstructions;
          }
          acknowledgeFields(item.id, snapshot, unsavedInstructions.map((entry) => `instructions.${entry}`));
          redrawPreserving();
        }
      }
      // Rewriting the caption over an unsaved caption edit asks, and asks
      // again for a caption typed while the chosen save was in flight.
      while (part === "caption" && dirtyParts(item, bufferOf(item.id)).caption) {
        const decision = await confirmUnsavedNavigation(leaveDialog, locale);
        if (!live || decision === "keep") return;
        if (decision === "discard") { dropBufferFields(item.id, ["caption"]); continue; }
        const ok = await saveItems([item.id]);
        if (!live) return;
        redrawPreserving();
        if (!ok) return;
      }
      /*
       * The image brief a Generate press is made under — the resolved staged
       * settings, so the request and the block can never disagree. The one-off
       * instruction is the "this run" layer: sent on the request itself when
       * it stays one-off, or saved as this post's image instruction FIRST when
       * the owner asked for both (the request then resolves it as the post
       * layer — what was saved is what runs).
       */
      const options = { needs };
      let brief = null;
      if (part === "image") {
        // A page-scoped ask names exactly the pages it covers — a page's
        // own Generate, never the whole post's. `null` keeps the legacy
        // meaning: every page the post has.
        if (Array.isArray(scopePages) && scopePages.length) needs.imagePages = scopePages;
        brief = imageBriefOf(item);
        options.image = { references: brief.useSource ? "source" : "none", aspectRatio: brief.ratio };
        const oneOff = runInstruction !== null ? String(runInstruction).trim() : brief.oneOff.trim();
        const saveOneOff = runInstruction !== null ? false : brief.saveOneOff;
        if (oneOff && saveOneOff) {
          let savedIns;
          saving = true;
          redrawFooter();
          try { savedIns = await rpc.saveInstructionOverrides({ batchItemId: item.id, image: oneOff }); } catch (error) {
            savedIns = { ok: false, message: error instanceof Error ? error.message : String(error) };
          } finally {
            saving = false;
          }
          if (!live) return;
          if (!savedIns?.ok) {
            redrawPreserving();
            announce(refusalMessage(savedIns ?? {}) || t(locale, "drawerInstructionsSaveFailed"), "");
            return;
          }
          for (const target of new Set([item, items.find((entry) => entry.id === item.id)].filter(Boolean))) {
            target.instructionOverrides = savedIns.instructionOverrides ?? { ...(target.instructionOverrides ?? {}), image: oneOff };
            if (savedIns.effectiveInstructions) target.effectiveInstructions = savedIns.effectiveInstructions;
          }
        } else if (oneOff) {
          options.instructions = { image: oneOff };
        }
      }
      const send = (withReplace) =>
        rpc.requestGeneration(batch.id, [item.id], withReplace ? { ...options, replace: true } : { ...options });
      // Declared outside the try so the recognised `result` is still in scope
      // for the dispatch stamp below, whatever the request path did.
      let result = null;
      try {
        result = await send(supersede);
        if (result && result.ok === false && result.code === "generation_pending" && !supersede) {
          const owed = ["image", "caption"].filter((entry) => result.pending?.needs?.[entry]);
          if (!live || !(await confirmReplacePending(owed.length ? owed : [part]))) {
            if (await refetchItems()) redraw();
            return;
          }
          result = await send(true);
        }
        if (result && result.ok === false) {
          // The fail-closed refusal is translated, never the raw code: the
          // owner picked "the post's image" and the honest answer is that it
          // cannot be used — with the two ways forward.
          announce(result.code === "reference_unavailable" ? t(locale, "drawerRefUnavailable") : refusalMessage(result), "");
          return;
        }
      } catch (error) {
        announce(error instanceof Error ? error.message : String(error), "");
        return;
      }
      if (!live) return;
      // The one-off named THIS request — a second Generate must not silently
      // reuse it. The settings (reference, ratio) stay as staged. A run-layer
      // correction consumed nothing staged, so it clears nothing.
      if (brief && runInstruction === null) {
        patchBuffer(item.id, { imageBrief: { ...bufferOf(item.id).imageBrief, oneOff: "", oneOffOpen: false, saveOneOff: false } });
      }
      await refetchItems();
      redraw();
      announce(t(locale, "drawerRequestSent"), "");
      try { inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 })); } catch (error) { console.error(error); }
      return true;
    };

    /**
     * The options a retry re-asks under: the failed request's OWN brief —
     * ratio, reference mode and any one-off instruction — because "retry"
     * means the same ask, not whatever the settings happen to say now. A mark
     * without a brief (written before the brief existed) retries with none.
     */
    const retryOptions = (mark, needs, replace) => {
      const options = { needs, ...(replace ? { replace: true } : {}) };
      if (mark?.imageBrief) {
        options.image = {
          aspectRatio: mark.imageBrief.aspectRatio,
          references: mark.imageBrief.references !== undefined ? "source" : "none"
        };
      }
      const run = mark?.runInstructions;
      if (run && (run.image || run.caption)) {
        options.instructions = Object.fromEntries(["image", "caption"].filter((part) => run[part]).map((part) => [part, run[part]]));
      }
      return options;
    };

    /**
     * Retry a failed start: a fresh request replaces the stranded mark.
     *
     * Only the parts still outstanding are asked for again — a caption that
     * already landed is not re-generated. `replace: true` is explicit because
     * the failed request's mark is still present.
     */
    const retryStart = async (item) => {
      if (saving || !live) return;
      const mark = generationMark(item.generation);
      const needs = mark && (mark.needs.image || mark.needs.caption) ? mark.needs : { image: true, caption: true };
      saving = true;
      redrawFooter();
      let result;
      try {
        result = await rpc.requestGeneration(batch.id, [item.id], retryOptions(mark, needs, true));
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      } finally {
        saving = false;
      }
      if (!live) return;
      if (result && result.ok === false) {
        announce(result.code === "reference_unavailable" ? t(locale, "drawerRefUnavailable") : refusalMessage(result), "");
        return;
      }
      await refetchItems();
      redraw();
      announce(t(locale, "drawerRequestSent"), "");
    };

    /**
     * Retry after a final platform outcome: the same outstanding needs are
     * re-asked WITHOUT `replace`, because the finished request is not
     * pending and there is nothing to retire — except a declined or failed
     * request, which nothing stamps onto the mark, so the server would
     * refuse it as still pending: those re-ask WITH `replace`. If the server
     * still sees live work (no outcome reached it yet), its refusal is
     * announced honestly.
     */
    const retryFinal = async (item) => {
      if (saving || !live) return;
      const mark = generationMark(item.generation);
      const needs = mark && (mark.needs.image || mark.needs.caption) ? mark.needs : { image: true, caption: true };
      const finalStage = canonicalStatus.get(item.id)?.stage;
      const replaceDead = finalStage === "declined" || finalStage === "execution_failed";
      saving = true;
      redrawFooter();
      let result;
      try {
        result = await rpc.requestGeneration(batch.id, [item.id], retryOptions(mark, needs, replaceDead));
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      } finally {
        saving = false;
      }
      if (!live) return;
      if (result && result.ok === false) {
        announce(result.code === "reference_unavailable" ? t(locale, "drawerRefUnavailable") : refusalMessage(result), "");
        if (await refetchItems()) redraw();
        return;
      }
      await refetchItems();
      redraw();
      announce(t(locale, "drawerRequestSent"), "");
    };

    const headerMeta = el("div", { class: "sl-drawer-meta" });
    const tabsEl = el("div", { class: "sl-drawer-tabs" });
    const bodyEl = el("div", { class: "sl-preview-scroll", tabindex: "-1" });
    const footerEl = el("footer", { class: "sl-preview-actions sl-drawer-footer" });

    /*
     * THE TITLE IS THE POST'S NAME, edited where it is read (batch_items.title,
     * schema 19). It looks like a heading until touched; Enter commits (via
     * blur), Escape restores the pre-edit value, and a submitted post's field
     * is read-only. The derived name — the source text's first line — is only
     * the placeholder: `title` stays NULL until the owner actually types one.
     */
    const titleField = el("input", {
      id: "sl-drawer-title",
      class: "sl-titlefield",
      type: "text",
      "aria-label": t(locale, "drawerTitleAria")
    });
    let titleBefore = null;
    titleField.addEventListener("focus", () => { titleBefore = titleField.value; });
    titleField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); titleField.blur(); }
      if (event.key === "Escape") { event.preventDefault(); titleField.value = titleBefore ?? ""; titleField.blur(); }
    });
    titleField.addEventListener("blur", () => {
      const item = activeItem();
      const next = titleField.value.trim();
      const before = titleBefore;
      titleBefore = null;
      if (!item || before === null || next === before.trim()) return;
      if (next === (item.title ?? "")) return;
      renamePost(item, next);
    });

    /** The post's display name — its stored title, else the derived source head, else the untitled label. */
    const postNameOf = (entry) => {
      const titled = typeof entry?.title === "string" && entry.title.trim() ? entry.title.trim() : null;
      if (titled) return titled;
      const head = (String(entry?.sourceItem?.text ?? entry?.caption ?? "")
        .split("\n").map((line) => line.trim()).find(Boolean) ?? "").slice(0, 60);
      return head || t(locale, "drawerTitlePlaceholder");
    };

    const renamePost = async (item, title) => {
      let result;
      try {
        result = await rpc.renameBatchItem({ batchItemId: item.id, title });
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (!result?.ok) {
        announce(result?.message || t(locale, "saveFailed"), "");
        redraw();
        return;
      }
      announce(t(locale, "drawerTitleSaved"), "");
      if (!live) return;
      await refetchItems();
      redraw();
    };

    /*
     * The accepted image is drawn from the gadget's own bytes. Nothing here
     * converts or re-delivers it: accepted bytes are immutable, and a JPEG
     * copy for a JPEG-only destination is prepared deliberately at Review
     * (see image-acceptance.js) as a new asset and a new revision.
     */
    const loadImage = () => (generated, img, onFail) => {
      const forId = generated.id;
      loadGeneratedImageAsBlobUrl(rpc, forId)
        .then(({ url }) => {
          if (!live) { URL.revokeObjectURL(url); return; }
          generatedUrls.set(forId, url);
          img.src = url;
        })
        .catch(() => onFail());
    };

    /*
     * Ask the platform what happened to this post's request, and remember it.
     *
     * Read-only: the room answers with the canonical action state and does no
     * work of its own. It also records the RESOLUTION — `found`, `not_found`,
     * `unavailable`, or `unknown` when the host did not say — because "there is
     * no action" is a fact the owner can act on and "this host cannot tell you"
     * is not (F1). Never throws to the caller: a failed read is recorded as
     * unavailable, which is still true.
     */
    const checkCanonicalStatus = async (item) => {
      statusChecked.add(item.id);
      const record = (entry) =>
        canonicalStatus.set(item.id, {
          stage: platformStage(entry?.platform ?? null),
          state: entry?.platform?.state ?? null,
          actionId: entry?.platform?.actionId ?? null,
          // The turn's terminal outcome, when the platform recorded one —
          // what a stopped request names as its reason. The code when there
          // is one (a turn's own report); the status otherwise (including the
          // approval's own execution receipt, which still reads as
          // approved-but-not-started).
          outcome: (() => {
            const code = entry?.platform?.outcomeCode;
            if (typeof code === "string" && code) return code;
            const status = entry?.platform?.outcomeStatus;
            return typeof status === "string" && status ? status : null;
          })(),
          resolution:
            entry?.resolution === "found" || entry?.resolution === "not_found" || entry?.resolution === "unavailable"
              ? entry.resolution
              : "unknown",
          reason: typeof entry?.reason === "string" ? entry.reason : null,
          at: new Date().toISOString()
        });
      try {
        const status = await rpc.checkGenerationStatus({ batchId: batch.id, batchItemId: item.id });
        if (!live) return false;
        if (status && status.ok === false) {
          record({ resolution: "unavailable", reason: typeof status.reason === "string" ? status.reason : null });
          return false;
        }
        const entry = Array.isArray(status?.workRequestStatus)
          ? status.workRequestStatus.find((candidate) => candidate.batchItemId === item.id)
          : null;
        record(entry ?? null);
        return true;
      } catch (error) {
        console.error(error);
        if (live) record({ resolution: "unavailable", reason: null });
        return false;
      }
    };

    /*
     * Deliver a request that was saved but never submitted.
     *
     * The gadget re-derives the handoff from the EXISTING mark — same request
     * id, same scope, same instructions — and the host files it through the
     * governed route, so pressing twice (or a lost response) converges on one
     * approval. Nothing is recorded here: what the platform did comes back on
     * the next read, exactly as a fresh request's does.
     */
    const resumeRequest = async (item) => {
      if (resuming || !live) return;
      const generationRequest = generationMark(item.generation)?.id ?? null;
      if (!generationRequest) return;
      resuming = true;
      redrawPreserving();
      try {
        const result = await rpc.resumeGeneration({ batchId: batch.id, batchItemId: item.id, generationRequest });
        if (!live) return;
        if (result && result.ok === false) {
          announce(refusalMessage(result), "");
          return;
        }
        // The cached resolution is now stale: the platform has an action to
        // report, and asking again is how we learn it.
        canonicalStatus.delete(item.id);
        statusChecked.delete(item.id);
        await refetchItems();
        announce(t(locale, "drawerResumeSent"), "");
      } catch (error) {
        announce(error instanceof Error ? error.message : t(locale, "genericError"), "");
      } finally {
        resuming = false;
        if (live) redrawPreserving();
      }
    };

    const redrawFooter = () => {
      const item = activeItem();
      if (!item) { replace(footerEl, []); return; }
      if (isEditableItem(item)) {
        const ui = uiOf(item.id);
        const destinations = summary?.destinations ?? [];
        const buffers = bufferOf(item.id);
        const picked = ui.picked ?? recordedBindings(item);
        const scheduledAt = ui.scheduledAt ?? null;
        const state = footerState(locale, item, { buffers, saving, defaults: instructionDefaultsOf(policy), destinations, picked, scheduledAt });
        const reason = state.primary.reason || state.save.reason || publicationHint(locale, { scheduledAt });
        /*
         * The truthful pending state. The mark's dispatch says whether the
         * request was FILED; the platform's canonical state, read back by
         * request identity, says whether the approval was since answered,
         * declined or run. Canonical wins when we have it, so a declined or
         * superseded request stops reading as awaiting approval.
         */
        const mark = generationMark(item.generation);
        const display = generationDisplayStage(item.generation);
        const resolved = canonicalStatus.get(item.id) ?? null;
        const canonical = resolved?.stage ?? null;
        const resolution = resolved?.resolution ?? null;
        const markOutcomeCode =
          typeof mark?.dispatch?.outcome?.code === "string" && mark.dispatch.outcome.code
            ? mark.dispatch.outcome.code
            : null;
        const where = mark?.dispatch?.conversationTitle
          ? ` ${t(locale, "drawerGenerationDestination", { conversation: mark.dispatch.conversationTitle })}`
          : "";
        let stageNote = null;
        if (canonical === "declined") {
          stageNote = t(locale, "drawerApprovalDeclined");
        } else if (canonical === "executing") {
          stageNote = t(locale, "drawerApprovalExecuting");
        } else if (canonical === "execution_failed") {
          stageNote = t(locale, "drawerStartFailed", {
            reason: resolved.outcome ? outcomeReasonText(resolved.outcome) : mark?.dispatch?.reason || t(locale, "genericError")
          });
        } else if (canonical === "stopped") {
          // The approved turn ended with work still outstanding. The outcome
          // code says why, in readable words — never the raw code; the parts
          // below say what remains. Never finished.
          stageNote = t(locale, "drawerGenerationStopped", {
            reason: outcomeReasonText(resolved.outcome ?? markOutcomeCode)
          });
        } else if (display === "stopped") {
          // The mark already carries the turn's end (stamped when it ended)
          // while the platform read still lags without it — the fresher fact
          // wins over an approved-not-started or awaiting canonical.
          stageNote = t(locale, "drawerGenerationStopped", { reason: outcomeReasonText(markOutcomeCode) });
        } else if (display === "declined") {
          stageNote = t(locale, "drawerApprovalDeclined");
        } else if (display === "execution_failed") {
          stageNote = t(locale, "drawerStartFailed", { reason: outcomeReasonText(markOutcomeCode) });
        } else if (canonical === "accepted") {
          stageNote = t(locale, "drawerApprovalAccepted");
        } else if (canonical === "approved_not_started") {
          // The approval executed, but no completion was ever reported. Not
          // finished, not running — just unreported.
          stageNote = t(locale, "drawerApprovalNotStarted");
        } else if (canonical === "awaiting_approval") {
          stageNote = `${t(locale, "drawerAwaitingApproval")}${where}`;
        } else if (display === "approved_not_started") {
          // No status read yet, but the receipt says the approval already ran
          // at filing — never a wait for approval.
          stageNote = t(locale, "drawerApprovalNotStarted");
        } else if (display === "insufficient_credits" || display === "credit_check_unavailable") {
          // The filing itself was refused on credits. Nothing is pending, so
          // topping up and retrying is a fresh ask, not a replacement.
          stageNote = t(locale, display === "insufficient_credits" ? "drawerInsufficientCredits" : "drawerCreditCheckUnavailable");
        } else if (display === "start_failed") {
          stageNote = t(locale, "drawerStartFailed", {
            reason: mark?.dispatch?.reason || t(locale, "genericError")
          });
        } else if (resolution === "not_found") {
          // The platform looked and there is no action. That is a request that
          // was saved but never submitted, and it is the only state that offers
          // a resume.
          stageNote = t(locale, "drawerRequestNotSubmitted");
        } else if (resolution === "unavailable") {
          // We could not find out. Unknown is not permission to create work, so
          // the only offer is to look again.
          stageNote = `${t(locale, "drawerStatusUnavailable")} ${t(locale, "drawerStatusCheckedAt", {
            time: new Date(resolved.at).toLocaleTimeString()
          })}`;
        } else if (display === "awaiting_approval") {
          stageNote = `${t(locale, "drawerAwaitingApproval")}${where}`;
        } else if (display === "start_unconfirmed") {
          // No platform answer at all: an older host, or a check that has not
          // run yet. Say what is known and nothing more.
          stageNote = t(locale, "drawerStartUnconfirmed");
        }
        const canResume =
          resolution === "not_found" && Boolean(mark?.needs.image || mark?.needs.caption) && isEditableItem(item);
        /*
         * One automatic status read for a request that looks pending. The
         * filing record cannot say an approval was answered, so this is how a
         * stale "awaiting approval" corrects itself after a reload without the
         * owner having to press anything. Once per post per drawer session.
         */
        if (
          live &&
          !closing &&
          !canonicalStatus.has(item.id) &&
          !statusChecked.has(item.id) &&
          (display === "awaiting_approval" || display === "start_unconfirmed" || display === "approved_not_started")
        ) {
          statusChecked.add(item.id);
          void checkCanonicalStatus(item).then((ok) => { if (ok && live) redrawPreserving(); });
        }
        /*
         * A pushed turn outcome the canvas has not read back yet. The mark
         * carries it — the room stamped it when the turn ended — while
         * canonical still holds whatever the last read saw. Re-check once per
         * outcome-bearing request so an open drawer converges on stopped
         * without a manual press; the set bounds it to one read, never a poll.
         */
        const markOutcome = mark?.dispatch?.outcome?.status ?? null;
        const outcomeKey = mark?.id && markOutcome ? `${item.id}:${mark.id}` : null;
        if (live && !closing && outcomeKey && !outcomeRechecked.has(outcomeKey)) {
          outcomeRechecked.add(outcomeKey);
          void checkCanonicalStatus(item).then((ok) => { if (ok && live) redrawPreserving(); });
        }
        const showStatusCheck =
          display === "start_unconfirmed" ||
          display === "start_failed" ||
          display === "insufficient_credits" ||
          display === "credit_check_unavailable" ||
          display === "stopped" ||
          display === "declined" ||
          display === "execution_failed" ||
          canonical === "declined" ||
          canonical === "execution_failed" ||
          canonical === "stopped" ||
          resolution === "not_found" ||
          resolution === "unavailable";
        replace(footerEl, [
          stageNote ? el("p", { class: "sl-drawer-stage-note", role: "status" }, stageNote) : null,
          /*
           * THE 增值 ASK. A run paused on credits gets its funding action in
           * place — no dead-end sentence. The host owns the top-up surface;
           * this row asks and hears the answer. `topped_up` re-files the SAME
           * request (retryStart), so the paused run resumes on its own and the
           * owner is never asked to ask again. A host with no top-up surface
           * leaves the row disabled with the reason.
           */
          display === "insufficient_credits"
            ? el("div", { class: "sl-topup", role: "group" }, [
                el("p", { class: "sl-topup-note" }, t(locale,
                  ui.topupDone ? "drawerTopupDone" : ui.topupCancelled ? "drawerTopupCancelled" : "drawerTopupResumeNote")),
                ui.topupDone
                  ? null
                  : el("button", {
                      type: "button", class: "sl-primary sl-sm sl-topup-btn",
                      disabled: ui.topupPending === true || !hostFeatures.has("topup"),
                      title: hostFeatures.has("topup") ? null : t(locale, "drawerTopupUnsupported"),
                      onclick: async () => {
                        if (uiOf(item.id).topupPending === true || !hostFeatures.has("topup")) return;
                        patchUi(item.id, { topupPending: true, topupCancelled: false });
                        redrawFooter();
                        const reply = await requestTopup(item);
                        if (!live) return;
                        if (reply.outcome === "topped_up") {
                          patchUi(item.id, { topupPending: false, topupDone: true });
                          redrawPreserving();
                          void retryStart(item);
                        } else {
                          patchUi(item.id, { topupPending: false, topupCancelled: reply.outcome === "cancelled" });
                          redrawPreserving();
                        }
                      }
                    }, t(locale, ui.topupPending === true ? "drawerTopupWorking" : "drawerTopupAction"))
              ])
            : null,
          // The publish row sits in the sheet foot per the accepted mockup —
          // the destination picker visible on every tab, above the actions.
          // What is picked here IS what submitForReview files.
          ...renderPublishControls(locale, item, {
            editable: true,
            saving,
            buffers,
            destinations,
            destinationLabel,
            picked,
            menuOpen: ui.destOpen === true,
            picking: ui.picking === true,
            scheduledAt,
            onToggleMenu: () => { patchUi(item.id, { destOpen: ui.destOpen !== true }); redrawFooter(); },
            onToggleDestination: (binding) => {
              const now = uiOf(item.id).picked ?? recordedBindings(item);
              patchUi(item.id, { picked: now.includes(binding) ? now.filter((entry) => entry !== binding) : [...now, binding] });
              redrawFooter();
            },
            onScheduleChange: (value) => { patchUi(item.id, { scheduledAt: value || null, picking: false }); redrawFooter(); },
            onScheduleCancel: () => { patchUi(item.id, { picking: false }); redrawFooter(); }
          }),
          el("p", { class: "sl-drawer-footer-hint", id: DRAWER_FOOTER_HINT_ID, role: "status" }, reason || ""),
          el("div", { class: "sl-drawer-footer-actions" }, [
            el("button", {
              type: "button", class: "sl-secondary",
              disabled: state.save.disabled,
              title: state.save.reason || null,
              "aria-describedby": state.save.disabled ? DRAWER_FOOTER_HINT_ID : null,
              // Preserving: the owner may be typing in a field the save did
              // not clear; its focus and caret survive the re-render.
              onclick: () => saveItems([item.id]).then(() => redrawPreserving())
            }, t(locale, "drawerSaveDraft")),
            // Continue generation: the one owner action for a request the
            // platform has confirmed was never submitted. It re-delivers the
            // EXISTING request, so it is offered only when that is what the
            // platform said, and only while a part is still outstanding.
            canResume
              ? el("button", {
                  type: "button", class: "sl-primary",
                  disabled: resuming || statusChecking,
                  onclick: () => resumeRequest(item)
                }, t(locale, "drawerResumeGeneration"))
              : null,
            // Check status: a read-only re-read of the platform's canonical
            // state for this request. It launches nothing, notifies nobody and
            // charges nothing, and it reuses the request identity on the mark.
            // Healthy in-flight work (approved / executing) is the overlay and
            // one footer line — not a second homework button.
            showStatusCheck
              ? el("button", {
                  type: "button", class: "sl-secondary",
                  disabled: statusChecking,
                  onclick: async () => {
                    if (statusChecking || !live) return;
                    statusChecking = true;
                    redrawFooter();
                    try {
                      const ok = await checkCanonicalStatus(item);
                      if (!live) return;
                      announce(t(locale, ok ? "drawerGenerationStatusChecked" : "drawerGenerationStatusFailed"), "");
                      await refetchItems();
                    } finally {
                      statusChecking = false;
                      // Every affected control, not just the footer: the body
                      // was rendered with the busy snapshot and only a full
                      // redraw clears it. Preserving keeps edits, focus,
                      // selection, section and scroll (F2).
                      if (live) redrawPreserving();
                    }
                  }
                }, t(locale, "drawerCheckGenerationStatus"))
              : null,
            // Retry is offered only when nothing is running. A failed start —
            // or a filing refused on credits — replaces the stranded mark
            // and keeps whatever part already succeeded (the mark's remaining
            // `needs`). A final platform outcome re-asks the outstanding
            // needs without replacing: nothing is pending, so there is
            // nothing to retire.
            display === "start_failed" || display === "insufficient_credits" || display === "credit_check_unavailable"
              ? el("button", {
                  type: "button", class: "sl-secondary",
                  disabled: saving,
                  onclick: () => retryStart(item)
                }, t(locale, "drawerRetryStart"))
              : canonicalFinal(item)
                ? el("button", {
                    type: "button", class: "sl-secondary",
                    disabled: saving,
                    onclick: () => retryFinal(item)
                  }, t(locale, "drawerRetryStart"))
                : null,
            el("span", { class: "sl-grow" }),
            // 排程… arms the field; a chosen time turns the primary into
            // "Schedule for …" — the press itself carries the intent.
            scheduledAt
              ? el("button", {
                  type: "button", class: "sl-brief-link",
                  disabled: saving,
                  onclick: () => { patchUi(item.id, { scheduledAt: null, picking: false }); redrawFooter(); }
                }, t(locale, "drawerCancelSchedule"))
              : el("button", {
                  type: "button", class: "sl-secondary",
                  disabled: saving || state.primary.disabled || ui.picking === true,
                  title: state.primary.reason || null,
                  onclick: () => { patchUi(item.id, { picking: true }); redrawFooter(); }
                }, t(locale, "drawerSchedulePick")),
            el("button", {
              type: "button", class: "sl-primary",
              disabled: state.primary.disabled,
              title: state.primary.reason || null,
              "aria-describedby": state.primary.disabled ? DRAWER_FOOTER_HINT_ID : null,
              onclick: () => submitFromDrawer(item)
            }, state.primary.label)
          ])
        ]);
        return;
      }
      // Filed/published/attention posts: no second submission from this
      // drawer — History carries the outcome, and Check status re-reads the
      // canonical state through the supported path.
      replace(footerEl, [
        el("div", { class: "sl-drawer-footer-actions" }, [
          el("button", {
            type: "button", class: "sl-secondary",
            onclick: async () => {
              try {
                await rpc.readPublishState(item.id);
                if (await refetchItems()) redraw();
              } catch (error) {
                announce(error instanceof Error ? error.message : t(locale, "genericError"), "");
              }
            }
          }, t(locale, "drawerCheckStatus"))
        ])
      ]);
    };

    const selectTab = (key, { focus } = {}) => {
      activeTab = key;
      redraw();
      if (focus) document.getElementById?.(drawerTabId(key))?.focus?.();
    };

    const redraw = () => {
      if (!live) return;
      for (const url of generatedUrls.values()) URL.revokeObjectURL(url);
      generatedUrls.clear();
      itemNotes.clear();
      const item = activeItem();
      if (!item) {
        replace(headerMeta, []);
        replace(tabsEl, []);
        replace(bodyEl, [el("p", { class: "sl-field-note" }, t(locale, "batchUnavailable"))]);
        replace(footerEl, []);
        return;
      }
      const phase = phaseOf(item);
      const editable = isEditableItem(item);
      // The header reads the same stage as the card chip and the footer: the
      // canonical platform stage when a status read reported one, else the
      // mark's own receipt, recorded outcome and outstanding needs. A queued
      // phase alone never implies an agent queue — an approved receipt reads
      // approved, a recorded end reads ended. A request the platform confirmed
      // was never submitted is not "queued" either.
      const resolvedHeader = canonicalStatus.get(item.id) ?? null;
      const headerStateKey = (() => {
        if (resolvedHeader?.resolution === "not_found") return "cardStageNotStarted";
        if (phase !== "queued" && phase !== "regenerating") return PHASE_STATE_KEYS[phase] ?? "stateUnknown";
        if (resolvedHeader?.stage) {
          return (
            {
              declined: "cardStageDeclined",
              accepted: "cardStageApproved",
              executing: "cardStageRunning",
              stopped: "cardStageStopped",
              approved_not_started: "cardStageApproved",
              awaiting_approval: "cardStageAwaitingApproval",
              execution_failed: "cardStageFailed"
            }[resolvedHeader.stage] ?? (PHASE_STATE_KEYS[phase] ?? "stateUnknown")
          );
        }
        return (
          {
            start_unconfirmed: "cardStageNotStarted",
            start_failed: "cardStageStartFailed",
            insufficient_credits: "cardStageInsufficientCredits",
            credit_check_unavailable: "cardStageCreditUnavailable",
            awaiting_approval: "cardStageAwaitingApproval",
            approved_not_started: "cardStageApproved",
            stopped: "cardStageStopped",
            declined: "cardStageDeclined",
            execution_failed: "cardStageFailed"
          }[generationDisplayStage(item.generation)] ?? (PHASE_STATE_KEYS[phase] ?? "stateUnknown")
        );
      })();

      // The eyebrow keeps state/revision; the post itself is named once, in
      // the title field — the drawer is one post, so nothing else navigates.
      replace(headerMeta, [
        el("span", { class: "sl-drawer-state" }, [
          t(locale, headerStateKey),
          " · ",
          (item.revision ?? 0) > 0 ? t(locale, "drawerRevision", { n: item.revision }) : t(locale, "inboxNoSavedRevision"),
          item.approval && (item.revision ?? 0) > (item.approval.approvedRevision ?? 0) ? " · " + t(locale, "approvalExpiredTitle") : ""
        ].join(""))
      ]);

      // A redraw must never stomp a title the owner is typing — only repaint
      // the field while it is not focused (blur commits first, so post-blur
      // repaints see the new value).
      if (document.activeElement !== titleField) {
        titleField.value = item.title ?? "";
        titleField.placeholder = postNameOf({ ...item, title: "" });
        titleField.readOnly = !isEditableItem(item) || postFiled(item);
      }

      replace(tabsEl, [
        renderDrawerTablist(locale, { active: activeTab, onSelect: selectTab })
      ]);

      const buffer = bufferOf(item.id);
      let panel;
      if (activeTab === "reference") {
        // The picture owns its adopt affordance here too — the same action
        // the Post tab's add menu carries, one click for the same write.
        panel = renderReferencePanel(locale, item, {
          rail: item.sourceItem ? railFor(item) : null,
          editable,
          saving,
          imageRefsAvailable: sourceImageReferences(item.sourceItem).length > 0,
          onAdoptSource: () => {
            // Adopt the post's own pictures: every page bound to a source
            // child takes THAT child — page k keeps child k, never the
            // blended set. Pages with no binding stay as they are.
            const list = workingPages(item, bufferOf(item.id)).map((page) =>
              page.sourceMediaId ? { ...page, kind: "original", mediaId: page.sourceMediaId } : page
            );
            void applyVisual(item, { pages: list });
          }
        });
      } else if (activeTab === "instructions") {
        // The brief lives here per the accepted mockup: the settings a
        // Generate ask is made under, beside the instructions it amends.
        panel = renderInstructionsPanel(locale, item, {
          editable,
          saving,
          buffers: buffer,
          policy,
          imageBrief: imageBriefOf(item),
          imageRefsAvailable: sourceImageReferences(item.sourceItem).length > 0,
          onPatchImageBrief: (patch) => {
            patchBuffer(item.id, { imageBrief: { ...bufferOf(item.id).imageBrief, ...patch } });
          },
          onBriefChanged: () => redraw(),
          onInput: (part, value) => {
            patchBuffer(item.id, { instructions: { ...bufferOf(item.id).instructions, [part]: value } });
            redrawFooter();
          },
          onReset: (part) => {
            patchBuffer(item.id, { instructions: { ...bufferOf(item.id).instructions, [part]: "" } });
            redraw();
          }
        });
      } else if (activeTab === "history") {
        panel = renderHistoryPanel(locale, item, {
          editable,
          onUseImage: (mediaId) => {
            // A history pick stages into the page it was generated for —
            // a page-2 image never displaces page 1. An unpaged row lands
            // on the first page, the single-image meaning it always had.
            const row = (item.generatedHistory ?? []).find((media) => media.id === mediaId) ?? null;
            const targetId = row?.pageId ?? workingPages(item, bufferOf(item.id))[0]?.pageId ?? null;
            if (targetId) {
              const saved = pagesOfItem(item).find((page) => page.pageId === targetId) ?? null;
              const list = workingPages(item, bufferOf(item.id)).map((page) =>
                page.pageId === targetId ? { ...page, kind: "generated", mediaId, sourceMediaId: page.sourceMediaId ?? saved?.sourceMediaId ?? null } : page
              );
              patchBuffer(item.id, { pages: list });
            }
            activeTab = "output";
            redraw();
            announce(t(locale, "drawerHistoryImageStaged"), "");
          },
          destinationLabel,
          stateLabel: (outcome) => publicationStateSummary(locale, outcome)
        });
      } else {
        panel = renderOutputPanel(locale, item, {
          editable,
          saving,
          // Confirmed missing filing: per-part copy agrees with the footer
          // instead of implying an agent queue.
          unsubmitted: canonicalStatus.get(item.id)?.resolution === "not_found",
          buffers: buffer,
          highlighted: highlightedCaption(buffer.caption ?? item.caption ?? ""),
          loadImage: loadImage(item),
          noteRef: (note) => itemNotes.set(item.id, note),
          onCaptionInput: (value) => {
            patchBuffer(item.id, { caption: value });
            redrawFooter();
          },
          onAltTextInput: (pageId, value) => {
            // Alt text is per page — the edit lands in the working list and
            // saves with Save like every other buffered field.
            const list = workingPages(item, bufferOf(item.id)).map((page) =>
              page.pageId === pageId ? { ...page, altText: value.trim() ? value : null } : page
            );
            patchBuffer(item.id, { pages: list });
            redrawFooter();
          },
          destinationLabel,
          captionConflict: captionConflicts.get(item.id) ?? null,
          onReacceptImage: async () => {
            // The same explicit re-accept the singular pin performed, per
            // page: every generated page whose provenance is "unknown" is
            // marked owner-explicit in one save.
            if (saving) return;
            const list = workingPages(item, bufferOf(item.id)).map((page) => {
              const projected = (item.pages ?? []).find((entry) => entry.pageId === page.pageId);
              return projected?.mediaProvenance === "unknown" ? { ...page, mediaAcceptance: "owner_explicit" } : page;
            });
            saving = true;
            redrawFooter();
            let result;
            try {
              result = await rpc.saveRevisions({ revisions: [{ batchItemId: item.id, expectedRevision: item.revision ?? 0, pages: list }] });
            } catch (error) {
              result = { ok: false, message: error instanceof Error ? error.message : String(error) };
            } finally {
              saving = false;
            }
            const one = result?.results?.[0] ?? result;
            if (!one?.ok) announce((one?.issues || []).map((issue) => issue.message).join(" ") || refusalMessage(one ?? {}) || t(locale, "saveFailed"), "");
            if (!live) return;
            await refetchItems();
            redraw();
          },
          onResolveCaptionConflict: (choice) => {
            // "use": the new saved caption wins and the local buffer is
            // discarded. "keep": the buffer stays, dirty against it.
            if (choice === "use") dropBufferFields(item.id, ["caption"]);
            captionConflicts.delete(item.id);
            redraw();
          },
          onStageImage: (pageId, mediaId) => {
            // A candidate pick stages into ITS page — never a neighbour's —
            // and unstaging restores the page's saved fill.
            const saved = pagesOfItem(item).find((page) => page.pageId === pageId) ?? null;
            const list = workingPages(item, bufferOf(item.id)).map((page) =>
              page.pageId === pageId ? { ...page, kind: mediaId ? "generated" : (saved?.kind ?? null), mediaId: mediaId ?? (saved?.mediaId ?? null) } : page
            );
            patchBuffer(item.id, { pages: list });
            redraw();
          },
          imageBrief: imageBriefOf(item),
          // The menu's honesty line: whether this post's own image can
          // actually be sent as a reference — decided by the same rule the
          // server applies, so a missing one warns before the refusal.
          imageRefsAvailable: sourceImageReferences(item.sourceItem).length > 0,
          onRequestPart: (part) => requestPart(item, part),
          uploadPreview: ownerUploads.has(item.id) ? { name: ownerUploads.get(item.id).name } : null,
          onAdoptUpload: () => adoptOwnerUpload(item),
          /*
           * The strip's callbacks. Add/menu/regenerate/destinations are
           * drawerUi — sheet state, never content. Remove is a real revision
           * change (it clears the accepted visual), so it goes through
           * applyVisual like any other visual decision; a staged pick is
           * dropped first so the next Save cannot resurrect it.
           */
          strip: {
            menuOpen: uiOf(item.id).menuOpen === true,
            menuAnchor: uiOf(item.id).menuAnchor ?? null,
            agentIntent: hostFeatures.has("agent-intent"),
            dismissedCandidates: uiOf(item.id).dismissedCandidates ?? null,
            onToggleMenu: (anchor) => {
              const ui = uiOf(item.id);
              // Re-clicking the control that owns the open menu closes it;
              // clicking another moves the one menu there is to it.
              const closing = ui.menuOpen === true && ui.menuAnchor === anchor;
              patchUi(item.id, closing ? { menuOpen: false } : { menuOpen: true, menuAnchor: anchor });
              redraw();
              if (closing) {
                bodyEl.querySelector(`.sl-addwrap[data-addanchor="${anchor}"] > button`)?.focus?.();
              } else {
                // A popover below the fold is invisible: bring its control
                // into the scroll viewport first.
                bodyEl.querySelector(".sl-menu")?.scrollIntoView?.({ block: "nearest" });
              }
            },
            // Adding a page is an explicit structural commit — the new
            // empty slot persists, holds its place at the end, and blocks
            // filing until filled or removed.
            onAddPage: () => {
              const list = [...workingPages(item, bufferOf(item.id)), { pageId: newPageId(item), kind: null, mediaId: null, sourceMediaId: null, altText: null }];
              void applyPages(item, list);
            },
            // A chosen row closes the popover immediately — the action's own
            // redraw comes later (or not at all, when the ask is refused).
            onMenuGenerate: (slot) => { patchUi(item.id, { menuOpen: false }); redraw(); void requestPart(item, "image", null, [slot.page.pageId]); },
            onMenuUpload: (slot) => { patchUi(item.id, { menuOpen: false }); redraw(); pickOwnerUpload(item, slot.page.pageId); },
            onMenuAdoptSource: (slot, sourceMediaId) => {
              patchUi(item.id, { menuOpen: false });
              const list = workingPages(item, bufferOf(item.id)).map((page) =>
                page.pageId === slot.page.pageId ? { ...page, kind: "original", mediaId: sourceMediaId, sourceMediaId } : page
              );
              void applyPages(item, list);
            },
            // Regenerate is a conversation hand-off: the intent carries this
            // page's context to the host, which opens the chat. The menu
            // closes and the layout does not move — the drawer keeps its state
            // for when the owner returns.
            onRegenIntent: (slot) => {
              patchUi(item.id, { menuOpen: false });
              redraw();
              postAgentIntent(item, slot);
            },
            onRemoveSlot: (slot) => {
              patchUi(item.id, { menuOpen: false });
              const list = workingPages(item, bufferOf(item.id)).filter((page) => page.pageId !== slot.page.pageId);
              void applyPages(item, list);
            },
            onViewSlot: () => { patchUi(item.id, { menuOpen: false }); redraw(); void openPreview(item); },
            onDismissCandidate: (candidateId) => {
              const ui = uiOf(item.id);
              const dismissed = new Set(ui.dismissedCandidates ?? []);
              if (candidateId) dismissed.add(candidateId);
              patchUi(item.id, { dismissedCandidates: dismissed });
              redraw();
            }
          }
        });
      }

      replace(bodyEl, [
        el("div", { id: drawerPanelId(activeTab), role: "tabpanel", "aria-labelledby": drawerTabId(activeTab), class: "sl-drawer-panel" }, [panel])
      ]);
      redrawFooter();
    };

    /** Redraw after a live read, keeping focus, caret and scroll where the owner left them. */
    const redrawPreserving = () => {
      const focused = document.activeElement;
      const focusId = typeof focused?.id === "string" && focused.id ? focused.id : null;
      const caret = focusId && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
      const scrollTop = bodyEl.scrollTop;
      redraw();
      if (typeof scrollTop === "number") bodyEl.scrollTop = scrollTop;
      if (!focusId) return;
      const next = document.getElementById?.(focusId);
      if (!next || next === focused) return;
      next.focus?.();
      if (caret) { try { next.setSelectionRange?.(caret[0], caret[1]); } catch { /* not a text control */ } }
    };

    /*
     * LIVE UPDATES. Host events (`revision`, `generated_image`,
     * `drafts_changed`, and reconciliation after re-subscribing) re-read this
     * batch through `getBatch`. Events that arrive while a read is in flight
     * collapse into one follow-up read; each read carries a token so only the
     * newest can land, and nothing lands after the drawer ended.
     */
    let refreshing = null;
    let rerun = false;
    let passIsReconnect = false; // the read in flight was started by a `reconnected`
    const refresh = (event) => {
      if (!live) return Promise.resolve();
      if (event?.batchItemId && !items.some((entry) => entry.id === event.batchItemId)) return Promise.resolve();
      if (event?.batchId && event.batchId !== batch.id) return Promise.resolve();
      const reconnect = event?.type === "reconnected";
      if (refreshing) {
        // A duplicate reconnect joins the reconciliation read already in
        // flight (issued after the stream came back); anything else owes a
        // follow-up read.
        if (!(reconnect && passIsReconnect && !rerun)) rerun = true;
        return refreshing;
      }
      refreshing = (async () => {
        try {
          passIsReconnect = reconnect;
          do {
            rerun = false;
            if ((await refetchItems()) && live) redrawPreserving();
            passIsReconnect = false;
          } while (rerun && live);
        } finally {
          refreshing = null;
          passIsReconnect = false;
        }
      })();
      return refreshing;
    };

    const dispose = () => {
      if (!live) return;
      live = false;
      readToken += 1;
      hostFeatureListeners.delete(redrawPreserving);
      for (const held of rails.values()) held.rail.dispose();
      rails.clear();
      for (const url of generatedUrls.values()) URL.revokeObjectURL(url);
      generatedUrls.clear();
      if (drawerSession === session) drawerSession = null;
    };

    // A host-features announcement that lands mid-drawer flips the ⋯ row
    // between offered and disabled-with-reason; the open sheet re-reads it.
    hostFeatureListeners.add(redrawPreserving);
    redraw();

    replace(batchDialog, [el("div", { class: "sl-preview-sheet sl-sheet-drawer" }, [
      el("header", { class: "sl-preview-head" }, [
        el("div", { class: "sl-preview-who" }, [
          headerMeta,
          titleField
        ]),
        el("div", { class: "sl-preview-head-actions" }, [
          el("button", {
            type: "button", class: "sl-icon-action",
            title: t(locale, "drawerClose"), "aria-label": t(locale, "drawerClose"),
            onclick: () => requestClose()
          }, icon("close"))
        ])
      ]),
      tabsEl,
      bodyEl,
      footerEl
    ])]);
    batchDialog.setAttribute("aria-labelledby", "sl-drawer-title");
    // The shared dialog's close/cancel listeners delegate here — one
    // registration, one session, see buildPreviewDialog above.
    session = { requestClose, refresh, dispose, previous, batchId: batch.id, closeAddMenu };
    // Opening another post ends the previous drawer session: its reads and
    // stages must not outlive it.
    if (drawerSession && drawerSession !== session) drawerSession.dispose?.();
    drawerSession = session;
    if (!batchDialog.open) batchDialog.showModal();
    // Focus moves into the drawer, onto the active section's tab.
    document.getElementById?.(drawerTabId(activeTab))?.focus?.();
  }

  function closePreview() {
    if (activePreviewRail) {
      activePreviewRail.dispose();
      activePreviewRail = null;
    }
    activePreviewItem = null;
    if (previewDialog.open) previewDialog.close();
    if (lastFocusedBeforePreview instanceof HTMLElement) lastFocusedBeforePreview.focus();
  }

  previewDialog.addEventListener("close", closePreview);
  previewDialog.addEventListener("click", (event) => {
    const rect = previewDialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (outside) closePreview();
  });

  // --- Collection handlers --------------------------------------------------
  async function handleSelect(id, selected) {
    collectionState = applySelection(collectionState, id, selected);
    renderCurrentView();
    try {
      await rpc.setSelection(id, selected);
    } catch (error) {
      console.error(error);
      collectionState = applySelection(collectionState, id, !selected);
      renderCurrentView();
    }
  }

  const collectionHandlers = {
    // Re-enters the setup form for a configured gadget. `runSetup` reads the
    // stored config itself rather than taking a draft from here, so there is
    // one place that knows how a config becomes a form.
    onOpenSettings: () => void runSetup({ editing: true }),
    onSelect: handleSelect,
    onOpen: (item) => openPreview(item),
    onFilter: (filter) => {
      collectionState = setFilter(collectionState, filter);
      loadCollection(filter);
    },
    onSearch: (value) => {
      collectionState = setSearch(collectionState, value);
      renderCurrentView();
    },
    onSourceFilter: (binding) => {
      collectionState = setSourceFilter(collectionState, binding);
      loadCollection(collectionState.filter);
    },
    onRefresh: async () => {
      try {
        const result = await rpc.refresh();
        // The summary carries each source's last outcome, which the source
        // chip shows. Reloading only the posts left a failed refresh looking
        // exactly like an account with no posts once the toast faded.
        await refreshSummary();
        await loadCollection(collectionState.filter);
        const outcome = classifyRefreshOutcome(result);
        announce(t(locale, outcome.titleKey), outcome.detail);
      } catch (error) {
        console.error(error);
        await refreshSummary().catch(() => {});
        renderCurrentView();
        announce(t(locale, "refreshFailedTitle"), error instanceof Error ? error.message : "");
      }
    },
    onClear: async () => {
      collectionState = clearCollectionSelection(collectionState);
      renderCurrentView();
      try {
        await rpc.clearSelection();
      } catch (error) {
        console.error(error);
      }
    },
    onContinue: () => continueWithSelection(false),
    // REQ-017's opt-in, taken deliberately by the owner from the refusal's
    // own banner. Nothing calls this except that button, so a duplicate is
    // never superseded by a retry the owner did not ask for.
    onNoticeAction: () => continueWithSelection(true),
    onNoticeDismiss: () => {
      collectionState = clearNotice(collectionState);
      renderCurrentView();
    },
    onInspectBatch: (batch, batchItemId) => openBatchDrawer({ id: batch.id, itemId: batchItemId }),
    // The card ⋯ — one menu open across the board; the Remove row asks in
    // place before the write, and a removed post leaves the review
    // selection too (a selected row that no longer exists is a stale ask).
    onCardMenu: (batchItemId) => {
      inboxState = setCardMenu(inboxState, batchItemId);
      renderCurrentView();
    },
    onCardMenuConfirm: (batchItemId) => {
      inboxState = setCardMenuConfirm(inboxState, batchItemId);
      renderCurrentView();
    },
    onCardMenuCancel: (batchItemId) => {
      inboxState = setCardMenu(inboxState, batchItemId);
      renderCurrentView();
    },
    onRemoveItem: async (batch, item) => {
      const batchItemId = item?.batchItemId ?? item?.id;
      inboxState = clearCardMenu(inboxState);
      renderCurrentView();
      let result;
      try {
        result = await rpc.removeBatchItem({ batchItemId });
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (!result?.ok) {
        inboxState = setInboxNotice(inboxState, result?.message || t(locale, "genericError"));
        renderCurrentView();
        return;
      }
      if (inboxState.selected?.[batchItemId]) inboxState = toggleInboxItem(inboxState, batchItemId, null);
      announce(t(locale, "drawerRemovedPost"), "");
      try {
        inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 }));
      } catch (error) {
        console.error(error);
      }
      renderCurrentView();
    },
    onSelectItem: (batchItemId, entry) => {
      inboxState = toggleInboxItem(inboxState, batchItemId, entry);
      renderCurrentView();
    },
    onClearItemSelection: () => {
      inboxState = clearInboxSelection(inboxState);
      inboxState = setInboxNotice(inboxState, null);
      renderCurrentView();
    },
    onReviewSelected: () => reviewSelectedItems(),
    onInboxFilter: (filter) => { inboxState = setInboxFilter(inboxState, filter); if (filter === "new") { collectionState = setFilter(collectionState, "new"); void loadCollection("new"); } renderCurrentView(); },
    onLoadMoreBatches: async () => {
      if (!inboxState.nextCursor || inboxState.loading) return;
      inboxState = setInboxLoading(inboxState, true);
      renderCurrentView();
      try {
        const page = await rpc.listBatchSummaries({ limit: 50, cursor: inboxState.nextCursor });
        inboxState = setInboxSummaries(inboxState, page, true);
      } catch (error) {
        inboxState = { ...inboxState, loading: false, error: error instanceof Error ? error.message : "Saved work could not be loaded." };
      }
      renderCurrentView();
    }
  };

  /**
   * Continue, and REQ-017's choice when the server refuses.
   *
   * `duplicate_active` is not a failure to report and move past: the owner
   * asked for something reasonable and there is exactly one other thing they
   * might have meant. So the refusal's own sentence goes on screen with the
   * one way forward beside it, and the second call carries
   * `createNewVersion` — the explicit opt-in the requirement asks for, made
   * by the person, not by this function retrying.
   */
  /**
   * A refusal, said to the person rather than to the caller.
   *
   * `refusalMessage` carries the server's own sentence, which is right for
   * `duplicate_active` (it names the batch) and wrong for the codes that
   * describe a missing setup step — "createBatch needs at least one
   * destination binding" is a sentence about a function argument. Where this
   * gadget knows the way out, it offers it.
   */
  function announceRefusal(refusal) {
    if (refusal?.code === "batch_needs_destinations") {
      announce(
        t(locale, "batchNoDestinationTitle"),
        t(locale, "batchNoDestinationBody"),
        { label: t(locale, "settingsOpen"), run: () => collectionHandlers.onOpenSettings() }
      );
      return;
    }
    announce(t(locale, "batchBlockedTitle"), refusalMessage(refusal));
  }

  /**
   * Source items already covered by an active batch — the client's mirror of
   * `findDuplicates` (active, never-filed batch items). The summaries only
   * approximate it: a batch with filed-but-still-active rows is not a
   * conflict, and the server stays authoritative for whatever this misses.
   * Drafts and attention rows are the ones that would refuse.
   */
  function takenSourceIds() {
    return new Set(
      (inboxState.summaries ?? [])
        .filter((entry) => (entry.draftCount ?? 0) + (entry.attentionCount ?? 0) > 0)
        .flatMap((entry) => entry.sourceItemIds ?? [])
    );
  }

  async function continueWithSelection(createNewVersion) {
    const selected = selectedIds(collectionState);
    if (!selected.length) return;
    /*
     * The count on the action is what the action can actually draft
     * (PM decision 5, corrected): selected posts already in an open draft
     * are not drafted again — they are skipped and named, not sent to a
     * batch the server would refuse. When every selected post is taken,
     * all ids still go to createBatch so its refusal can offer the
     * explicit new-version path (REQ-017's opt-in entry).
     */
    const taken = takenSourceIds();
    const draftable = selected.filter((id) => !taken.has(id));
    const ids = draftable.length ? draftable : selected;
    collectionState = setContinuing(collectionState, true);
    renderCurrentView();
    try {
      const destinationBindings = (summary?.destinations || []).map((destination) => destination.destinationBinding || destination.binding);
      const batch = await rpc.createBatch({ itemIds: ids, destinationBindings, createNewVersion });
      // createBatch answers an expected refusal (no items, an existing
      // active draft) as a value, not a throw — see server.js's
      // header note.
      if (isRefusalResult(batch)) {
        if (batch.code === "duplicate_active") {
          collectionState = setNotice(collectionState, {
            message: refusalMessage(batch),
            actionLabel: t(locale, "duplicateBlockedNewVersion")
          });
          return;
        }
        collectionState = clearNotice(collectionState);
        announceRefusal(batch);
        return;
      }
      collectionState = clearNotice(collectionState);
      /*
       * The batch is pending drafts now. The host reads the returned
       * `workRequest` and files the governed agent request; the outcome is
       * stamped onto each item's durable mark so the Content cards say
       * "awaiting approval" or "could not start" rather than an indefinite
       * "waiting for generation". Land on Content, where drafts appear as they
       * are saved. Editing still reaches the wizard through a card → Continue
       * editing.
       */
      if (draftable.length && draftable.length < selected.length) {
        collectionState = setNotice(collectionState, {
          message: t(locale, "skippedDrafts", { n: selected.length - draftable.length })
        });
      }
      activeSection = "content";
      inboxState = setInboxFilter(inboxState, "drafts");
      await rpc.markSeen(ids).catch(() => {});
      try {
        inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 }));
      } catch (error) {
        console.error(error);
      }
    } catch (error) {
      console.error(error);
      // A thrown failure used to die here silently — the tray went back to
      // its idle label with nothing to show for the press. Say it.
      announce(t(locale, "batchBlockedTitle"), error instanceof Error ? error.message : String(error));
    } finally {
      collectionState = setContinuing(collectionState, false);
      renderCurrentView();
    }
  }

  /**
   * §9.C — Review selected. The dock selects batch-ITEM ids, possibly across
   * batches; this is the single eligibility gate the drawer's own
   * Review-post path shares (active + editable + a saved revision), applied
   * to a fresh server read of each item — never to the snapshot the dock
   * collected. Blocked posts are named by their source label; eligible ones
   * enter the Publish step under each item's OWN batch id, so a cross-batch
   * selection submits each post to its own batch and revision.
   */
  async function reviewSelectedItems() {
    const entries = selectedInboxItems(inboxState);
    if (!entries.length) return;
    const batchCache = new Map();
    const fetchBatch = async (batchId, fresh = false) => {
      if (fresh) batchCache.delete(batchId);
      if (!batchCache.has(batchId)) {
        batchCache.set(batchId, await rpc.getBatch(batchId).catch(() => null));
      }
      return batchCache.get(batchId);
    };
    const labelOf = (entry, item) => item?.sourceItem?.sourceLabel || entry.itemId || entry.batchItemId;
    const batches = new Map();
    for (const entry of entries) {
      if (!batches.has(entry.batchId)) batches.set(entry.batchId, await fetchBatch(entry.batchId));
    }
    const classified = classifyReviewSelection(entries, batches);
    const eligible = classified.eligible;
    const blocked = classified.blocked.map(({ entry, item, reason }) => t(locale, reason, { name: labelOf(entry, item) }));
    if (!eligible.length) {
      // Nothing proceeds — and the selection stays exactly as the owner
      // left it, so a retry after fixing the blocked posts is one click.
      inboxState = setInboxNotice(inboxState, t(locale, "reviewNoneEligible", { total: entries.length, names: blocked.join(" · ") }));
      renderCurrentView();
      return;
    }
    if (blocked.length) {
      // Mixed eligibility is an explicit decision, never a silent
      // narrowing: name the blocked posts, then let the owner confirm the
      // eligible subset actually proceeds.
      const decision = await confirmReviewSubset(leaveDialog, locale, {
        ready: eligible.length,
        total: entries.length,
        blocked
      });
      if (decision !== "proceed") return;
    }
    // Poster bytes must exist before submit — materialize them here, per
    // item, then re-read so each post's Publish card carries the revision
    // the stored poster actually belongs to (the stale-snapshot fix, on the
    // bulk path). `acknowledged` records the revision each write returned.
    const acknowledged = new Map();
    for (const { batchId, item } of eligible) {
      if (!item.posterLayout || (item.posterStored && item.posterMimeType === "image/jpeg")) {
        acknowledged.set(item.id, item.revision ?? 0);
        continue;
      }
      try {
        const png = await renderPosterImage(item.posterLayout.template, {
          headline: item.posterLayout.headline, subline: item.posterLayout.subline,
          background: { value: item.posterLayout.background?.value },
          textColor: item.posterLayout.textColor, align: item.posterLayout.align
        });
        const stored = await rpc.savePoster({
          batchItemId: item.id, expectedRevision: item.revision ?? 0,
          template: item.posterLayout.template, png
        });
        if (stored && stored.ok === false) {
          announce(refusalMessage(stored), "");
          return;
        }
        acknowledged.set(item.id, stored?.revision ?? null);
      } catch (error) {
        announce(error instanceof Error ? error.message : String(error), "");
        return;
      }
    }
    // Final reads are REQUIRED — an acknowledged poster write must never
    // enter review as the revision before it. An item that cannot be
    // re-read (or rereads older than its own acknowledged write) stays
    // selected with an explicit reason rather than silently dropping out.
    const items = [];
    const lost = [];
    for (const { batchId, item } of eligible) {
      const containing = await fetchBatch(batchId, true);
      const fresh = containing?.items?.find((candidate) => candidate.id === item.id);
      const floor = acknowledged.get(item.id);
      if (fresh && isEditableItem(fresh) && (fresh.revision ?? 0) > 0 && (floor == null || (fresh.revision ?? 0) >= floor)) {
        items.push({ ...fresh, batchId });
      } else {
        lost.push({ batchItemId: item.id, reason: t(locale, "reviewReadFailed", { name: labelOf({ batchItemId: item.id, itemId: item.itemId }, item) }) });
      }
    }
    if (!items.length) {
      inboxState = setInboxNotice(inboxState, t(locale, "reviewNoneEligible", { total: entries.length, names: [...blocked, ...lost.map((entry) => entry.reason)].join(" · ") }));
      renderCurrentView();
      return;
    }
    // Only the posts actually entering review leave the selection; blocked
    // and unreadable ones stay selected so the owner can retry them.
    const entered = new Set(items.map((item) => item.id));
    let next = { ...inboxState.selected };
    for (const id of Object.keys(next)) if (entered.has(id)) delete next[id];
    inboxState = { ...inboxState, selected: next, notice: null };
    if (lost.length || blocked.length) {
      announce(t(locale, "reviewPartialNotice", { n: items.length, blocked: [...blocked, ...lost.map((entry) => entry.reason)].join(" · ") }), "");
    }
    // The wizard's batch.id is only the fallback for items missing their
    // own batchId — every projected item carries its own through.
    wizard = resumeBatch(wizard, { id: items[0].batchId, items });
    if (!wizard.batch?.items?.length) {
      announce(t(locale, "batchUnavailable"), "");
      return;
    }
    await refreshPublishState();
    renderCurrentView();
  }

  // --- Wizard (publish / result) handlers -------------------------------------
  // Review-time decisions that make a new revision: a JPEG copy of a PNG for a
  // JPEG-only destination, and re-accepting an image whose provenance the
  // server cannot vouch for.
  const imageAcceptance = createImageAcceptance({
    rpc,
    loadImage: (id) => loadGeneratedImageAsBlobUrl(rpc, id),
    onChange: () => { if (wizard.step === "publish") renderCurrentView(); }
  });
  const reviewItem = (id) => wizard.batch?.items.find((entry) => entry.id === id) ?? null;
  const rereadReviewItem = async (id) => {
    const item = reviewItem(id);
    if (!item) return;
    const refreshed = await rpc.getBatch(item.batchId ?? wizard.batch.id);
    const fresh = refreshed?.items?.find((entry) => entry.id === id);
    if (fresh) wizard = { ...wizard, batch: { ...wizard.batch, items: wizard.batch.items.map((entry) => (entry.id === id ? fresh : entry)) } };
  };
  const settleAcceptance = async (id, saved) => {
    if (!saved) return;
    if (isRefusalResult(saved)) {
      wizard = setPublishError(wizard, id, { code: saved.code, message: refusalMessage(saved) });
    } else {
      wizard = setPublishError(wizard, id, null);
      try { await rereadReviewItem(id); } catch (error) { console.error(error); }
    }
    renderCurrentView();
  };
  const wizardHandlers = {
    imageAcceptanceState: (id) => imageAcceptance.state(id),
    onPrepareJpeg: async (id) => {
      const item = reviewItem(id);
      if (item) await imageAcceptance.prepare(item);
    },
    onAcceptJpeg: async (id) => {
      const item = reviewItem(id);
      if (item) await settleAcceptance(id, await imageAcceptance.accept(item));
    },
    onReacceptImage: async (id) => {
      const item = reviewItem(id);
      if (item) await settleAcceptance(id, await imageAcceptance.reaccept(item));
    },
    // Review draws the same accepted generated image the drawer shows.
    loadGeneratedImage: (id) => loadGeneratedImageAsBlobUrl(rpc, id),
    // A review image finished loading, decoding or failing: redraw so the
    // card's submit reflects whether the approver can actually see it.
    onReviewImageState: () => { if (wizard.step === "publish") renderCurrentView(); },
    // --- Publish step: the send decision is per item, made at submit -------
    onToggleBinding: (id, binding) => {
      wizard = togglePublishBinding(wizard, id, binding);
      renderCurrentView();
    },
    onPublishIntent: (id, patch, redraw = true) => {
      wizard = setPublishIntent(wizard, id, patch);
      // Radio changes redraw; the schedule text/datetime inputs stay put so
      // typing does not lose focus mid-keystroke.
      if (redraw) renderCurrentView();
    },
    /**
     * TASK-016's submit: one item, the bindings the picker has chosen, the
     * timing it carries. `createNewVersion` arrives only from the refusal's
     * own button — REQ-017's opt-in, taken by the owner, never retried.
     * Every expected refusal (a stale revision, no
     * destination chosen, an already-filed pair, a provider outage) is a
     * value — server.js's header note — shown on the item it belongs to.
     */
    onSubmitItem: async (id, createNewVersion = false) => {
      const item = wizard.batch?.items.find((entry) => entry.id === id);
      if (!item || wizard.submittingByItem?.[id]) return;
      const choice = wizard.publishChoices?.[id] ?? {};
      // The picker's answer is what the summary offers AND still grants —
      // a binding seeded from a since-revoked destination is not a choice,
      // and the server would refuse it by the same rule (#1960).
      const knownBindings = new Set(
        (Array.isArray(summary?.destinations) ? summary.destinations : [])
          .filter((entry) => entry.granted !== false)
          .map((entry) => entry.destinationBinding ?? entry.binding)
      );
      wizard = setPublishError(wizard, id, null);
      wizard = setSubmitting(wizard, id, true);
      renderCurrentView();
      try {
        const result = await rpc.submitForReview({
          batchItemId: id,
          expectedRevision: item.revision ?? 0,
          destinationBindings: (choice.bindings ?? []).filter((binding) => knownBindings.has(binding)),
          intent: choice.intent,
          createNewVersion
        });
        if (isRefusalResult(result)) {
          wizard = setPublishError(wizard, id, { code: result.code, message: refusalMessage(result) });
        } else {
          // The filing landed — read back the item and its publication rows
          // so the picker shows them as filed rather than chosen. A docked
          // review can hold posts from several batches, so the refetch uses
          // the item's OWN batch id, not the wizard's header batch.
          const refreshed = await rpc.getBatch(item.batchId ?? wizard.batch.id);
          const fresh = refreshed?.items?.find((entry) => entry.id === id);
          if (fresh) {
            wizard = { ...wizard, batch: { ...wizard.batch, items: wizard.batch.items.map((entry) => (entry.id === id ? fresh : entry)) } };
          }
          if (result.warnings?.length) announce(result.warnings[0].message, "");
          const publishState = await rpc.readPublishState(id);
          wizard = applyPublishState(wizard, id, publishState);
        }
      } catch (error) {
        console.error(error);
        wizard = setPublishError(wizard, id, { code: "error", message: error instanceof Error ? error.message : String(error) });
      }
      wizard = setSubmitting(wizard, id, false);
      renderCurrentView();
    },
    // The Publish step's empty state offers the same grant re-check the
    // Settings screen does (TASK-022) — a destination granted after setup is
    // exactly the case an owner reaches it with.
    onRefreshGrants: async () => {
      try {
        const result = await rpc.refreshGrants();
        if (result && result.ok === false) {
          announce(t(locale, "genericError"), result.message || "");
          return;
        }
        await refreshSummary();
        const names = [...(result?.added?.sources ?? []), ...(result?.added?.destinations ?? [])].map((row) => row.label || row.binding);
        announce(t(locale, names.length ? "setupConnectionsFound" : "setupConnectionsNone", names.length ? { names: names.join(", ") } : {}), "");
        renderCurrentView();
      } catch (error) {
        console.error(error);
        announce(t(locale, "genericError"), error instanceof Error ? error.message : "");
      }
    },
    onOpenSettings: () => collectionHandlers.onOpenSettings(),
    // The publish card shows the caption as finished copy, not a second
    // place to change it -- one editing surface (the drawer, with its
    // composer and protected-literal preview), one place to ship (this
    // card). Only `.id` reaches openBatchDrawer; it re-fetches the batch
    // itself.
    //
    // A docked review CAN hold posts from several batches (§9.C), so this
    // resolves the clicked item's own batch id — `wizard.batch.id` is only
    // the fallback for a projected item missing its `batchId`.
    onEditCaption: (itemId) => {
      const item = wizard.batch?.items.find((entry) => entry.id === itemId);
      return openBatchDrawer({ id: item?.batchId ?? wizard.batch?.id, itemId });
    },
    onBack: async () => {
      const target = WIZARD_BACK_TARGET[wizard.step];
      // "select" has no wizard view of its own — going back from Publish
      // means leaving the batch and returning to the collection.
      wizard = target === "select" ? createWizardState() : target ? goToWizardStep(wizard, target) : wizard;
      // A refusal banner from the step being left does not belong on the
      // step navigated to.
      wizard = setWizardError(wizard, null);
      renderCurrentView();
    },
    /**
     * Publishing authority is the owner's to give, in the host's own dialog
     * (`gadget:grant-door`). The canvas only asks; once the host grants it,
     * the canvas is remounted and the owner submits again.
     */
    onGrantPublishing: () => {
      window.parent.postMessage({ type: "gadget:grant-door", requirementKey: "social" }, "*");
    },
    onRetry: async (itemId, destinationBinding) => {
      // A failed pair re-files through the same per-item submit, scoped to
      // the one destination that failed.
      wizard = setPublishError(wizard, itemId, null);
      try {
        const result = await rpc.submitForReview({
          batchItemId: itemId,
          expectedRevision: wizard.batch.items.find((item) => item.id === itemId)?.revision ?? 0,
          destinationBindings: [destinationBinding]
        });
        if (isRefusalResult(result)) {
          wizard = setPublishError(wizard, itemId, { code: result.code, message: refusalMessage(result) });
        } else {
          const state = await rpc.readPublishState(itemId);
          wizard = applyPublishState(wizard, itemId, state);
        }
        renderCurrentView();
      } catch (error) {
        console.error(error);
        wizard = setPublishError(wizard, itemId, { code: "error", message: error instanceof Error ? error.message : String(error) });
        renderCurrentView();
      }
    },
    onCheckManually: async (itemId) => {
      try {
        const state = await rpc.readPublishState(itemId);
        wizard = applyPublishState(wizard, itemId, state);
        renderCurrentView();
      } catch (error) {
        console.error(error);
      }
    },
  };

  async function refreshPublishState() {
    if (!wizard.batch) return;
    for (const item of wizard.batch.items) {
      try {
        const state = await rpc.readPublishState(item.id);
        wizard = applyPublishState(wizard, item.id, state);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function renderCurrentView() {
    if (!summary?.configured) return; // setup screen owns viewHost until configured
    if (!wizard.batch) {
      // Leaving Review releases the image object URLs it owned.
      releaseReviewImages();
      const section = activeSection || 'sources';
      const body = el('div');
      const navigation = el('nav', { class: 'sl-main-nav', 'aria-label': t(locale, 'appTitle') }, [
        ...[['sources', locale === 'zh-HK' ? '來源' : 'Sources'], ['content', locale === 'zh-HK' ? '內容' : 'Content']].map(([key, label]) => el('button', {
          type: 'button', 'aria-pressed': String(section === key), onclick: () => { activeSection = key; renderCurrentView(); }
        }, label)),
        el('div', { class: 'sl-main-actions' }, [
          el('button', { type: 'button', class: `sl-icon-action sl-refresh-action${refreshBusy ? ' is-busy' : ''}`,
            title: t(locale, refreshBusy ? 'refreshing' : 'refresh'), 'aria-label': t(locale, refreshBusy ? 'refreshing' : 'refresh'),
            'aria-busy': String(refreshBusy), disabled: refreshBusy || collectionState.loading || inboxState.loading,
            onclick: async (event) => {
              // One request at a time; the icon spins only while it is live
              // and stops on every way it can settle.
              if (refreshBusy) return;
              const hadFocus = event?.currentTarget === document.activeElement;
              refreshBusy = true; renderCurrentView(); refocusRefresh(hadFocus);
              try {
                if (section === 'sources') { await collectionHandlers.onRefresh(); return; }
                inboxState = setInboxLoading(inboxState, true); renderCurrentView(); refocusRefresh(hadFocus);
                try {
                  inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 }));
                  announce(t(locale, 'inboxRefreshed'), '');
                } catch (error) {
                  inboxState = { ...inboxState, loading: false, error: error instanceof Error ? error.message : t(locale, 'genericError') };
                  announce(t(locale, 'refreshFailedTitle'), error instanceof Error ? error.message : '');
                }
              } finally {
                refreshBusy = false; renderCurrentView(); refocusRefresh(hadFocus);
              }
            }
          }, icon('refresh')),
          el('button', { type: 'button', class: 'sl-icon-action', title: t(locale, 'settingsOpen'), 'aria-label': t(locale, 'settingsOpen'), onclick: collectionHandlers.onOpenSettings }, icon('settings'))
        ])
      ]);
      const taken = takenSourceIds();
      const draftableCount = selectedIds(collectionState).filter((id) => !taken.has(id)).length;
      if (section === 'sources') renderCollection(body, collectionState, { locale, summary, handlers: collectionHandlers, loadCover, draftableCount });
      else renderInbox(body, inboxState, { locale, handlers: collectionHandlers, loadCover, loadGeneratedCover, sources: summary?.sources });
      replace(viewHost, [navigation, body]);
      return;
    }
    if (wizard.step === "publish") renderPublish(viewHost, wizard, { locale, summary, policy, handlers: wizardHandlers });
  }



  // --- First run, and every visit after it (TASK-302) ------------------------
  /**
   * `options.editing` re-enters the form for a gadget that is already
   * configured, prefilled from its stored config. Without it this was a
   * one-way door — cadence, timezone and the protected-term
   * lists were fixed at first run for the life of the gadget, on every
   * surface. Door grants and schedules were never the problem: the workspace
   * page has owned both, with revoke and stop, all along.
   */
  async function runSetup(options = {}) {
    let editing = options.editing === true;
    let draft = editing ? draftFromConfig(summary?.config) : createSetupDraft();
    let saving = false;
    let savedDraft = editing ? JSON.stringify(draft) : null;
    let notice = null;
    // Finding C: a failed `setConfig` used to reset `saving` and redraw the
    // identical form with nothing telling the owner it had failed — the
    // click looked like it did nothing. This is what makes a failure
    // visible without needing the sandboxed iframe's own devtools console
    // (SEC-002 keeps it opaque to the top Studio frame).
    let error = null;
    // A refusal that names a grant the host can give carries its button here.
    let errorAction = null;
    // The public accounts this workspace watches, and the state of adding one.
    // Read from `summary()` rather than kept in the draft: they are stored the
    // moment they resolve, not on save, because resolution can fail and the
    // owner needs to know before they leave the form.
    let openSources = (summary?.sources || []).filter((source) => source.origin === "open");
    let openBusy = false;
    let openError = null;
    // The additive grant re-check — busy/result live beside the button that
    // asks for it (TASK-021), namespaced like the open-source fields.
    let grantsBusy = false;
    let grantsNote = null;

    const draw = () =>
      renderSetup(viewHost, draft, {
        locale,
        saving,
        error,
        editing,
        errorAction,
        summary,
        dirty: JSON.stringify(draft) !== savedDraft,
        notice,
        openSources,
        // Namespaced, NOT `busy`/`error`. A first version passed `error`
        // twice in this literal, so the public-account error silently
        // clobbered the setConfig one and a failed save showed nothing.
        openBusy,
        openError,
        grantsBusy,
        grantsNote,
        fetchGranted: Boolean(summary?.doors?.metered_fetch),
        handlers: setupHandlers
      });
    const setupHandlers = {
      /**
       * Resolve and store one public account.
       *
       * Stored immediately rather than on save: resolution is the server's
       * answer and it can refuse, so an owner has to see "that link does not
       * name an account" while they are looking at the field. Holding it in
       * the draft would defer the refusal to a save, or to a scan tomorrow.
       */
      onAddOpenSource: async (value) => {
        const link = typeof value === "string" ? value.trim() : "";
        if (!link || openBusy) return;
        openBusy = true;
        openError = null;
        draw();
        try {
          const result = await rpc.addOpenSource(link);
          if (!result || result.ok !== true) {
            openError =
              result?.code === "fetch_not_granted"
                ? t(locale, "fetchNeedsPermission")
                : (result && result.message) || t(locale, "genericError");
          } else {
            await refreshSummary();
            openSources = (summary?.sources || []).filter((source) => source.origin === "open");
          }
        } catch (thrown) {
          console.error(thrown);
          openError = thrown instanceof Error ? thrown.message : String(thrown);
        }
        openBusy = false;
        draw();
      },

      onRemoveOpenSource: async (binding) => {
        if (openBusy) return;
        openBusy = true;
        openError = null;
        draw();
        try {
          await rpc.removeOpenSource(binding);
          await refreshSummary();
          openSources = (summary?.sources || []).filter((source) => source.origin === "open");
        } catch (thrown) {
          console.error(thrown);
          openError = thrown instanceof Error ? thrown.message : String(thrown);
        }
        openBusy = false;
        draw();
      },

      /**
       * "Check for new connections" — TASK-021. A connector granted after
       * first setup never reached the lists this form shows, because the
       * derive step only ran at first setup or through the legacy `setConfig`
       * path and this payload carries no bindings. `refreshGrants` is the
       * additive re-derive; what it added (or that it added nothing) is said
       * beside the button.
       */
      onGrantFetch: async () => {
        if (grantsBusy) return;
        grantsBusy = true;
        grantsNote = null;
        draw();
        const answer = await requestDoorGrant("metered_fetch");
        // Re-read what is granted and redraw THIS form: the draft, the open
        // sources and anything typed stay exactly as they were.
        await refreshSummary().catch(() => {});
        grantsBusy = false;
        grantsNote =
          answer.outcome === "activated" ? null
            : answer.outcome === "activation_failed" ? t(locale, "drawerMediaActivationBody")
              : answer.outcome === "cancelled" ? t(locale, "drawerMediaCancelled")
                : answer.outcome === "busy" ? t(locale, "drawerMediaBusy")
                  : answer.outcome === "unconfirmed" ? t(locale, "drawerMediaUnconfirmed")
                    : answer.message || t(locale, "drawerMediaDenied");
        draw();
      },

      onRefreshGrants: async () => {
        if (grantsBusy) return;
        grantsBusy = true;
        grantsNote = null;
        draw();
        try {
          const result = await rpc.refreshGrants();
          if (!result || result.ok === false) {
            grantsNote = result?.message || t(locale, "genericError");
          } else {
            await refreshSummary();
            const names = [...(result.added?.sources || []), ...(result.added?.destinations || [])]
              .map((row) => row.label || row.binding);
            grantsNote = names.length
              ? t(locale, "setupConnectionsFound", { names: names.join(", ") })
              : t(locale, "setupConnectionsNone");
          }
        } catch (thrown) {
          console.error(thrown);
          grantsNote = thrown instanceof Error ? thrown.message : String(thrown);
        }
        grantsBusy = false;
        draw();
      },

      // Leaves the form without writing anything, back to the collection the
      // owner came from. Only rendered while `editing`.
      onCancel: async () => {
        if (saving) return;
        if (JSON.stringify(draft) !== savedDraft) {
          const decision = await confirmUnsavedNavigation(leaveDialog, locale);
          if (decision === "keep") return;
          if (decision === "save") {
            await setupHandlers.onSubmit();
            if (error) return;
          }
        }
        if (summary?.configured) await loadCollection("new");
      },
      onChange: (patch) => {
        if (saving) return;
        draft = { ...draft, ...patch, ...(patch.refinementBrief ? { refinementBrief: { ...draft.refinementBrief, ...patch.refinementBrief } } : {}) };
        error = null;
        errorAction = null;
        notice = null;
        // Do not replace the clicked Save button during the input's blur/change
        // event: replacement would consume the user's first click. Only the
        // off→on direction is gated on a clean draft; pausing stays live.
        const monitorSwitch = viewHost.querySelector?.("[data-monitor-enable]");
        if (monitorSwitch && monitorSwitch.getAttribute("aria-checked") !== "true") monitorSwitch.setAttribute("disabled", "");
        const savedNotice = viewHost.querySelector?.(".sl-setup-notice");
        if (savedNotice) savedNotice.textContent = "";
        viewHost.querySelector?.(".sl-setup-error")?.remove();
      },
      onMonitoring: async (enabled) => {
        if (saving || (enabled && JSON.stringify(draft) !== savedDraft)) return;
        saving = true;
        error = null;
        errorAction = null;
        notice = null;
        draw();
        try {
          const result = await rpc.setMonitoring(enabled);
          if (result?.code === "schedule_not_granted") {
            error = t(locale, "scheduleNotGrantedBody");
            errorAction = {
              label: t(locale, "scheduleGrantAction"),
              run: () => window.parent.postMessage({ type: "gadget:grant-door", requirementKey: "schedule" }, "*")
            };
          } else if (!result?.ok) error = result?.message || t(locale, "genericError");
          await refreshSummary();
        } catch (thrown) {
          error = thrown instanceof Error ? thrown.message : String(thrown);
        }
        saving = false;
        draw();
      },
      onSubmit: async () => {
        if (saving) return; // a stale second click (e.g. a slow first submit) must not race a duplicate setConfig
        saving = true;
        error = null;
        errorAction = null;
        try {
          draw();
          const result = await rpc.saveSetup(toConfigPayload(draft));
          if (result?.ok === false) throw new Error(result.message || t(locale, "setupError"));
          await refreshSummary();
          draft = draftFromConfig(summary.config);
          savedDraft = JSON.stringify(draft);
          notice = t(locale, "setupSaved");
          // The first save is what makes the gadget configured, and the
          // way back to the posts is only drawn while `editing`. Without
          // this, an owner who saved a new setup stayed on the form with
          // nothing to press but reload.
          if (summary?.configured) editing = true;
          saving = false;
          draw();
        } catch (thrown) {
          // Logged for the sandbox's own forwarded console (see `announce`)
          // AND shown inline, because a thrown error before the RPC ever
          // reaches `env` is exactly the failure mode this cannot rely on
          // console access to diagnose.
          console.error(thrown);
          saving = false;
          error = thrown instanceof Error ? thrown.message : String(thrown);
          draw();
        }
      }
    };
    draw();
  }

  // --- Live updates (REQ-014 / the reference's subscribe convention) -------
  class GadgetSubscriber extends RpcTarget {
    operation(event) {
      handleOperation(event).catch((error) => console.error(error));
    }
    presence() {
      // No collaborative presence in this gadget — one owner reviews at a time.
    }
  }

  // Subscribing again (after the network returns) may have missed events, so
  // every re-subscription reconciles: the open drawer and the list re-read.
  const liveClientId = Math.random().toString(36).slice(2);
  let liveSubscribed = false;
  async function establishLiveUpdates() {
    await rpc.subscribe(new GadgetSubscriber(), { clientId: liveClientId });
    if (liveSubscribed) await handleOperation({ type: "reconnected" });
    liveSubscribed = true;
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("online", () => { if (liveSubscribed) establishLiveUpdates().catch((error) => console.error(error)); });
  }

  async function handleOperation(event) {
    // Saved work changed: the open drawer re-reads its batch (state-preserving)
    // and the Content list refreshes its summaries.
    if (["revision", "generated_image", "drafts_changed", "review_requested", "reconnected"].includes(event?.type)) {
      const drawerRefresh = drawerSession?.refresh?.(event) ?? null;
      try {
        await refreshSummary();
        inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 }));
        if (!wizard.batch) renderCurrentView();
      } catch (error) {
        console.error(error);
      }
      await drawerRefresh;
      return;
    }
    if (!event || event.type !== "scan") return;
    if (!summary?.configured || wizard.batch) return; // a live scan never disturbs an in-progress batch
    try {
      const page = await rpc.listItems({ filter: collectionState.filter, sourceBinding: collectionState.sourceFilter || undefined, query: collectionState.search || undefined });
      collectionState = mergeScanResult(collectionState, page.items || []);
      collectionState = setLastCheckedAt(collectionState, new Date().toISOString());
      renderCurrentView();
    } catch (error) {
      console.error(error);
    }
  }

  (async function init() {
    try {
      await refreshSummary();
      if (summary?.configured) {
        await loadCollection("new");
      } else {
        await runSetup();
      }
      await establishLiveUpdates();
    } catch (error) {
      console.error(error);
      replace(viewHost, [el("p", null, t(locale, "genericError"))]);
    }
  })();
}

App();
