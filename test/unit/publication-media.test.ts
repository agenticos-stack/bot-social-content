import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";
import { isPublisherAddressableUrl, publicationMedia } from "../../src/model.js";
import { socialCreateDraft } from "../../src/doors.js";

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

function seed(gadget: Gadget) {
  gadget.storage.setConfig({
    rightsPolicy: "require_confirmation",
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: []
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
    state: "drafting",
    rightsStatus: "confirmed"
  });
  gadget.storage.setOriginLink("item-1", {
    provider: "instagram",
    sourceBinding: "IG_MAIN",
    sourceLabel: "Main Instagram",
    providerItemId: "p1",
    permalink: "https://www.instagram.com/p/p1/",
    sourceContentHash: "source-hash",
    sourcePublishedAt: "2026-09-06T00:00:00.000Z",
    retrievedAt: "2026-09-06T00:00:00.000Z"
  });
}

function mockSocial(created: unknown[]) {
  return {
    social: {
      async createDraft(input: unknown) {
        created.push(input);
        return {
          postId: "post-1",
          versionId: "ver-1",
          versionNumber: 1,
          contentHash: "hash-1",
          targets: [{ destinationBinding: "FB_MAIN", label: "Facebook", provider: "facebook" }]
        };
      },
      async submitForReview() {
        return { refused: true, code: "submission_required", message: "Needs owner approval.", authority: "send" };
      }
    }
  };
}

describe("isPublisherAddressableUrl", () => {
  it("accepts a public https CDN url the publisher can fetch", () => {
    expect(isPublisherAddressableUrl("https://cdn.example.test/original.jpg")).toBe(true);
  });

  it("refuses the generated media route Meta cannot fetch without org auth", () => {
    expect(isPublisherAddressableUrl("https://api.agenticos.hk/v1/media/job_1/assets/0")).toBe(false);
    expect(isPublisherAddressableUrl("https://staging-api.agenticos.hk/v1/media/job_1/assets/0")).toBe(false);
  });

  it("refuses empty, non-https, and loopback urls", () => {
    expect(isPublisherAddressableUrl("")).toBe(false);
    expect(isPublisherAddressableUrl("http://cdn.example.test/x.jpg")).toBe(false);
    expect(isPublisherAddressableUrl("https://127.0.0.1:8787/v1/media/job_1/assets/0")).toBe(false);
  });
});

describe("publicationMedia", () => {
  const source = [{ id: "source-media", kind: "image", url: "https://cdn.example.test/original.jpg" }];

  it("uses derived refs when they are publisher-addressable", () => {
    const result = publicationMedia({
      derivedMediaRefs: [{ assetId: "derived-1", kind: "image", url: "https://cdn.example.test/derived.jpg" }],
      originalMediaRefs: [],
      sourceMedia: source
    });
    expect(result).toEqual({
      ok: true,
      media: [{ assetId: "derived-1", url: "https://cdn.example.test/derived.jpg", kind: "image" }]
    });
  });

  it("falls back to the source item media when derived refs are absent", () => {
    const result = publicationMedia({
      derivedMediaRefs: [],
      originalMediaRefs: [],
      sourceMedia: source
    });
    expect(result).toEqual({
      ok: true,
      media: [{ assetId: "source-media", url: "https://cdn.example.test/original.jpg", kind: "image" }]
    });
  });

  it("refuses a generated media-job url rather than forwarding it to the publisher", () => {
    const result = publicationMedia({
      derivedMediaRefs: [
        { assetId: "job_1:0", kind: "image", url: "https://api.agenticos.hk/v1/media/job_1/assets/0" }
      ],
      originalMediaRefs: [],
      sourceMedia: source
    });
    expect(result).toMatchObject({ ok: false, code: "media_unaddressable" });
  });
});

describe("socialCreateDraft media forwarding", () => {
  it("forwards media unchanged when every entry is publisher-addressable", async () => {
    const seen: unknown[] = [];
    const env = mockSocial(seen);
    const input = {
      caption: "第一稿內容文字",
      media: [{ assetId: "source-media", url: "https://cdn.example.test/original.jpg", kind: "image" as const }],
      targets: [{ destinationBinding: "FB_MAIN" }],
      origin: {
        provider: "instagram",
        sourceLabel: "Main Instagram",
        providerItemId: "p1",
        permalink: "https://www.instagram.com/p/p1/",
        sourceContentHash: "source-hash",
        sourcePublishedAt: "2026-09-06T00:00:00.000Z",
        retrievedAt: "2026-09-06T00:00:00.000Z"
      }
    };
    const result = await socialCreateDraft(env, input);
    expect(result).toMatchObject({ postId: "post-1" });
    expect(seen[0]).toMatchObject({ media: input.media });
  });

  it("refuses by value, never throw, when a media entry is not publisher-addressable", async () => {
    const seen: unknown[] = [];
    const env = mockSocial(seen);
    const result = await socialCreateDraft(env, {
      caption: "第一稿內容文字",
      media: [{ assetId: "job_1:0", url: "https://api.agenticos.hk/v1/media/job_1/assets/0" }],
      targets: [{ destinationBinding: "FB_MAIN" }],
      origin: {
        provider: "instagram",
        sourceLabel: "Main Instagram",
        providerItemId: "p1",
        permalink: "https://www.instagram.com/p/p1/",
        sourceContentHash: "source-hash",
        sourcePublishedAt: "2026-09-06T00:00:00.000Z",
        retrievedAt: "2026-09-06T00:00:00.000Z"
      }
    });
    expect(result).toMatchObject({ refused: true, code: "media_unaddressable" });
    expect(seen).toEqual([]);
  });
});

