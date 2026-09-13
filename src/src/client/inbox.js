// Card-first inbox projections. This module deliberately keeps source rows
// and localization batches separate: one source may have many historical
// batches, and inspecting a batch must never create another one.
//
// Post-audit §9: the Content card IS a post (one batch item). Its chip,
// filter membership, count and drawer all read the shared `itemPresentation`
// roll-up from `model.js` — one policy, so a filed or published item can
// never fall through to "drafting" again.
import { itemPresentation, PHASE_FILTERS } from "../../model.js";
import { el, relativeLabel } from "./dom.js";
import { t } from "./i18n.js";
import { fillCovers, providerGlyph, renderPostCard, sourceLabel } from "./post-card.js";

export const INBOX_FILTERS = Object.freeze(["all", "new", "drafts", "review", "scheduled", "attention"]);

export function createInboxState() {
  return {
    filter: "all",
    summaries: [],
    sourceItems: [],
    nextCursor: null,
    totals: null,
    loading: false,
    drawer: null,
    error: null,
    notice: null,
    // §9.C — Content selection is on batch-ITEM ids (the post), not source
    // items and not batches: `{ [batchItemId]: { batchId, itemId, revision } }`.
    // `revision` is the revision observed at select time, refreshed as
    // summaries land; eligibility is re-read before any review.
    selected: {}
  };
}

export function setInboxSourceItems(state, sourceItems) {
  return { ...state, sourceItems: Array.isArray(sourceItems) ? sourceItems : [] };
}
export function setInboxLoading(state, loading) { return { ...state, loading }; }

export function setInboxNotice(state, notice) {
  return { ...state, notice: notice ?? null };
}

export function setInboxSummaries(state, page, append = false) {
  const incoming = Array.isArray(page?.batches) ? page.batches : [];
  const summaries = append
    ? [...state.summaries, ...incoming].filter(
        (row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index
      )
    : incoming;
  // Refresh the observed revision of anything already selected — a post
  // that moved on since its selection is re-validated at review time, so
  // the dock count stays truthful instead of silently going stale.
  const selected = { ...state.selected };
  for (const batch of summaries) {
    for (const item of batch.items ?? []) {
      const entry = selected[item.batchItemId];
      if (entry) selected[item.batchItemId] = { ...entry, revision: item.revision };
    }
  }
  return {
    ...state,
    summaries,
    selected,
    nextCursor: page?.nextCursor ?? null,
    totals: page?.totals ?? state.totals,
    loading: false,
    error: null
  };
}

export function setInboxFilter(state, filter) {
  return INBOX_FILTERS.includes(filter) ? { ...state, filter } : state;
}

// ---------------------------------------------------------------------------
// Content selection (§9.C) — client-side work-queue state, no server writes
// ---------------------------------------------------------------------------

export function toggleInboxItem(state, batchItemId, entry) {
  const selected = { ...state.selected };
  if (selected[batchItemId]) delete selected[batchItemId];
  else if (entry) selected[batchItemId] = entry;
  return { ...state, selected };
}

export function clearInboxSelection(state) {
  return { ...state, selected: {} };
}

export function inboxSelectionCount(state) {
  return Object.keys(state.selected ?? {}).length;
}

export function selectedInboxItems(state) {
  return Object.entries(state.selected ?? {}).map(([batchItemId, entry]) => ({ batchItemId, ...entry }));
}

/**
 * The phase a summary item presents. Server projections carry `phase`
 * already; a fixture or older projection without it derives the same answer
 * from the shared policy rather than a second, drifting table.
 */
export function itemPhase(batch, item) {
  if (item?.phase) return item.phase;
  return itemPresentation({
    state: item?.state,
    revision: item?.revision ?? 0,
    generation: item?.generation ?? (batch?.generation === "requested" ? "requested" : null),
    publications: item?.publications ?? [],
    targets: item?.targets ?? []
  }).phase;
}

function itemInFilter(state, batch, item) {
  if (state.filter === "all") return true;
  // New is a source-post facet, not a saved-work state — Content items
  // never belong to it, so a draft can never be counted in both domains.
  if (state.filter === "new") return false;
  const phases = PHASE_FILTERS[state.filter];
  return Array.isArray(phases) ? phases.includes(itemPhase(batch, item)) : true;
}

export function visibleBatchSummaries(state) {
  const key = {
    all: () => true,
    new: () => false,
    drafts: (b) => b.draftCount > 0,
    review: (b) => b.reviewCount > 0,
    scheduled: (b) => b.scheduledCount > 0,
    attention: (b) => b.attentionCount > 0
  }[state.filter] || (() => true);
  return state.summaries.filter(key);
}

/** The posts a filter shows — per ITEM, so a mixed batch places each post in its own filter. */
export function visibleInboxItems(state) {
  return visibleBatchSummaries(state).flatMap((batch) =>
    (Array.isArray(batch.items) ? batch.items : [])
      .filter((item) => itemInFilter(state, batch, item))
      .map((item) => ({ batch, item }))
  );
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

/**
 * §9.B — the drawer is ONE post. `batchItemId` selects the item inside the
 * fetched batch; siblings stay available for navigation but are never the
 * drawer's subject on entry.
 */
export function drawerProjection(batch, sourceItem, batchItemId) {
  if (!batch) return null;
  const items = Array.isArray(batch.items) ? batch.items : [];
  // Full-batch items carry `id`; summary items carry `batchItemId` — both
  // name the same row, so match either rather than assume one projection.
  const active =
    items.find((item) => item.id === batchItemId || item.batchItemId === batchItemId) ?? items[0] ?? null;
  return {
    batchId: batch.id,
    batchItemId: active?.id ?? active?.batchItemId ?? null,
    createdAt: batch.createdAt ?? null,
    source: sourceItem ?? active?.sourceItem ?? null,
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
      phase: item.phase ?? null,
      deliveries: Array.isArray(item.deliveries) ? item.deliveries.map((delivery) => ({ ...delivery })) : [],
      approval: item.approval ?? null
    }))
  };
}

