// Social Localization client — tiny DOM helpers shared by every view module.
//
// Nothing here talks to the gadget RPC or holds state; it exists so
// collection.js, steps.js and client.js build markup the same way instead of
// each inventing its own createElement wrapper. Untrusted source content
// (captions, handles, provider messages — SEC-003) always goes through
// `text()` or the `textContent` a caller sets itself; nothing in this module
// ever parses a string as HTML.

// Domain-to-design-system adapter. No SDK dependency on Social Content names.
const UI_CLASSES = {
  'sl-primary': 'bot-button', 'sl-secondary': 'bot-button',
  'sl-filter-btn': 'bot-button', 'sl-search-input': 'bot-input',
  'sl-zh-edit': 'bot-input', 'sl-open-source-input': 'bot-input',
  'sl-post': 'bot-card', 'sl-inbox-card': 'bot-card',
  'sl-post-body': 'bot-card-body', 'sl-field': 'bot-field',
  'sl-empty': 'bot-empty', 'sl-preview-dialog': 'bot-drawer',
  'sl-preview-sheet': 'bot-drawer-sheet', 'sl-preview-head': 'bot-drawer-head',
  'sl-preview-scroll': 'bot-drawer-body', 'sl-preview-actions': 'bot-drawer-actions'
};

/** Creates an element, applies attrs/props, and appends children (strings become text nodes). */
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "value" && tag === "textarea") node.value = String(value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
  }
  for (const name of [...node.classList]) {
    if (UI_CLASSES[name]) node.classList.add(UI_CLASSES[name]);
  }
  if (node.classList.contains('sl-primary')) node.dataset.variant = 'primary';
  for (const child of Array.isArray(children) ? children : children != null ? [children] : []) {
    if (child == null) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** A bare text node — for call sites that want to skip the `el()` ceremony. */
export function text(value) {
  return document.createTextNode(String(value ?? ""));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** `el()` for the SVG namespace, which `createElement` cannot produce. */
export function svgEl(tag, attrs, children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : children != null ? [children] : []) {
    if (child instanceof Node) node.appendChild(child);
  }
  return node;
}

/**
 * Studio's icon vocabulary, drawn with Studio's geometry.
 *
 * Studio itself keeps two implementations of one set: `StudioIcon.svelte` maps
 * names onto Hugeicons, and `agenticos-ui/Icon.svelte` draws the same names by
 * hand for surfaces that cannot take the dependency. A gadget canvas is that
 * second case twice over — it is vanilla DOM in a sandboxed iframe, and the
 * archive it ships in is self-contained flat JavaScript — so the path data
 * below is copied from `Icon.svelte` rather than re-drawn. Same names, same
 * 24 grid, same 1.8 round stroke, so a gadget's chrome cannot drift away from
 * the app that hosts it. Add a name here only when Studio already has it.
 */
const ICON_PATHS = {
  close: ["M6 6l12 12", "M18 6L6 18"],
  refresh: [
    "M20 6v5h-5",
    "M4 18v-5h5",
    "M18.2 10.5A6.6 6.6 0 0 0 6.6 7.2L4 9.7",
    "M5.8 13.5a6.6 6.6 0 0 0 11.6 3.3L20 14.3"
  ],
  settings: [
    "M12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6Z",
    "M19.4 13.5a7.7 7.7 0 0 0 .05-3l2-1.55-2-3.45-2.45 1a8 8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8 8 0 0 0 7 6.5l-2.45-1-2 3.45 2 1.55a7.7 7.7 0 0 0 .05 3l-2.05 1.55 2 3.45L7 17.5a8 8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8 8 0 0 0 2.6-1.5l2.45 1 2-3.45-2.05-1.55Z"
  ]
};

/**
 * One named icon, sized and coloured by CSS.
 *
 * Built as nodes rather than injected as markup, so an icon stays subject to
 * the same no-innerHTML rule as everything else in this module. Decorative by
 * construction: every icon button carries its own `aria-label`.
 */
export function icon(name) {
  const paths = ICON_PATHS[name];
  if (!paths) throw new Error(`Unknown icon: ${name}`);
  return svgEl("svg", {
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8,
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false"
  }, paths.map((d) => svgEl("path", { d })));
}

/** Clears a container and appends fresh children in one step. */
export function replace(container, children) {
  container.replaceChildren(...(Array.isArray(children) ? children.filter(Boolean) : [children].filter(Boolean)));
  return container;
}

const RELATIVE_UNITS = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000]
];

/**
 * A coarse "N units ago" without pulling in Intl.RelativeTimeFormat data the
 * sandbox may not ship a locale for. Falls back to "just now" under a
 * minute — good enough for "Checked 2 min ago" / a card's timestamp.
 */
const RELATIVE_UNITS_ZH = { year: "年", month: "個月", week: "星期", day: "日", hour: "小時", minute: "分鐘" };

/**
 * "3 days ago" / "3 日前", from one place.
 *
 * This phrasing existed three times over — twice in collection.js and once
 * more the moment the drawer wanted a timestamp. Three copies of a plural
 * rule is three chances for one of them to drift.
 */
export function relativeLabel(locale, iso, now = Date.now()) {
  const rel = relativeTimeFrom(iso, now);
  if (!rel) return null;
  if (locale === "zh-HK") return `${rel.amount} ${RELATIVE_UNITS_ZH[rel.unit]}前`;
  return `${rel.amount} ${rel.unit}${rel.amount === 1 ? "" : "s"} ago`;
}

export function relativeTimeFrom(iso, now = Date.now()) {
  if (typeof iso !== "string" || !iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const diff = Math.max(0, now - then);
  for (const [unit, ms] of RELATIVE_UNITS) {
    const amount = Math.floor(diff / ms);
    if (amount >= 1) return { unit, amount };
  }
  return { unit: "minute", amount: 0 };
}
