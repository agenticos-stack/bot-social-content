/*
 * Generation continuity (QA d57d357, "existing generation acceptance risks"):
 *
 * 1. Request correlation — a registration carries the CALLER's request id,
 *    validated against the item's current mark. Late work from a superseded
 *    ask is kept as explicit stale history: it never clears the newer mark,
 *    never overwrites the newer draft, and is never auto-accepted.
 * 2. The reviewed asset is pinned on the revision — filing ships exactly the
 *    pinned bytes, whatever registered later.
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

const JPEG_B = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 9, 9, 9, 9, 0, 0]);
const CAPTION = "第一稿內容文字";

function needs(gadget: Gadget) {
  const raw = gadget.storage.getBatchItem("item-1").generation;
  return raw ? JSON.parse(raw) : null;
}

async function projected(gadget: Gadget) {
  return (await gadget.getBatch("batch-1"))!.items[0];
}

describe("generation request correlation", () => {
  it("a late registration from an older request is stale history: it clears nothing and is not accepted", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial([], []) as never);
    seed(gadget);

    const oldAsk = (await gadget.requestGeneration("batch-1", ["item-1"])).request;
    // A pending request is serialized: superseding it is an explicit replace.
    const newAsk = (await gadget.requestGeneration("batch-1", ["item-1"], { replace: true })).request;
    expect(newAsk).not.toBe(oldAsk);

    const late = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "old", generationRequest: oldAsk });
    expect(late).toMatchObject({ ok: true, generationRequest: oldAsk, stale: true });
    const row = gadget.storage.getGeneratedMedia(late.id);
    expect(row).toMatchObject({ generationRequest: oldAsk, stale: true });
    expect(row.generationRequest).not.toBe(needs(gadget).id);

    // Late byte delivery for the older request: bytes kept, newer mark untouched.
    expect(await gadget.deliverGeneratedImage({ id: late.id, bytes: JPEG })).toMatchObject({ ok: true });
    expect(needs(gadget)).toMatchObject({ id: newAsk, needs: { caption: true, image: true } });

    // Never auto-accepted: switching to ai_refinement pins nothing stale.
    const saved = await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement" });
    expect(saved).toMatchObject({ ok: true, revision: 1 });
    expect(gadget.storage.getRevision("item-1", 1).acceptedGeneratedMediaId).toBeNull();
    const item = await projected(gadget);
    expect(item.generatedImage).toBeNull();
    // Stale rows are not offered as the candidate either.
    expect(item.generatedCandidate).toBeNull();
  });

  it("late caption/poster writes from an older request are refused and do not overwrite the newer draft", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial([], []) as never);
    seed(gadget);
    const oldAsk = (await gadget.requestGeneration("batch-1", ["item-1"])).request;
    const newAsk = (await gadget.requestGeneration("batch-1", ["item-1"], { replace: true })).request;

    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: "新的內容文字", generationRequest: newAsk })).toMatchObject({ ok: true, revision: 1 });
    const stale = await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, caption: "舊的內容文字", generationRequest: oldAsk });
    expect(stale).toMatchObject({ ok: false, issues: [{ code: "generation_request_stale" }] });
    const batched = await gadget.saveRevisions({ revisions: [{ batchItemId: "item-1", expectedRevision: 1, caption: "舊的內容文字", generationRequest: oldAsk }] });
    expect(batched).toMatchObject({ ok: false, results: [{ ok: false, issues: [{ code: "generation_request_stale" }] }] });
    const poster = await gadget.savePoster({ batchItemId: "item-1", expectedRevision: 1, template: "square", png: PNG, generationRequest: oldAsk });
    expect(poster).toMatchObject({ ok: false, issues: [{ code: "generation_request_stale" }] });

    expect(gadget.storage.getBatchItem("item-1").currentRevision).toBe(1);
    expect(gadget.storage.latestRevision("item-1").caption).toBe("新的內容文字");
    expect(needs(gadget)).toMatchObject({ id: newAsk, needs: { caption: false, image: true } });
  });

  it("a registration without a request id is not attributed to the pending mark", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial([], []) as never);
    seed(gadget);
    const ask = (await gadget.requestGeneration("batch-1", ["item-1"])).request;

    const anon = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "anon" });
    expect(anon).toMatchObject({ ok: true, generationRequest: null, stale: false });
    expect(gadget.storage.getGeneratedMedia(anon.id).generationRequest).toBeNull();
    await gadget.deliverGeneratedImage({ id: anon.id, bytes: JPEG });
    expect(needs(gadget)).toMatchObject({ id: ask, needs: { caption: true, image: true } });
  });

  it("a registration echoing the current request is correlated and its delivery clears the image need", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial([], []) as never);
    seed(gadget);
    const ask = (await gadget.requestGeneration("batch-1", ["item-1"])).request;
    const current = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "cur", generationRequest: ask });
    expect(current).toMatchObject({ ok: true, generationRequest: ask, stale: false });
    await gadget.deliverGeneratedImage({ id: current.id, bytes: JPEG });
    expect(needs(gadget)).toMatchObject({ id: ask, needs: { caption: true, image: false } });
    expect(gadget.storage.getGeneratedMedia(current.id).contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("the reviewed generated asset is pinned on the revision", () => {
  async function acceptedFirstImage(gadget: Gadget) {
    const first = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "first", altText: "first alt" });
    await gadget.deliverGeneratedImage({ id: first.id, bytes: JPEG });
    // A registration with no request id is legacy: implicit selection never
    // picks it, so the owner names it explicitly.
    const saved = await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: first.id });
    expect(saved).toMatchObject({ ok: true, revision: 1 });
    return first.id as string;
  }

  it("a newer registration and delivery do not change the accepted image, and filing uploads the pinned bytes", async () => {
    const created: unknown[] = [];
    const uploaded: any[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);
    const firstId = await acceptedFirstImage(gadget);

    const newer = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "second", altText: "second alt" });
    let item = await projected(gadget);
    expect(item.generatedImage).toMatchObject({ id: firstId, ready: true, altText: "first alt", mimeType: "image/jpeg" });
    expect(item.generatedImage.digest).toMatch(/^sha256:/);
    expect(item.generatedCandidate).toMatchObject({ id: newer.id, ready: false });

    await gadget.deliverGeneratedImage({ id: newer.id, bytes: JPEG_B });
    item = await projected(gadget);
    expect(item.generatedImage.id).toBe(firstId);
    expect(item.generatedCandidate).toMatchObject({ id: newer.id, ready: true });
    expect(item.revision).toBe(1);

    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).not.toMatchObject({ ok: false });
    expect(uploaded).toHaveLength(1);
    expect(Buffer.from(uploaded[0].dataBase64, "base64")).toEqual(Buffer.from(JPEG));
    expect((created[0] as any).media[0]).toMatchObject({ altText: "first alt" });
  });

  it("a caption-only save carries the pinned asset forward unchanged", async () => {
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial([], []) as never);
    seed(gadget);
    const firstId = await acceptedFirstImage(gadget);
    const newer = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "second" });
    await gadget.deliverGeneratedImage({ id: newer.id, bytes: JPEG_B });

    // Omitted mode, and a re-sent ai_refinement mode: neither swaps the image.
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, caption: "第二稿內容文字" })).toMatchObject({ ok: true, revision: 2 });
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 2, caption: "第三稿內容文字", acceptedVisualMode: "ai_refinement" })).toMatchObject({ ok: true, revision: 3 });
    const r1 = gadget.storage.getRevision("item-1", 1);
    const r3 = gadget.storage.getRevision("item-1", 3);
    expect(gadget.storage.getRevision("item-1", 2).acceptedGeneratedMediaId).toBe(firstId);
    expect(r3.acceptedGeneratedMediaId).toBe(firstId);
    expect(r3.acceptedGeneratedMediaDigest).toBe(r1.acceptedGeneratedMediaDigest);
  });

  it("selecting a different image advances the revision; a foreign or undelivered id refuses", async () => {
    const uploaded: any[] = [];
    const { ctx } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial([], uploaded) as never);
    seed(gadget);
    await acceptedFirstImage(gadget);
    const pending = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "pending" });
    expect(
      await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: pending.id })
    ).toMatchObject({ ok: false, issues: [{ code: "generated_media_invalid" }] });
    expect(
      await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: "gm_nope" })
    ).toMatchObject({ ok: false, issues: [{ code: "generated_media_invalid" }] });

    await gadget.deliverGeneratedImage({ id: pending.id, bytes: JPEG_B });
    const picked = await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: pending.id });
    expect(picked).toMatchObject({ ok: true, revision: 2 });
    const item = await projected(gadget);
    expect(item.generatedImage.id).toBe(pending.id);
    expect(item.generatedCandidate).toBeNull();

    expect(await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 2 })).not.toMatchObject({ ok: false });
    expect(Buffer.from(uploaded[0].dataBase64, "base64")).toEqual(Buffer.from(JPEG_B));
  });

  it("refuses to file when the pinned asset's bytes no longer match the reviewed digest", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const { ctx, db } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);
    const firstId = await acceptedFirstImage(gadget);
    // A re-delivery with different bytes is refused (G4); the digest check at
    // filing still catches bytes changed underneath the revision.
    expect(await gadget.deliverGeneratedImage({ id: firstId, bytes: JPEG_B })).toMatchObject({ ok: false, issues: [{ code: "generated_media_immutable" }] });
    db.prepare("UPDATE generated_media SET bytes = ? WHERE id = ?").run(JPEG_B, firstId);

    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).toMatchObject({ ok: false, code: "generated_image_changed" });
    expect(uploaded).toEqual([]);
    expect(created).toEqual([]);
  });

  it("refuses generated_image_required when the pinned row is missing", async () => {
    const created: unknown[] = [];
    const { ctx, db } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, []) as never);
    seed(gadget);
    const firstId = await acceptedFirstImage(gadget);
    db.prepare("DELETE FROM generated_media WHERE id = ?").run(firstId);
    const result = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });
    expect(result).toMatchObject({ ok: false, code: "generated_image_required" });
    expect(created).toEqual([]);
  });
});

describe("migration 16 (no longer guesses)", () => {
  it("leaves a historical ai_refinement revision unpinned; filing asks for review until the owner re-accepts", async () => {
    const created: unknown[] = [];
    const uploaded: any[] = [];
    const { ctx, db } = sqliteContext();
    const gadget = new Gadget(ctx as never, mockSocial(created, uploaded) as never);
    seed(gadget);

    // Rewind to a schema-15 database holding a legacy ai_refinement revision.
    for (const [table, column] of [
      ["batch_items", "instruction_overrides"],
      ["batch_items", "last_generation"],
      ["generated_media", "stale"],
      ["generated_media", "content_digest"],
      ["generated_media", "derived_from"],
      ["revisions", "accepted_generated_media_id"],
      ["revisions", "accepted_generated_media_digest"],
      ["revisions", "accepted_generated_media_provenance"],
      ["revisions", "accepted_generated_media_source"],
      ["revisions", "alt_text"],
      ["publications", "last_checked_at"],
      ["publications", "provider_id"],
      ["publications", "receipt_url"]
    ]) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    db.exec("UPDATE schema_version SET version = 15");
    db.prepare(
      "INSERT INTO generated_media (id, batch_item_id, attachment_id, mime_type, bytes, byte_length, created_at, delivered_at) VALUES (?, 'item-1', 'a', 'image/jpeg', ?, ?, '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:01.000Z')"
    ).run("gm_old", JPEG, JPEG.byteLength);
    db.prepare(
      "INSERT INTO generated_media (id, batch_item_id, attachment_id, created_at) VALUES ('gm_pending', 'item-1', 'b', '2026-09-11T00:00:00.000Z')"
    ).run();
    db.prepare(
      "INSERT INTO revisions (batch_item_id, revision, caption, accepted_visual_mode, created_at) VALUES ('item-1', 1, ?, 'ai_refinement', '2026-09-10T00:00:02.000Z')"
    ).run(CAPTION);
    db.prepare("UPDATE batch_items SET current_revision = 1 WHERE id = 'item-1'").run();

    expect(gadget.storage.migrate()).toBe(18);
    expect(gadget.storage.getRevision("item-1", 1)).toMatchObject({
      acceptedGeneratedMediaId: null,
      acceptedGeneratedMediaDigest: null,
      acceptedGeneratedMediaProvenance: null
    });

    let item = await projected(gadget);
    expect(item.generatedImage).toBeNull();
    expect(item.generatedHistory.map((row: any) => [row.id, row.status])).toEqual([
      ["gm_pending", "legacy"],
      ["gm_old", "legacy"]
    ]);

    expect(await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 })).toMatchObject({
      ok: false,
      code: "generated_image_review_required"
    });
    expect(uploaded).toEqual([]);

    const reaccepted = await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: "gm_old" });
    expect(reaccepted).toMatchObject({ ok: true, revision: 2 });
    item = await projected(gadget);
    expect(item.revisionHistory.at(-1)).toMatchObject({ acceptanceSource: "owner_explicit", acceptedGeneratedMediaProvenance: "recorded" });
    expect(await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 2 })).not.toMatchObject({ ok: false });
    expect(Buffer.from(uploaded[0].dataBase64, "base64")).toEqual(Buffer.from(JPEG));
  });
});
