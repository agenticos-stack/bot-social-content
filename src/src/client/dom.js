// Social Content client — tiny DOM helpers shared by every view module.
//
// The generic helpers live in @agenticos-dev/bot-shell's client modules; what
// stays here is the domain-to-design-system adapter (the `sl-*` vocabulary the
// canvas stylesheet owns, mapped onto the shared `bot-*` contracts) and the
// three-icon table this canvas actually draws.
// Untrusted source content (captions, handles, provider messages — SEC-003)
// always goes through `text()` or the `textContent` a caller sets itself;
// nothing in this module ever parses a string as HTML.

import {
  createEl,
  text,
  svgEl,
  iconEl,
  replace,
  skeletonEl
} from "@agenticos-dev/bot-shell/client/elements.js";
import {
  relativeLabel,
  relativeTimeFrom,
  ICON_CLOSE,
  ICON_REFRESH,
  ICON_SETTINGS
} from "@agenticos-dev/bot-shell/client/dom.js";

// Domain-to-design-system adapter. No SDK dependency on Social Content names.
const UI_CLASSES = {
  'sl-primary': 'bot-button', 'sl-secondary': 'bot-button', 'sl-brand': 'bot-button',
  'sl-filter-btn': 'bot-button', 'sl-search-input': 'bot-input',
  'sl-zh-edit': 'bot-input', 'sl-open-source-input': 'bot-input',
  'sl-post': 'bot-card', 'sl-inbox-card': 'bot-card',
  'sl-post-body': 'bot-card-body', 'sl-field': 'bot-field',
  'sl-empty': 'bot-empty', 'sl-preview-dialog': 'bot-drawer',
  'sl-preview-sheet': 'bot-drawer-sheet', 'sl-preview-head': 'bot-drawer-head',
  'sl-preview-scroll': 'bot-drawer-body', 'sl-preview-actions': 'bot-drawer-actions'
};

/** Creates an element, applies attrs/props, and appends children (strings become text nodes). */
export const el = createEl(UI_CLASSES, (node) => {
  if (node.classList.contains('sl-primary')) node.dataset.variant = 'primary';
});

/**
 * The canvas's icon vocabulary, drawn with Studio's geometry.
 *
 * Only the names this canvas calls are bound — the shared package's full
 * table stays in the package, so a name added here is deliberate. Same
 * `Unknown icon` failure as before keeps a typo loud.
 */
const ICONS = { close: ICON_CLOSE, refresh: ICON_REFRESH, settings: ICON_SETTINGS };

/**
 * One named icon, sized and coloured by CSS.
 *
 * Built as nodes rather than injected as markup, so an icon stays subject to
 * the same no-innerHTML rule as everything else in this module. Decorative by
 * construction: every icon button carries its own `aria-label`.
 */
export function icon(name) {
  const d = ICONS[name];
  if (!d) throw new Error(`Unknown icon: ${name}`);
  return iconEl(d);
}

export { text, svgEl, replace, skeletonEl, relativeLabel, relativeTimeFrom };
