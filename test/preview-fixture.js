// In-memory read/selection fixture only. Unsupported actions fail explicitly.
globalThis.RpcTarget = class {};
const items = ["A brighter kind of daily", "Start with morning light", "Blend it your way"].map((text, index) => ({
  id: `fixture-${index}`, provider: "instagram", sourceBinding: "IG_MAIN",
  sourceLabel: "Example Studio", providerItemId: String(index), authorHandle: "@example_studio",
  permalink: "https://example.invalid/source", publishedAt: "2026-09-01T10:00:00.000Z",
  text, media: [], metrics: { likes: 100 + index, comments: 2 }, seen: false, selected: false
}));
const fixture = {
  async listBatchSummaries() {
    return { batches: previewBatch ? [{ id: previewBatch.id, itemCount: 2, draftCount: 1, reviewCount: 1, scheduledCount: 0, attentionCount: 0, preview: { sourceLabel: "Example Studio", caption: "每日精選內容，歡迎了解。", revision: 1 } }] : [], totals: { batches: previewBatch ? 1 : 0, drafts: previewBatch ? 1 : 0 }, nextCursor: null };
  },
  async getBatch(id) { return previewBatch?.id === id ? JSON.parse(JSON.stringify(previewBatch)) : null; },
  async saveRevision(input) {
    const item = previewBatch?.items.find((entry) => entry.id === input.batchItemId);
    if (!item || item.state !== "drafting") throw new Error("Fixture preview has no editable item. No live action was performed.");
    if (conflictPending) {
      conflictPending = false;
      item.revision += 1;
      item.caption = "另一位編輯已儲存的內容。";
    }
    if (input.expectedRevision !== item.revision) return { ok: false, issues: [{ code: "revision_conflict", message: "A newer fixture revision exists." }] };
    item.revision += 1;
    item.caption = input.caption;
    item.posterLayout = input.posterLayout;
    return { ok: true, revision: item.revision };
  },
  async summary() {
    return {
      configured: new URL(location.href).searchParams.get("setup") !== "1",
      sources: [{ binding: "IG_MAIN", provider: "instagram", glyphKey: "instagram", label: "Example Studio", lastOutcome: "confirmed" }],
      destinations: [{ destinationBinding: "IG_MAIN", provider: "instagram", label: "Example Studio" }], config: {}
    };
  },
  async listItems({ filter, query = "" }) { return { items: items.filter((item) => (filter === "all" || !item.seen) && item.text.toLowerCase().includes(query.toLowerCase())), nextCursor: null }; },
  async setSelection(id, selected) { items.find((item) => item.id === id).selected = selected; shareSelection(); },
  async clearSelection() { for (const item of items) item.selected = false; shareSelection(); },
  async markSeen(ids) { for (const item of items) if (ids.includes(item.id)) item.seen = true; },
  async subscribe() { return {}; }
};
const previewBatch = new URL(location.href).searchParams.get("draft") === "1" ? {
  id: "fixture-batch", items: [
    { id: "fixture-submitted", state: "submitted", sourceItem: items[0], revision: 1, caption: "已送交審核的內容。", destinationBindings: ["IG_MAIN"], rightsStatus: "confirmed" },
    { id: "fixture-draft", state: "drafting", sourceItem: items[1], revision: 1, caption: "每日精選內容，歡迎了解。", destinationBindings: ["IG_MAIN"], rightsStatus: "confirmed" }
  ]
} : null;
let conflictPending = new URL(location.href).searchParams.get("conflict") === "1";
function shareSelection() {
  if (globalThis.parent && globalThis.parent !== globalThis) globalThis.parent.postMessage({
    type: 'social-preview-selection', records: items.filter(item => item.selected).map(item => ({id:item.id,label:item.text}))
  }, new URL(location.href).origin);
}
globalThis.gadget = new Proxy(fixture, {
  get(target, key) {
    if (key === "then") return undefined;
    return target[key] || (async () => { throw new Error(`Fixture preview does not implement ${String(key)}. No live action was performed.`); });
  }
});
