// In-memory read/selection fixture only. Unsupported actions fail explicitly.
globalThis.RpcTarget = class {};
const items = ["A brighter kind of daily", "Start with morning light", "Blend it your way"].map((text, index) => ({
  id: `fixture-${index}`, provider: "instagram", sourceBinding: "IG_MAIN",
  sourceLabel: "Example Studio", providerItemId: String(index), authorHandle: "@example_studio",
  permalink: "https://example.invalid/source", publishedAt: "2026-09-01T10:00:00.000Z",
  text, media: [], metrics: { likes: 100 + index, comments: 2 }, seen: false, selected: false
}));
// ?pages=1: a synthetic multi-media source. Data-URL SVGs render without a
// media door; the video child exercises the not-carried-over disclosure.
const svg = (label, from, to) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="400" height="500" fill="url(#g)"/><text x="200" y="260" font-family="sans-serif" font-size="42" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`)}`;
const carouselSource = {
  id: "fixture-carousel-src", provider: "instagram", sourceBinding: "IG_MAIN",
  sourceLabel: "Example Studio", providerItemId: "cs1", authorHandle: "@example_studio",
  permalink: "https://example.invalid/source", publishedAt: "2026-09-01T10:00:00.000Z",
  text: "Three frames and a clip from the morning shoot.",
  media: [
    { id: "m1", kind: "carousel_child", url: "https://example.invalid/frame1.png", alt: "Studio frame one" },
    { id: "m2", kind: "carousel_child", url: "https://example.invalid/frame2.png", alt: "Studio frame two" },
    { id: "v1", kind: "video", url: "https://example.invalid/clip.mp4", alt: "Behind-the-scenes clip" }
  ],
  metrics: { likes: 210, comments: 14 }, seen: false, selected: false
};
const carouselSourceVisual = {
  ...carouselSource, id: "fixture-carousel-vis-src", providerItemId: "cs2",
  media: [
    { ...carouselSource.media[0], url: svg("FRAME 1", "#f5b544", "#e07856") },
    { ...carouselSource.media[1], url: svg("FRAME 2", "#2a6f97", "#34e597") },
    carouselSource.media[2]
  ]
};
const singleSource = {
  ...carouselSourceVisual, id: "fixture-single-src", providerItemId: "ss1",
  text: "One frame from the set.", media: [carouselSourceVisual.media[0]]
};
const fixture = {
  async listBatchSummaries() {
    if (pagesScenario) {
      return {
        batches: previewBatches.map((batch) => ({
          id: batch.id, itemCount: 1, draftCount: 1, reviewCount: 0, scheduledCount: 0, attentionCount: 0,
          preview: { sourceLabel: "Example Studio", caption: batch.items[0].caption, revision: batch.items[0].revision }
        })),
        totals: { batches: previewBatches.length, drafts: previewBatches.length }, nextCursor: null
      };
    }
    return { batches: previewBatch ? [{ id: previewBatch.id, itemCount: 2, draftCount: 1, reviewCount: 1, scheduledCount: 0, attentionCount: 0, preview: { sourceLabel: "Example Studio", caption: "每日精選內容，歡迎了解。", revision: 1 } }] : [], totals: { batches: previewBatch ? 1 : 0, drafts: previewBatch ? 1 : 0 }, nextCursor: null };
  },
  async getBatch(id) {
    const batch = (previewBatches ?? []).find((entry) => entry.id === id) ?? (previewBatch?.id === id ? previewBatch : null);
    return batch ? JSON.parse(JSON.stringify(batch)) : null;
  },
  async saveRevision(input) {
    const item = [...(previewBatches ?? []), ...(previewBatch ? [previewBatch] : [])]
      .flatMap((batch) => batch.items)
      .find((entry) => entry.id === input.batchItemId);
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
    if (Array.isArray(input.pages)) {
      item.pages = input.pages;
      // The singular mirror pre-pages readers still consult.
      item.altText = input.pages.find((page) => page?.altText)?.altText ?? null;
    }
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
  // The drawer saves through the batch form; each entry answers like saveRevision.
  async saveRevisions({ revisions }) {
    const results = [];
    for (const entry of revisions) results.push(await fixture.saveRevision(entry));
    return { results };
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
// ?pages=1: the carousel page strip — an unsaved post on a mixed-media
// source (empty bound pages + video disclosure), a filled two-page
// carousel, and a single-page post.
const pagesScenario = new URL(location.href).searchParams.get("pages") === "1";
const previewBatches = pagesScenario ? [
  { id: "fixture-batch-empty", items: [
    { id: "fixture-pages-empty", state: "drafting", sourceItem: carouselSource, revision: 0,
      caption: "早上的拍攝三個畫面。", destinationBindings: ["IG_MAIN"],
      skippedVideos: [carouselSource.media[2]] }
  ] },
  { id: "fixture-batch-carousel", items: [
    { id: "fixture-pages", state: "drafting", sourceItem: carouselSourceVisual, revision: 1,
      caption: "早上的拍攝三個畫面。", destinationBindings: ["IG_MAIN"],
      skippedVideos: [carouselSourceVisual.media[2]],
      pages: [
        { pageId: "pg_src_m1", kind: "original", mediaId: "m1", sourceMediaId: "m1", altText: "Studio frame one" },
        { pageId: "pg_src_m2", kind: "original", mediaId: "m2", sourceMediaId: "m2", altText: "Studio frame two" }
      ] }
  ] },
  { id: "fixture-batch-single", items: [
    { id: "fixture-pages-single", state: "drafting", sourceItem: singleSource, revision: 1,
      caption: "One frame from the set.", destinationBindings: ["IG_MAIN"],
      pages: [
        { pageId: "pg_src_m1", kind: "original", mediaId: "m1", sourceMediaId: "m1", altText: "Studio frame one" }
      ] }
  ] }
] : null;
const previewBatch = !pagesScenario && new URL(location.href).searchParams.get("draft") === "1" ? {
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
