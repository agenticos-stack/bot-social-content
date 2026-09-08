// Social Localization client — the generic "watch, notify, act" collection
// (PAT-003). Cards, filters, provider/account chips, search, the sticky
// selection tray, empty/loading states and the New badge live here as a
// single module so the next blueprint of this shape packs the same file
// with a different action module in place of steps.js.
//
// State is plain, immutable-update data — no DOM, no RPC — so the reducer
// half of this module is unit-testable in node (see
// tests/social-localization-client.test.ts). The render half below it is
// imperative DOM building that a smoke test exercises with a fake `gadget`.

import { el, replace, relativeTimeFrom } from "./dom.js";
import { t } from "./i18n.js";

// ---------------------------------------------------------------------------
// Pure state — filters, selection, search; independent of each other by
// construction (REQ-006: the checkbox and the card body change different
// things, and nothing here couples them).
// ---------------------------------------------------------------------------

export function createCollectionState() {
  return {
    items: [], // SourceItem & { seen, selected, duplicateOf? }, as returned by listItems()
    filter: "new", // "new" | "all"
    search: "",
    sourceFilter: null, // a sourceBinding, or null for every granted source
    nextCursor: null,
    loading: false,
    lastCheckedAt: null,
    // A refusal the collection's own action came back with, rendered above
    // the tray. Generic on purpose (PAT-003): any "watch, notify, act"
    // collection can have its Continue refused, and the only thing this
    // module knows about one is that it has a message and may offer the
    // caller a single way forward.
    notice: null // { message, actionLabel? } — `handlers.onNoticeAction` runs the way forward
  };
}

/** Shows a refusal (or any one-line message) above the tray, with an optional single action. */
export function setNotice(state, notice) {
  if (!notice || typeof notice.message !== "string" || !notice.message) return { ...state, notice: null };
  return {
    ...state,
    notice: { message: notice.message, actionLabel: typeof notice.actionLabel === "string" ? notice.actionLabel : null }
  };
}

export function clearNotice(state) {
  return state.notice ? { ...state, notice: null } : state;
}

/** Replaces (or appends, for pagination) the item list after a listItems() fetch. */
export function setItems(state, { items, nextCursor = null, append = false }) {
  return {
    ...state,
    items: append ? state.items.concat(items) : items.slice(),
    nextCursor,
    loading: false
  };
}

export function setLoading(state, loading) {
  return { ...state, loading };
}

export function setFilter(state, filter) {
  return filter === "all" || filter === "new" ? { ...state, filter } : state;
}

export function setSearch(state, search) {
  return { ...state, search: typeof search === "string" ? search : "" };
}

/** Clicking an already-active chip clears the filter — same toggle behaviour as the mockup's provider chips. */
export function setSourceFilter(state, sourceBinding) {
  return { ...state, sourceFilter: state.sourceFilter === sourceBinding ? null : sourceBinding };
}

/** The checkbox alone changes selection (REQ-006) — never coupled to opening the preview. */
export function applySelection(state, id, selected) {
  return { ...state, items: state.items.map((item) => (item.id === id ? { ...item, selected } : item)) };
}

export function clearSelection(state) {
  return { ...state, items: state.items.map((item) => (item.selected ? { ...item, selected: false } : item)) };
}

export function markSeenLocally(state, ids) {
  const seen = new Set(ids);
  return { ...state, items: state.items.map((item) => (seen.has(item.id) ? { ...item, seen: true } : item)) };
}

/**
 * Merges a fresh page of items — typically a refetch after a live
 * `operation({type:"scan"})` event — into the current list, WITHOUT losing
 * an in-flight local selection. The server is authoritative for `selected`
 * at initial load; after that, a `setSelection()` call may be racing ahead
 * of a slower scan refetch, so an item already known locally keeps its local
 * flag rather than being clobbered back to whatever the scan snapshot says.
 */
