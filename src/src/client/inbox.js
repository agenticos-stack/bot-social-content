// Card-first inbox projections. This module deliberately keeps source rows
// and localization batches separate: one source may have many historical
// batches, and inspecting a batch must never create another one.
import { el } from "./dom.js";
import { t } from "./i18n.js";
import { fillCovers, providerGlyph, renderPostCard, sourceLabel } from "./post-card.js";

export const INBOX_FILTERS = Object.freeze(["all", "new", "drafts", "review", "scheduled", "attention"]);

export function createInboxState() {
  return { filter: "all", summaries: [], sourceItems: [], nextCursor: null, totals: null, loading: false, drawer: null, error: null };
}

export function setInboxSourceItems(state, sourceItems) {
  return { ...state, sourceItems: Array.isArray(sourceItems) ? sourceItems : [] };
}
export function setInboxLoading(state, loading) { return { ...state, loading }; }

export function setInboxSummaries(state, page, append = false) {
  const incoming = Array.isArray(page?.batches) ? page.batches : [];
  return {
    ...state,
    summaries: append ? [...state.summaries, ...incoming].filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index) : incoming,
    nextCursor: page?.nextCursor ?? null,
    totals: page?.totals ?? state.totals,
    loading: false,
    error: null
  };
}

export function setInboxFilter(state, filter) {
  return INBOX_FILTERS.includes(filter) ? { ...state, filter } : state;
}

export function visibleBatchSummaries(state) {
  const key = {
    all: () => true,
    // New is a source-post facet, not a saved-batch state. Keeping it empty
    // here prevents a draft from being counted twice in the two domains.
    new: () => false,
    drafts: (b) => b.draftCount > 0,
    review: (b) => b.reviewCount > 0,
    scheduled: (b) => b.scheduledCount > 0,
    attention: (b) => b.attentionCount > 0
  }[state.filter] || (() => true);
  return state.summaries.filter(key);
}

export function groupSourcesWithBatches(items, summaries) {
  const bySource = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!bySource.has(item.id)) bySource.set(item.id, { source: item, batches: [] });
  }
  // Summaries intentionally carry no mutable source content. The full batch
  // is fetched only after the owner chooses Continue editing in the drawer.
  const linked = new Map();
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    for (const sourceId of summary.sourceItemIds ?? []) {
      const list = linked.get(sourceId) ?? [];
      list.push(summary);
      linked.set(sourceId, list);
    }
  }
  return [...bySource.values()].map((entry) => ({ ...entry, summaries: linked.get(entry.source.id) ?? [] }));
}

export function drawerProjection(batch, sourceItem) {
  if (!batch) return null;
  const items = Array.isArray(batch.items) ? batch.items : [];
  return {
    batchId: batch.id,
    createdAt: batch.createdAt ?? null,
    source: sourceItem ?? items[0]?.sourceItem ?? null,
    items: items.map((item) => ({
      id: item.id,
      sourceItem: item.sourceItem ?? null,
      revision: item.revision ?? 0,
      caption: item.caption ?? null,
      posterLayout: item.posterLayout ?? null,
      destinationBindings: Array.isArray(item.destinationBindings) ? item.destinationBindings.slice() : [],
      // Where this draft was sent — one row per (destination, revision)
      // filing, `bound` included for destinations recorded but never sent.
      publications: Array.isArray(item.publications) ? item.publications.map((pub) => ({ ...pub })) : [],
      state: item.state ?? "unknown",
      approval: item.approval ?? null
    }))
  };
}

export function isEditableItem(item) {
  return ["drafting", "expired"].includes(item?.state);
}

export function drawerAction(item) {
  if (!item) return { kind: "unavailable", label: "Unavailable" };
  if (isEditableItem(item)) return { kind: "resume", label: "Continue editing" };
  if (item.state === "submitted" || item.state === "awaiting_approval") return { kind: "approval", label: "Open existing approval" };
  if (item.state === "scheduled") return { kind: "schedule", label: "View canonical schedule" };
  if (["failed", "unknown", "held"].includes(item.state)) return { kind: "outcome", label: "Review canonical outcome" };
  return { kind: "unavailable", label: "Unavailable" };
}

/**
 * The state chip a Content card carries. Order is deliberate: outcome states
 * first (they're past drafting), then queued (a generation-requested batch
 * with nothing saved yet), then drafting as the in-progress default.
 */
function itemChip(locale, batch, item) {
  if (["submitted", "awaiting_approval"].includes(item.state)) return { label: t(locale, "stateSubmitted"), cls: "sl-chip-submitted" };
  if (item.state === "scheduled") return { label: t(locale, "stateScheduled"), cls: "sl-chip-scheduled" };
  if (["failed", "held", "unknown"].includes(item.state)) return { label: t(locale, "stateAttention"), cls: "sl-chip-attention" };
  // The mark is the state: a requested batch is queued for the agent's next
  // turn whether its items carry an earlier draft (re-armed by Regenerate)
  // or none yet (fresh from Continue).
  if (batch.generation === "requested") return { label: t(locale, "stateQueued"), cls: "sl-chip-queued" };
  return { label: t(locale, "stateDrafting"), cls: "sl-chip-drafting" };
}

