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
import { el, icon, replace } from "./dom.js";
import { resolveLocale, t } from "./i18n.js";
import { createRpc, loadMediaAsBlobUrl } from "./rpc.js";
import { confirmUnsavedNavigation } from "./navigation.js";
import { createInboxState, isEditableItem, renderInbox, setInboxFilter, setInboxLoading, setInboxSourceItems, setInboxSummaries } from "./inbox.js";
import {
  addListEntry,
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
  removeListEntry,
  renderLocalize,
  renderPosterPng,
  renderPublish,
  renderResult,
  renderReview,
  renderSetup,
  setActiveItem,
  setBatch,
  resumeBatch,
  submitEnabled,
  recordDraftConflict,
  resolveDraftConflict,
  setMobilePane,
  setSaving,
  setWizardError,
  toConfigPayload,
  toggleConfirmedClaim,
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
.sl-titleline h1 { margin: 0 0 6px; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
.sl-main-nav { display:flex; align-items:center; gap:16px; border-bottom:1px solid var(--sl-line); margin-bottom:20px; }
.sl-main-nav > button { min-height:40px; padding:8px 0; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--sl-muted); font-weight:600; }
.sl-main-nav > button[aria-pressed=true] { border-bottom-color:var(--sl-ink); color:var(--sl-ink); }
.sl-main-actions { margin-left:auto; display:flex; gap:4px; }
.sl-main-actions .sl-icon-action { width:34px; height:34px; border:0; border-radius:var(--sl-radius-control); background:transparent; color:var(--sl-muted); display:grid; place-items:center; }
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
.sl-inbox-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.sl-inbox-card { display: grid; gap: 6px; min-height: 142px; padding: 13px; border: 1px solid var(--sl-line); border-radius: var(--sl-radius-row); background: var(--sl-surface); }
.sl-inbox-card:focus-within, .sl-inbox-card:focus { outline: 2px solid var(--sl-focus); outline-offset: 2px; }
.sl-inbox-card-meta { display: flex; justify-content: space-between; color: var(--sl-muted); font-size: 9px; }
.sl-inbox-card .sl-secondary { min-height: 34px; font-size: 10.5px; }
.sl-drawer-section { padding: 12px 0; border-bottom: 1px solid var(--sl-line); }
.sl-drawer-section h3 { margin: 0 0 5px; font-size: 11px; }
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
.sl-result-note { margin: 0 0 16px; padding: 10px 12px; border-radius: var(--sl-radius-row); background: var(--sl-selected); font-size: 10.5px; }
.sl-export-row { display: flex; gap: 8px; margin-bottom: 16px; }
.sl-setup-form { display: grid; gap: 4px; max-width: 720px; }
.sl-setup-section .sl-field-note { font-size: 13px; line-height: 1.6; }
.sl-setup-section .sl-field label { font-size: 13px; }
.sl-setup-section input, .sl-setup-section select { min-height: 42px; }
.sl-setup-section textarea { border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); padding: 10px; background: var(--sl-surface); }
.sl-radio { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 4px; }
.sl-tag-field { border: 1px solid var(--sl-line-strong); border-radius: var(--sl-radius-control); padding: 8px; }
.sl-tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.sl-tag { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: var(--sl-selected); font-size: 10.5px; }
.sl-tag button { border: 0; background: transparent; font-size: 12px; line-height: 1; }
.sl-tag-field input { width: 100%; border: 0; height: 30px; }
.sl-preview-dialog { width: min(640px, 100vw); max-width: 100%; height: 100dvh; max-height: 100dvh; margin: 0 0 0 auto; padding: 0; border: 0; border-left: 1px solid var(--sl-line); background: var(--sl-surface); color: var(--sl-ink); box-shadow: -30px 0 60px -32px rgba(24,24,27,.45); translate: 0 0; opacity: 1; transition: translate .3s cubic-bezier(.32,.72,0,1), opacity .24s ease, display .3s allow-discrete, overlay .3s allow-discrete; }
/* The drawer slides in from the edge it is docked to. The display and overlay
   properties have to transition discretely or the closing frames are never
   painted: a dialog leaves the top layer the instant close() runs. The
   starting-style rule carries the pre-open frame, which an element entering the
   top layer cannot otherwise express, having no previous style to start from. */
