/*
 * Audit 5ccaff1 (design-plans/evidence/social-content-5ccaff1-review) G1–G4,
 * against the real server and real node:sqlite storage.
 *
 * - G1: a mark's `scope` (what was requested) is immutable; `needs` (what
 *   remains) shrinks. Authorization reads scope; completion clears needs.
 * - Overlap: a pending request is refused `generation_pending` unless replaced.
 * - G2: a generated row's status is derived from current data at delivery,
 *   candidate projection, implicit selection and completion.
 * - G3: provenance of migrated pins is unknown, never guessed.
 * - G4: delivered bytes are immutable; conversions are new derived rows.
 * - Drawer contracts: revision alt text, publication check metadata, thumbnail.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";

type Sqlite = {
  exec(sql: string): void;
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown; get(...args: unknown[]): unknown };
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
      if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
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
const JPEG_A = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 4, 6, 4, 6, 0, 0]);
const JPEG_B = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 9, 9, 9, 9, 0, 0]);
const JPEG_C = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 7, 7, 7, 7, 0, 0]);
const CAPTION = "第一稿內容文字";
const CAPTION_2 = "第二稿內容文字";

type Env = { created: any[]; uploaded: any[]; statusReads: any[] };

function mockEnv(env: Env) {
  return {
    IG_DEST: {
      async describe() {
        return { provider: "instagram", role: "destination", resourceLabel: "Instagram", resolvedId: "crb_ig" };
      }
    },
    social: {
      async uploadMedia(input: unknown) {
        env.uploaded.push(input);
        return { assetId: "asset-1", url: "https://cdn.example.test/uploaded.jpg", mimeType: "image/jpeg", byteSize: 11 };
      },
      async createDraft(input: unknown) {
        env.created.push(input);
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
      },
      async readStatus() {
        return env.statusReads.shift() ?? null;
      }
    }
  };
}

function setup({ bound = true, ctx: existing }: { bound?: boolean; ctx?: ReturnType<typeof sqliteContext> } = {}) {
  const context = existing ?? sqliteContext();
  const env: Env = { created: [], uploaded: [], statusReads: [] };
  const gadget = new Gadget(context.ctx as never, mockEnv(env) as never);
  if (!existing) {
    gadget.storage.setConfig({ protectedTerms: [], protectedHashtags: [], disclaimers: [], claimsRequiringConfirmation: [] });
    gadget.storage.upsertItem({
      id: "instagram:IG_MAIN:p1",
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      provider: "instagram",
      providerItemId: "p1",
      text: "Original source",
      media: [{ id: "source-media", kind: "image", url: "https://cdn.example.test/original.jpg", altText: "source alt" }],
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
      destinationBindings: bound ? ["IG_DEST"] : [],
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
    gadget.storage.setDestinations([{ binding: "IG_DEST", label: "Instagram", provider: "instagram" }]);
    context.db
      .prepare("INSERT INTO sources (binding, label, provider, origin) VALUES ('IG_MAIN', 'Main Instagram', 'instagram', 'binding')")
      .run();
  }
  return { gadget, env, context };
}

const mark = (gadget: Gadget) => {
  const raw = gadget.storage.getBatchItem("item-1").generation;
  return raw ? JSON.parse(raw) : null;
};
const itemOf = async (gadget: Gadget) => (await gadget.getBatch("batch-1"))!.items[0] as Record<string, any>;
const statusOf = async (gadget: Gadget, id: string) =>
  (await itemOf(gadget)).generatedHistory.find((row: any) => row.id === id);

async function imageFor(gadget: Gadget, request: string | undefined, bytes = JPEG_A, extra: Record<string, unknown> = {}) {
  const registered = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: `up-${Math.random()}`, generationRequest: request, ...extra });
  expect(registered).toMatchObject({ ok: true });
  return registered.id as string;
}

describe("G1 — requested scope is immutable, remaining needs shrink", () => {
  it("image first, then the correlated caption save that accepts it (the audit probe's order)", async () => {
    const { gadget } = setup();
    const ask = await gadget.requestGeneration("batch-1", ["item-1"]);
    const image = await imageFor(gadget, ask.request);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    expect(mark(gadget)).toMatchObject({ id: ask.request, scope: { caption: true, image: true }, needs: { caption: true, image: false } });

    const saved = await gadget.saveRevision({
      batchItemId: "item-1", expectedRevision: 0, caption: CAPTION,
      acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: image, generationRequest: ask.request
    });
    expect(saved).toMatchObject({ ok: true, revision: 1, generation: null });
    expect(gadget.storage.getRevision("item-1", 1)).toMatchObject({ acceptedGeneratedMediaId: image, acceptanceSource: "generation", acceptedGeneratedMediaProvenance: "recorded" });
    expect((await itemOf(gadget)).lastGeneration).toMatchObject({ scope: { caption: true, image: true } });
  });

  it("caption first, then the image; the delivered candidate is picked implicitly by an ai_refinement save", async () => {
    const { gadget } = setup();
    const ask = await gadget.requestGeneration("batch-1", ["item-1"]);
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, generationRequest: ask.request })).toMatchObject({
      ok: true, generation: { scope: { caption: true, image: true }, needs: { caption: false, image: true } }
    });
    const image = await imageFor(gadget, ask.request);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    expect(mark(gadget)).toBeNull();
    expect((await statusOf(gadget, image)).status).toBe("candidate");

    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement" })).toMatchObject({ ok: true, revision: 2 });
    expect(gadget.storage.getRevision("item-1", 2)).toMatchObject({ acceptedGeneratedMediaId: image, acceptanceSource: "generation" });
  });

  it("image-only and caption-only requests authorize only their own part", async () => {
    const { gadget } = setup();
    const imageOnly = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { image: true } });
    const image = await imageFor(gadget, imageOnly.request);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    expect(mark(gadget)).toBeNull();
    expect((await itemOf(gadget)).lastGeneration).toMatchObject({ scope: { image: true, caption: false } });

    const captionOnly = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { caption: true } });
    const swap = await gadget.saveRevision({
      batchItemId: "item-1", expectedRevision: 0, caption: CAPTION,
      acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: image, generationRequest: captionOnly.request
    });
    expect(swap).toMatchObject({ ok: false, issues: [{ code: "generation_part_not_requested" }] });
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, generationRequest: captionOnly.request })).toMatchObject({ ok: true, generation: null });
  });

  it("duplicate registration, delivery and save complete nothing twice", async () => {
    const { gadget } = setup();
    const ask = await gadget.requestGeneration("batch-1", ["item-1"]);
    const image = await imageFor(gadget, ask.request);
    expect(await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A })).toMatchObject({ ok: true });
    expect(await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A })).toMatchObject({ ok: true, unchanged: true });
    expect(mark(gadget)).toMatchObject({ needs: { caption: true, image: false } });

    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, generationRequest: ask.request })).toMatchObject({ ok: true, generation: null });
    // Replays after completion: refused by value, nothing re-completed.
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, caption: CAPTION_2, generationRequest: ask.request })).toMatchObject({ ok: false, issues: [{ code: "generation_request_stale" }] });
    const again = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "dup", generationRequest: ask.request });
    expect(again).toMatchObject({ ok: true, stale: true });
    expect(await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A })).toMatchObject({ ok: true, unchanged: true });
    expect(gadget.storage.getBatchItem("item-1").currentRevision).toBe(1);
  });

  it("retry after partial completion, and a part that never arrives keeps the mark on that part", async () => {
    const { gadget } = setup();
    const ask = await gadget.requestGeneration("batch-1", ["item-1"]);
    const image = await imageFor(gadget, ask.request);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    // First caption attempt loses a revision race; the retry still counts.
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 5, caption: CAPTION, generationRequest: ask.request })).toMatchObject({ ok: false, issues: [{ code: "revision_conflict" }] });
    expect(mark(gadget)).toMatchObject({ needs: { caption: true, image: false } });
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, generationRequest: ask.request })).toMatchObject({ ok: true, generation: null });

    const both = await gadget.requestGeneration("batch-1", ["item-1"]);
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, caption: CAPTION_2, generationRequest: both.request })).toMatchObject({ ok: true });
    expect(mark(gadget)).toMatchObject({ id: both.request, scope: { caption: true, image: true }, needs: { caption: false, image: true } });
    expect((await itemOf(gadget)).phase).toBe("regenerating");
  });

  it("owner edits while a request is pending are not scope-limited and complete nothing", async () => {
    const { gadget } = setup();
    const pinned = await imageFor(gadget, undefined);
    await gadget.deliverGeneratedImage({ id: pinned, bytes: JPEG_A });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: pinned });
    const ask = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { image: true } });

    // A manual caption edit while the image request is pending.
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, caption: CAPTION_2 })).toMatchObject({ ok: true, generation: { id: ask.request, needs: { image: true } } });
    // A manual visual change on a caption-less request is not refused either.
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 2, acceptedVisualMode: "keep_original" })).toMatchObject({ ok: true });
    expect(mark(gadget)).toMatchObject({ id: ask.request, needs: { image: true, caption: false } });
  });
});

describe("overlapping requests are serialized", () => {
  it("refuses a second request on a pending post, names the pending one, and replaces only on replace:true", async () => {
    const { gadget } = setup();
    const first = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { image: true } });
    const refused = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { caption: true } });
    expect(refused).toMatchObject({
      ok: false,
      code: "generation_pending",
      pending: { requestId: first.request, scope: { image: true, caption: false }, needs: { image: true, caption: false } }
    });
    expect(mark(gadget).id).toBe(first.request);
    // The batch-level form refuses the same way rather than merging.
    expect(await gadget.requestGeneration("batch-1")).toMatchObject({ ok: false, code: "generation_pending" });

    const oldImage = await imageFor(gadget, first.request);
    const replaced = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { caption: true }, replace: true });
    expect(replaced).toMatchObject({ ok: true, replaced: [{ batchItemId: "item-1", requestId: first.request }] });
    expect(mark(gadget)).toMatchObject({ id: replaced.request, scope: { caption: true, image: false } });
    expect(await statusOf(gadget, oldImage)).toMatchObject({ status: "superseded", stale: true, generationRequest: first.request });
  });

  it("a finished request needs no replace", async () => {
    const { gadget } = setup();
    const first = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { caption: true } });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, generationRequest: first.request });
    expect(await gadget.requestGeneration("batch-1", ["item-1"])).toMatchObject({ ok: true });
  });
});

describe("G2 — freshness is derived at every step", () => {
  it("audit probe, corrected: A registered → B requested (replace) → A delivered is superseded and never auto-accepted", async () => {
    const { gadget } = setup();
    const a = await gadget.requestGeneration("batch-1", ["item-1"]);
    const image = await imageFor(gadget, a.request);
    const b = await gadget.requestGeneration("batch-1", ["item-1"], { replace: true });
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });

    const row = await statusOf(gadget, image);
    expect(row).toMatchObject({ generationRequest: a.request, status: "superseded", stale: true });
    expect(mark(gadget)).toMatchObject({ id: b.request, needs: { image: true, caption: true } });
    expect((await itemOf(gadget)).generatedCandidate).toBeNull();

    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement" })).toMatchObject({ ok: true });
    expect(gadget.storage.latestRevision("item-1").acceptedGeneratedMediaId).toBeNull();
  });

  it("A requested → B requested → A registered and delivered: stale at registration, completes nothing", async () => {
    const { gadget } = setup();
    const a = await gadget.requestGeneration("batch-1", ["item-1"]);
    const b = await gadget.requestGeneration("batch-1", ["item-1"], { replace: true });
    const image = await imageFor(gadget, a.request);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    expect(await statusOf(gadget, image)).toMatchObject({ status: "superseded", generationRequest: a.request });
    expect(mark(gadget)).toMatchObject({ id: b.request, needs: { image: true } });
  });

  it("B completed → A delivered: A stays superseded; B is the candidate; explicit owner acceptance of A is allowed and recorded", async () => {
    const { gadget } = setup();
    const a = await gadget.requestGeneration("batch-1", ["item-1"]);
    const imageA = await imageFor(gadget, a.request, JPEG_A);
    const b = await gadget.requestGeneration("batch-1", ["item-1"], { replace: true });
    const imageB = await imageFor(gadget, b.request, JPEG_B);
    await gadget.deliverGeneratedImage({ id: imageB, bytes: JPEG_B });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, generationRequest: b.request });
    expect(mark(gadget)).toBeNull();

    await gadget.deliverGeneratedImage({ id: imageA, bytes: JPEG_A });
    let item = await itemOf(gadget);
    expect(item.generatedHistory.find((row: any) => row.id === imageA)).toMatchObject({ status: "superseded", stale: true });
    expect(item.generatedCandidate).toMatchObject({ id: imageB, status: "candidate", stale: false });

    // Correlated to B, naming A: not this request's result.
    const b2 = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { image: true } });
    expect(
      await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: imageA, generationRequest: b2.request })
    ).toMatchObject({ ok: false, issues: [{ code: "generated_media_not_current" }] });

    // The owner's explicit choice.
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: imageA })).toMatchObject({ ok: true, revision: 2 });
    item = await itemOf(gadget);
    expect(item.generatedImage).toMatchObject({ id: imageA, status: "accepted" });
    expect(item.revisionHistory.at(-1)).toMatchObject({ acceptedGeneratedMediaId: imageA, acceptanceSource: "owner_explicit" });
    expect(item.generation).toMatchObject({ id: b2.request, needs: { image: true } });
  });

  it("stale caption save after a newer request is refused generation_request_stale", async () => {
    const { gadget } = setup();
    const a = await gadget.requestGeneration("batch-1", ["item-1"]);
    await gadget.requestGeneration("batch-1", ["item-1"], { replace: true });
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, generationRequest: a.request })).toMatchObject({
      ok: false, issues: [{ code: "generation_request_stale" }]
    });
  });

  it("a legacy registration (no request id) is labelled legacy and never picked implicitly", async () => {
    const { gadget } = setup();
    const image = await imageFor(gadget, undefined);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    expect(await statusOf(gadget, image)).toMatchObject({ status: "legacy", generationRequest: null });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement" });
    expect(gadget.storage.latestRevision("item-1").acceptedGeneratedMediaId).toBeNull();
  });
});

describe("G3 — migrated pins are provenance-unknown, never re-guessed", () => {
  function rewindTo17(db: Sqlite) {
    for (const [table, column] of [
      ["revisions", "accepted_generated_media_provenance"],
      ["revisions", "accepted_generated_media_source"],
      ["revisions", "alt_text"],
      ["generated_media", "derived_from"],
      ["publications", "last_checked_at"],
      ["publications", "provider_id"],
      ["publications", "receipt_url"]
    ]) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    db.exec("UPDATE schema_version SET version = 17");
  }

  it("a schema-17 database with guessed pins becomes unknown; recorded pins, receipts and content are untouched; replay is idempotent", async () => {
    const { gadget, env, context } = setup();
    const sqlite = context.db;
    const raw = context.ctx;

    const insertImage = (id: string, bytes: Uint8Array | null, createdAt: string, digest: string | null) =>
      sqlite.prepare(
        "INSERT INTO generated_media (id, batch_item_id, attachment_id, mime_type, bytes, byte_length, content_digest, created_at, delivered_at) VALUES (?, 'item-1', ?, 'image/jpeg', ?, ?, ?, ?, ?)"
      ).run(id, id, bytes, bytes ? bytes.byteLength : null, digest, createdAt, bytes ? createdAt : null);
    rewindTo17(sqlite);
    // Images over time; the newest registration still awaits bytes.
    insertImage("gm_1", JPEG_A, "2026-09-01T00:00:00.000Z", null);
    insertImage("gm_2", JPEG_B, "2026-09-03T00:00:00.000Z", null);
    insertImage("gm_3", null, "2026-09-05T00:00:00.000Z", null);
    // Old migration 16 guessed gm_2 (newest delivered) for BOTH historical
    // revisions, digest NULL; revision 3 was pinned at runtime with a digest.
    const digestB = "sha256:" + (await import("node:crypto")).createHash("sha256").update(JPEG_B).digest("hex");
    for (const [revision, id, digest] of [[1, "gm_2", null], [2, "gm_2", null], [3, "gm_2", digestB]] as const) {
      sqlite.prepare(
        "INSERT INTO revisions (batch_item_id, revision, caption, accepted_visual_mode, accepted_generated_media_id, accepted_generated_media_digest, created_at) VALUES ('item-1', ?, ?, 'ai_refinement', ?, ?, ?)"
      ).run(revision, `${CAPTION}${revision}`, id, digest, `2026-09-0${revision}T12:00:00.000Z`);
    }
    sqlite.prepare("UPDATE batch_items SET current_revision = 3 WHERE id = 'item-1'").run();
    sqlite.prepare(
      "INSERT INTO publications (id, batch_item_id, destination_binding, revision, intent_json, state, approval_id, post_id, version, created_at, updated_at) VALUES ('pub_old', 'item-1', 'IG_DEST', 1, '{}', 'published', 'appr', 'post-9', 'ver-9', '2026-09-02', '2026-09-02')"
    ).run();
    const before = {
      revisions: sqlite.prepare("SELECT batch_item_id, revision, caption, accepted_visual_mode, accepted_generated_media_id, accepted_generated_media_digest, created_at FROM revisions ORDER BY revision").all(),
      publications: sqlite.prepare("SELECT * FROM publications ORDER BY id").all()
    };

    expect(gadget.storage.migrate()).toBe(18);
    expect(gadget.storage.getRevision("item-1", 1)).toMatchObject({ acceptedGeneratedMediaId: "gm_2", acceptedGeneratedMediaProvenance: "unknown" });
    expect(gadget.storage.getRevision("item-1", 2)).toMatchObject({ acceptedGeneratedMediaId: "gm_2", acceptedGeneratedMediaProvenance: "unknown" });
    expect(gadget.storage.getRevision("item-1", 3)).toMatchObject({ acceptedGeneratedMediaId: "gm_2", acceptedGeneratedMediaProvenance: "recorded" });
    const after = {
      revisions: sqlite.prepare("SELECT batch_item_id, revision, caption, accepted_visual_mode, accepted_generated_media_id, accepted_generated_media_digest, created_at FROM revisions ORDER BY revision").all(),
      publications: sqlite.prepare("SELECT id, batch_item_id, destination_binding, revision, intent_json, state, approval_id, post_id, version, created_at, updated_at FROM publications ORDER BY id").all()
    };
    expect(after).toEqual(before);

    // Repeated startup (and a new Gadget on the same database) changes nothing.
    expect(gadget.storage.migrate()).toBe(18);
    const reloaded = new Gadget(raw as never, mockEnv(env) as never);
    expect(reloaded.storage.getRevision("item-1", 1).acceptedGeneratedMediaProvenance).toBe("unknown");

    // Filing an unknown-provenance revision refuses; the thumbnail is withheld.
    sqlite.prepare("UPDATE batch_items SET current_revision = 2 WHERE id = 'item-1'").run();
    sqlite.prepare("DELETE FROM revisions WHERE revision = 3").run();
    expect(await reloaded.submitForReview({ batchItemId: "item-1", expectedRevision: 2 })).toMatchObject({ ok: false, code: "generated_image_review_required" });
    expect(env.uploaded).toEqual([]);
    const item = await itemOf(reloaded);
    expect(item.acceptedGeneratedMediaProvenance).toBe("unknown");
    expect(item.outputThumbnail).toBeNull();
    expect(item.generatedHistory.find((row: any) => row.id === "gm_3")).toMatchObject({ ready: false });
    // A caption-only save carries the unknown provenance forward; it does not launder it.
    expect(await reloaded.saveRevision({ batchItemId: "item-1", expectedRevision: 2, caption: CAPTION_2 })).toMatchObject({ ok: true, revision: 3 });
    expect(reloaded.storage.getRevision("item-1", 3).acceptedGeneratedMediaProvenance).toBe("unknown");
    // Re-acceptance writes a new, recorded revision that files.
    expect(await reloaded.saveRevision({ batchItemId: "item-1", expectedRevision: 3, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: "gm_2" })).toMatchObject({ ok: true, revision: 4 });
    expect(await reloaded.submitForReview({ batchItemId: "item-1", expectedRevision: 4 })).not.toMatchObject({ ok: false });
    // The new filing retires the older row for the same destination as any
    // filing does; its receipt identifiers are kept as history.
    expect(sqlite.prepare("SELECT state, post_id, version FROM publications WHERE id = 'pub_old'").get()).toEqual({ state: "superseded", post_id: "post-9", version: "ver-9" });
  });

  it("a pin whose asset row is missing still refuses generated_image_required", async () => {
    const { gadget, context } = setup();
    const image = await imageFor(gadget, undefined);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: image });
    context.db.prepare("DELETE FROM generated_media WHERE id = ?").run(image);
    expect(await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 })).toMatchObject({ ok: false, code: "generated_image_required" });
  });
});

describe("G4 — delivered assets are immutable; conversions are derived rows", () => {
  it("PNG accepted → JPEG copy derived and accepted in a new revision → files the JPEG, destination picked after drafting, pins survive reload", async () => {
    const { gadget, env, context } = setup({ bound: false });
    const ask = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { image: true } });
    const png = await imageFor(gadget, ask.request, PNG, { altText: "generated alt" });
    await gadget.deliverGeneratedImage({ id: png, bytes: PNG });
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: png })).toMatchObject({ ok: true, revision: 1 });

    const refused = await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1, destinationBindings: ["IG_DEST"] });
    expect(refused).toMatchObject({ ok: false, code: "generated_image_format_stale" });
    expect(refused.message).toMatch(/JPEG copy/);

    // Different bytes to the delivered PNG row are refused, pinned or not.
    expect(await gadget.deliverGeneratedImage({ id: png, bytes: JPEG_A })).toMatchObject({ ok: false, issues: [{ code: "generated_media_immutable" }] });

    const copy = await gadget.saveDerivedGeneratedImage({ sourceMediaId: png, bytes: JPEG_A, mimeType: "image/jpeg" });
    expect(copy).toMatchObject({ ok: true, mimeType: "image/jpeg", reused: false });
    const again = await gadget.saveDerivedGeneratedImage({ sourceMediaId: png, bytes: JPEG_A });
    expect(again).toMatchObject({ ok: true, id: copy.id, reused: true });
    expect(gadget.storage.getGeneratedMedia(copy.id)).toMatchObject({ derivedFrom: png, generationRequest: ask.request, altText: "generated alt", mimeType: "image/jpeg" });
    expect(gadget.storage.getGeneratedMedia(png).bytes).toEqual(PNG);
    expect(await gadget.saveDerivedGeneratedImage({ sourceMediaId: png, bytes: new Uint8Array([1, 2, 3]) })).toMatchObject({ ok: false, issues: [{ code: "generated_media_not_image" }] });

    // Not accepted implicitly; accepted explicitly in a new revision.
    expect(gadget.storage.latestRevision("item-1").acceptedGeneratedMediaId).toBe(png);
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: copy.id })).toMatchObject({ ok: true, revision: 2 });

    const reloaded = new Gadget(context.ctx as never, mockEnv(env) as never);
    expect(reloaded.storage.getRevision("item-1", 1).acceptedGeneratedMediaId).toBe(png);
    expect(reloaded.storage.getRevision("item-1", 2).acceptedGeneratedMediaId).toBe(copy.id);

    const filed = await reloaded.submitForReview({ batchItemId: "item-1", expectedRevision: 2, destinationBindings: ["IG_DEST"] });
    expect(filed).not.toMatchObject({ ok: false });
    expect(env.uploaded).toHaveLength(1);
    expect(env.uploaded[0].mimeType).toBe("image/jpeg");
    expect(Buffer.from(env.uploaded[0].dataBase64, "base64")).toEqual(Buffer.from(JPEG_A));
  });

  it("a JPEG delivery files directly, and the digest check at filing still refuses bytes changed underneath", async () => {
    const { gadget, env, context } = setup();
    const image = await imageFor(gadget, undefined);
    expect(await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A })).toMatchObject({ ok: true });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: image });
    context.db.prepare("UPDATE generated_media SET bytes = ? WHERE id = ?").run(JPEG_C, image);
    expect(await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 })).toMatchObject({ ok: false, code: "generated_image_changed" });
    expect(env.uploaded).toEqual([]);
  });
});

describe("drawer data contracts", () => {
  it("revision alt text is stored, carried on caption-only saves, validated, and filed before the asset's", async () => {
    const { gadget, env } = setup();
    const image = await imageFor(gadget, undefined, JPEG_A, { altText: "asset alt" });
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: image, altText: "owner alt" })).toMatchObject({ ok: true });
    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, caption: CAPTION_2 })).toMatchObject({ ok: true, revision: 2 });
    expect((await itemOf(gadget)).altText).toBe("owner alt");
    expect(await gadget.saveRevisions({ revisions: [{ batchItemId: "item-1", expectedRevision: 2, altText: "x".repeat(1001) }] })).toMatchObject({ ok: false, results: [{ issues: [{ code: "alt_text_invalid" }] }] });

    expect(await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 2 })).not.toMatchObject({ ok: false });
    expect(env.created[0].media[0]).toMatchObject({ altText: "owner alt" });

    expect(await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 2, altText: null })).toMatchObject({ ok: true, revision: 3 });
    expect((await itemOf(gadget)).altText).toBeNull();
  });

  it("publication checks persist lastCheckedAt and receipt ids, and a later empty read keeps the confirmed receipt", async () => {
    const { gadget, env } = setup();
    const image = await imageFor(gadget, undefined);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: image });
    await gadget.submitForReview({ batchItemId: "item-1", expectedRevision: 1 });

    let filed = (await itemOf(gadget)).publications.find((row: any) => row.state === "review_requested");
    expect(filed).toMatchObject({ lastCheckedAt: null, receipt: { postId: "post-1", version: "ver-1", providerId: null, url: null } });

    env.statusReads.push({ targets: [{ destinationBinding: "IG_DEST", outcome: "published", receiptUrl: "https://instagram.com/p/xyz", providerPostId: "ig-123" }] });
    let state = await gadget.readPublishState("item-1");
    filed = state.publications.find((row: any) => row.id === filed.id);
    expect(filed.lastCheckedAt).toEqual(expect.any(String));
    expect(filed.receipt).toEqual({ postId: "post-1", version: "ver-1", providerId: "ig-123", url: "https://instagram.com/p/xyz" });

    env.statusReads.push({ targets: [{ destinationBinding: "IG_DEST", outcome: "unknown" }] });
    state = await gadget.readPublishState("item-1");
    expect(state.publications.find((row: any) => row.id === filed.id).receipt).toEqual({ postId: "post-1", version: "ver-1", providerId: "ig-123", url: "https://instagram.com/p/xyz" });
    // A refused read changes nothing.
    env.statusReads.push({ refused: true, code: "provider_unavailable", message: "down" });
    const checkedAt = state.publications.find((row: any) => row.id === filed.id).lastCheckedAt;
    state = await gadget.readPublishState("item-1");
    expect(state.publications.find((row: any) => row.id === filed.id).lastCheckedAt).toBe(checkedAt);
  });

  it("outputThumbnail is the current revision's accepted asset only", async () => {
    const { gadget } = setup();
    const summaryItem = async () => (await gadget.listBatchSummaries()).batches[0];
    expect((await summaryItem()).items[0].outputThumbnail).toBeNull();
    expect((await itemOf(gadget)).outputThumbnail).toBeNull();

    const image = await imageFor(gadget, undefined);
    await gadget.deliverGeneratedImage({ id: image, bytes: JPEG_A });
    // A delivered but unaccepted image is not the output.
    expect((await summaryItem()).items[0].outputThumbnail).toBeNull();
    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 0, caption: CAPTION, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: image });
    const summary = await summaryItem();
    expect(summary.items[0].outputThumbnail).toEqual({ generatedMediaId: image, mimeType: "image/jpeg" });
    expect(summary.preview.outputThumbnail).toEqual({ generatedMediaId: image, mimeType: "image/jpeg" });
    expect((await itemOf(gadget)).outputThumbnail).toEqual({ generatedMediaId: image, mimeType: "image/jpeg" });

    await gadget.saveRevision({ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "keep_original" });
    expect((await summaryItem()).items[0].outputThumbnail).toBeNull();
    expect((await itemOf(gadget)).outputThumbnail).toBeNull();
  });
});