export function mergeScanResult(state, items) {
  const localSelection = new Map(state.items.map((item) => [item.id, item.selected]));
  const merged = items.map((item) =>
    localSelection.has(item.id) ? { ...item, selected: localSelection.get(item.id) } : item
  );
  return { ...state, items: merged, loading: false };
}

export function setLastCheckedAt(state, iso) {
  return { ...state, lastCheckedAt: iso };
}

export function selectedIds(state) {
  return state.items.filter((item) => item.selected).map((item) => item.id);
}

export function selectedCount(state) {
  return state.items.reduce((count, item) => count + (item.selected ? 1 : 0), 0);
}

/** REQ-014's "N new posts" count — unseen items, independent of the active filter/search. */
export function newCount(state) {
  return state.items.reduce((count, item) => count + (item.seen ? 0 : 1), 0);
}

export function findItem(state, id) {
  return state.items.find((item) => item.id === id) || null;
}

/** The filter/search/chip-narrowed list a card grid actually renders. */
export function visibleItems(state) {
  let items = state.filter === "new" ? state.items.filter((item) => !item.seen) : state.items;
  if (state.sourceFilter) items = items.filter((item) => item.sourceBinding === state.sourceFilter);
  const query = state.search.trim().toLowerCase();
  if (query) {
    items = items.filter((item) => {
      const haystack = `${item.text || ""} ${item.sourceLabel || ""} ${item.authorHandle || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Rendering — imperative DOM, using the host's closed theme tokens
// (gadget-sandbox-html.ts GadgetThemeTokens) with plain fallbacks so the
// gadget still reads correctly the one time no `theme` was supplied.
// ---------------------------------------------------------------------------

function formatChecked(locale, iso) {
  if (!iso) return t(locale, "checkedNever");
  const rel = relativeTimeFrom(iso);
  if (!rel) return t(locale, "checkedNever");
  const unitLabel =
    locale === "zh-HK"
      ? { year: "年", month: "個月", week: "星期", day: "日", hour: "小時", minute: "分鐘" }[rel.unit]
      : rel.unit + (rel.amount === 1 ? "" : "s");
  const time =
    rel.amount === 0
      ? locale === "zh-HK"
        ? "剛剛"
        : "just now"
      : locale === "zh-HK"
        ? `${rel.amount} ${unitLabel}前`
        : `${rel.amount} ${unitLabel} ago`;
  return t(locale, "checkedAt", { time });
}

function metaLine(locale, item) {
  const wrap = el("span", { class: "sl-meta" });
  const time = relativeTimeFrom(item.publishedAt);
  wrap.appendChild(
    el(
      "span",
      null,
      time
        ? locale === "zh-HK"
          ? `${time.amount} ${{ year: "年", month: "個月", week: "星期", day: "日", hour: "小時", minute: "分鐘" }[time.unit]}前`
          : `${time.amount} ${time.unit}${time.amount === 1 ? "" : "s"} ago`
        : ""
    )
  );
  const likes = item.metrics && typeof item.metrics.likes === "number" ? item.metrics.likes : null;
  wrap.appendChild(
    likes === null
      ? el("span", { class: "sl-meta-unavail" }, t(locale, "metricsUnavailable"))
      : el("span", null, likes.toLocaleString(locale === "zh-HK" ? "zh-HK" : "en-US"))
  );
  return wrap;
}

function renderCard(locale, item, handlers, sources) {
  const checkboxId = `sl-check-${item.id}`;
  const checkbox = el("input", {
    type: "checkbox",
    id: checkboxId,
    class: "sl-post-check",
    checked: !!item.selected,
    "aria-label": item.text ? item.text.slice(0, 80) : item.sourceLabel || "source post",
    onchange: (event) => handlers.onSelect(item.id, event.currentTarget.checked)
  });
  const selectbox = el("label", { class: "sl-selectbox", for: checkboxId }, [checkbox]);

  const openButton = el(
    "button",
    { type: "button", class: "sl-post-open", "aria-label": item.text ? item.text.slice(0, 80) : "Preview post", onclick: () => handlers.onOpen(item) },
    [
      el("span", { class: "sl-media" }, [
        el("span", { class: "sl-provider-glyph", "data-glyph": glyphKeyFor(item, sources) || "" }, providerGlyph(item, sources)),
        el("span", { class: "sl-media-kicker" }, sourceLabel(locale, item))
      ]),
      el("span", { class: "sl-post-body" }, [
        el("strong", null, item.text ? item.text.split("\n")[0].slice(0, 90) : item.sourceLabel || ""),
        el("p", null, item.text || ""),
        metaLine(locale, item)
      ])
    ]
  );

  const card = el("article", { class: "sl-post" }, [
    selectbox,
    openButton,
    item.duplicateOf ? el("span", { class: "sl-duplicate-badge" }, t(locale, "duplicateNote")) : null
  ]);
  card.classList.toggle("sl-post-selected", !!item.selected);
  return card;
}

/** The `glyphKey` the door reported for the source binding this item came from, or null when it reported none. */
function glyphKeyFor(item, sources) {
  const source = Array.isArray(sources) ? sources.find((row) => row.binding === item.sourceBinding) : null;
  return typeof source?.glyphKey === "string" && source.glyphKey.trim() ? source.glyphKey.trim() : null;
}

/**
 * REQ-016 — the mark comes from the glyph key the DOOR reports, never from a
 * table of providers kept here.
 *
 * A hardcoded `instagram -> "IG", facebook -> "FB"` is a second copy of the
 * provider registry living where it cannot see the registry change: the day
 * a third provider is pinned, this file silently renders a bullet for it and
 * nobody finds out until someone looks at the screen. The key is also set as
 * `data-glyph`, so a real brand mark can be styled per provider without this
 * function learning any provider's name.
 *
 * The provider fallback stays for the one case the requirement allows: a door
 * that reported nothing at all.
 */
function providerGlyph(item, sources) {
  const glyphKey = glyphKeyFor(item, sources);
  if (glyphKey) return glyphKey.slice(0, 2).toUpperCase();
  return item.provider === "instagram" ? "IG" : item.provider === "facebook" ? "FB" : "•";
}

function sourceLabel(locale, item) {
  return item.sourceLabel || (item.provider === "instagram" ? t(locale, "providerInstagram") : t(locale, "providerFacebook"));
}

function renderChip(locale, source, active, onToggle) {
  const degraded = source.lastOutcome && source.lastOutcome !== "confirmed";
  const parts = [source.label || sourceLabel(locale, { provider: source.provider })];
  if (degraded && source.message) parts.push(source.message);
  const chip = el(
    "button",
    {
      type: "button",
      class: `sl-chip${degraded ? " sl-chip-degraded" : ""}${active ? " sl-chip-active" : ""}`,
      "aria-pressed": String(active),
      onclick: onToggle
    },
    [el("span", { class: "sl-chip-dot" }), el("span", null, parts.join(" — "))]
  );
  return chip;
}

/**
 * Mounts the full step-1 collection view into `root`. `handlers` supplies
 * every side effect (RPC calls, opening the preview, navigating to step 2);
 * this function only builds and updates markup from `state`.
 */
export function renderCollection(root, state, ctx) {
  const { locale, summary, handlers } = ctx;
  const items = visibleItems(state);
  const nSelected = selectedCount(state);
  const nNew = newCount(state);

  const searchInput = el("input", {
    type: "search",
    class: "sl-search-input",
    value: state.search,
    placeholder: t(locale, "searchPlaceholder"),
    "aria-label": t(locale, "searchLabel"),
    oninput: (event) => handlers.onSearch(event.currentTarget.value)
  });

  const toolbar = el("div", { class: "sl-toolbar" }, [
    el("label", { class: "sl-search" }, [searchInput]),
    el(
      "button",
      {
        type: "button",
        class: `sl-filter-btn${state.filter === "new" ? " sl-filter-active" : ""}`,
        onclick: () => handlers.onFilter("new")
      },
      [t(locale, "filterNew"), " ", el("small", null, String(nNew))]
    ),
    el(
      "button",
      { type: "button", class: `sl-filter-btn${state.filter === "all" ? " sl-filter-active" : ""}`, onclick: () => handlers.onFilter("all") },
      t(locale, "filterAll")
    ),

  ]);

  const sources = Array.isArray(summary?.sources) ? summary.sources : [];
  const chipRow = el(
    "div",
    { class: "sl-chip-row", "aria-label": "Provider and account filters" },
    // `summary().sources` rows carry `binding` — the same name `describeRows`
    // writes on the server and the same one line 231 reads to resolve an
    // item's source. Reading `sourceBinding` here (the name items use, not
    // sources) passed `undefined` to both arguments, so every chip rendered
    // inactive and clicking one set the filter to `undefined`, which
    // `renderCollection`'s `if (state.sourceFilter)` then treats as no filter
    // at all: the control did nothing, silently, in every state.
    sources.map((source) =>
      renderChip(locale, source, state.sourceFilter === source.binding, () => handlers.onSourceFilter(source.binding))
    )
  );

  let body;
  if (state.loading && !state.items.length) {
    body = el("div", { class: "sl-empty" }, [el("p", null, t(locale, "loadingPosts"))]);
  } else if (!items.length) {
    const filtered = state.search || state.sourceFilter || state.filter === "new";
    body = el("div", { class: "sl-empty" }, [
      el("strong", null, t(locale, filtered ? "emptyFilteredTitle" : "emptyTitle")),
      el("p", null, t(locale, filtered ? "emptyFilteredDesc" : "emptyDesc"))
    ]);
  } else {
    body = el(
      "div",
      { class: "sl-collection" },
      items.map((item) => renderCard(locale, item, handlers, sources))
    );
  }

  const notice = state.notice
    ? el("div", { class: "sl-notice", role: "status" }, [
        el("p", null, state.notice.message),
        state.notice.actionLabel
          ? el(
              "button",
              { type: "button", class: "sl-notice-action", onclick: () => handlers.onNoticeAction && handlers.onNoticeAction() },
              state.notice.actionLabel
            )
          : null,
        el(
          "button",
          { type: "button", class: "sl-notice-dismiss", "aria-label": t(locale, "dismiss"), onclick: () => handlers.onNoticeDismiss && handlers.onNoticeDismiss() },
          "\u00d7"
        )
      ])
    : null;

  const tray = el("footer", { class: "sl-selection" }, [
    el("div", { class: "sl-selection-inner" }, [
      el("div", { class: "sl-selected-copy" }, [
        el("strong", null, t(locale, "selectedCount", { n: nSelected })),
      ]),
      el("button", { type: "button", class: "sl-clear", onclick: handlers.onClear }, t(locale, "clear")),
      el(
        "button",
        { type: "button", class: "sl-primary", disabled: nSelected === 0, onclick: handlers.onContinue },
        nSelected ? t(locale, "continueWithPosts", { n: nSelected }) : t(locale, "continueSelectPrompt")
      )
    ])
  ]);

  replace(root, [
    ctx.inboxState ? (() => { const host = el("div"); renderInboxInto(host, ctx.inboxState, ctx); return host; })() : null,
    el("div", { class: "sl-titleline" }, [el("h1", null, t(locale, "collectionTitle"))]),
    toolbar,
    chipRow,
    body,
    notice,
    tray
  ]);
}

function renderInboxInto(root, state, ctx) {
  // Kept as an injected renderer to avoid making collection state own saved
  // batch state. The archive entry supplies renderInbox on ctx.
  ctx.renderInbox?.(root, state, ctx);
}
