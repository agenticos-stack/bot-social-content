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
    if ("caption" in input) item.caption = input.caption;
    if ("posterLayout" in input) item.posterLayout = input.posterLayout;
    if (input.acceptedGeneratedMediaId) {
      // ?jpeg=1: pinning an image is a new revision; the stored bytes never change.
      const stored = generatedStore.get(input.acceptedGeneratedMediaId);
      if (!stored) return { ok: false, issues: [{ code: "generated_image_missing", message: "No such fixture image." }] };
      item.acceptedVisualMode = input.acceptedVisualMode;
      item.generatedImage = { id: stored.id, ready: true, mimeType: stored.mime, digest: stored.digest, status: "accepted", derivedFrom: stored.derivedFrom ?? null };
    }
    item.revisionHistory = [...(item.revisionHistory ?? []), { revision: item.revision, generatedMediaId: item.generatedImage?.id ?? null }];
    return { ok: true, revision: item.revision };
  },
  async summary() {
    return {
      configured: new URL(location.href).searchParams.get("setup") !== "1",
      sources: [{ binding: "IG_MAIN", provider: "instagram", glyphKey: "instagram", label: "Example Studio", lastOutcome: "confirmed" }],
      // ?nodest=1 renders the zero-destination publish step: draft cards
      // visible under the notice, sends disabled until one exists (#1960).
      // ?revoked=1 keeps the row but flips the live-grant read off — the
      // stored-but-dead destination the picker must mark, not offer.
      destinations: new URL(location.href).searchParams.get("nodest") === "1"
        ? []
        : [{
            destinationBinding: "IG_MAIN", provider: "instagram", label: "Example Studio",
            ...(new URL(location.href).searchParams.get("revoked") === "1" ? { granted: false } : {})
          }],
      config: {}
    };
  },
  async listItems({ filter, query = "" }) { return { items: items.filter((item) => (filter === "all" || !item.seen) && item.text.toLowerCase().includes(query.toLowerCase())), nextCursor: null }; },
  async setSelection(id, selected) { items.find((item) => item.id === id).selected = selected; shareSelection(); },
  async clearSelection() { for (const item of items) item.selected = false; shareSelection(); },
  async markSeen(ids) { for (const item of items) if (ids.includes(item.id)) item.seen = true; },
  // The publish step asks every item for its filings; the fixture has none.
  async readPublishState() { return { publications: [], targets: [] }; },
  async subscribe() { return {}; },
  // ?jpeg=1 only: synthetic persistence. Chunked like the host, immutable per id.
  async getGeneratedImage(id, { chunk = 0 } = {}) {
    await jpegSeed;
    const stored = generatedStore.get(id);
    if (!stored) return { ok: false, message: "This fixture image does not exist." };
    const size = 64 * 1024, chunks = Math.max(1, Math.ceil(stored.bytes.length / size));
    return { mime: stored.mime, total: stored.bytes.length, chunk, chunks, bytes: stored.bytes.slice(chunk * size, (chunk + 1) * size) };
  },
  async saveDerivedGeneratedImage({ sourceMediaId, bytes, mimeType }) {
    await jpegSeed;
    if (!generatedStore.has(sourceMediaId)) return { ok: false, code: "generated_image_missing", message: "No such source image." };
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = await sha256(data);
    for (const stored of generatedStore.values()) if (stored.derivedFrom === sourceMediaId && stored.digest === digest) return { ok: true, id: stored.id, reused: true };
    const id = `gm_fixture_jpeg_${generatedStore.size}`;
    generatedStore.set(id, { id, mime: mimeType, bytes: data.slice(), digest, derivedFrom: sourceMediaId });
    return { ok: true, id };
  },
  // Read-back for the proof: ids, digests and byte sizes only.
  async fixtureGeneratedStore() { await jpegSeed; return [...generatedStore.values()].map(({ id, mime, digest, derivedFrom, bytes }) => ({ id, mime, digest, derivedFrom: derivedFrom ?? null, size: bytes.length })); }
};
async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const generatedStore = new Map();
const jpegScenario = new URL(location.href).searchParams.get("jpeg") === "1";
// The PNG is drawn here at runtime, so no customer image is committed.
const jpegSeed = jpegScenario ? (async () => {
  const canvas = new OffscreenCanvas(1254, 1254);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 1254, 1254);
  gradient.addColorStop(0, "#f4c542"); gradient.addColorStop(1, "#2a6f97");
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1254, 1254);
  ctx.fillStyle = "#fff"; ctx.font = "bold 96px sans-serif"; ctx.fillText("SYNTHETIC PNG", 180, 640);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  generatedStore.set("gm_fixture_png", { id: "gm_fixture_png", mime: "image/png", bytes, digest: await sha256(bytes) });
})() : Promise.resolve();
const previewBatch = new URL(location.href).searchParams.get("draft") === "1" ? {
  id: "fixture-batch", items: [
    { id: "fixture-submitted", state: "submitted", sourceItem: items[0], revision: 1, caption: "已送交審核的內容。", destinationBindings: ["IG_MAIN"] },
    { id: "fixture-draft", state: "drafting", sourceItem: items[1], revision: 1, caption: "每日精選內容，歡迎了解。", destinationBindings: ["IG_MAIN"] }
  ]
} : jpegScenario ? {
  id: "fixture-batch", items: [
    { id: "fixture-jpeg", state: "drafting", sourceItem: items[1], revision: 1, caption: "合成測試圖片。", altText: "Synthetic gradient test image.",
      acceptedVisualMode: "ai_refinement", destinationBindings: ["IG_MAIN"],
      generatedImage: { id: "gm_fixture_png", ready: true, mimeType: "image/png", status: "accepted" },
      revisionHistory: [{ revision: 1, generatedMediaId: "gm_fixture_png" }] }
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
