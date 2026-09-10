// Card-first inbox projections. This module deliberately keeps source rows
// and localization batches separate: one source may have many historical
// batches, and inspecting a batch must never create another one.
import { el } from "./dom.js";
import { t } from "./i18n.js";

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
      rightsStatus: item.rightsStatus ?? "unknown",
      state: item.state ?? "unknown",
      approval: item.approval ?? null
    }))
  };
}

export function isEditableItem(item) {
  return ["drafting", "held_rights", "expired"].includes(item?.state);
}

export function drawerAction(item) {
  if (!item) return { kind: "unavailable", label: "Unavailable" };
  if (isEditableItem(item)) return { kind: "resume", label: "Continue editing" };
  if (item.state === "submitted" || item.state === "awaiting_approval") return { kind: "approval", label: "Open existing approval" };
  if (item.state === "scheduled") return { kind: "schedule", label: "View canonical schedule" };
  if (["failed", "unknown", "held"].includes(item.state)) return { kind: "outcome", label: "Review canonical outcome" };
  return { kind: "unavailable", label: "Unavailable" };
}

export function renderInbox(root, state, ctx) {
  const { locale, handlers } = ctx;
  const totals = state.totals ?? {};
  const filters = [
    ["all", t(locale, "inboxAll"), totals.batches], ["drafts", t(locale, "inboxDrafts"), totals.drafts],
    ["review", t(locale, "inboxReview"), totals.review], ["scheduled", t(locale, "inboxScheduled"), totals.scheduled], ["attention", t(locale, "inboxAttention"), totals.attention]
  ];
  const cards = visibleBatchSummaries(state).map((batch) => {
    // Saved work is independent of the currently filtered/paged source list.
    const preview = batch.preview;
    return el("article", { class: "sl-inbox-card", tabindex: "0" }, [
    el("div", { class: "sl-inbox-card-meta" }, [el("span", null, preview?.sourceLabel || t(locale, "drawerSavedWork")), el("span", null, t(locale, "inboxItemCount", { n: batch.itemCount }))]),
    el("div", { class: "sl-inbox-thumb" }, t(locale, preview?.hasMediaReference ? "inboxMediaSaved" : "inboxMediaUnavailable")),
    el("strong", null, batch.draftCount ? t(locale, "inboxDrafts") : batch.reviewCount ? t(locale, "inboxReview") : batch.scheduledCount ? t(locale, "inboxScheduled") : batch.attentionCount ? t(locale, "inboxAttention") : t(locale, "inboxAll")),
    el("p", null, preview?.caption ?? preview?.sourceText ?? t(locale, "inboxNoSource")),
    el("span", { class: "sl-field-note" }, Number.isInteger(preview?.revision) ? t(locale, "drawerRevision", { n: preview.revision }) : t(locale, "inboxNoSavedRevision")),
    batch.itemCount > 1 ? el("span", { class: "sl-field-note" }, t(locale, "inboxRepresentative")) : null,
    el("p", { class: "sl-field-note" }, batch.lastUpdatedAt ? new Date(batch.lastUpdatedAt).toLocaleString(locale) : ""),
    el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onInspectBatch(batch) }, t(locale, "inboxInspect"))
  ]); });
  root.appendChild(el("section", { class: "sl-inbox", "aria-label": t(locale, "appTitle") }, [
    el("div", { class: "sl-inbox-tabs", role: "group", "aria-label": t(locale, "inboxAll") }, filters.map(([key, label, count]) => el("button", { type: "button", "aria-pressed": String(state.filter === key), class: state.filter === key ? "sl-filter-active" : "", onclick: () => handlers.onInboxFilter(key) }, `${label}${typeof count === "number" && count > 0 ? ` ${count}` : ""}`))),
    cards.length ? el("div", { class: "sl-inbox-grid" }, cards) : state.loading ? el("p", { class: "sl-field-note", role: "status" }, t(locale, "loading")) : null,
    state.nextCursor ? el("button", { type: "button", class: "sl-secondary", onclick: handlers.onLoadMoreBatches }, t(locale, "inboxLoadMore")) : null,
    state.error ? el("p", { class: "sl-wizard-error", role: "alert" }, state.error) : null
  ]));
}
