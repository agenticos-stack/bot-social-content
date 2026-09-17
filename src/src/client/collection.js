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

import { el, relativeLabel, relativeTimeFrom, replace } from "./dom.js";
import { t } from "./i18n.js";
import { fillCovers, glyphKeyFor, providerGlyph, renderPostCard, sourceLabel } from "./post-card.js";
import {
  createCollectionState as createSharedCollectionState,
  setNotice,
  clearNotice,
  setItems,
  setLoading,
  setSearch,
  setSourceFilter,
  applySelection,
  clearSelection,
  markSeenLocally,
  mergeScanResult,
  setLastCheckedAt,
  selectedIds,
  selectedCount,
  newCount,
  findItem,
  setFilter as setSharedFilter,
  visibleItems as visibleSharedItems
} from "@agenticos-dev/bot-shell/client/collection.js";

// ---------------------------------------------------------------------------
// Pure state — filters, selection, search; independent of each other by
// construction (REQ-006: the checkbox and the card body change different
// things, and nothing here couples them). The reducers are the shared
// package's; what stays local is this canvas's filter vocabulary and what a
// card is searchable by.
// ---------------------------------------------------------------------------

const FILTERS = ["new", "all"];

export function createCollectionState() {
  // items: SourceItem & { seen, selected, duplicateOf? }, as returned by listItems();
  // filter: "new" | "all"; sourceFilter: a sourceBinding, or null for every
  // granted source. `notice` is { message, actionLabel? } — a refusal the
  // collection's own action came back with, rendered above the tray;
  // `handlers.onNoticeAction` runs the way forward.
  return createSharedCollectionState();
}

export function setFilter(state, filter) {
  return setSharedFilter(state, filter, FILTERS);
}

/** The filter/search/chip-narrowed list a card grid actually renders. */
export function visibleItems(state) {
  return visibleSharedItems(state, {
    searchable: (item) => `${item.text || ""} ${item.sourceLabel || ""} ${item.authorHandle || ""}`
  });
}

export {
  setNotice,
  clearNotice,
  setItems,
  setLoading,
  setSearch,
  setSourceFilter,
  applySelection,
  clearSelection,
  markSeenLocally,
  mergeScanResult,
  setLastCheckedAt,
  selectedIds,
  selectedCount,
  newCount,
  findItem
};

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
  wrap.appendChild(el("span", null, relativeLabel(locale, item.publishedAt) || ""));
  const likes = item.metrics && typeof item.metrics.likes === "number" ? item.metrics.likes : null;
  wrap.appendChild(
    likes === null
      ? el("span", { class: "sl-meta-unavail" }, t(locale, "metricsUnavailable"))
      : el("span", null, likes.toLocaleString(locale === "zh-HK" ? "zh-HK" : "en-US"))
  );
  return wrap;
}

/**
 * Which media a card's cover comes from, or null when it has none.
 */
function coverMediaId(item) {
  const media = Array.isArray(item?.media) ? item.media[0] : null;
  return media && media.id !== undefined && media.id !== null ? String(media.id) : null;
}

function renderCard(locale, item, handlers, sources, covers) {
  return renderPostCard(locale, {
    key: item.id,
    selectable: true,
    selected: !!item.selected,
    onSelect: (checked) => handlers.onSelect(item.id, checked),
    onOpen: () => handlers.onOpen(item),
    ariaLabel: item.text ? item.text.slice(0, 80) : "Preview post",
    cover: coverMediaId(item) ? { itemId: item.id, mediaId: coverMediaId(item) } : null,
    glyphKey: glyphKeyFor(item, sources),
    glyph: providerGlyph(item, sources),
    kicker: sourceLabel(locale, item),
    title: item.text ? item.text.split("\n")[0].slice(0, 90) : item.sourceLabel || "",
    body: item.text || "",
    meta: metaLine(locale, item),
    badge: item.duplicateOf ? t(locale, "duplicateNote") : null
  }, covers);
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
  const { locale, summary, handlers, loadCover } = ctx;
  const covers = [];
  const items = visibleItems(state);
  const nSelected = selectedCount(state);
  // Zero draftable is not shown as "Draft 0 posts" — every selected post
  // being taken is the duplicate-refusal case, where the button still says
  // the selected count because that click goes to the new-version opt-in.
  const nDraft = nSelected === 0 ? 0 : (ctx.draftableCount ?? nSelected) || nSelected;
  // UNKNOWN IS NOT ZERO. Before `summary()` resolves there is no destination
  // list, and treating that as "none configured" would flash a setup prompt at
  // every owner on every load and then take it back.

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
        "aria-pressed": String(state.filter === "new"),
        onclick: () => handlers.onFilter("new")
      },
      [t(locale, "filterNew"), el("span", { class: "sl-filter-count" }, String(nNew))]
    ),
    el(
      "button",
      { type: "button", class: `sl-filter-btn${state.filter === "all" ? " sl-filter-active" : ""}`, "aria-pressed": String(state.filter === "all"), onclick: () => handlers.onFilter("all") },
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
      items.map((item) => renderCard(locale, item, handlers, sources, covers))
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
      /*
       * Continue is always offered — drafting is `generate` and needs no
       * destination (TASK-015). This used to gate on `summary.destinations`
       * and swap in a "configure a destination first" button, which made the
       * `send` target a precondition for the `generate` work it is chosen
       * for. Where the draft goes is picked on the Publish step; an empty
       * destination list is that step's problem to state, not this one's.
       */
      el(
        "button",
        // Brand gold, not primary ink: drafting a batch is the one creation
        // call-to-action on this screen (the component study's `brand`).
        { type: "button", class: "sl-brand", disabled: nSelected === 0, onclick: handlers.onContinue },
        nSelected
          // One agent turn drafts the whole batch — and the count on the
          // action is the DRAFTABLE count, not the selected one (PM decision
          // 5, corrected): posts already in an open draft are skipped by
          // `continueWithSelection`, so the button says what the batch will
          // actually hold. All-taken selections keep the selected count —
          // that click reaches the duplicate refusal and its new-version opt-in.
          ? t(locale, nDraft === 1 ? "draftPost" : "draftPosts", { n: nDraft })
          : t(locale, "continueSelectPrompt")
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

  /*
   * Fill the covers after the grid is on screen, never before it.
   *
   * Each is a separate round trip for cached bytes, so awaiting fifteen of
   * them up front would trade a grid that draws immediately for one that
   * appears all at once, later. A card that never gets its cover keeps the
   * provider glyph it already had, which is what a source with no media —
   * or no fetch door — looks like anyway.
   */
  if (typeof loadCover === "function") fillCovers(covers, loadCover);
}

// Covers draw a few at a time via `fillCovers` (post-card.js) — bounded by
// the host's call pool, shared with the Content grid so both tabs fill the
// same way.

function renderInboxInto(root, state, ctx) {
  // Kept as an injected renderer to avoid making collection state own saved
  // batch state. The archive entry supplies renderInbox on ctx.
  ctx.renderInbox?.(root, state, ctx);
}
