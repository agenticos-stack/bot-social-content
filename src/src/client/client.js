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
import { createRpc, loadMediaAsBlobUrl } from "./rpc.js";
import { createMediaStage } from "./preview-media.js";
import { computePosterLayout, drawPoster } from "./poster.js";
import { confirmUnsavedNavigation } from "./navigation.js";
import { createInboxState, isEditableItem, renderInbox, setInboxFilter, setInboxLoading, setInboxSourceItems, setInboxSummaries } from "./inbox.js";
import {
  applyPublishState,
  applySavedRevision,
  applySavedPoster,
  createSetupDraft,
  draftFromConfig,
  createWizardState,
  draftIsDirty,
  discardDraft,
  goToStep as goToWizardStep,
  isRefusal,
  refusalMessage,
  renderLocalize,
  renderPosterPng,
  renderPublish,
  renderResult,
  renderReview,
  renderSetup,
  setActiveItem,
  setBatch,
  resumeBatch,
  reviewEnabled,
  recordDraftConflict,
  resolveDraftConflict,
  setMobilePane,
  setPublishError,
  setPublishIntent,
  setSaving,
  setSubmitting,
  setWizardError,
  toConfigPayload,
  toggleConfirmedClaim,
  togglePublishBinding,
  updateDraft
} from "./steps.js";

const WIZARD_BACK_TARGET = { localize: "select", review: "localize", publish: "review", result: "publish" };

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
  /* One height for every toolbar control, so the search field and the filter
     buttons beside it cannot drift apart again. */
  --sl-control-h: 40px;
  /* One height for every toolbar control, so a search field and the filter
     buttons beside it cannot drift apart. */
  --sl-control-h: 40px;
  --sl-radius-row: var(--studio-v2-radius-row, 8px);
  --sl-focus: var(--gadget-focus, var(--sl-ink));
  --sl-font: var(--font-sans, system-ui, sans-serif);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--sl-bg); color: var(--sl-ink); font: 13.5px/1.55 var(--sl-font); }
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--sl-focus); outline-offset: 2px;
}
.sl-app { max-width: 1080px; margin: 0 auto; padding: 20px clamp(16px, 3vw, 36px) 96px; }
.sl-titleline { margin-bottom: 18px; }
.sl-titleline h1 { margin: 0 0 6px; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
.sl-main-nav { display:flex; align-items:center; gap:16px; border-bottom:1px solid var(--sl-line); margin-bottom:20px; }
.sl-main-nav > button { min-height:40px; padding:8px 0; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--sl-muted); font-weight:600; }
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
.sl-icon-action { width:34px; height:34px; border:0; border-radius:var(--sl-radius-control); background:transparent; color:var(--sl-muted); display:grid; place-items:center; cursor:pointer; flex-shrink:0; }
.sl-icon-action svg { width:18px; height:18px; display:block; }
.sl-icon-action:hover:not(:disabled) { background:var(--sl-hover); color:var(--sl-ink); }
.sl-icon-action:disabled { color:var(--sl-line-strong); cursor:not-allowed; }
@media(pointer:coarse) { .sl-main-actions .sl-icon-action { width:44px; height:44px; } }
.sl-titleline p { margin: 0; color: var(--sl-muted); font-size: 12px; max-width: 620px; }
.sl-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.sl-search { flex: 1 1 200px; }
.sl-search-input { width: 100%; height: var(--sl-control-h); padding: 0 12px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); }
.sl-filter-btn { display: inline-flex; align-items: center; gap: 7px; height: var(--sl-control-h); padding: 0 12px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); color: var(--sl-muted); font-size: 11px; white-space: nowrap; }
.sl-filter-btn.sl-filter-active { background: var(--sl-selected); color: var(--sl-ink); font-weight: 650; }
/* The count is a reading of the filter, not part of its name: it stays legible
   at a glance and stops "New" and "3" reading as one word. */