/**
 * One Content card per batch ITEM — the same `sl-post` shape Sources uses
 * (shared `renderPostCard`), carrying the drafted caption when one exists
 * and the source caption marked as such otherwise. Everything beyond the
 * scan — revision history, publications, issues — stays in
 * the drawer behind Inspect.
 */
function itemCard(locale, batch, item, ctx, covers) {
  const snapshot = item.caption ?? item.sourceText ?? "";
  return renderPostCard(locale, {
    key: item.batchItemId,
    onOpen: () => ctx.handlers.onInspectBatch(batch),
    ariaLabel: snapshot.slice(0, 80) || t(locale, "inboxInspect"),
    cover: item.coverMediaId ? { itemId: item.itemId, mediaId: item.coverMediaId } : null,
    glyph: providerGlyph({ provider: item.provider, sourceBinding: item.sourceBinding }, ctx.sources),
    glyphKey: null,
    kicker: item.sourceLabel || t(locale, "drawerSavedWork"),
    title: snapshot.split("\n")[0].slice(0, 90) || t(locale, "inboxNoSource"),
    body: snapshot,
    chip: itemChip(locale, batch, item),
    meta: el("span", { class: "sl-meta" }, [
      el("span", null, item.caption ? t(locale, "inboxSnapshotDraft") : t(locale, "inboxSnapshotSource")),
      el("span", null, (item.revision ?? 0) > 0 ? t(locale, "drawerRevision", { n: item.revision }) : t(locale, "inboxNoSavedRevision"))
    ])
  }, covers);
}

export function renderInbox(root, state, ctx) {
  const { locale, handlers, loadCover } = ctx;
  const covers = [];
  const totals = state.totals ?? {};
  const filters = [
    ["all", t(locale, "inboxAll"), totals.batches], ["drafts", t(locale, "inboxDrafts"), totals.drafts],
    ["review", t(locale, "inboxReview"), totals.review], ["scheduled", t(locale, "inboxScheduled"), totals.scheduled], ["attention", t(locale, "inboxAttention"), totals.attention]
  ];
  const cards = visibleBatchSummaries(state).flatMap((batch) => {
    const items = Array.isArray(batch.items) ? batch.items : [];
    // A summary built before the items projection (or an empty batch) still
    // gets a card — the batch row itself, same post shape, no cover.
    return items.length
      ? items.map((item) => itemCard(locale, batch, item, ctx, covers))
      : [renderPostCard(locale, {
          key: batch.id,
          onOpen: () => handlers.onInspectBatch(batch),
          ariaLabel: t(locale, "inboxInspect"),
          cover: null,
          glyph: "•",
          kicker: batch.preview?.sourceLabel || t(locale, "drawerSavedWork"),
          title: (batch.preview?.caption ?? batch.preview?.sourceText ?? "").split("\n")[0].slice(0, 90) || t(locale, "inboxNoSource"),
          body: batch.preview?.caption ?? batch.preview?.sourceText ?? "",
          chip: null,
          meta: el("span", { class: "sl-meta" }, [
            el("span", null, batch.preview?.caption ? t(locale, "inboxSnapshotDraft") : t(locale, "inboxSnapshotSource")),
            el("span", null, Number.isInteger(batch.preview?.revision) ? t(locale, "drawerRevision", { n: batch.preview.revision }) : t(locale, "inboxNoSavedRevision"))
          ])
        }, covers)];
  });
  root.appendChild(el("section", { class: "sl-inbox", "aria-label": t(locale, "appTitle") }, [
    el("div", { class: "sl-inbox-tabs", role: "group", "aria-label": t(locale, "inboxAll") }, filters.map(([key, label, count]) => el("button", { type: "button", "aria-pressed": String(state.filter === key), class: state.filter === key ? "sl-filter-active" : "", onclick: () => handlers.onInboxFilter(key) }, `${label}${typeof count === "number" && count > 0 ? ` ${count}` : ""}`))),
    cards.length ? el("div", { class: "sl-inbox-grid" }, cards) : state.loading ? el("p", { class: "sl-field-note", role: "status" }, t(locale, "loading")) : null,
    state.nextCursor ? el("button", { type: "button", class: "sl-secondary", onclick: handlers.onLoadMoreBatches }, t(locale, "inboxLoadMore")) : null,
    state.error ? el("p", { class: "sl-wizard-error", role: "alert" }, state.error) : null
  ]));
  if (typeof loadCover === "function") fillCovers(covers, loadCover);
}
