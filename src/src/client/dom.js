// Social Localization client — tiny DOM helpers shared by every view module.
//
// Nothing here talks to the gadget RPC or holds state; it exists so
// collection.js, steps.js and client.js build markup the same way instead of
// each inventing its own createElement wrapper. Untrusted source content
// (captions, handles, provider messages — SEC-003) always goes through
// `text()` or the `textContent` a caller sets itself; nothing in this module
// ever parses a string as HTML.

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