describe("submitForReview createDraft media", () => {
  it("passes derivedMediaRefs when they are publisher-addressable", async () => {
    const created: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created) as never);
    seed(gadget);
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      derivedMediaRefs: [{ assetId: "derived-1", kind: "image", url: "https://cdn.example.test/derived.jpg" }]
    });
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
    expect(created[0]).toMatchObject({
      media: [{ assetId: "derived-1", url: "https://cdn.example.test/derived.jpg", kind: "image" }]
    });
  });

  it("falls back to the source item media when derived refs are absent", async () => {
    const created: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created) as never);
    seed(gadget);
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字"
    });
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
    expect(created[0]).toMatchObject({
      media: [{ assetId: "source-media", url: "https://cdn.example.test/original.jpg", kind: "image" }]
    });
  });
});

describe("submitForReview rights from the ledger", () => {
  function seedPending(gadget: Gadget) {
    seed(gadget);
    gadget.storage.updateBatchItem("item-1", { rights_status: "pending", state: "held_rights" });
  }

  it("lets an original-only derived post submit without confirmRights", async () => {
    const created: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created) as never);
    seedPending(gadget);
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      refinementBrief: { visualTreatment: "ai_refinement", allowedChanges: ["price"] },
      ledger: { spans: [], media: [{ ref: "gen-1", provenance: "original" }] }
    });
    expect(gadget.projectBatchItem(gadget.storage.getBatchItem("item-1")!).rightsRequired).toBe(false);
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
    expect(created[0]).toMatchObject({
      origin: {
        provider: "instagram",
        providerItemId: "p1",
        sourceContentHash: "source-hash"
      }
    });
  });

  it("blocks a derived post that reuses the source photo until rights are confirmed", async () => {
    const created: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created) as never);
    seedPending(gadget);
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      refinementBrief: { visualTreatment: "ai_refinement" },
      ledger: { spans: [], media: [{ ref: "source-media", provenance: "source" }] }
    });
    expect(gadget.projectBatchItem(gadget.storage.getBatchItem("item-1")!).rightsRequired).toBe(true);
    const blocked = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(blocked).toMatchObject({ ok: false, code: "rights_unconfirmed" });
    await gadget.confirmRights({ batchItemId: "item-1", status: "confirmed", by: "owner" });
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
    expect(created[0]).toMatchObject({
      origin: { provider: "instagram", providerItemId: "p1", permalink: "https://www.instagram.com/p/p1/" }
    });
  });

  it("still requires confirmation for an open source even when the ledger is original-only", async () => {
    const created: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created) as never);
    seedPending(gadget);
    gadget.storage.addOpenSource({
      binding: "open:instagram:natgeo",
      platform: "instagram",
      accountKey: "natgeo",
      displayName: "@natgeo"
    });
    gadget.storage.upsertItem({
      id: "instagram:open:instagram:natgeo:p1",
      sourceBinding: "open:instagram:natgeo",
      sourceLabel: "@natgeo",
      provider: "instagram",
      providerItemId: "p1",
      text: "Original source",
      media: [{ id: "source-media", kind: "image", url: "https://cdn.example.test/original.jpg" }],
      metrics: {},
      contentHash: "source-hash",
      firstSeenAt: "2026-09-06T00:00:00.000Z",
      lastSeenAt: "2026-09-06T00:00:00.000Z"
    });
    gadget.storage.updateBatchItem("item-1", { item_id: "instagram:open:instagram:natgeo:p1" });
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      refinementBrief: { visualTreatment: "ai_refinement" },
      ledger: { spans: [], media: [{ ref: "gen-1", provenance: "original" }] }
    });
    const blocked = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(blocked).toMatchObject({ ok: false, code: "rights_unconfirmed" });
    await gadget.confirmRights({ batchItemId: "item-1", status: "confirmed", by: "owner" });
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
  });
});

describe("submitForReview attribution (TASK-015)", () => {
  it("refuses when the stored ledger stands on a source other than the observed one", async () => {
    const created: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created) as never);
    seed(gadget);
    // A localization brief never inspects the ledger's bases, and a grounded
    // brief only checks spans it detects in the caption — so a contradicting
    // basis does reach storage. Submit is where it must not reach the publisher.
    await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 0,
      caption: "第一稿內容文字",
      ledger: { spans: [{ text: "HK$99", kind: "price", basis: "source:instagram:IG_MAIN:other" }], media: [] }
    });
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).toMatchObject({ ok: false, code: "origin_contradicted" });
    expect(created).toEqual([]);
  });

  it("refuses before the door when the observation record is missing a field the door requires", async () => {
    const created: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created) as never);
    seed(gadget);
    gadget.storage.setOriginLink("item-1", {
      provider: "instagram",
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      providerItemId: "p1",
      permalink: null,
      sourceContentHash: "source-hash",
      sourcePublishedAt: "2026-09-06T00:00:00.000Z",
      retrievedAt: "2026-09-06T00:00:00.000Z"
    });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "第一稿內容文字" });
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).toMatchObject({
      ok: false,
      code: "origin_incomplete",
      message: expect.stringContaining("permalink")
    });
    expect(created).toEqual([]);
  });
});
