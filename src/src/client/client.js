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
import { computePosterLayout, drawPoster, renderPosterImage } from "./poster.js";
import { confirmReviewSubset, confirmUnsavedNavigation } from "./navigation.js";
import { detectProtectedLiterals, generationMark, itemPresentation } from "../../model.js";
import {
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
.sl-sheet-drawer .sl-drawer-tabs { padding: 12px 24px 0; }
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
  let drawerSession = null; // { requestClose, stages, previous } for the open drawer
  batchDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    drawerSession?.requestClose();
  });
  batchDialog.addEventListener("close", () => {
    const session = drawerSession;
    drawerSession = null;
    for (const mediaStage of session?.stages ?? []) mediaStage.dispose();
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
  let lastFocusedBeforePreview = null;
  let drawerRequest = 0;

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
   * Media stages that are on screen, so a host `doors_changed` event can hand
   * the consent/activation change to the one frame that asked for it.
   */
  const liveStages = new Set();
  function mediaStageFor(target) {
    const stage = createMediaStage(rpc, target, locale, {
      onGrantFetch: () => window.parent.postMessage({ type: "gadget:grant-door", requirementKey: "metered_fetch" }, "*"),
      onRecheck: () => refreshSummary()
    });
    const dispose = stage.dispose;
    stage.dispose = () => { liveStages.delete(stage); dispose(); };
    liveStages.add(stage);
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

  async function refreshSummary() {
    summary = await rpc.summary();
    policy = summary?.config || {};
    return summary;
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

    // Unsaved caption text survives sibling switches inside this drawer and
    // never leaves it — a post's buffer is only committed by that post's own
    // Save/Review, or by the close guard's explicit "save and leave".
    const draftCaptions = new Map(); // batchItemId -> unsaved caption text
    const itemNotes = new Map();     // batchItemId -> live note element (current render)
    const visualChoices = new Map(); // batchItemId -> staged visualTreatment the owner picked
    const generatedUrls = new Map(); // generatedMediaId -> live blob: URL (revoked on redraw/close)
    const stages = [];
    let closing = false;
    let saving = false;

    /*
     * What must survive a rewrite, marked where the owner is looking at the
     * caption — not a fact the owner has to already know to check for. A
     * textarea cannot carry inline marks, so an editable item gets this as
     * a small read-only preview above its composer, shown only when there
     * is something protected to show (nothing to mark is nothing to add).
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

    // The poster renders at the Publish composition's own scale — the old
    // 200px thumb read as a decoration, and the audit asked for the
    // generated image to be the drawer's primary content.
    const posterCanvas = (item) => {
      const layout = item.posterLayout;
      if (!layout?.template) return null;
      const canvas = el("canvas", { class: "sl-pc-canvas", "aria-label": t(locale, "posterTitle") });
      const computed = computePosterLayout({ template: layout.template, headline: layout.headline, subline: layout.subline, align: layout.align });
      canvas.width = computed.width;
      canvas.height = computed.height;
      const ctx2d = canvas.getContext("2d");
      if (ctx2d) drawPoster(ctx2d, computed, { headline: layout.headline, subline: layout.subline, background: { value: layout.background?.value }, textColor: layout.textColor });
      return canvas;
    };

    /**
     * The pick the drawer DISPLAYS for a revision that never recorded one:
     * what submit would actually ship — a stored poster when bytes exist at
     * this revision, else the source media. `acceptedVisualMode` NULL is
     * "nobody picked", not "keep_original" (migration 15), so defaulting the
     * radio to the shipping answer keeps the checked box truthful.
     */
    const displayedVisual = (item) =>
      item?.acceptedVisualMode ?? (item?.posterStored ? "text_poster" : "keep_original");

    /**
     * Poster bytes exist only when the client renders them — render and
     * persist them for ONE item. A stored poster in a format the renderer
     * no longer produces (a PNG saved before the JPEG switch) is
     * re-rendered here rather than filed into a provider hold.
     */
    const materializePoster = async (item) => {
      // Only a revision whose visual pick ships the poster needs poster
      // bytes — materializing one for `ai_refinement`/`keep_original` would
      // append a revision carrying pixels the post will never use. No pick
      // recorded (null) keeps the legacy ship-the-stored-poster behaviour.
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

    /** One `saveRevisions` for the named items only. Per-item issues land on that item's own note line. */
    const saveItems = async (ids) => {
      const dirty = ids
        .map((idToSave) => {
          const item = items.find((entry) => entry.id === idToSave);
          const caption = draftCaptions.get(idToSave);
          const visual = visualChoices.get(idToSave);
          // Compare against what the radio showed — an item with no recorded
          // pick displays the mode its content would actually ship under, so
          // re-picking the displayed choice sends nothing.
          const currentVisual = item ? displayedVisual(item) : "keep_original";
          return {
            item,
            caption: caption !== undefined && caption !== (item?.caption || "") ? caption : undefined,
            visual: visual !== undefined && visual !== currentVisual ? visual : undefined
          };
        })
        .filter((entry) => entry.item && (entry.caption !== undefined || entry.visual !== undefined));
      if (!dirty.length) return true;
      saving = true;
      for (const entry of dirty) {
        const note = itemNotes.get(entry.item.id);
        if (note) note.textContent = t(locale, "saving");
      }
      try {
        const result = await rpc.saveRevisions({
          revisions: dirty.map((entry) => ({
            batchItemId: entry.item.id,
            expectedRevision: entry.item.revision,
            ...(entry.caption !== undefined ? { caption: entry.caption } : {}),
            ...(entry.visual !== undefined ? { acceptedVisualMode: entry.visual } : {})
          }))
        });
        let allOk = true;
        for (const [index, entry] of dirty.entries()) {
          const one = result?.results?.[index];
          const note = itemNotes.get(entry.item.id);
          if (one?.ok) {
            entry.item.revision = one.revision;
            if (entry.caption !== undefined) entry.item.caption = entry.caption;
            if (entry.visual !== undefined) {
              entry.item.acceptedVisualMode = entry.visual;
              visualChoices.delete(entry.item.id);
            }
            // The server may keep a partial mark (a pending image ask is not
            // answered by a caption) — mirror whatever it reports, and drop
            // the cached phase so it recomputes off the new fields.
            entry.item.generation = one.generation ?? null;
            entry.item.phase = null;
            draftCaptions.delete(entry.item.id);
            if (note) note.textContent = t(locale, "drawerRevisionSaved", { n: one.revision });
          } else {
            allOk = false;
            if (note) note.textContent = (one?.issues || []).map((issue) => issue.message).join(" ") || t(locale, "saveFailed");
          }
        }
        if (allOk) {
          try { inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 })); } catch (error) { console.error(error); }
        }
        return allOk;
      } finally {
        saving = false;
      }
    };

    const dirtyItemIds = () =>
      items.filter((item) => {
        const draft = draftCaptions.get(item.id);
        if (draft !== undefined && draft !== (item.caption || "")) return true;
        const visual = visualChoices.get(item.id);
        return visual !== undefined && visual !== displayedVisual(item);
      }).map((item) => item.id);

    /**
     * The one exit guard every drawer dismissal runs — Close, Escape,
     * Review and Re-draft all call it. Dirty buffers are an explicit
     * keep/discard/save decision: reviewing one post can never silently
     * save or discard another's edits, and a failed save keeps the editor
     * and its text.
     */
    const requestExit = async () => {
      if (closing || saving) return false;
      const dirty = dirtyItemIds();
      if (!dirty.length) return true;
      const decision = await confirmUnsavedNavigation(leaveDialog, locale);
      if (decision === "keep") return false;
      if (decision === "save" && !(await saveItems(dirty))) return false;
      // "discard" must actually drop the buffers — leaving them would let a
      // later saveItems (e.g. Review's own) resurrect text the owner chose
      // to throw away. The staged visual choice is part of the same buffer.
      if (decision === "discard") for (const id of dirty) {
        draftCaptions.delete(id);
        visualChoices.delete(id);
      }
      return true;
    };

    /**
     * Review this ONE post: save its caption if dirty, materialize its
     * poster bytes when missing or stale, then resume the wizard on the
     * FINAL acknowledged revision. The refetch after savePoster is a
     * REQUIRED read — an acknowledged revision-2 poster can never enter
     * review as revision 1, so a lost response keeps the drawer open with
     * an explanation rather than handing the wizard a stale snapshot.
     * "Review post" IS the retry: it re-reads canonical state and never
     * duplicates a save or a submission.
     */
    const reviewPost = async (item) => {
      if (saving) return;
      if (!(await requestExit())) return;
      if (!(await saveItems([item.id]))) return;
      const note = () => itemNotes.get(item.id);
      const readFailed = () => {
        const line = note();
        if (line) line.textContent = t(locale, "drawerReviewReadFailed");
        announce(t(locale, "drawerReviewReadFailed"), "");
      };
      let fresh;
      try { fresh = await rpc.getBatch(batch.id); } catch { fresh = null; }
      let current = fresh?.items?.find((entry) => entry.id === item.id);
      if (!current) { readFailed(); return; }
      if (!isEditableItem(current)) {
        // Filed (or retired) while the owner looked — refresh the drawer to
        // the canonical rows rather than review a post that no longer edits.
        items = fresh.items;
        redraw();
        announce(t(locale, "batchUnavailable"), "");
        return;
      }
      const materialized = await materializePoster(current);
      if (!materialized.ok) {
        const message = materialized.refusal ? refusalMessage(materialized.refusal) : materialized.error?.message ?? t(locale, "genericError");
        const line = note();
        if (line) line.textContent = message;
        announce(message, "");
        return;
      }
      try { fresh = await rpc.getBatch(batch.id); } catch { fresh = null; }
      current = fresh?.items?.find((entry) => entry.id === item.id) ?? null;
      // The wizard gets the read AFTER the poster write — never the
      // pre-poster snapshot, and never a revision older than the write that
      // was just acknowledged.
      if (!current || (materialized.revision != null && (current.revision ?? 0) < materialized.revision)) {
        readFailed();
        return;
      }
      draftCaptions.delete(item.id);
      closing = true;
      batchDialog.close();
      wizard = resumeBatch(wizard, { ...fresh, id: batch.id, items: [current] });
      if (!wizard.batch?.items?.length) {
        closing = false;
        announce(t(locale, "batchUnavailable"), "");
        return;
      }
      // The merged Publish step reads publication rows off
      // wizard.publishByItem — fetch them on the way in rather than
      // showing a picker for pairs that are already filed.
      await refreshPublishState();
      renderCurrentView();
    };

    const requestClose = async () => {
      if (!(await requestExit())) return;
      closing = true;
      draftCaptions.clear();
      visualChoices.clear();
      for (const url of generatedUrls.values()) URL.revokeObjectURL(url);
      generatedUrls.clear();
      batchDialog.close();
    };

    const bodyEl = el("div", { class: "sl-preview-scroll" });
    const tabsEl = el("div", { class: "sl-drawer-tabs" });
    const footerEl = el("footer", { class: "sl-preview-actions" });

    const deliveryRow = (delivery) => {
      const note = [
        delivery.detail && delivery.detail !== delivery.outcome ? delivery.detail : null,
        delivery.guidance
      ].filter(Boolean).join(" — ");
      return el("div", { class: "sl-target-row" }, [
        el("div", { class: "sl-who" }, [
          el("strong", null, destinationLabel(delivery.destinationBinding)),
          (delivery.revision ?? 0) > 0 ? el("span", null, t(locale, "drawerRevision", { n: delivery.revision })) : null
        ]),
        el("span", { class: `sl-state-badge sl-state-${delivery.outcome}` }, publicationStateSummary(locale, delivery.outcome)),
        delivery.receiptUrl
          ? el("a", { class: "sl-receipt", href: delivery.receiptUrl, target: "_blank", rel: "noopener noreferrer" }, t(locale, "viewReceipt"))
          : null,
        note ? el("p", { class: "sl-guidance" }, note) : null
      ]);
    };

    const redrawFooter = () => {
      const item = activeItem();
      if (!item) { replace(footerEl, []); return; }
      const editable = isEditableItem(item);
      const dirty = dirtyItemIds().includes(item.id);
      if (editable) {
        // Drafts edit + save + review. A revision-0 post (queued, nothing
        // drafted) cannot review until the owner has typed or the agent has
        // saved output — the disabled button carries that reason.
        replace(footerEl, [
          el("button", {
            type: "button", class: "sl-secondary",
            disabled: !dirty || saving,
            onclick: () => saveItems([item.id]).then((ok) => { if (ok) redraw(); })
          }, t(locale, "drawerSaveDraft")),
          el("button", {
            type: "button", class: "sl-primary",
            disabled: saving || ((item.revision ?? 0) === 0 && !(draftCaptions.get(item.id) ?? "").trim()),
            title: (item.revision ?? 0) === 0 ? t(locale, "drawerReviewNeedsOutput") : "",
            onclick: () => reviewPost(item)
          }, t(locale, "drawerReviewPost"))
        ]);
        return;
      }
      // Filed/published/attention posts: no second submission from this
      // drawer — the outcome rows carry the receipt, and Check status
      // re-reads the canonical state through the supported path.
      replace(footerEl, [
        el("button", {
          type: "button", class: "sl-secondary",
          onclick: async () => {
            try {
              await rpc.readPublishState(item.id);
              const fresh = await rpc.getBatch(batch.id);
              if (fresh?.items) {
                items = fresh.items;
                redraw();
              }
            } catch (error) {
              announce(error instanceof Error ? error.message : t(locale, "genericError"), "");
            }
          }
        }, t(locale, "drawerCheckStatus"))
      ]);
    };

    const redraw = () => {
      for (const mediaStage of stages.splice(0)) mediaStage.dispose();
      for (const url of generatedUrls.values()) URL.revokeObjectURL(url);
      generatedUrls.clear();
      itemNotes.clear();
      const item = activeItem();
      if (!item) {
        replace(tabsEl, []);
        replace(bodyEl, [el("p", { class: "sl-field-note" }, t(locale, "batchUnavailable"))]);
        replace(footerEl, []);
        return;
      }
      const phase = phaseOf(item);
      const editable = isEditableItem(item);
      const isQueued = phase === "queued" || phase === "regenerating";

      // Sibling navigation: tabs name ONE post each and switching is pure
      // navigation — unsaved caption text waits in draftCaptions for its
      // own item and is never applied to a sibling.
      replace(tabsEl, items.length > 1 ? [
        el("div", { class: "sl-item-tabs", role: "group", "aria-label": t(locale, "drawerSavedWork") },
          items.map((entry, index) => el("button", {
            type: "button",
            "aria-selected": String(entry.id === activeId),
            onclick: () => { activeId = entry.id; redraw(); }
          }, t(locale, "drawerPostNofM", { n: index + 1, total: items.length }))))
      ] : []);

      const draftCaption = draftCaptions.get(item.id);
      const marked = highlightedCaption(item.caption || "");

      // Generated output — PRIMARY. A missing layout or a not-yet-drafted
      // item gets an explicit pending slot; the source photo never stands
      // in as output. An accepted AI-generated image is a real alternative
      // visual: the owner picks which ships (`acceptedVisualMode` on the
      // revision), and the choice persists through the same saveRevisions
      // path as the caption.
      const poster = posterCanvas(item);
      const generated = item.generatedImage ?? null;
      const currentVisual = visualChoices.get(item.id) ?? displayedVisual(item);
      const mediaSlot = el("div", { class: "sl-pc-media-slot", style: `aspect-ratio: ${item.posterLayout?.template === "1080x1080" ? "1 / 1" : "4 / 5"}; max-width: 320px;` });
      if (currentVisual === "ai_refinement" && generated?.ready) {
        const img = el("img", { class: "sl-pc-canvas", alt: generated.altText || t(locale, "drawerGeneratedImageAlt") });
        const forId = generated.id;
        loadGeneratedImageAsBlobUrl(rpc, forId)
          .then(async ({ url, mime }) => {
            generatedUrls.set(forId, url);
            img.src = url;
            /*
             * JPEG conversion at the one place a canvas exists: Instagram's
             * publish container rejects PNG, and the agent-side attachment
             * pipeline delivers whatever format the image tool produced. When
             * a bound destination is JPEG-only and the stored bytes are PNG,
             * convert through the canvas and re-deliver — the stored asset is
             * then the file that can actually ship, not just the file that
             * arrived. A conversion failure leaves the delivered PNG on
             * screen; submit's format refusal is the backstop, not this.
             */
            const jpegOnly = (item.destinationBindings ?? []).some((binding) =>
              (summary?.destinations ?? []).some((d) => (d.destinationBinding ?? d.binding) === binding && d.provider === "instagram"));
            if (!jpegOnly || mime !== "image/png") return;
            try {
              const jpegBlob = await new Promise((resolveConvert, rejectConvert) => {
                const probe = new Image();
                probe.onload = () => {
                  const canvas = document.createElement("canvas");
                  canvas.width = probe.naturalWidth;
                  canvas.height = probe.naturalHeight;
                  const ctx = canvas.getContext("2d");
                  if (!ctx) { rejectConvert(new Error("no 2d context")); return; }
                  ctx.drawImage(probe, 0, 0);
                  canvas.toBlob((result) => (result ? resolveConvert(result) : rejectConvert(new Error("canvas.toBlob returned no blob"))), "image/jpeg", 0.92);
                };
                probe.onerror = () => rejectConvert(new Error("generated image did not decode"));
                probe.src = url;
              });
              const buffer = await jpegBlob.arrayBuffer();
              const redelivered = await rpc.deliverGeneratedImage({ id: forId, bytes: new Uint8Array(buffer), mimeType: "image/jpeg" });
              if (redelivered?.ok) generated.mimeType = "image/jpeg";
            } catch (error) {
              console.error("generated image JPEG conversion failed:", error);
            }
          })
          .catch(() => {
            img.replaceWith(el("span", { class: "sl-pc-media-empty" }, t(locale, "drawerGeneratedImageFailed")));
          });
        replace(mediaSlot, [img]);
      } else if (currentVisual === "ai_refinement" && generated) {
        replace(mediaSlot, [el("span", { class: "sl-pc-media-empty" }, t(locale, "drawerGeneratedPending"))]);
      } else if (currentVisual === "keep_original") {
        replace(mediaSlot, [el("span", { class: "sl-pc-media-empty" }, t(locale, "drawerVisualSource"))]);
      } else {
        replace(mediaSlot, [poster || el("span", { class: "sl-pc-media-empty" }, t(locale, isQueued ? "posterPendingGeneration" : "posterPending"))]);
      }
      const visualPicker = generated || item.posterStored
        ? el("div", { class: "sl-dest", role: "group", "aria-label": t(locale, "drawerVisualChoice") }, [
            generated
              ? el("label", { class: "sl-dest-row" }, [
                  el("input", {
                    type: "radio",
                    name: `visual-${item.id}`,
                    checked: currentVisual === "ai_refinement",
                    disabled: !generated.ready || !editable || saving,
                    onchange: () => {
                      visualChoices.set(item.id, "ai_refinement");
                      redraw();
                    }
                  }),
                  t(locale, "drawerVisualGenerated"),
                  generated.ready ? null : el("span", { class: "sl-dest-tag" }, t(locale, "drawerGeneratedPendingTag"))
                ])
              : null,
            // A text poster is history, not a new output: offered only when
            // this post already stored one, so a legacy revision stays reviewable.
            item.posterStored
              ? el("label", { class: "sl-dest-row" }, [
                  el("input", {
                    type: "radio",
                    name: `visual-${item.id}`,
                    checked: currentVisual === "text_poster",
                    disabled: !editable || saving,
                    onchange: () => {
                      visualChoices.set(item.id, "text_poster");
                      redraw();
                    }
                  }),
                  t(locale, "drawerVisualPoster")
                ])
              : null,
            el("label", { class: "sl-dest-row" }, [
              el("input", {
                type: "radio",
                name: `visual-${item.id}`,
                checked: currentVisual === "keep_original",
                disabled: !editable || saving,
                onchange: () => {
                  visualChoices.set(item.id, "keep_original");
                  redraw();
                }
              }),
              t(locale, "drawerVisualSourceOption")
            ])
          ])
        : null;
      const outputSection = el("section", { class: "sl-drawer-section" }, [
        el("h3", null, t(locale, "drawerGeneratedOutput")),
        mediaSlot,
        visualPicker,
        generated?.ready && generated.altText
          ? el("p", { class: "sl-field-note" }, t(locale, "drawerGeneratedAlt", { alt: generated.altText }))
          : null,
        isQueued
          ? el("p", { class: "sl-field-note", role: "status" }, (() => {
              // Caption-ready vs image-ready are different states: a saved
              // caption with a pending image asks must not read as "still
              // queued for everything".
              const mark = generationMark(item.generation);
              if (mark && mark.needs.image && !mark.needs.caption) return t(locale, "drawerWaitingImageNote");
              if (mark && !mark.needs.image && mark.needs.caption) return t(locale, "drawerWaitingCaptionNote");
              return t(locale, phase === "regenerating" ? "drawerRegeneratingNote" : "drawerWaitingNote");
            })())
          : null,
        editable
          ? el("div", null, [
              marked ? el("p", { class: "sl-drawer-caption-preview" }, [marked]) : null,
              (() => {
                const note = el("p", { class: "sl-field-note", role: "status" });
                itemNotes.set(item.id, note);
                const textarea = el("textarea", {
                  class: "sl-drawer-caption",
                  rows: "4",
                  placeholder: t(locale, "drawerCaptionPlaceholder"),
                  oninput: () => {
                    draftCaptions.set(item.id, textarea.value);
                    textarea.classList.toggle("sl-dirty", textarea.value !== (item.caption || ""));
                    redrawFooter();
                  }
                });
                textarea.value = draftCaption ?? item.caption ?? "";
                textarea.classList.toggle("sl-dirty", textarea.value !== (item.caption || ""));
                return el("div", { class: "sl-field sl-drawer-composer" }, [textarea, note]);
              })()
            ])
          : el("p", { class: "sl-drawer-caption-preview" }, [marked || item.caption || t(locale, "inboxNoSource")]),
        el("p", { class: "sl-field-note" }, [
          (item.revision ?? 0) > 0 ? t(locale, "drawerRevision", { n: item.revision }) : t(locale, "inboxNoSavedRevision"),
          item.approval && (item.revision ?? 0) > (item.approval.approvedRevision ?? 0)
            ? " " + t(locale, "approvalExpiredTitle")
            : ""
        ].join(""))
      ]);

      // Deliveries — filings at/behind the current revision with the
      // canonical outcome each last read back. Superseded/failed rows stay
      // visible as labelled history; an old held revision is visibly
      // previous, not the post's state.
      const deliveries = Array.isArray(item.deliveries) ? item.deliveries : [];
      const history = (item.publications ?? []).filter((pub) => pub.state === "superseded" || pub.state === "failed");
      const deliverySection = deliveries.length || history.length
        ? el("section", { class: "sl-drawer-section" }, [
            el("h3", null, t(locale, "drawerDelivery")),
            ...deliveries.map(deliveryRow),
            history.length
              ? el("p", { class: "sl-field-note" }, [
                  t(locale, "drawerPreviousFilings"),
                  " ",
                  history.map((pub) => `${destinationLabel(pub.destinationBinding)} · ${t(locale, "drawerRevision", { n: pub.revision })}`).join(" · ")
                ])
              : null
          ])
        : null;

      // Source reference — SECONDARY and labelled. The stage keeps the
      // carousel strip; the caption and permalink come after it so nothing
      // reads as generated output.
      const sourceItem = item.sourceItem;
      const sourceSection = sourceItem
        ? el("section", { class: "sl-drawer-section" }, [
            el("h3", null, t(locale, "drawerSourceReference")),
            (() => {
              const mediaStage = mediaStageFor(sourceItem);
              stages.push(mediaStage);
              return el("div", { class: "sl-preview-stage-wrap" }, [mediaStage.node, mediaStage.strip]);
            })(),
            el("p", { class: "sl-field-note" }, t(locale, "drawerSourceCaption")),
            el("p", { class: "sl-drawer-caption-preview" }, sourceItem.text || t(locale, "inboxNoSource")),
            sourceItem.permalink
              ? el("a", { href: sourceItem.permalink, target: "_blank", rel: "noopener noreferrer", class: "sl-receipt" }, t(locale, "drawerViewOriginal"))
              : null
          ])
        : null;

      // Per-item regenerate — the scoped requestGeneration path. The ask
      // names THIS post; a batch-wide request would silently regenerate
      // its siblings.
      const regenerateRow = editable && phase === "draft"
        ? el("div", { class: "sl-drawer-regen-row" }, [
            el("button", {
              type: "button", class: "sl-secondary sl-drawer-regen",
              onclick: async () => {
                // Same exit guard as Close/Review — a re-draft that drops a
                // dirty caption without asking is the audit's defect 2.
                if (!(await requestExit())) return;
                try {
                  const result = await rpc.requestGeneration(batch.id, [item.id]);
                  if (result && result.ok === false) { announce(refusalMessage(result), ""); return; }
                } catch (error) {
                  announce(error instanceof Error ? error.message : String(error), "");
                  return;
                }
                closing = true;
                draftCaptions.clear();
                batchDialog.close();
                announce(t(locale, "drawerRegenerateNote"), "");
                try { inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 })); } catch (error) { console.error(error); }
                renderCurrentView();
              }
            }, t(locale, "drawerRegeneratePost"))
          ])
        : null;

      // Export stays batch-scoped (the archive is one batch) even though
      // the drawer's subject is one post.
      const exportRow = el("div", { class: "sl-export-row" }, [
        el("button", { type: "button", class: "sl-secondary", onclick: () => wizardHandlers.onExport("json") }, t(locale, "exportJson")),
        el("button", { type: "button", class: "sl-secondary", onclick: () => wizardHandlers.onExport("html") }, t(locale, "exportHtml"))
      ]);

      replace(bodyEl, [
        el("p", { class: "sl-field-note" }, [
          t(locale, "drawerPostNofM", { n: items.findIndex((entry) => entry.id === activeId) + 1, total: items.length }),
          " · ",
          t(locale, PHASE_STATE_KEYS[phase] ?? "stateUnknown")
        ]),
        outputSection,
        deliverySection,
        sourceSection,
        regenerateRow,
        exportRow
      ]);
      redrawFooter();
    };

    redraw();

    replace(batchDialog, [el("div", { class: "sl-preview-sheet sl-sheet-drawer" }, [
      el("header", { class: "sl-preview-head" }, [el("strong", null, t(locale, "drawerSavedWork")), el("div", { class: "sl-preview-head-actions" }, [
        el("button", {
          type: "button", class: "sl-icon-action",
          title: t(locale, "drawerClose"), "aria-label": t(locale, "drawerClose"),
          onclick: () => requestClose()
        }, icon("close"))
      ])]),
      tabsEl,
      bodyEl,
      footerEl
    ])]);
    // The shared dialog's close/cancel listeners delegate here — one
    // registration, one session, see buildPreviewDialog above.
    drawerSession = { requestClose, stages, previous };
    if (!batchDialog.open) batchDialog.showModal();
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
    const eligible = [];
    const blocked = [];
    for (const entry of entries) {
      const containing = await fetchBatch(entry.batchId);
      const item = containing?.items?.find((candidate) => candidate.id === entry.batchItemId);
      if (!item || item.active === false) {
        blocked.push(t(locale, "reviewBlockedUnavailable", { name: labelOf(entry, item) }));
      } else if (!isEditableItem(item)) {
        blocked.push(t(locale, "reviewBlockedFiled", { name: labelOf(entry, item) }));
      } else if ((item.revision ?? 0) === 0) {
        blocked.push(t(locale, "reviewBlockedNoDraft", { name: labelOf(entry, item) }));
      } else {
        eligible.push({ batchId: entry.batchId, item });
      }
    }
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
  const wizardHandlers = {
    // Review draws the same accepted generated image the drawer shows.
    loadGeneratedImage: (id) => loadGeneratedImageAsBlobUrl(rpc, id),
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
      else renderInbox(body, inboxState, { locale, handlers: collectionHandlers, loadCover, sources: summary?.sources });
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
      onGrantFetch: () => {
        window.parent.postMessage({ type: "gadget:grant-door", requirementKey: "metered_fetch" }, "*");
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

  async function handleOperation(event) {
    if (event?.type === "doors_changed") {
      // Re-read what the runtime now reports, in place. Nothing re-renders
      // the drawer, so loaded frames, selection and unsaved edits stay; only
      // a frame that was waiting on this answer is fetched again.
      await refreshSummary();
      if (!summary?.configured) { await runSetup(); return; }
      for (const stage of liveStages) stage.onDoorsChanged();
      return;
    }
    if(event?.type==='drafts_changed'){
      await refreshSummary();
      inboxState=setInboxSummaries(inboxState,await rpc.listBatchSummaries({limit:50}));
      if(!wizard.batch)renderCurrentView();
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
      await rpc.subscribe(new GadgetSubscriber(), { clientId: Math.random().toString(36).slice(2) });
    } catch (error) {
      console.error(error);
      replace(viewHost, [el("p", null, t(locale, "genericError"))]);
    }
  })();
}

App();