.sl-filter-count { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--sl-surface-2); color: var(--sl-muted); font: 600 9.5px/18px var(--sl-font); font-variant-numeric: tabular-nums; text-align: center; }
.sl-filter-active .sl-filter-count { background: var(--sl-ink); color: var(--sl-surface); }
.sl-sync-refresh { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--sl-muted); font-size: 10.5px; }
.sl-sync-refresh button { height: 32px; padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); background: var(--sl-surface); font-size: 11px; }
.sl-chip-row { display: flex; flex-wrap: wrap; gap: 7px; margin: 0 0 16px; }
.sl-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: 999px; background: var(--sl-surface); font-size: 10.5px; }
.sl-chip-active { background: var(--sl-selected); font-weight: 650; }
.sl-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--sl-success); }
.sl-chip-degraded { border-color: var(--sl-warning); color: var(--sl-warning); background: color-mix(in srgb, var(--sl-warning) 10%, var(--sl-surface)); }
.sl-chip-degraded .sl-chip-dot { background: var(--sl-warning); }
.sl-collection { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.sl-mobile-panes { display: none; }
.sl-inbox { margin: 0 0 24px; padding: 0 0 20px; border-bottom: 1px solid var(--sl-line); background: var(--sl-surface); }
.sl-inbox-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.sl-inbox-tabs button { min-height: 34px; padding: 6px 10px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--sl-muted); white-space: nowrap; font-size: 12px; }
.sl-inbox-tabs button.sl-filter-active { color: var(--sl-ink); border-bottom-color: var(--sl-ink); font-weight: 650; }
.sl-inbox-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.sl-inbox-card { display: grid; gap: 6px; min-height: 142px; padding: 13px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-row); background: var(--sl-surface); }
.sl-inbox-card:focus-within, .sl-inbox-card:focus { outline: 2px solid var(--sl-focus); outline-offset: 2px; }
.sl-inbox-card-meta { display: flex; justify-content: space-between; color: var(--sl-muted); font-size: 9px; }
.sl-inbox-card .sl-secondary { min-height: 34px; font-size: 10.5px; }
.sl-state-chip { display: inline-block; margin: 2px 0 6px; padding: 2px 8px; border-radius: 999px; font: 600 8.5px var(--sl-font); letter-spacing: .03em; text-transform: uppercase; background: var(--sl-surface-2); color: var(--sl-muted); }
.sl-chip-queued { background: var(--sl-selected, var(--sl-surface-2)); color: var(--sl-ink); }
.sl-chip-attention { background: rgba(176,84,42,.12); color: var(--sl-warn, #a0522d); }
.sl-chip-submitted, .sl-chip-scheduled { background: rgba(46,122,74,.12); color: var(--sl-ok, #2e7a4a); }

.sl-drawer-section { padding: 12px 0; border-bottom: 1px solid var(--sl-line); }
.sl-drawer-section h3 { margin: 0 0 5px; font-size: 11px; }
.sl-drawer-composer textarea { width: 100%; resize: vertical; font: inherit; font-size: 12px; line-height: 1.55; padding: 8px 10px; }
.sl-drawer-composer .sl-setup-actions { margin-top: 6px; justify-content: flex-end; }
.sl-drawer-poster { display: block; max-width: 200px; width: 40%; height: auto; margin-top: 10px; border-radius: var(--sl-radius-control); border: 1px solid var(--sl-line); }
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
.sl-app { --bot-control-height: 34px; --sl-control-h: 36px; }
.sl-app .bot-button.bot-button { font-size: 12px; padding: 6px 10px; }
@media (pointer: coarse) { .sl-app { --bot-control-height: 44px; --sl-control-h: 44px; } .sl-inbox-tabs button { min-height: 44px; } }
.sl-post-body strong { display: block; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sl-post-body p { height: 34px; margin: 4px 0 8px; color: var(--sl-muted); font-size: 10.5px; line-height: 1.55; overflow: hidden; }
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
   bottom padding on .sl-app is what lets the last row scroll clear of it. */
.sl-selection { position: fixed; bottom: clamp(10px, 2vh, 18px); left: 50%; translate: -50% 0; z-index: 5; width: fit-content; max-width: calc(100% - 32px); padding: 8px; border: 1px solid var(--sl-line); border-radius: calc(var(--sl-radius-card) + 4px); background: color-mix(in srgb, var(--sl-surface) 80%, transparent); backdrop-filter: blur(16px) saturate(180%); box-shadow: 0 1px 2px rgba(24,24,27,.04), 0 14px 30px -14px rgba(24,24,27,.3); }
.sl-selection-inner { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.sl-selected-copy { padding-inline: 8px 4px; }
.sl-selected-copy strong { display: block; font-size: 11.5px; }
.sl-selected-copy span { display: block; color: var(--sl-muted); font-size: 9.5px; }
.sl-clear { border: 0; background: transparent; color: var(--sl-muted); font-size: 11px; border-radius: var(--sl-radius-control); height: var(--sl-control-h); padding: 0 10px; }
.sl-clear:hover { background: var(--sl-hover); color: var(--sl-ink); }
.sl-primary, .sl-secondary { min-height: 40px; padding: 0 15px; border-radius: var(--sl-radius-control); font-size: 12px; font-weight: 650; }
.sl-primary { margin-left: auto; border: 1px solid var(--sl-accent-strong); background: var(--sl-accent); color: #1a1a1a; }
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
.sl-setup-actions .sl-primary { margin-left: 0; }
.sl-item-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.sl-item-tabs button { height: 32px; padding: 0 12px; border: 1px solid var(--sl-line-strong); border-radius: 999px; background: var(--sl-surface); font-size: 11px; }
.sl-item-tabs button[aria-selected="true"] { background: var(--sl-ink); border-color: var(--sl-ink); color: #fff; }
.sl-dual { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 14px; }
.sl-dual-pane { border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); overflow: hidden; }
.sl-dual-pane header { padding: 9px 13px; background: var(--sl-surface-2); border-bottom: 1px solid var(--sl-line); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; display: flex; justify-content: space-between; align-items: center; }
.sl-dual-body { padding: 14px; }
.sl-src-text { margin: 0; font-size: 12.5px; line-height: 1.85; }
.sl-lit { background: var(--sl-accent-soft); border-radius: 4px; padding: 1px 4px; font-weight: 600; }
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
.sl-review-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-bottom: 18px; }
.sl-preview-card { border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); overflow: hidden; }
.sl-preview-card header { padding: 10px 13px; border-bottom: 1px solid var(--sl-line); font-size: 11px; font-weight: 650; }
.sl-pc-media { aspect-ratio: 1/1; background: var(--sl-surface-2); display: grid; place-items: center; padding: 14px; text-align: center; }
.sl-pc-body { padding: 11px 13px; }
.sl-pc-body p { margin: 0; font-size: 11px; }
.sl-bind-label { display: inline-flex; margin-top: 9px; padding: 4px 8px; border-radius: 999px; background: var(--sl-selected); color: var(--sl-muted); font: 9px var(--sl-font); }
.sl-approval-card { border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-card); padding: 16px; }
.sl-approval-expired { border-color: var(--sl-warning); background: color-mix(in srgb, var(--sl-warning) 8%, var(--sl-surface)); }
.sl-approval-card h3 { margin: 0 0 4px; font-size: 13px; }
.sl-approval-card p { margin: 0 0 8px; color: var(--sl-muted); font-size: 11px; }
.sl-hash { font: 10px var(--sl-font); color: var(--sl-muted); word-break: break-all; }
.sl-target-row { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 12px 14px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-row); margin-bottom: 8px; }
.sl-who strong { display: block; font-size: 12px; }
.sl-who span { display: block; color: var(--sl-muted); font-size: 10px; }
.sl-state-badge { display: inline-flex; height: 24px; padding: 0 10px; border-radius: 999px; align-items: center; font-size: 10px; font-weight: 650; }
.sl-state-scheduled { background: var(--sl-selected); }
.sl-state-published { background: color-mix(in srgb, var(--sl-success) 16%, var(--sl-surface)); color: var(--sl-success); }
.sl-state-failed_safe { background: color-mix(in srgb, var(--sl-danger) 12%, var(--sl-surface)); color: var(--sl-danger); }
.sl-state-unknown { background: color-mix(in srgb, var(--sl-warning) 14%, var(--sl-surface)); color: var(--sl-warning); }
.sl-cta { height: 28px; padding: 0 10px; border: 1px solid var(--sl-line-strong); border-radius: 7px; background: var(--sl-surface); font-size: 10.5px; }
.sl-guidance { grid-column: 1/-1; margin: 6px 0 0; padding: 10px 12px; border-radius: var(--sl-radius-row); background: var(--sl-surface-2); color: var(--sl-muted); font-size: 10.5px; }
.sl-receipt { color: var(--sl-ink); font-size: 10.5px; }
.sl-result-summary { border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); padding: 16px; margin-bottom: 12px; }
.sl-result-item { padding: 10px 0; border-top: 1px solid var(--sl-line); }
.sl-result-item:first-child { border-top: 0; padding-top: 0; }
.sl-outcomes { display: flex; gap: 6px; margin-top: 6px; }
.sl-outcome { display: inline-flex; align-items: center; gap: 6px; }
.sl-result-note { margin: 0 0 16px; padding: 10px 12px; border-radius: var(--sl-radius-row); background: var(--sl-selected); font-size: 10.5px; }
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
.sl-preview-actions { padding: 12px 16px; border-top: 1px solid var(--sl-line); display: flex; gap: 8px; }
.sl-preview-actions button { flex: 1; min-height: 44px; white-space: normal; }
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
  .sl-preview-actions button { min-height: 44px; }
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
  let leavingEditor = false;

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
    activePreviewStage = createMediaStage(rpc, item, locale);

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
           * headed @essentialfoodsofficial while belonging to @hilde.oest,
           * @junior_the_copenhagen_lab, @nordictail and @arcticspots. Those
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

  async function openBatchDrawer(summaryRow) {
    const request = ++drawerRequest;
    const previous = document.activeElement;
    let batch;
    try { batch = await rpc.getBatch(summaryRow.id); } catch (error) {
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
    const editable = batch.items?.some(isEditableItem);
    const destinationLabel = (binding) =>
      (summary?.destinations || []).find((d) => d.destinationBinding === binding || d.binding === binding)?.label || binding;
    const posterPreview = (layout) => {
      if (!layout?.template) return null;
      const canvas = el("canvas", { class: "sl-drawer-poster", "aria-label": t(locale, "posterTitle") });
      const computed = computePosterLayout({ template: layout.template, headline: layout.headline, subline: layout.subline, align: layout.align });
      canvas.width = computed.width;
      canvas.height = computed.height;
      const ctx2d = canvas.getContext("2d");
      if (ctx2d) drawPoster(ctx2d, computed, { headline: layout.headline, subline: layout.subline, background: { value: layout.background?.value }, textColor: layout.textColor });
      return canvas;
    };
    const captionEditor = (item) => {
      if (!isEditableItem(item)) return null;
      const note = el("p", { class: "sl-field-note", role: "status" });
      const textarea = el("textarea", {
        class: "sl-field-input sl-drawer-caption",
        rows: "4",
        placeholder: t(locale, "drawerCaptionPlaceholder")
      });
      textarea.value = item.caption || "";
      const save = el("button", { type: "button", class: "sl-secondary" }, t(locale, "saveChanges"));
      save.onclick = async () => {
        save.disabled = true;
        note.textContent = t(locale, "saving");
        const result = await rpc.saveRevision({ batchItemId: item.id, expectedRevision: item.revision, caption: textarea.value });
        save.disabled = false;
        if (result?.ok) {
          item.revision = result.revision;
          item.caption = textarea.value;
          note.textContent = t(locale, "drawerRevision", { n: result.revision });
          const summaries = await rpc.listBatchSummaries({ limit: 50 });
          inboxState = setInboxSummaries(inboxState, summaries);
          return;
        }
        note.textContent = (result?.issues || []).map((issue) => issue.message).join(" ") || t(locale, "saveFailed");
      };
      return el("div", { class: "sl-field sl-drawer-composer" }, [textarea, el("div", { class: "sl-setup-actions" }, [save]), note]);
    };
    const body = el("div", { class: "sl-preview-scroll" }, [
      el("p", { class: "sl-field-note" }, t(locale, "inboxItemCount", { n: batch.items.length })),
      ...batch.items.map((item) => {
        return el("section", { class: "sl-drawer-section" }, [
        el("h3", null, item.sourceItem?.sourceLabel || item.sourceItem?.provider || t(locale, "paneSource")),
        el("p", null, item.sourceItem?.text || t(locale, "inboxNoSource")),
        el("p", { class: "sl-field-note" }, t(locale, "drawerRevision", { n: item.revision })),
        // TASK-018: where this draft was sent — one line per publication,
        // including `bound` ones (recorded destinations, never sent).
        item.publications?.length
          ? el("ul", { class: "sl-field-note" }, item.publications.map((pub) =>
              el("li", null, `${destinationLabel(pub.destinationBinding)} · ${pub.state}${pub.postId ? ` · post ${pub.postId}` : ""}`)))
          : null,
        isEditableItem(item)
          ? captionEditor(item)
          : el("p", { class: "sl-field-note" }, item.caption || t(locale, "inboxNoSource")),
        posterPreview(item.posterLayout),
        item.state === "submitted" || item.state === "awaiting_approval" ? el("p", { class: "sl-field-note" }, t(locale, "drawerApprovalUnavailable")) : null
      ]); })
    ]);
    replace(batchDialog, [el("div", { class: "sl-preview-sheet" }, [
      el("header", { class: "sl-preview-head" }, [el("strong", null, t(locale, "drawerSavedWork")), el("div", { class: "sl-preview-head-actions" }, [
        el("button", {
          type: "button", class: "sl-icon-action",
          title: t(locale, "drawerClose"), "aria-label": t(locale, "drawerClose"),
          onclick: () => batchDialog.close()
        }, icon("close"))
      ])]),
      body,
      el("footer", { class: "sl-preview-actions" }, [
        el("button", { type: "button", class: "sl-secondary", onclick: () => batchDialog.close() }, t(locale, "drawerClose")),
        editable ? el("button", { type: "button", class: "sl-primary", onclick: () => { batchDialog.close(); wizard = { ...resumeBatch(wizard, batch), returnToDrawer: batch.id }; renderCurrentView(); } }, t(locale, "drawerContinue")) : null
      ])
    ])]);
    if (!batchDialog.open) batchDialog.showModal();
    batchDialog.addEventListener("close", () => { if (previous instanceof HTMLElement) previous.focus(); }, { once: true });
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

  function askLeaveEditor() {
    return confirmUnsavedNavigation(leaveDialog, locale);
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
        await rpc.refresh();
        await loadCollection(collectionState.filter);
        announce(t(locale, "refreshedTitle"), "");
      } catch (error) {
        console.error(error);
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
    onInspectBatch: openBatchDrawer,
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

  // --- Wizard (localize / review / publish / result) handlers --------------
  const wizardHandlers = {
    onSelectItem: (id) => {
      wizard = setActiveItem(wizard, id);
      renderCurrentView();
    },
    onMobilePane: (pane) => { wizard = setMobilePane(wizard, pane); renderCurrentView(); },
    onDraftChange: (id, patch, redraw = true) => {
      const field = document.activeElement;
      const selection = field?.classList?.contains("sl-zh-edit") ? [field.selectionStart, field.selectionEnd] : null;
      wizard = updateDraft(wizard, id, patch);
      if (!redraw) {
        viewHost.querySelector?.(".sl-selection .sl-primary")?.setAttribute("disabled", "");
        return;
      }
      renderCurrentView();
      if (selection) {
        const replacement = document.querySelector(".sl-zh-edit");
        replacement?.focus();
        replacement?.setSelectionRange(...selection);
      }
    },
    onToggleClaim: (id, value) => {
      wizard = toggleConfirmedClaim(wizard, id, value);
      renderCurrentView();
    },
    onPosterChange: (patch) => {
      wizard = updateDraft(wizard, wizard.activeItemId, patch);
      renderCurrentView();
    },
    onSave: async (id) => {
      if (wizard.submitting || wizard.savingByItem[id] || Object.hasOwn(wizard.conflicts ?? {}, id)) return;
      const item = wizard.batch.items.find((entry) => entry.id === id);
      const draft = wizard.drafts[id];
      const submittedDraft = { ...draft, confirmedClaims: [...(draft.confirmedClaims || [])] };
      wizard = setSaving(wizard, id, true);
      wizard = setWizardError(wizard, null);
      renderCurrentView();
      try {
        const result = await rpc.saveRevision({
          batchItemId: id,
          expectedRevision: item.revision ?? 0,
          caption: submittedDraft.caption,
          posterLayout: { template: submittedDraft.template, headline: submittedDraft.headline, subline: submittedDraft.subline, background: { kind: "solid", value: submittedDraft.background }, textColor: submittedDraft.textColor, align: submittedDraft.align },
          confirmedClaims: submittedDraft.confirmedClaims,
          publicationIntent: submittedDraft.publicationIntent,
          refinementBrief: submittedDraft.refinementBrief,
          acceptedVisualMode: submittedDraft.acceptedVisualMode,
          ledger: submittedDraft.ledger
        });
        if (result?.ok) wizard = applySavedRevision(wizard, id, result, submittedDraft);
        // A `{ ok: false }` refusal (a validation `block` issue, or a
        // now-unknown batch item) is a value, never a caught exception —
        // server.js's header note — so it is surfaced the same way a
        // genuine throw is, via the inline banner below.
        else {
          wizard = setWizardError(wizard, refusalMessage(result));
          if (result?.issues?.some((issue) => issue.code === "revision_conflict")) {
            const batch = await rpc.getBatch(wizard.batch.id);
            wizard = recordDraftConflict(wizard, id, batch?.items?.find((entry) => entry.id === id));
          }
        }
      } catch (error) {
        console.error(error);
        wizard = setWizardError(wizard, error instanceof Error ? error.message : String(error));
      }
      wizard = setSaving(wizard, id, false);
      renderCurrentView();
    },
    onSavePoster: async (id) => {
      if (wizard.submitting || wizard.savingByItem[id] || Object.hasOwn(wizard.conflicts ?? {}, id)) return;
      const item = wizard.batch.items.find((entry) => entry.id === id);
      const draft = wizard.drafts[id];
      const submittedDraft = { ...draft };
      wizard = setSaving(wizard, id, true);
      wizard = setWizardError(wizard, null);
      try {
        const png = await renderPosterPng(draft.template, { headline: draft.headline, subline: draft.subline, background: { value: draft.background }, textColor: draft.textColor });
        const result = await rpc.savePoster({ batchItemId: id, expectedRevision: item.revision ?? 0, template: draft.template, png });
        if (result?.ok) wizard = applySavedPoster(wizard, id, result, submittedDraft);
        else if (isRefusal(result)) {
          wizard = setWizardError(wizard, refusalMessage(result));
          if (result?.issues?.some((issue) => issue.code === "revision_conflict")) {
            const batch = await rpc.getBatch(wizard.batch.id);
            wizard = recordDraftConflict(wizard, id, batch?.items?.find((entry) => entry.id === id));
          }
        }
      } catch (error) {
        console.error(error);
        wizard = setWizardError(wizard, error instanceof Error ? error.message : String(error));
      }
      wizard = setSaving(wizard, id, false);
      renderCurrentView();
    },
    onResolveConflict: (id, keepEdits) => {
      wizard = resolveDraftConflict(wizard, id, keepEdits);
      renderCurrentView();
    },
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
      wizard = setPublishError(wizard, id, null);
      wizard = setSubmitting(wizard, id, true);
      renderCurrentView();
      try {
        const result = await rpc.submitForReview({
          batchItemId: id,
          expectedRevision: item.revision ?? 0,
          destinationBindings: choice.bindings ?? [],
          intent: choice.intent,
          createNewVersion
        });
        if (isRefusal(result)) {
          wizard = setPublishError(wizard, id, { code: result.code, message: refusalMessage(result) });
        } else {
          // The filing landed — read back the item and its publication rows
          // so the picker shows them as filed rather than chosen.
          const refreshed = await rpc.getBatch(wizard.batch.id);
          const fresh = refreshed?.items?.find((entry) => entry.id === id);
          if (fresh) {
            wizard = { ...wizard, batch: { ...wizard.batch, items: wizard.batch.items.map((entry) => (entry.id === id ? fresh : entry)) } };
          }
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
    onBack: async () => {
      if (wizard.submitting || leavingEditor) return;
      leavingEditor = true;
      try {
      const dirtyIds = wizard.batch ? wizard.batch.items.map((item) => item.id).filter((id) => draftIsDirty(wizard, id)) : [];
      if (dirtyIds.length) {
        const decision = await askLeaveEditor();
        if (decision === "keep") return;
        if (decision === "discard") {
          for (const id of dirtyIds) wizard = discardDraft(wizard, id);
        } else {
          for (const id of dirtyIds) await wizardHandlers.onSave(id);
          if (wizard.batch && dirtyIds.some((id) => draftIsDirty(wizard, id))) return;
        }
      }
      const target = WIZARD_BACK_TARGET[wizard.step];
      if (wizard.step === "localize" && wizard.returnToDrawer) {
        const row = inboxState.summaries.find((entry) => entry.id === wizard.returnToDrawer);
        wizard = createWizardState();
        renderCurrentView();
        if (row) await openBatchDrawer(row);
        return;
      }
      // "select" has no wizard view of its own — going back from Localize
      // means dropping the batch and returning to the collection.
      wizard = target === "select" ? createWizardState() : target ? goToWizardStep(wizard, target) : wizard;
      // A refusal banner from the step being left does not belong on the
      // step navigated to.
      wizard = setWizardError(wizard, null);
      renderCurrentView();
      } finally {
        leavingEditor = false;
      }
    },
    onContinue: async () => {
      // Localize -> Review asks only that the stored draft is current; the
      // destination is the Publish step's question, not this transition's.
      if (wizard.step === "localize") {
        if (!reviewEnabled(wizard)) {
          wizard = setWizardError(wizard, t(locale, "reviewBlocked"));
        } else {
          wizard = setWizardError(wizard, null);
          wizard = goToWizardStep(wizard, "review");
        }
      } else if (wizard.step === "review") {
        wizard = goToWizardStep(wizard, "publish");
        await refreshPublishState();
      }
      renderCurrentView();
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
    onViewSummary: () => {
      wizard = goToWizardStep(wizard, "result");
      renderCurrentView();
    },
    onExport: async (format) => {
      try {
        await rpc.exportAs(format);
      } catch (error) {
        console.error(error);
        announce(t(locale, "exportFailed"), "");
      }
    },
    onStartAnother: async () => {
      wizard = createWizardState();
      await loadCollection("new");
      renderCurrentView();
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
          el('button', { type: 'button', class: 'sl-icon-action', title: t(locale, 'refresh'), 'aria-label': t(locale, 'refresh'), disabled: collectionState.loading || inboxState.loading,
            onclick: async () => {
              if (section === 'sources') return collectionHandlers.onRefresh();
              inboxState = setInboxLoading(inboxState, true); renderCurrentView();
              try { inboxState = setInboxSummaries(inboxState, await rpc.listBatchSummaries({ limit: 50 })); }
              catch (error) { inboxState = { ...inboxState, loading: false, error: error instanceof Error ? error.message : t(locale, 'genericError') }; }
              renderCurrentView();
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
    if (wizard.step === "localize") renderLocalize(viewHost, wizard, { locale, policy, handlers: wizardHandlers });
    else if (wizard.step === "review") renderReview(viewHost, wizard, { locale, summary, handlers: wizardHandlers });
    else if (wizard.step === "publish") renderPublish(viewHost, wizard, { locale, summary, policy, handlers: wizardHandlers });
    else if (wizard.step === "result") renderResult(viewHost, wizard, { locale, summary, handlers: wizardHandlers });
  }

  globalThis.addEventListener?.("beforeunload", (event) => {
    if (!wizard.batch || !wizard.batch.items.some((item) => draftIsDirty(wizard, item.id))) return;
    event.preventDefault();
    event.returnValue = "";
  });

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
    const editing = options.editing === true;
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
            openError = (result && result.message) || t(locale, "genericError");
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
        notice = null;
        draw();
        try {
          const result = await rpc.setMonitoring(enabled);
          if (!result?.ok) error = result?.message || t(locale, "genericError");
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
        try {
          draw();
          const result = await rpc.saveSetup(toConfigPayload(draft));
          if (result?.ok === false) throw new Error(result.message || t(locale, "setupError"));
          await refreshSummary();
          draft = draftFromConfig(summary.config);
          savedDraft = JSON.stringify(draft);
          notice = t(locale, "setupSaved");
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
