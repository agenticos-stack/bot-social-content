/*
 * The generated-image path end to end at the Gadget boundary:
 *
 *   requestGeneration marks the item -> saveGeneratedImage registers the
 *   platform attachment (identity + alt text, no bytes) -> the host fetches
 *   the attachment's bytes and calls deliverGeneratedImage -> the revision
 *   saved under `ai_refinement` ships those bytes through uploadMedia at
 *   submit, exactly like a stored poster.
 *
 * The assertions pin the parts the review asked for: registration never
 * satisfies the ask by itself, a delivery correlates to the ask it was
 * stamped under (a superseded ask keeps its image need), and the three
 * visual modes ship three different things at submit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";

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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 4, 6, 4, 6, 0, 0]);

function seed(gadget: Gadget, { origin = "binding" }: { origin?: string } = {}) {
  gadget.storage.setConfig({
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
    destinationBindings: ["IG_DEST"],
    state: "drafting"
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
  gadget.storage.setSources([]);
  gadget.storage.setDestinations([{ binding: "IG_DEST", label: "Instagram", provider: "instagram" }]);
  const db = (gadget.storage as any).sql;
  db.exec(
    "INSERT INTO sources (binding, label, provider, origin) VALUES ('IG_MAIN', 'Main Instagram', 'instagram', ?)",
    origin
  );
}

function mockSocial(created: unknown[], uploaded: unknown[]) {
  return {
    IG_DEST: {
      async describe() {
        return { provider: "instagram", role: "destination", resourceLabel: "Instagram", resolvedId: "crb_ig" };
      }
    },
    social: {
      async uploadMedia(input: unknown) {
        uploaded.push(input);
        return { assetId: "asset-1", url: "https://cdn.example.test/uploaded.jpg", mimeType: "image/jpeg", byteSize: 11 };
      },
      async createDraft(input: unknown) {
        created.push(input);
        return {
          postId: "post-1",
          versionId: "ver-1",
          versionNumber: 1,
          contentHash: "hash-1",
          targets: [{ destinationBinding: "IG_DEST", label: "Instagram", provider: "instagram" }]
        };
      },
      async submitForReview() {
        return { refused: true, code: "submission_required", message: "Needs owner approval.", authority: "send" };
      }
    }
  };
}

describe("generated image registration and delivery", () => {
  it("registration is pending until bytes arrive, and the delivery answers only the ask it was stamped under", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);

    const asked = await gadget.requestGeneration("batch-1", ["item-1"]);
    expect(asked).toMatchObject({ ok: true, requested: ["item-1"] });
    const firstAsk = asked.request;

    const registered = await gadget.saveGeneratedImage({
      batchItemId: "item-1",
      attachmentId: "upload-1",
      altText: "generated dark poster",
      mimeType: "image/png"
    });
    expect(registered).toMatchObject({ ok: true });
    // Registration alone must not touch the mark — only bytes do.
    let item = gadget.storage.getBatchItem("item-1");
    expect(JSON.parse(item.generation).needs).toEqual({ caption: true, image: true });
    expect((await gadget.pendingGeneratedImages()).pending.map((row: any) => row.id)).toEqual([registered.id]);

    // Supersede the ask: the still-registered image answered the OLD one.
    const reasked = await gadget.requestGeneration("batch-1", ["item-1"]);
    expect(reasked.request).not.toBe(firstAsk);

    const delivered = await gadget.deliverGeneratedImage({ id: registered.id, bytes: PNG });
    expect(delivered).toMatchObject({ ok: true, byteLength: PNG.byteLength });
    // Bytes are kept, but the newer ask's image need is NOT satisfied by a
    // delivery stamped under the superseded request.
    item = gadget.storage.getBatchItem("item-1");
    expect(JSON.parse(item.generation).needs).toEqual({ caption: true, image: true });
    // getGeneratedImage mirrors getMedia's chunked envelope — {mime, total,
    // chunk, chunks, bytes}; a missing row answers a media_missing value.
    const read = await gadget.getGeneratedImage(registered.id, {});
    expect(read).toMatchObject({ total: PNG.byteLength, chunk: 0, mime: "image/png" });
    expect((await gadget.pendingGeneratedImages()).pending).toHaveLength(0);
  });

  it("a delivery stamped under the current ask clears the image need; the caption save clears the rest", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial([], []) as never);
    seed(gadget);

    await gadget.requestGeneration("batch-1", ["item-1"]);
    const registered = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "u", altText: null });
    await gadget.deliverGeneratedImage({ id: registered.id, bytes: JPEG });
    expect(JSON.parse(gadget.storage.getBatchItem("item-1").generation).needs).toEqual({ caption: true, image: false });

    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "第一稿內容文字" });
    expect(gadget.storage.getBatchItem("item-1").generation).toBeNull();
  });
});

describe("generated image at submit", () => {
  it("ships delivered bytes through uploadMedia under ai_refinement, with the generated alt text", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);

    const registered = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "u", altText: "AI alt" });
    await gadget.deliverGeneratedImage({ id: registered.id, bytes: JPEG });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "第一稿內容文字", acceptedVisualMode: "ai_refinement" });

    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
    expect(uploaded).toHaveLength(1);
    expect((uploaded[0] as any).mimeType).toBe("image/jpeg");
    expect((created[0] as any).media[0]).toMatchObject({
      assetId: "asset-1",
      url: "https://cdn.example.test/uploaded.jpg",
      kind: "image",
      altText: "AI alt"
    });
  });

  it("refuses an Instagram-bound PNG rather than filing a format the container rejects", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);

    const registered = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "u", altText: null });
    await gadget.deliverGeneratedImage({ id: registered.id, bytes: PNG });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "第一稿內容文字", acceptedVisualMode: "ai_refinement" });

    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).toMatchObject({ ok: false, code: "generated_image_format_stale" });
    expect(created).toEqual([]);
    expect(uploaded).toEqual([]);
  });

  it("an open source with generated mode chosen but no bytes refuses as generated_image_required", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget, { origin: "open" });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "第一稿內容文字", acceptedVisualMode: "ai_refinement" });

    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).toMatchObject({ ok: false, code: "generated_image_required" });
    expect(created).toEqual([]);
  });

  // Product decision 2026-09-14: a generated-image revision never quietly
  // ships the source photograph instead — for an owned source too.
  it("an owned source with generated mode chosen but no bytes refuses and files nothing", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "第一稿內容文字", acceptedVisualMode: "ai_refinement" });

    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).toMatchObject({ ok: false, code: "generated_image_required" });
    expect(uploaded).toEqual([]);
    expect(created).toEqual([]);
  });

  it("keep_original ships the source media even when a poster is stored for the revision", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "第一稿內容文字", acceptedVisualMode: "keep_original" });
    gadget.storage.savePoster("item-1", 1, "banner", Buffer.from(PNG));

    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
    // The stored poster must NOT ship — the owner's pick was source media.
    expect(uploaded).toEqual([]);
    expect((created[0] as any).media[0]).toMatchObject({ assetId: "source-media", url: "https://cdn.example.test/original.jpg" });
  });
});