export function isEditableItem(item) {
  // `active !== false` keeps summary items (which carry no `active` field)
  // editable while retired batch items — superseded rows that keep their
  // drafting state — are read-only.
  return item?.active !== false && ["drafting", "expired"].includes(item?.state);
}

/** The single contextual action a drawer's post footer offers, driven by the shared phase. */
export function drawerAction(item) {
  const phase =
    item?.phase ??
    itemPresentation({
      state: item?.state,
      revision: item?.revision ?? 0,
      generation: item?.generation ?? null,
      publications: item?.publications ?? [],
      targets: item?.targets ?? []
    }).phase;
  switch (phase) {
    case "queued":
      return { kind: "waiting", label: "Waiting for generation" };
    case "regenerating":
    case "draft":
      return { kind: "resume", label: "Continue editing" };
    case "in_review":
      return { kind: "approval", label: "Review requested" };
    case "scheduled":
      return { kind: "schedule", label: "Scheduled" };
    case "published":
      return { kind: "receipt", label: "Published" };
    case "attention":
      return { kind: "outcome", label: "Review outcome" };
    default:
      return { kind: "unavailable", label: "Unavailable" };
  }
}

/**
 * The state chip a Content card carries — the phase roll-up, nothing else.
 * `queued`/`regenerating` come from the item's own durable generation mark;
 * `in_review`/`scheduled`/`published`/`attention` from its live filings and
 * their canonical outcomes at the current revision.
 */
function itemChip(locale, batch, item) {
  const phase = itemPhase(batch, item);
  const key = {
    queued: ["stateQueued", "sl-chip-queued"],
    regenerating: ["stateRegenerating", "sl-chip-queued"],
    draft: ["stateDraft", "sl-chip-drafting"],
    in_review: ["stateInReview", "sl-chip-submitted"],
    scheduled: ["stateScheduled", "sl-chip-scheduled"],
    published: ["statePublished", "sl-chip-published"],
    attention: ["stateAttention", "sl-chip-attention"]
  }[phase] ?? ["stateDraft", "sl-chip-drafting"];
  return { label: t(locale, key[0]), cls: key[1] };
}

