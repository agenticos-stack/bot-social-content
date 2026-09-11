import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";
import { normalizePublicationIntent } from "../../src/model.js";

it("only accepts the hold late policy for Social Content", () => {
  expect(normalizePublicationIntent({ publishMode: "publish_now" })).toMatchObject({ ok: true, intent: { latePolicy: "hold" } });
  expect(normalizePublicationIntent({ publishMode: "publish_now", latePolicy: "publish_when_recovered" })).toMatchObject({ ok: false, code: "publication_intent_invalid" });
});

type Sqlite = {
  exec(sql: string): void;
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
  close(): void;
};

const databases: Sqlite[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function sqliteContext() {
  const { DatabaseSync } = (
    process as unknown as { getBuiltinModule(name: string): { DatabaseSync: new (path: string) => Sqlite } }
  ).getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      if (/^\s*SELECT\b/i.test(query)) {
        const values = db.prepare(query).all(...bindings);
        return { toArray: () => values, one: () => values[0] };
      }
      db.prepare(query).run(...bindings);
      return { toArray: () => [], one: () => undefined };
    }
  };
  const ctx = {
    storage: {
      sql,
      transactionSync<T>(callback: () => T): T {
        db.exec("BEGIN");
        try {
          const result = callback();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    }
  };
  return { ctx, db };
}

function minimalPng(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function seed(gadget: Gadget) {
  gadget.storage.setConfig({
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: [],
    // The org's stored brief is what permits "price" as an allowed change —
    // a caller-supplied allowedChanges is honoured only where setup already
    // did, so these tests' briefs need it here, not only on the call.
    refinementBrief: { allowedChanges: ["price"] }
  });
  gadget.storage.upsertItem({
    id: "instagram:IG_MAIN:p1",
    sourceBinding: "IG_MAIN",
    sourceLabel: "Main Instagram",
    provider: "instagram",
    providerItemId: "p1",
    text: "Original source",
    media: [{ id: "source-media", kind: "image", url: "https://cdn.example.test/original.jpg" }],
    metrics: {},
    contentHash: "source-hash",
    firstSeenAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z"
  });
  gadget.storage.createBatch("batch-1");
  gadget.storage.createBatchItem({
    id: "item-1",
    batchId: "batch-1",
    itemId: "instagram:IG_MAIN:p1",
    destinationBindings: ["FB_MAIN"],
    state: "drafting"
  });
}

describe("social archive revision metadata persistence", () => {
  it("treats nullable schema-5 metadata as historical absence for an old-client save", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    // A schema-5 revision had no metadata columns, equivalent to these NULLs.
    gadget.storage.appendRevision("item-1", 0, {
      caption: "第一稿內容文字",
      posterLayout: null,
      confirmedClaims: [],
      issues: []
    });
    const saved = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 1,
      caption: "第二稿內容文字"
    });
    expect(saved).toMatchObject({ ok: true, revision: 2 });
    expect(gadget.storage.latestRevision("item-1")?.publicationIntent).toMatchObject({ publishMode: "save_draft" });
  });

  it("honours an explicitly supplied visual mode in a full brief on later saves", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      refinementBrief: { visualTreatment: "ai_refinement" }
    });
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 1,
      caption: "第二稿內容文字",
      refinementBrief: { tone: "formal", visualTreatment: "keep_original" }
    });
    expect(gadget.storage.latestRevision("item-1")?.refinementBrief).toMatchObject({
      tone: "formal",
      visualTreatment: "keep_original"
    });
  });

  it("old-client saves preserve metadata, explicit clears reset it, and reload reads the same revision", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);

    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      refinementBrief: { tone: "calm", visualTreatment: "ai_refinement" },
      protectedOverrides: [{ literal: "HK$10", reason: "owner correction", approvedBy: "owner_1" }],
      originalMediaRefs: [{ assetId: "saved-original", url: "https://cdn.example.test/saved.jpg" }],
      derivedMediaRefs: [{ assetId: "derived-1", url: "https://cdn.example.test/derived.jpg" }],
      publicationIntent: { publishMode: "schedule", publishLocalTime: "2099-08-01T10:00", timezone: "Asia/Hong_Kong" }
    });

    // This is the payload sent by the old client: metadata fields are absent.
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, caption: "第二稿內容文字" });
    const preserved = gadget.storage.latestRevision("item-1");
    expect(preserved).toMatchObject({
      revision: 2,
      refinementBrief: expect.objectContaining({ tone: "calm", visualTreatment: "ai_refinement" }),
      protectedOverrides: [{ literal: "HK$10" }],
      originalMediaRefs: [{ assetId: "saved-original" }],
      derivedMediaRefs: [{ assetId: "derived-1", source: "derived" }],
      publicationIntent: expect.objectContaining({ publishMode: "schedule", timezone: "Asia/Hong_Kong" })
    });
    // Explicit empty arrays clear; explicit save_draft resets publication intent.
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 2,
      caption: "第三稿內容文字",
      protectedOverrides: [],
      derivedMediaRefs: [],
      publicationIntent: { publishMode: "save_draft" }
    });
    const cleared = gadget.storage.latestRevision("item-1");
    expect(cleared?.protectedOverrides).toEqual([]);
    expect(cleared?.derivedMediaRefs).toEqual([]);
    expect(cleared?.publicationIntent).toMatchObject({ publishMode: "save_draft" });
    expect(cleared?.originalMediaRefs).toEqual([
      { assetId: "saved-original", kind: "image", url: "https://cdn.example.test/saved.jpg", source: "original" }
    ]);

    const reloaded = new Gadget(ctx as never, {} as never);
    expect(reloaded.storage.latestRevision("item-1")).toEqual(cleared);
  });

  it("savePoster carries metadata into its appended revision", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      refinementBrief: { tone: "calm", visualTreatment: "text_poster" },
      originalMediaRefs: [{ assetId: "saved-original" }],
      publicationIntent: { publishMode: "publish_now" }
    });
    const saved = await gadget.savePoster({
      batchItemId: "item-1",
      expectedRevision: 1,
      template: "1080x1080",
      png: minimalPng(1080, 1080)
    });
    expect(saved).toMatchObject({ ok: true, revision: 2 });
    expect(gadget.storage.latestRevision("item-1")).toMatchObject({
      refinementBrief: expect.objectContaining({ tone: "calm", visualTreatment: "text_poster" }),
      originalMediaRefs: [{ assetId: "saved-original", kind: "image", url: null, source: "original" }],
      publicationIntent: expect.objectContaining({ publishMode: "publish_now" })
    });
  });
});

