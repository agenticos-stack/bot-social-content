// Social Localization client — the sandboxed gadget entry point (TASK-203).
//
// Bundled by scripts/pack-social-localization-client.mjs into the single
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
import { createMediaStage } from "./preview-media.js";
import { createImageAcceptance } from "./image-acceptance.js";
import { newGrantRequestId, parseGadgetDoorsChangedMessage, parseGadgetGrantResultMessage } from "../../grant-request.js";
import { renderPosterImage } from "./poster.js";
import { confirmReviewSubset, confirmUnsavedNavigation } from "./navigation.js";
import {
  DRAWER_FOOTER_HINT_ID,
  captionConflictFor,
  confirmDrawerChoice,
  dirtyInstructionParts,
  dirtyParts,
  pendingParts,
  drawerPanelId,
  drawerTabId,
  footerState,
  instructionPatchFor,
  renderDrawerTablist,
  renderHistoryPanel,
  renderInstructionsPanel,
  renderOutputPanel,
  renderReferencePanel,
  revisionEntryFor
} from "./drawer.js";
import { detectProtectedLiterals, itemPresentation } from "../../model.js";
import {
  classifyReviewSelection,
  clearInboxSelection,
  createInboxState,
  isEditableItem,
  renderInbox,
  selectedInboxItems,
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
  isRefusal,
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

const BASE_STYLE = `${sharedTokens}\n${sharedComponents}
.sl-setup-fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.sl-setup-section { min-width: 0; border: 1px solid var(--sl-line); border-radius: 12px; padding: 20px; margin: 0 0 20px; background: var(--sl-surface); }
.sl-setup-section legend { font-size: 16px; font-weight: 650; padding: 0 6px; }
.sl-setup-section .sl-field { margin-block: 16px; }
.sl-setup-section textarea { width: 100%; min-height: 90px; resize: vertical; font: inherit; }
.sl-setup-actions { flex-wrap: wrap; gap: 10px; }
:root {
  color-scheme: light;
  --sl-bg: var(--color-bg, #fafafa);
  --sl-surface: var(--color-surface, #fff);
  --sl-surface-2: var(--color-surface-2, #f4f4f5);
  --sl-line: var(--color-line, #e7e7ea);
  --sl-line-strong: var(--color-line-strong, #d9d9de);
  --sl-ink: var(--color-ink, #18181b);
  --sl-muted: var(--color-muted, #71717a);
  --sl-accent: var(--color-accent, #f5b544);
  --sl-accent-strong: var(--color-accent-strong, #e09a2e);
  --sl-accent-soft: var(--color-accent-soft, #fdf5e4);
  --sl-danger: var(--color-danger, #df1b41);
  --sl-warning: var(--color-warning, #b26b00);
  --sl-success: var(--color-success, #0e8a5f);
  --sl-selected: var(--studio-v2-selected, #f1f1f1);
  --sl-hover: var(--studio-v2-hover, #f6f6f6);
  --sl-radius-card: var(--studio-v2-radius-card, 14px);
  --sl-radius-control: var(--studio-v2-radius-control, 9px);
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
.sl-stage-thumb[data-state="refused"] { outline: 1px dashed var(--sl-line-strong); }
.sl-stage-thumb[data-state="held"] .sl-stage-thumb-n::after { content: " ✓"; }
.sl-stage-read { margin: 0 0 0 8px; align-self: center; font-size: 12px; color: var(--sl-ink-soft, inherit); }
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

.sl-drawer-section { padding: 12px 0; }
.sl-drawer-tablist { display: flex; gap: 2px; border-bottom: 1px solid var(--sl-line); overflow-x: auto; scrollbar-width: none; }
.sl-drawer-tablist [role="tab"] { flex: 0 0 auto; min-height: 44px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--sl-muted); font-size: 13px; font-weight: 600; box-shadow: none; }
.sl-drawer-tablist [role="tab"][aria-selected="true"] { color: var(--sl-ink); border-bottom-color: var(--sl-ink); }
.sl-drawer-meta { font-size: 12px; color: var(--sl-muted); }
.sl-drawer-state { display: block; margin-top: 2px; }
.sl-output-images { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); }
.sl-output-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.sl-output-frame { display: grid; place-items: center; aspect-ratio: 4 / 5; max-width: 100%; background: var(--sl-surface-2); border: 1px solid var(--sl-line); border-radius: var(--sl-radius-control); overflow: hidden; padding: 0; }
.sl-output-frame img { width: 100%; height: 100%; object-fit: contain; }
.sl-output-frame .sl-pc-media-empty { padding: 12px; text-align: center; }
.sl-output-candidate .sl-output-frame { border-style: dashed; border-color: var(--sl-ink); }
.sl-part-action { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.sl-reference-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 0 10px; border-radius: 999px; border: 1px dashed var(--sl-line-strong); font-size: 11px; font-weight: 600; color: var(--sl-muted); }
.sl-reference-text { color: var(--sl-muted); }
.sl-instructions-part { margin: 0 0 18px; }
.sl-instructions-used { margin-top: 12px; padding: 12px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-control); }
.sl-history-list { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.8; }
.sl-history-delivery, .sl-history-earlier { margin-bottom: 10px; }
.sl-drawer-footer { flex-direction: column; align-items: stretch; gap: 6px; }
.sl-drawer-footer-actions { display: flex; gap: 8px; }
.sl-drawer-footer-actions button { flex: 1; min-height: var(--sl-h-control); white-space: normal; }
.sl-drawer-footer-hint { margin: 0; font-size: 12px; color: var(--sl-muted); min-height: 1em; }
.sl-drawer-footer-hint:empty { display: none; }
.sl-drawer-section h3 { margin: 0 0 5px; font-size: 11px; }
.sl-drawer-regen-row { margin: 0 0 16px; }
.sl-drawer-poster { display: block; max-width: 200px; width: 40%; height: auto; margin-top: 10px; border-radius: var(--sl-radius-control); border: 1px solid var(--sl-line); }
.sl-drawer-poster-dl.sl-secondary.sl-secondary { display: inline-flex; min-height: var(--sl-h-compact); padding: 0 10px; margin-top: 6px; font-size: 10px; margin-left: 0; }
.sl-drawer-section p { margin: 4px 0; font-size: 11px; }
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
   .sl-selection-inner and .sl-preview-actions above/below), not this class. */
.sl-primary, .sl-secondary { padding: 0 15px; border-radius: var(--sl-radius-control); font-size: 12px; font-weight: 650; }
.sl-primary { border: 1px solid var(--sl-accent-strong); background: var(--sl-accent); color: #1a1a1a; }
.sl-primary:hover:not(:disabled) { background: var(--sl-accent-strong); }
/* A faded brand fill reads as a broken button. An unavailable action is inert,
   so it drops the brand entirely instead of wearing a washed-out version. */
.sl-primary:disabled, .sl-app .sl-primary.sl-primary:disabled {
  border-color: var(--sl-line); background: var(--sl-surface-2); color: var(--sl-muted); opacity: 1; cursor: not-allowed;
}
.sl-secondary { border: 1px solid var(--sl-line-strong); background: var(--sl-surface); }
.sl-secondary:hover:not(:disabled) { background: var(--sl-hover); }
.sl-setup-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.sl-open-source-field { display: grid; gap: 6px; }
.sl-open-source-input { height: 34px; padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); font-size: 12px; }
.sl-open-source-list { display: grid; gap: 4px; }
.sl-open-source { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-row); background: var(--sl-surface); font-size: 12px; }
.sl-open-source-name { font-weight: 550; }
.sl-open-source-meta { margin-left: auto; color: var(--sl-muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.sl-open-source-remove { border: 0; background: none; color: var(--sl-muted); font-size: 14px; line-height: 1; padding: 0 2px; }
.sl-item-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.sl-item-tabs button { height: var(--sl-h-compact); padding: 0 12px; border: 1px solid var(--sl-line-strong); border-radius: 999px; background: var(--sl-surface); font-size: 11px; }
.sl-item-tabs button[aria-selected="true"] { background: var(--sl-ink); border-color: var(--sl-ink); color: #fff; }
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
   steps.js's mediaAspect), so the canvas fills it edge to edge rather than
   capping its own height the way a variable-ratio source frame has to
   (preview-media.js's FRAME_MAX) -- there is no mismatch here to guard. */
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
.sl-dest-tag { margin-left: auto; color: var(--sl-muted); font-size: 10px; }
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
.sl-guidance { grid-column: 1/-1; margin: 6px 0 0; padding: 10px 12px; border-radius: var(--sl-radius-row); background: var(--sl-surface-2); color: var(--sl-muted); font-size: 10.5px; }
.sl-receipt { color: var(--sl-ink); font-size: 10.5px; }
.sl-export-row { display: flex; gap: 8px; margin-bottom: 16px; }
.sl-setup-form { display: grid; gap: 4px; max-width: 720px; }
.sl-setup-section .sl-field-note { font-size: 13px; line-height: 1.6; }
.sl-setup-section .sl-field label { font-size: 13px; }
.sl-setup-section input, .sl-setup-section select { min-height: 42px; }
.sl-setup-section textarea { border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); padding: 10px; background: var(--sl-surface); }
.sl-radio { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 4px; }
/*
 * SLIM, because the media is tall.
 *
 * 640px was a generic drawer width. Nine of the twelve posts a real account
 * produces are portrait -- 1080x1350 or 480x852 -- so a wide sheet spends its
 * width on empty ground beside the picture and its height on the thing that
 * matters. 440 is a 4:5 frame at full bleed with the caption still reading
 * near 60 characters; a 9:16 reel sits inside it without the sheet having to
 * grow. The blurred fill behind the frame went with it: it existed only to
 * cover the gap a too-wide sheet left, and there is no gap now.
 */
.sl-preview-dialog { width: min(440px, 100vw); max-width: 100%; height: 100dvh; max-height: 100dvh; margin: 0 0 0 auto; padding: 0; border: 0; border-left: 1px solid var(--sl-line); background: var(--sl-surface); color: var(--sl-ink); box-shadow: -30px 0 60px -32px rgba(24,24,27,.45); translate: 0 0; opacity: 1; transition: translate .3s cubic-bezier(.32,.72,0,1), opacity .24s ease, display .3s allow-discrete, overlay .3s allow-discrete; }
/* The drawer slides in from the edge it is docked to. The display and overlay
   properties have to transition discretely or the closing frames are never
   painted: a dialog leaves the top layer the instant close() runs. The
   starting-style rule carries the pre-open frame, which an element entering the
   top layer cannot otherwise express, having no previous style to start from. */
.sl-preview-dialog:not([open]) { translate: 100% 0; opacity: 0; }
@starting-style { .sl-preview-dialog[open] { translate: 100% 0; opacity: 0; } }
/*
 * No dim. The drawer is for looking at one post while the others stay in
 * view; darkening them makes the grid a wall instead of a row you are moving
 * along. The sheet reads as a layer from its own edge and shadow.
 *
 * The backdrop element stays (showModal still traps focus and Escape still
 * closes) but it is transparent, so a click on it is a click on something the
 * owner can plainly see -- and that click now closes the drawer, because a
 * visible grid that swallows clicks is worse than a dimmed one that does.
 */
.sl-preview-dialog::backdrop { background: transparent; opacity: 1; transition: opacity .3s ease, display .3s allow-discrete, overlay .3s allow-discrete; }
.sl-preview-dialog:not([open])::backdrop { opacity: 0; }
@starting-style { .sl-preview-dialog[open]::backdrop { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .sl-preview-dialog, .sl-preview-dialog::backdrop { transition-duration: 1ms; } }
.sl-preview-sheet { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; box-shadow: -18px 0 40px -16px rgba(24,24,27,.28); }
.sl-preview-sheet.sl-sheet-drawer { grid-template-rows: auto auto minmax(0, 1fr) auto; }
.sl-sheet-drawer .sl-drawer-tabs { padding: 8px 24px 0; display: grid; gap: 8px; }
.sl-sheet-drawer .sl-drawer-tabs:empty { padding: 0; }
.sl-preview-head { min-height: 52px; padding: 0 14px; border-bottom: 1px solid var(--sl-line); display: flex; align-items: flex-start; gap: 10px; }
.sl-preview-who { flex: 1 1 auto; min-width: 0; padding: 10px 0; }
.sl-preview-head-actions { margin-left: auto; display: flex; gap: 4px; align-self: flex-start; padding: 9px 0; }
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
.sl-preview-head strong { display: block; font-size: 13px; }
.sl-preview-kicker { display: block; color: var(--sl-muted); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }

.sl-preview-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 24px; overflow-wrap: anywhere; }
/* The media stage. See preview-media.js for why the cap is a length. */
.sl-preview-stage-wrap { margin-bottom: 20px; }
.sl-stage { position: relative; display: flex; align-items: center; justify-content: center; min-height: 300px; padding: 0; background: #0d0c0a; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card) var(--sl-radius-card) 0 0; overflow: hidden; }
.sl-stage-surface { display: flex; align-items: center; justify-content: center; width: 100%; min-width: 0; }
.sl-stage-img { position: relative; display: block; width: auto; height: auto; max-width: 100%; }
.sl-stage-chip { position: absolute; z-index: 2; top: 12px; font-size: 11px; font-weight: 600; letter-spacing: .03em; padding: 4px 8px; color: #f3f0e9; background: rgba(13,12,10,.74); border: 1px solid rgba(243,240,233,.16); }
.sl-stage-kind { left: 12px; }
.sl-stage-count { right: 12px; font-variant-numeric: tabular-nums; }
/* A text-only post has no frame kind or count: an empty chip drew as a dark block. */
.sl-stage-chip:empty { display: none; }
.sl-stage-nav { position: absolute; z-index: 2; top: 50%; transform: translateY(-50%); width: 34px; height: 56px; cursor: pointer; color: #f3f0e9; background: rgba(13,12,10,.6); border: 1px solid rgba(243,240,233,.18); font-size: 17px; line-height: 1; }
.sl-stage-nav:hover { background: rgba(13,12,10,.9); }
.sl-stage-prev { left: 8px; }
.sl-stage-next { right: 8px; }
.sl-stage-state { display: grid; place-items: center; gap: 8px; text-align: center; padding: 26px 12px; }
.sl-stage-state p { margin: 0; color: #9d968a; font-size: 12.5px; line-height: 1.55; max-width: 34ch; }
.sl-stage-state strong { color: #f3f0e9; font-size: 13.5px; }
/* A genuinely empty post is a quiet fact, not a loading state or a refusal
   -- it keeps the stage's own footprint (below) but drops the dark ground,
   the two other states earn. */
.sl-stage.sl-stage-empty { background: var(--sl-surface-2); border-style: dashed; border-radius: var(--sl-radius-card); }
.sl-stage-empty-note { padding: 22px; text-align: center; max-width: 30ch; }
.sl-stage-empty-note strong { display: block; color: var(--sl-ink); font-size: 12px; font-weight: 650; margin-bottom: 4px; }
.sl-stage-empty-note p { margin: 0; color: var(--sl-muted); font-size: 11.5px; line-height: 1.55; }
.sl-stage-skeleton { width: 108px; height: 136px; background: linear-gradient(100deg, #24211a 30%, #3a3427 50%, #24211a 70%) 0 0 / 300% 100%; animation: sl-shimmer 1.5s linear infinite; }
@keyframes sl-shimmer { to { background-position: -150% 0; } }
@media (prefers-reduced-motion: reduce) { .sl-stage-skeleton { animation: none; } }
.sl-stage-retry { cursor: pointer; font-size: 11.5px; font-weight: 600; padding: 6px 11px; color: #f3f0e9; background: transparent; border: 1px solid rgba(243,240,233,.32); }
.sl-stage-retry:hover { background: rgba(243,240,233,.1); }
.sl-stage-strip { display: flex; gap: 6px; padding: 8px 10px; background: #080807; border: 1px solid var(--sl-line); border-top: 0; border-radius: 0 0 var(--sl-radius-card) var(--sl-radius-card); overflow-x: auto; overscroll-behavior-x: contain; }
.sl-stage-thumb { flex: 0 0 auto; width: 34px; height: 42px; cursor: pointer; display: grid; place-items: center; color: #9d968a; background: #14120f; border: 1px solid rgba(243,240,233,.18); font-size: 11px; font-variant-numeric: tabular-nums; }
.sl-stage-thumb[aria-selected="true"] { color: #f3f0e9; border-color: var(--sl-accent, #f5b544); }
.sl-drawer-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--sl-line); border: 1px solid var(--sl-line); margin: 0 0 18px; }
.sl-fact { background: var(--sl-surface, #fff); padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.sl-fact dt { font-size: 9.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--sl-muted); }
.sl-fact dd { margin: 0; font-size: 13.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.sl-preview-who { display: flex; flex-direction: column; gap: 1px; }
.sl-preview-via { font-size: 11.5px; color: var(--sl-muted); text-transform: none; letter-spacing: 0; }
.sl-preview-caption { font-size: 15px; line-height: 1.8; white-space: pre-wrap; }
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
.sl-preview-head { padding: 12px 20px; }
.sl-preview-head strong { font-size: 16px; }
.sl-preview-kicker { font-size: 11px; }
.sl-preview-scroll .sl-field-note { font-size: 13px; line-height: 1.65; }
.sl-preview-scroll .sl-drawer-section { padding: 20px 0; }
.sl-preview-scroll .sl-drawer-section h3 { font-size: 15px; }
.sl-preview-scroll .sl-drawer-section p { font-size: 14px; line-height: 1.8; white-space: pre-wrap; }
/* One footer rule for both drawers -- the single-post preview and the batch
   drawer each carry exactly one action now, so there is no second, opposing
   system to keep in sync with this one. */
.sl-preview-actions { padding: 12px 16px; border-top: 1px solid var(--sl-line); display: flex; gap: 8px; }
.sl-preview-actions button { flex: 1; min-height: var(--sl-h-control); white-space: normal; }
/* An item's stage sits inside a sheet that already scrolls — a little shorter
   than the source drawer's, same media fidelity. */
.sl-drawer-section .sl-stage { min-height: 220px; }
.sl-drawer-section .sl-stage-img { max-height: min(420px, 46dvh); }
.sl-drawer-section .sl-preview-stage-wrap { margin-bottom: 10px; }
.sl-preview-scroll .sl-drawer-section .sl-field-note { font-size: 12px; line-height: 1.6; }
/* What the composer below it must not lose, marked read-only -- a
   textarea cannot carry inline marks of its own. */
.sl-drawer-caption-preview { margin: 0 0 8px; font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; }
.sl-drawer-caption { width: 100%; resize: vertical; font: inherit; font-size: 12px; line-height: 1.6; padding: 9px 11px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-control); background: var(--sl-surface-2, var(--sl-surface)); color: var(--sl-ink); }
.sl-drawer-caption:focus { outline: none; border-color: var(--sl-ink); background: var(--sl-surface); }
.sl-drawer-caption.sl-dirty { border-color: var(--sl-ink); }
.sl-drawer-caption::placeholder { color: var(--sl-muted); }
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
  .sl-preview-dialog { width: 100vw; height: 100dvh; margin: 0; border-left: 0; }
  .sl-preview-scroll { padding: 14px; }
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
 * frames all bear on whether this is the post to localize. Anything the
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
  let announceTimer = null;
  const announceRegion = el("div", { class: "sl-announce", role: "status", "aria-live": "polite" });
  const { root: shellRoot, viewHost } = buildShell();
  shellRoot.appendChild(announceRegion);
  const previewDialog = buildPreviewDialog(() => closePreview());
  const batchDialog = buildPreviewDialog();
  const leaveDialog = buildPreviewDialog();
  /*
   * The drawer dialog is shared across opens, so its listeners register ONCE
   * and delegate to the current session — a per-open `cancel` listener would
   * accumulate, and Escape would stack one unsaved-changes guard per drawer
   * ever opened.
   */
  let drawerSession = null; // { requestClose, refresh, dispose, previous } for the open drawer
  batchDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    drawerSession?.requestClose();
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
  let activePreviewStage = null;
  // Every media stage still on screen (preview dialog and drawer panels), so a
  // host door notice reaches each one; a stage leaves the set when disposed.
  const liveMediaStages = new Set();
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
  // A sandboxed canvas always has a window to listen on; guarded so the
  // client still boots where there is none (unit shims, a detached render).
  if (typeof window.addEventListener === "function") window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
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
   * generation) and give live media stages the read's outcome. An obsolete read
   * changes nothing.
   */
  async function onDoorsChanged() {
    const state = await readMeteredFetchConsent();
    if (state === null) return;
    for (const stage of liveMediaStages) stage.notifyPermission({ state });
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

  function mediaStageFor(target) {
    const stage = createMediaStage(rpc, target, locale, {
      requestGrant: () => requestDoorGrant("metered_fetch"),
      requestActivation: () => requestDoorActivation("metered_fetch"),
      refreshSources: () => collectionHandlers.onRefresh(),
      // The owner's own "Check again" on an unconfirmed-permission frame:
      // the same metadata-only read as a notice, never `getMedia`.
      recheckPermission: () => recheckMeteredFetchConsent()
    });
    liveMediaStages.add(stage);
    const dispose = stage.dispose;
    stage.dispose = () => {
      liveMediaStages.delete(stage);
      dispose();
    };
    return stage;
  }

  function announce(title, body, action) {
    console.log(`[social-localization] ${title}: ${body || ""}`);
    if (announceTimer) clearTimeout(announceTimer);
    replace(announceRegion, [
      el("div", { class: "sl-announce-card" }, [
        el("strong", null, title),
        body ? el("span", null, body) : null,
        action
          ? el("button", { type: "button", class: "sl-announce-action", onclick: () => { announce.clear(); action.run(); } }, action.label)
          : null,
        el("button", {
          type: "button", class: "sl-announce-dismiss",
          "aria-label": t(locale, "dismiss"), onclick: () => announce.clear()
        }, "\u00d7")
      ])
    ]);
    // Long enough to read a refusal, and it can be dismissed sooner. A notice
    // that vanishes before it is read is the same as no notice.
    announceTimer = setTimeout(() => announce.clear(), 12000);
  }
  announce.clear = () => {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = null;
    replace(announceRegion, []);
  };

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

    if (activePreviewStage) activePreviewStage.dispose();
    activePreviewStage = mediaStageFor(item);

    replace(body, [
      el("div", { class: "sl-preview-stage-wrap" }, [
        activePreviewStage.node,
        activePreviewStage.strip
      ]),
      drawerFacts(locale, item, activePreviewStage.frameCount),
      el("p", { class: "sl-preview-caption" }, item.text || ""),
      item.permalink
        ? el("a", { href: item.permalink, target: "_blank", rel: "noopener noreferrer", class: "sl-receipt" }, t(locale, "drawerViewOriginal"))
        : null,
      item.duplicateOf ? el("p", { class: "sl-field-note" }, t(locale, "duplicateNote")) : null
    ]);

    /*
     * RELABEL THE FOOTER; DO NOT REBUILD THE DRAWER.
     *
     * Selecting used to call `openPreview` again, which disposes the media
     * stage and builds a new one — so pressing "Select post" threw away the
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
    const actions = el("footer", { class: "sl-preview-actions" });
    const drawActions = (isSelected) => replace(actions, [
      el(
        "button",
        {
          type: "button",
          class: "sl-primary",
          onclick: async () => {
            if (!activePreviewItem.selected) {
              await handleSelect(item.id, true);
              activePreviewItem = { ...activePreviewItem, selected: true };
              announce(t(locale, "drawerSelectedNotice"), "");
            }
            closePreview();
          }
        },
        isSelected ? t(locale, "drawerContinueSelected") : t(locale, "drawerSelectAndContinue")
      )
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
   * subject. Generated output — the poster image and the localized caption
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
    const bufferOf = (id) => buffers.get(id) ?? {};
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
    // One reference stage per post for this drawer session, kept across
    // section switches (its node is re-attached, never rebuilt) so the frame,
    // loaded/blocked state and any recovery in progress survive. Disposed when
    // the post leaves the drawer, its source item changes, or the drawer ends.
    const stages = new Map(); // batchItemId -> { key, stage }
    // A generated caption that arrived over the owner's unsaved caption.
    const captionConflicts = new Map(); // batchItemId -> { caption, revision }
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
    const stageFor = (item) => {
      const key = sourceKeyOf(item);
      const held = stages.get(item.id);
      if (held && held.key === key) return held.stage;
      held?.stage.dispose();
      const stage = mediaStageFor(item.sourceItem);
      stages.set(item.id, { key, stage });
      return stage;
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
      for (const [id, held] of stages) {
        const owner = items.find((entry) => entry.id === id);
        if (!owner || sourceKeyOf(owner) !== held.key) {
          held.stage.dispose();
          stages.delete(id);
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
        .map((job) => ({ ...job, entry: revisionEntryFor(job.item, job.snapshot.buffer), patch: instructionPatchFor(job.item, job.snapshot.buffer) }))
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
                target.generation = one.generation ?? null;
                target.phase = null;
              }
              acknowledgeFields(job.item.id, job.snapshot, ["caption", "imageId", "altText"]);
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

    const dirtyItemIds = () => items.filter((item) => dirtyParts(item, bufferOf(item.id)).any).map((item) => item.id);

    /**
     * The one exit guard every drawer dismissal runs — Close, Escape and
     * Review call it. Unsaved caption, staged image and instruction edits
     * are one decision: keep editing, discard, or save and leave.
     *
     * One policy for every continuation (Close, Review, generation): a save
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
     * Review this ONE post: save its buffer, materialize a legacy poster when
     * one is still what ships, then resume the wizard on the FINAL
     * acknowledged revision (a required reread — never a stale snapshot).
     * Edits typed during any of those awaits stop Review before the drawer
     * is disposed; they are shown dirty and asked about, and a resolved
     * decision re-reads rather than reviewing an older snapshot.
     */
    const reviewPost = async (item) => {
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
        // Immediately before disposal: nothing typed during the reads.
        if (!dirtyItemIds().length) break;
      }
      buffers.clear();
      closing = true;
      session.dispose();
      batchDialog.close();
      wizard = resumeBatch(wizard, { ...fresh, id: batch.id, items: [current] });
      if (!wizard.batch?.items?.length) {
        closing = false;
        announce(t(locale, "batchUnavailable"), "");
        return;
      }
      await refreshPublishState();
      renderCurrentView();
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

    const partName = (part) => t(locale, part === "image" ? "drawerPartImage" : "drawerPartCaption");

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
     */
    const requestPart = async (item, part) => {
      if (saving) return;
      const parts = [part];
      const needs = { [part]: true };
      let supersede = false;
      // Any outstanding part — the other one, the same one, or the request a
      // new post starts with — is replaced only on an explicit confirm.
      const outstanding = pendingParts(item);
      if (outstanding.length) {
        if (!(await confirmReplacePending(outstanding))) return;
        supersede = true;
      }
      const unsavedInstructions = dirtyInstructionParts(item, bufferOf(item.id), parts);
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
          const patch = instructionPatchFor(item, snapshot.buffer, parts);
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
      const send = (withReplace) =>
        rpc.requestGeneration(batch.id, [item.id], withReplace ? { needs, replace: true } : { needs });
      try {
        let result = await send(supersede);
        if (result && result.ok === false && result.code === "generation_pending" && !supersede) {
          const owed = ["image", "caption"].filter((entry) => result.pending?.needs?.[entry]);
          if (!live || !(await confirmReplacePending(owed.length ? owed : [part]))) {
            if (await refetchItems()) redraw();
            return;
          }
          result = await send(true);
        }
        if (result && result.ok === false) { announce(refusalMessage(result), ""); return; }
      } catch (error) {
        announce(error instanceof Error ? error.message : String(error), "");
        return;
      }
      if (!live) return;
      await refetchItems();
      redraw();
      announce(t(locale, "drawerRequestSent"), "");
      try { inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 })); } catch (error) { console.error(error); }
    };

    const headerMeta = el("div", { class: "sl-drawer-meta" });
    const tabsEl = el("div", { class: "sl-drawer-tabs" });
    const bodyEl = el("div", { class: "sl-preview-scroll", tabindex: "-1" });
    const footerEl = el("footer", { class: "sl-preview-actions sl-drawer-footer" });

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

    const redrawFooter = () => {
      const item = activeItem();
      if (!item) { replace(footerEl, []); return; }
      if (isEditableItem(item)) {
        const state = footerState(locale, item, { buffers: bufferOf(item.id), saving });
        const reason = state.review.reason || state.save.reason;
        replace(footerEl, [
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
            el("button", {
              type: "button", class: "sl-primary",
              disabled: state.review.disabled,
              title: state.review.reason || null,
              "aria-describedby": state.review.disabled ? DRAWER_FOOTER_HINT_ID : null,
              onclick: () => reviewPost(item)
            }, t(locale, "drawerReviewPost"))
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

      replace(headerMeta, [
        el("span", { class: "sl-drawer-state" }, [
          items.length > 1 ? t(locale, "drawerPostNofM", { n: items.findIndex((entry) => entry.id === activeId) + 1, total: items.length }) + " · " : "",
          t(locale, PHASE_STATE_KEYS[phase] ?? "stateUnknown"),
          " · ",
          (item.revision ?? 0) > 0 ? t(locale, "drawerRevision", { n: item.revision }) : t(locale, "inboxNoSavedRevision"),
          item.approval && (item.revision ?? 0) > (item.approval.approvedRevision ?? 0) ? " · " + t(locale, "approvalExpiredTitle") : ""
        ].join(""))
      ]);

      // Sibling navigation names ONE post each; switching never applies a
      // buffer to a sibling.
      replace(tabsEl, [
        items.length > 1
          ? el("div", { class: "sl-item-tabs", role: "group", "aria-label": t(locale, "drawerSavedWork") },
              items.map((entry, index) => el("button", {
                type: "button",
                "aria-pressed": String(entry.id === activeId),
                "aria-selected": String(entry.id === activeId),
                onclick: () => {
                  activeId = entry.id;
                  // A read in flight was taken for the previous post's view:
                  // it must not land, but the drawer still owes a refresh.
                  if (refreshing) { readToken += 1; rerun = true; }
                  redraw();
                }
              }, t(locale, "drawerPostNofM", { n: index + 1, total: items.length }))))
          : null,
        renderDrawerTablist(locale, { active: activeTab, onSelect: selectTab })
      ]);

      const buffer = bufferOf(item.id);
      let panel;
      if (activeTab === "reference") {
        panel = renderReferencePanel(locale, item, { stage: item.sourceItem ? stageFor(item) : null });
      } else if (activeTab === "instructions") {
        panel = renderInstructionsPanel(locale, item, {
          editable,
          buffers: buffer,
          policy,
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
            patchBuffer(item.id, { imageId: mediaId });
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
          buffers: buffer,
          highlighted: highlightedCaption(buffer.caption ?? item.caption ?? ""),
          loadImage: loadImage(item),
          noteRef: (note) => itemNotes.set(item.id, note),
          onCaptionInput: (value) => {
            patchBuffer(item.id, { caption: value });
            redrawFooter();
          },
          onAltTextInput: (value) => {
            patchBuffer(item.id, { altText: value });
            redrawFooter();
          },
          captionConflict: captionConflicts.get(item.id) ?? null,
          onReacceptImage: async (mediaId) => {
            if (saving) return;
            saving = true;
            redrawFooter();
            let result;
            try {
              result = await rpc.saveRevisions({ revisions: [{ batchItemId: item.id, expectedRevision: item.revision ?? 0, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: mediaId }] });
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
          onStageImage: (mediaId) => {
            if (mediaId) patchBuffer(item.id, { imageId: mediaId });
            else dropBufferFields(item.id, ["imageId"]);
            redraw();
          },
          onRequestPart: (part) => requestPart(item, part)
        });
      }

      // Export stays batch-scoped (the archive is one batch).
      const exportRow = activeTab === "history"
        ? el("div", { class: "sl-export-row" }, [
            el("button", { type: "button", class: "sl-secondary", onclick: () => wizardHandlers.onExport("json") }, t(locale, "exportJson")),
            el("button", { type: "button", class: "sl-secondary", onclick: () => wizardHandlers.onExport("html") }, t(locale, "exportHtml"))
          ])
        : null;

      replace(bodyEl, [
        el("div", { id: drawerPanelId(activeTab), role: "tabpanel", "aria-labelledby": drawerTabId(activeTab), class: "sl-drawer-panel" }, [panel, exportRow])
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
      for (const held of stages.values()) held.stage.dispose();
      stages.clear();
      for (const url of generatedUrls.values()) URL.revokeObjectURL(url);
      generatedUrls.clear();
      if (drawerSession === session) drawerSession = null;
    };

    redraw();

    replace(batchDialog, [el("div", { class: "sl-preview-sheet sl-sheet-drawer" }, [
      el("header", { class: "sl-preview-head" }, [
        el("div", { class: "sl-preview-who" }, [
          el("strong", { id: "sl-drawer-title" }, t(locale, "drawerSavedWork")),
          headerMeta
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
    session = { requestClose, refresh, dispose, previous, batchId: batch.id };
    // Opening another post ends the previous drawer session: its reads and
    // stages must not outlive it.
    if (drawerSession && drawerSession !== session) drawerSession.dispose?.();
    drawerSession = session;
    if (!batchDialog.open) batchDialog.showModal();
    // Focus moves into the drawer, onto the active section's tab.
    document.getElementById?.(drawerTabId(activeTab))?.focus?.();
  }

  function closePreview() {
    if (activePreviewStage) {
      activePreviewStage.dispose();
      activePreviewStage = null;
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
    try {
      const destinationBindings = (summary?.destinations || []).map((destination) => destination.destinationBinding || destination.binding);
      const batch = await rpc.createBatch({ itemIds: ids, destinationBindings, createNewVersion });
      // createBatch answers an expected refusal (no items, an existing
      // active localization) as a value, not a throw — see server.js's
      // header note.
      if (isRefusal(batch)) {
        if (batch.code === "duplicate_active") {
          collectionState = setNotice(collectionState, {
            message: refusalMessage(batch),
            actionLabel: t(locale, "duplicateBlockedNewVersion")
          });
          renderCurrentView();
          return;
        }
        collectionState = clearNotice(collectionState);
        announceRefusal(batch);
        renderCurrentView();
        return;
      }
      collectionState = clearNotice(collectionState);
      /*
       * The batch is pending drafts now — generation happens on the agent's
       * next turn (no platform work-request mechanism exists yet;
       * agenticos-stack/agenticos#1863). Land on Content, where the pending
       * items read as queued cards off the batch's durable `generation`
       * mark and drafts appear as they are saved. Editing still reaches the
       * wizard through a card → Continue editing.
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
      renderCurrentView();
    } catch (error) {
      console.error(error);
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
    if (isRefusal(saved)) {
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
        if (isRefusal(result)) {
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
        if (isRefusal(result)) {
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
    // Relocated into the batch drawer's body (openBatchDrawer, next to
    // Regenerate) now that the Batch summary screen is gone -- the drawer
    // is already scoped to one batch, which is what an export is of.
    // Unchanged: same rpc call, same refusal handling.
    onExport: async (format) => {
      try {
        await rpc.exportAs(format);
      } catch (error) {
        console.error(error);
        announce(t(locale, "exportFailed"), "");
      }
    }
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
        // event: replacement would consume the user's first click.
        viewHost.querySelector?.("[data-monitor-enable]")?.setAttribute("disabled", "");
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