.sl-preview-dialog:not([open]) { translate: 100% 0; opacity: 0; }
@starting-style { .sl-preview-dialog[open] { translate: 100% 0; opacity: 0; } }
.sl-preview-dialog::backdrop { background: rgba(24,24,27,.28); opacity: 1; transition: opacity .3s ease, display .3s allow-discrete, overlay .3s allow-discrete; }
.sl-preview-dialog:not([open])::backdrop { opacity: 0; }
@starting-style { .sl-preview-dialog[open]::backdrop { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .sl-preview-dialog, .sl-preview-dialog::backdrop { transition-duration: 1ms; } }
.sl-preview-sheet { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.sl-preview-head { min-height: 52px; padding: 0 14px; border-bottom: 1px solid var(--sl-line); display: flex; align-items: center; gap: 10px; }
.sl-preview-head strong { display: block; font-size: 13px; }
.sl-preview-head span { display: block; color: var(--sl-muted); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }
.sl-preview-close { margin-left: auto; flex-shrink: 0; border: 0; background: transparent; color: var(--sl-ink); font-size: 24px; height: 44px; width: 44px; border-radius: var(--sl-radius-row); }
.sl-preview-close:hover { background: var(--sl-hover); }
.sl-preview-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 24px; overflow-wrap: anywhere; }
.sl-preview-media { height: clamp(140px, 28dvh, 260px); background: var(--sl-surface-2); border: 1px solid var(--sl-line); border-radius: var(--sl-radius-card); margin-bottom: 20px; display: grid; place-items: center; overflow: hidden; }
.sl-preview-media img { width: 100%; height: 100%; object-fit: contain; }
.sl-preview-caption { font-size: 15px; line-height: 1.8; white-space: pre-wrap; }
.sl-preview-head { padding: 12px 20px; }
.sl-preview-head strong { font-size: 16px; }
.sl-preview-head span { font-size: 11px; }
.sl-preview-scroll .sl-field-note, .sl-preview-scroll .sl-rights { font-size: 13px; line-height: 1.65; }
.sl-preview-scroll .sl-drawer-section { padding: 20px 0; }
.sl-preview-scroll .sl-drawer-section h3 { font-size: 15px; }
.sl-preview-scroll .sl-drawer-section p { font-size: 14px; line-height: 1.8; white-space: pre-wrap; }
.sl-rights { margin-top: 14px; padding: 12px; border-radius: var(--sl-radius-control); }
.sl-rights-confirmed { background: color-mix(in srgb, var(--sl-success) 14%, var(--sl-surface)); }
.sl-rights-pending { background: color-mix(in srgb, var(--sl-warning) 14%, var(--sl-surface)); }
.sl-rights-denied { background: color-mix(in srgb, var(--sl-danger) 14%, var(--sl-surface)); }
.sl-rights strong { display: block; font-size: 10.5px; }
.sl-rights span { display: block; margin-top: 2px; font-size: 9.5px; }
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

function buildPreviewDialog() {
  const dialog = el("dialog", { class: "sl-preview-dialog", "aria-labelledby": "sl-preview-title" });
  document.body.appendChild(dialog);
  return dialog;
}

function providerFormatKey(item) {
  const kind = item?.media?.[0]?.kind;
  if (kind === "video") return "drawerFormatVideo";
  if (kind === "carousel_child") return "drawerFormatCarousel";
  return "drawerFormatImage";
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
  const { viewHost } = buildShell();
  const previewDialog = buildPreviewDialog();
  const batchDialog = buildPreviewDialog();
  const leaveDialog = buildPreviewDialog();

  let summary = null;
  let activeSection = null;
  let policy = {};
  let collectionState = createCollectionState();
  let inboxState = createInboxState();
  let wizard = createWizardState();
  let activePreviewItem = null;
  let activePreviewBlobUrl = null;
  let lastFocusedBeforePreview = null;
  let drawerRequest = 0;
  let leavingEditor = false;

  function toast(title, body) {
    // Minimal, dependency-free toast; console.log also reaches the host via
    // the sandbox bootstrap's forwarded console, so this is never the only
    // trace of an action.
    console.log(`[social-localization] ${title}: ${body || ""}`);
  }

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

  const media = el("div", { class: "sl-preview-media" }, [el("span", null, t(locale, "mediaUnavailable"))]);
    if (item.media && item.media.length && item.media[0].id) {
      loadMediaAsBlobUrl(rpc, item.id, item.media[0].id, "preview")
        .then(({ url }) => {
          if (activePreviewItem !== item) {
            URL.revokeObjectURL(url);
            return;
          }
          activePreviewBlobUrl = url;
          replace(media, [el("img", { src: url, alt: "" })]);
        })
        .catch((error) => console.error(error));
    }

    const rightsStatus = item.rightsStatus || "pending";
    const rightsBlock = el("div", { class: `sl-rights sl-rights-${rightsStatus}` }, [
      el("strong", null, t(locale, `drawerRights${rightsStatus[0].toUpperCase()}${rightsStatus.slice(1)}Title`)),
      el("span", null, t(locale, `drawerRights${rightsStatus[0].toUpperCase()}${rightsStatus.slice(1)}Body`))
    ]);

    const metrics = item.metrics && typeof item.metrics.likes === "number" ? item.metrics.likes.toLocaleString(locale === "zh-HK" ? "zh-HK" : "en-US") : t(locale, "metricsUnavailable");
    const metaLine = el("p", { class: "sl-field-note" }, [
      t(locale, "drawerFormat"),
      ": ",
      t(locale, providerFormatKey(item)),
      "  ·  ",
      t(locale, "drawerEngagement"),
      ": ",
      metrics
    ]);

    replace(body, [
      media,
      metaLine,
      el("p", { class: "sl-preview-caption" }, item.text || ""),
      item.permalink
        ? el("a", { href: item.permalink, target: "_blank", rel: "noopener noreferrer", class: "sl-receipt" }, t(locale, "drawerViewOriginal"))
        : null,
      rightsBlock,
      item.duplicateOf ? el("p", { class: "sl-field-note" }, t(locale, "duplicateNote")) : null
    ]);

    const selected = !!item.selected;
    const actions = el("footer", { class: "sl-preview-actions" }, [
      el(
        "button",
        {
          type: "button",
          class: "sl-secondary",
          onclick: async () => {
            const next = !activePreviewItem.selected;
            await handleSelect(item.id, next);
            activePreviewItem = { ...activePreviewItem, selected: next };
            openPreview(activePreviewItem);
          }
        },
        selected ? t(locale, "drawerRemove") : t(locale, "drawerSelect")
      ),
      el(
        "button",
        {
          type: "button",
          class: "sl-primary",
          onclick: async () => {
            if (!activePreviewItem.selected) await handleSelect(item.id, true);
            closePreview();
          }
        },
        selected ? t(locale, "drawerContinueSelected") : t(locale, "drawerSelectAndContinue")
      )
    ]);

    replace(previewDialog, [
      el("div", { class: "sl-preview-sheet" }, [
        el("header", { class: "sl-preview-head" }, [
          el("div", null, [el("span", null, t(locale, "drawerEyebrow")), el("strong", { id: "sl-preview-title" }, item.sourceLabel || item.authorHandle || "")]),
          el("button", { type: "button", class: "sl-preview-close", "aria-label": t(locale, "close"), onclick: () => closePreview() }, "×")
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
    const body = el("div", { class: "sl-preview-scroll" }, [
      el("p", { class: "sl-field-note" }, t(locale, "inboxItemCount", { n: batch.items.length })),
      ...batch.items.map((item) => el("section", { class: "sl-drawer-section" }, [
        el("h3", null, item.sourceItem?.sourceLabel || item.sourceItem?.provider || t(locale, "paneSource")),
        el("p", null, item.sourceItem?.text || t(locale, "inboxNoSource")),
        el("p", { class: "sl-field-note" }, t(locale, "drawerRevision", { n: item.revision })),
        el("p", { class: `sl-rights sl-rights-${item.rightsStatus}` }, `${t(locale, "drawerRightsPendingTitle")}: ${item.rightsStatus}`),
        el("p", { class: "sl-field-note" }, item.caption || t(locale, "inboxNoSource")),
        item.state === "submitted" || item.state === "awaiting_approval" ? el("p", { class: "sl-field-note" }, t(locale, "drawerApprovalUnavailable")) : null
      ]))
    ]);
    replace(batchDialog, [el("div", { class: "sl-preview-sheet" }, [
      el("header", { class: "sl-preview-head" }, [el("strong", null, t(locale, "drawerSavedWork")), el("button", { type: "button", class: "sl-preview-close", "aria-label": t(locale, "drawerClose"), onclick: () => batchDialog.close() }, "×")]),
      body,
      el("footer", { class: "sl-preview-actions" }, [
        el("button", { type: "button", class: "sl-secondary", onclick: () => batchDialog.close() }, t(locale, "drawerClose")),
        editable ? el("button", { type: "button", class: "sl-primary", onclick: () => { batchDialog.close(); wizard = { ...resumeBatch(wizard, batch), returnToDrawer: batch.id }; renderCurrentView(); } }, t(locale, "drawerContinue")) : null
      ])
    ])]);
    batchDialog.showModal();
    batchDialog.addEventListener("close", () => { if (previous instanceof HTMLElement) previous.focus(); }, { once: true });
  }

  function closePreview() {
    if (activePreviewBlobUrl) {
      URL.revokeObjectURL(activePreviewBlobUrl);
      activePreviewBlobUrl = null;
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
        toast(t(locale, "refreshedTitle"), "");
      } catch (error) {
        console.error(error);
        toast(t(locale, "refreshFailedTitle"), "");
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
  async function continueWithSelection(createNewVersion) {
    const ids = selectedIds(collectionState);
    if (!ids.length) return;
    try {
      const destinationBindings = (summary?.destinations || []).map((destination) => destination.destinationBinding || destination.binding);
      const batch = await rpc.createBatch({ itemIds: ids, destinationBindings, createNewVersion });
      // createBatch answers an expected refusal (no items, no destinations,
      // an existing active localization) as a value, not a throw — see
      // server.js's header note.
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
        toast(t(locale, "refreshFailedTitle"), refusalMessage(batch));
        renderCurrentView();
        return;
      }
      collectionState = clearNotice(collectionState);
      wizard = setBatch(wizard, batch);
      await rpc.markSeen(ids).catch(() => {});
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
    onSubmitForReview: async () => {
      if (!submitEnabled(wizard, policy)) {
        wizard = setWizardError(wizard, t(locale, "submitBlocked"));
        renderCurrentView();
        return;
      }
      wizard = setWizardError(wizard, null);
      wizard = { ...wizard, submitting: true };
      renderCurrentView();
      try {
        for (const item of wizard.batch.items) {
          const result = await rpc.submitForReview({ batchItemId: item.id, expectedRevision: item.revision ?? 0 });
          // Every expected refusal (rights unconfirmed, a stale revision, an
          // unresolved destination, a provider outage) is a value now, not
          // a rejected promise — server.js's header note. Stop at the first
          // one and show it rather than moving on as if every item cleared.
          if (isRefusal(result)) {
            wizard = setWizardError(wizard, refusalMessage(result));
            renderCurrentView();
            return;
          }
        }
        const refreshed = await rpc.getBatch(wizard.batch.id);
        wizard = setBatch(wizard, refreshed);
        wizard = goToWizardStep(wizard, "review");
      } catch (error) {
        console.error(error);
        wizard = setWizardError(wizard, error instanceof Error ? error.message : String(error));
      } finally {
        wizard = { ...wizard, submitting: false };
        renderCurrentView();
      }
      renderCurrentView();
    },
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
      if (wizard.step === "review") {
        wizard = goToWizardStep(wizard, "publish");
        await refreshPublishState();
      }
      renderCurrentView();
    },
    onRetry: async (itemId, destinationBinding) => {
      wizard = setWizardError(wizard, null);
      try {
        const result = await rpc.submitForReview({
          batchItemId: itemId,
          expectedRevision: wizard.batch.items.find((item) => item.id === itemId)?.revision ?? 0
        });
        if (isRefusal(result)) {
          wizard = setWizardError(wizard, refusalMessage(result));
        } else {
          await refreshPublishState();
        }
        renderCurrentView();
      } catch (error) {
        console.error(error);
        wizard = setWizardError(wizard, error instanceof Error ? error.message : String(error));
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
        toast(t(locale, "exportFailed"), "");
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
      if (section === 'sources') renderCollection(body, collectionState, { locale, summary, handlers: collectionHandlers, loadCover });
      else renderInbox(body, inboxState, { locale, handlers: collectionHandlers });
      replace(viewHost, [navigation, body]);
      return;
    }
    if (wizard.step === "localize") renderLocalize(viewHost, wizard, { locale, policy, handlers: wizardHandlers });
    else if (wizard.step === "review") renderReview(viewHost, wizard, { locale, summary, handlers: wizardHandlers });
    else if (wizard.step === "publish") renderPublish(viewHost, wizard, { locale, handlers: wizardHandlers });
    else if (wizard.step === "result") renderResult(viewHost, wizard, { locale, handlers: wizardHandlers });
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
   * one-way door — cadence, timezone, rights policy and the protected-term
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
      onAdd: (field, value) => {
        draft = addListEntry(draft, field, value);
        error = null;
        notice = null;
        draw();
      },
      onRemove: (field, value) => {
        draft = removeListEntry(draft, field, value);
        error = null;
        notice = null;
        draw();
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
          // Logged for the sandbox's own forwarded console (client.js's
          // `toast` comment above notes it reaches the host that way) AND
          // shown inline, because a thrown error before the RPC ever
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