describe("saveRevision validation routing", () => {
  it("still blocks an altered price when the brief allows no changes", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    gadget.storage.upsertItem({
      id: "instagram:IG_MAIN:p1",
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      provider: "instagram",
      providerItemId: "p1",
      text: "Get the HK$1,299 bundle now.",
      media: [{ id: "source-media", kind: "image", url: "https://cdn.example.test/original.jpg" }],
      metrics: {},
      contentHash: "source-hash",
      firstSeenAt: "2026-09-06T00:00:00.000Z",
      lastSeenAt: "2026-09-06T00:00:00.000Z"
    });
    const result = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "宣傳優惠：套裝價錢HK$999，立即購買。",
      refinementBrief: { visualTreatment: "keep_original", allowedChanges: [] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "protected_literal_altered", severity: "block" })
    );
  });

  it("accepts a derived price when the brief allows changes and the ledger names a basis", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    const result = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "宣傳優惠：套裝價錢HK$999，立即購買。",
      refinementBrief: { visualTreatment: "ai_refinement", allowedChanges: ["price"] },
      ledger: { spans: [{ text: "HK$999", kind: "price", basis: "knowledge:fact_price" }] }
    });
    expect(result).toMatchObject({ ok: true, revision: 1 });
  });

  it("blocks a derived price with no basis", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    const result = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "宣傳優惠：套裝價錢HK$999，立即購買。",
      refinementBrief: { allowedChanges: ["price"] }
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "ungrounded_span", severity: "block" }));
  });

  it("persists the ledger on the revision row", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    const result = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "宣傳優惠：套裝價錢HK$999，立即購買。",
      refinementBrief: { visualTreatment: "ai_refinement", allowedChanges: ["price"] },
      ledger: {
        spans: [{ text: "HK$999", kind: "price", basis: "knowledge:fact_price" }],
        media: [{ ref: "source-media", provenance: "source" }]
      }
    });
    expect(result).toMatchObject({ ok: true, revision: 1 });
    expect(gadget.storage.latestRevision("item-1")?.ledger).toEqual({
      spans: [{ text: "HK$999", kind: "price", basis: "knowledge:fact_price" }],
      media: [{ ref: "source-media", provenance: "source" }]
    });
  });

  it("grounds a derived price from protectedOverrides as owner: entries", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    const result = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "宣傳優惠：套裝價錢HK$999，立即購買。",
      refinementBrief: { allowedChanges: ["price"] },
      protectedOverrides: [{ literal: "HK$999", reason: "owner correction", approvedBy: "owner_1" }]
    });
    expect(result).toMatchObject({ ok: true, revision: 1 });
    expect(gadget.storage.latestRevision("item-1")?.ledger?.spans).toContainEqual(
      expect.objectContaining({
        text: "HK$999",
        kind: "price",
        basis: "owner:owner_1",
        reason: "owner correction",
        approvedBy: "owner_1"
      })
    );
  });

  it("reconstructs owner: ledger entries from pre-ledger protectedOverrides", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    seed(gadget);
    gadget.storage.appendRevision("item-1", 0, {
      caption: "第一稿內容文字",
      protectedOverrides: [{ literal: "HK$10", reason: "owner correction", approvedBy: "owner_1" }]
    });
    expect(gadget.storage.latestRevision("item-1")?.ledger?.spans).toContainEqual(
      expect.objectContaining({ text: "HK$10", kind: "price", basis: "owner:owner_1" })
    );
  });

  it("passes a permitted-brief draft that preserves a protected name verbatim", async () => {
    // The positive case (QA gap): preservation running on both paths must not
    // over-block a legitimate draft. Stored brief allows "tone"; the caller
    // uses it; the zh caption keeps "Nautical living" verbatim with the text
    // reordered around it — expect ok with an EMPTY issues array.
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, {} as never);
    gadget.storage.setConfig({
      protectedTerms: ["Nautical living"],
      protectedHashtags: [],
      disclaimers: [],
      claimsRequiringConfirmation: [],
      refinementBrief: { allowedChanges: ["tone"] }
    });
    gadget.storage.upsertItem({
      id: "instagram:IG_MAIN:p2",
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      provider: "instagram",
      providerItemId: "p2",
      text: "Annonse — Nautical living er og blir en favoritt for Halia",
      media: [],
      metrics: {},
      contentHash: "source-hash-2",
      firstSeenAt: "2026-09-06T00:00:00.000Z",
      lastSeenAt: "2026-09-06T00:00:00.000Z"
    });
    gadget.storage.createBatch("batch-2");
    gadget.storage.createBatchItem({
      id: "item-2",
      batchId: "batch-2",
      itemId: "instagram:IG_MAIN:p2",
      destinationBindings: [],
      state: "drafting"
    });
    const result = await gadget.saveRevisions({
      revisions: [{
        batchItemId: "item-2",
        expectedRevision: 0,
        caption: "依然是小傢伙每日的最愛 — Nautical living 配方不變 🐟",
        refinementBrief: { allowedChanges: ["tone"] }
      }]
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.results).toEqual([expect.objectContaining({ ok: true, revision: 1, issues: [] })]);
  });
});