/** The trailing line a card carries — the freshest delivery time when one exists, else the batch edit time. */
function itemWhen(locale, batch, item) {
  const phase = itemPhase(batch, item);
  if (phase === "queued" || phase === "regenerating") return null;
  const deliveries = Array.isArray(item.deliveries) ? item.deliveries : [];
  const latest = deliveries
    .map((delivery) => delivery.filedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const when = latest ?? batch.lastUpdatedAt;
  return when ? t(locale, "cardEditedAgo", { time: relativeLabel(locale, when) }) : null;
}

/**
 * One Content card per batch ITEM — the same `sl-post` shape Sources uses
 * (shared `renderPostCard`), carrying the drafted caption when one exists
 * and the source caption marked as such otherwise. The checkbox selects the
 * post without opening it; opening carries `{batch, batchItemId}` so the
 * drawer renders this post alone.
 */
function itemCard(locale, batch, item, ctx, covers) {
  const state = ctx.state;
  const snapshot = item.caption ?? item.sourceText ?? "";
  const title = snapshot.split("\n")[0].slice(0, 90) || t(locale, "inboxNoSource");
  const selected = Boolean(state?.selected?.[item.batchItemId]);
  return renderPostCard(locale, {
    key: item.batchItemId,
    onOpen: () => ctx.handlers.onInspectBatch(batch, item.batchItemId),
    ariaLabel: snapshot.slice(0, 80) || t(locale, "inboxInspect"),
    cover: item.coverMediaId ? { itemId: item.itemId, mediaId: item.coverMediaId } : null,
    glyph: providerGlyph({ provider: item.provider, sourceBinding: item.sourceBinding }, ctx.sources),
    glyphKey: null,
    kicker: item.sourceLabel || t(locale, "drawerSavedWork"),
    title,
    // A one-line snapshot IS the title, in full -- printing it again below
    // as the body was defect 5. Only the part the title truncated or the
    // later lines it dropped belong here.
    body: snapshot === title ? "" : snapshot,
    chip: itemChip(locale, batch, item),
    selectable: true,
    selected,
    onSelect: () =>
      ctx.handlers.onSelectItem(item.batchItemId, {
        batchId: batch.id,
        itemId: item.itemId,
        revision: item.revision ?? 0
      }),
    when: itemWhen(locale, batch, item)
  }, covers);
}

/** A batch summary that arrived before its items projection (or an empty batch) still gets a card — the batch row itself, same post shape, no cover. */
function summaryCard(locale, batch, handlers) {
  const previewText = batch.preview?.caption ?? batch.preview?.sourceText ?? "";
  const previewTitle = previewText.split("\n")[0].slice(0, 90) || t(locale, "inboxNoSource");
  return renderPostCard(locale, {
    key: batch.id,
    onOpen: () => handlers.onInspectBatch(batch, batch.preview?.batchItemId ?? null),
    ariaLabel: t(locale, "inboxInspect"),
    cover: null,
    glyph: "•",
    kicker: batch.preview?.sourceLabel || t(locale, "drawerSavedWork"),
    title: previewTitle,
    // Same shape as itemCard's dedupe: a one-line preview is the title, in
    // full -- printing it again as the body was defect 5.
    body: previewText === previewTitle ? "" : previewText,
    chip: null,
    meta: el("span", { class: "sl-meta" }, [
      el("span", null, batch.preview?.caption ? t(locale, "inboxSnapshotDraft") : t(locale, "inboxSnapshotSource")),
      el("span", null, Number.isInteger(batch.preview?.revision) ? t(locale, "drawerRevision", { n: batch.preview.revision }) : t(locale, "inboxNoSavedRevision"))
    ])
  });
}

/**
 * The floating review dock — the Sources `.sl-selection` exemplar, on
 * batch-item selection. Count is the FULL selection, so a filter that hides
 * selected posts never silently narrows what Review will read.
 */
function selectionDock(locale, state, handlers) {
  const count = inboxSelectionCount(state);
  if (!count) return null;
  return el("div", { class: "sl-selection", role: "region", "aria-label": t(locale, "selectionAria") }, [
    el("div", { class: "sl-selection-inner" }, [
      el("div", { class: "sl-selected-copy" }, [
        el("strong", null, t(locale, "selectedCount", { n: count }))
      ]),
      el("button", { type: "button", class: "sl-clear", onclick: () => handlers.onClearItemSelection() }, t(locale, "clear")),
      el("button", { type: "button", class: "sl-primary", onclick: () => handlers.onReviewSelected() }, t(locale, "reviewSelected"))
    ])
  ]);
}

export function renderInbox(root, state, ctx) {
  const { locale, handlers, loadCover } = ctx;
  const covers = [];
  const totals = state.totals ?? {};
  const filters = [
    ["all", t(locale, "inboxAll"), totals.items], ["drafts", t(locale, "inboxDrafts"), totals.drafts],
    ["review", t(locale, "inboxReview"), totals.review], ["scheduled", t(locale, "inboxScheduled"), totals.scheduled], ["attention", t(locale, "inboxAttention"), totals.attention]
  ];
  const cards = visibleBatchSummaries(state).flatMap((batch) => {
    const items = Array.isArray(batch.items) ? batch.items : [];
    // A summary built before the items projection (or an empty batch) still
    // gets a card — the batch row itself, same post shape, no cover.
    if (!items.length) return [summaryCard(locale, batch, handlers)];
    const visible = items.filter((item) => itemInFilter(state, batch, item));
    return visible.map((item) => itemCard(locale, batch, item, ctx, covers));
  });
  root.appendChild(el("section", { class: "sl-inbox", "aria-label": t(locale, "appTitle") }, [
    el("div", { class: "sl-inbox-tabs", role: "group", "aria-label": t(locale, "inboxAll") }, filters.map(([key, label, count]) => el("button", { type: "button", "aria-pressed": String(state.filter === key), class: state.filter === key ? "sl-filter-active" : "", onclick: () => handlers.onInboxFilter(key) }, `${label}${typeof count === "number" && count > 0 ? ` ${count}` : ""}`))),
    state.notice ? el("p", { class: "sl-field-note", role: "status" }, state.notice) : null,
    cards.length ? el("div", { class: "sl-inbox-grid" }, cards) : state.loading ? el("p", { class: "sl-field-note", role: "status" }, t(locale, "loading")) : null,
    state.nextCursor ? el("button", { type: "button", class: "sl-secondary", onclick: handlers.onLoadMoreBatches }, t(locale, "inboxLoadMore")) : null,
    selectionDock(locale, state, handlers),
    state.error ? el("p", { class: "sl-wizard-error", role: "alert" }, state.error) : null
  ]));
  if (typeof loadCover === "function") fillCovers(covers, loadCover);
}
