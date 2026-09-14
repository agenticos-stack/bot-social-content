/*
 * The drawer's per-part actions and per-post instructions at the Gadget
 * boundary (sqlite harness, same shape as generated-media.test.ts):
 *
 * - "Regenerate image" asks for the image only and keeps the caption;
 *   "Rewrite caption" asks for the caption only and keeps the pinned image.
 * - A candidate image is accepted through the save path with
 *   `acceptedGeneratedMediaId`, which creates a new revision.
 * - Per-post instruction overrides save, reset, and are snapshotted on the
 *   generation mark a request creates (kept as `lastGeneration` after it clears).
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
  return {
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
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 4, 6, 4, 6, 0, 0]);
const JPEG_2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 9, 9, 9, 9, 0, 0]);

function gadgetWithPost() {
  const gadget = new Gadget(sqliteContext() as never, {} as never);
  gadget.storage.setConfig({
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: [],
    contentPrompt: "Default caption instructions",
    posterPrompt: "Default image instructions"
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
    destinationBindings: [],
    state: "drafting"
  });
  return gadget;
}

/** Revision 1: caption plus an accepted (pinned) generated image. */
async function acceptedPost(gadget: Gadget) {
  const image = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "upload-a", altText: "first image" });
  await gadget.deliverGeneratedImage({ id: image.id, bytes: JPEG });
  const saved = await gadget.saveRevision({
    batchItemId: "item-1",
    expectedRevision: 0,
    caption: "第一稿內容文字",
    acceptedVisualMode: "ai_refinement",
    acceptedGeneratedMediaId: image.id
  });
  expect(saved).toMatchObject({ ok: true, revision: 1 });
  return image.id as string;
}

const itemOf = async (gadget: Gadget) => (await gadget.getBatch("batch-1"))!.items[0] as Record<string, any>;

describe("per-part generation requests", () => {
  it("Regenerate image asks for the image only; the new image arrives as a candidate and the caption stays", async () => {
    const gadget = gadgetWithPost();
    const pinned = await acceptedPost(gadget);

    const asked = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { image: true } });
    expect(asked).toMatchObject({ ok: true, needs: { image: true, caption: false } });
    let item = await itemOf(gadget);
    expect(item.generation.needs).toEqual({ image: true, caption: false });

    // A correlated save that rewrites the caption is not what was asked for.
    const refused = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 1,
      caption: "另一段完全不同的文字",
      generationRequest: asked.request
    });
    expect(refused).toMatchObject({ ok: false, issues: [{ code: "generation_part_not_requested" }] });

    const next = await gadget.saveGeneratedImage({
      batchItemId: "item-1",
      attachmentId: "upload-b",
      altText: "second image",
      generationRequest: asked.request
    });
    item = await itemOf(gadget);
    expect(item.generatedCandidate).toMatchObject({ id: next.id, ready: false });
    await gadget.deliverGeneratedImage({ id: next.id, bytes: JPEG_2 });

    item = await itemOf(gadget);
    expect(item.generation).toBeNull();
    expect(item.caption).toBe("第一稿內容文字");
    expect(item.revision).toBe(1);
    expect(item.generatedImage).toMatchObject({ id: pinned, ready: true });
    expect(item.generatedCandidate).toMatchObject({ id: next.id, ready: true });
    expect(item.lastGeneration).toMatchObject({ id: asked.request, needs: { image: true, caption: false } });
  });

  it("accepting the candidate goes through the save path with acceptedGeneratedMediaId and makes a new revision", async () => {
    const gadget = gadgetWithPost();
    await acceptedPost(gadget);
    const next = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "upload-b", altText: "second image" });
    await gadget.deliverGeneratedImage({ id: next.id, bytes: JPEG_2 });

    const result = await gadget.saveRevisions({
      revisions: [{ batchItemId: "item-1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: next.id }]
    });
    expect(result).toMatchObject({ ok: true, results: [{ ok: true, revision: 2 }] });
    const item = await itemOf(gadget);
    expect(item.generatedImage).toMatchObject({ id: next.id });
    expect(item.generatedCandidate).toBeNull();
    expect(item.caption).toBe("第一稿內容文字");
    expect(item.revisionHistory.map((entry: { revision: number }) => entry.revision)).toEqual([1, 2]);
    expect(item.generatedHistory).toHaveLength(2);
  });

  it("Rewrite caption asks for the caption only and keeps the pinned image", async () => {
    const gadget = gadgetWithPost();
    const pinned = await acceptedPost(gadget);
    const stray = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "upload-c", altText: null });
    await gadget.deliverGeneratedImage({ id: stray.id, bytes: JPEG_2 });

    const asked = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { caption: true } });
    expect((await itemOf(gadget)).generation.needs).toEqual({ image: false, caption: true });

    // Swapping the image on a caption-only request is refused.
    const swap = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 1,
      acceptedVisualMode: "ai_refinement",
      acceptedGeneratedMediaId: stray.id,
      generationRequest: asked.request
    });
    expect(swap).toMatchObject({ ok: false, issues: [{ code: "generation_part_not_requested" }] });

    const saved = await gadget.saveRevision({
      batchItemId: "item-1",
      expectedRevision: 1,
      caption: "重新撰寫的內容文字",
      generationRequest: asked.request
    });
    expect(saved).toMatchObject({ ok: true, revision: 2, generation: null });
    const item = await itemOf(gadget);
    expect(item.caption).toBe("重新撰寫的內容文字");
    expect(item.generatedImage).toMatchObject({ id: pinned });
  });

  it("refuses a needs argument that asks for nothing or names an unknown part", async () => {
    const gadget = gadgetWithPost();
    for (const needs of [{}, { image: false, caption: false }, { image: "yes" }, { video: true }, null]) {
      expect(await gadget.requestGeneration("batch-1", ["item-1"], { needs })).toMatchObject({ ok: false, code: "generation_needs_invalid" });
    }
    expect(gadget.storage.getBatchItem("item-1").generation).toBeNull();
    // Omitted needs keeps the old both-parts request.
    expect(await gadget.requestGeneration("batch-1", ["item-1"])).toMatchObject({ ok: true, needs: { image: true, caption: true } });
  });
});

describe("per-post instruction overrides", () => {
  it("saves, snapshots onto the request, and resets to the saved default without generating anything", async () => {
    const gadget = gadgetWithPost();
    let item = await itemOf(gadget);
    expect(item.instructionOverrides).toEqual({ image: null, caption: null });
    expect(item.effectiveInstructions).toEqual({
      image: { text: "Default image instructions", source: "default" },
      caption: { text: "Default caption instructions", source: "default" }
    });

    const saved = await gadget.saveInstructionOverrides({ batchItemId: "item-1", image: "Outdoor photo, morning light" });
    expect(saved).toMatchObject({ ok: true, instructionOverrides: { image: "Outdoor photo, morning light", caption: null } });
    item = await itemOf(gadget);
    expect(item.effectiveInstructions.image).toEqual({ text: "Outdoor photo, morning light", source: "post" });
    // Editing instructions is not a request and not a revision.
    expect(item.generation).toBeNull();
    expect(item.revision).toBe(0);

    const asked = await gadget.requestGeneration("batch-1", ["item-1"], { needs: { image: true } });
    item = await itemOf(gadget);
    expect(item.generation.instructions).toEqual({ image: "Outdoor photo, morning light", caption: "Default caption instructions" });

    // Reset: the next request uses the default; the earlier snapshot is unchanged history.
    await gadget.saveInstructionOverrides({ batchItemId: "item-1", image: null });
    item = await itemOf(gadget);
    expect(item.instructionOverrides).toEqual({ image: null, caption: null });
    expect(item.effectiveInstructions.image.source).toBe("default");
    expect(item.generation).toMatchObject({ id: asked.request, instructions: { image: "Outdoor photo, morning light" } });

    const image = await gadget.saveGeneratedImage({ batchItemId: "item-1", attachmentId: "u", altText: null, generationRequest: asked.request });
    await gadget.deliverGeneratedImage({ id: image.id, bytes: JPEG });
    item = await itemOf(gadget);
    expect(item.generation).toBeNull();
    expect(item.lastGeneration).toMatchObject({ id: asked.request, instructions: { image: "Outdoor photo, morning light" } });
  });

  it("refuses an unknown post and a non-text override", async () => {
    const gadget = gadgetWithPost();
    expect(await gadget.saveInstructionOverrides({ batchItemId: "nope", image: "x" })).toMatchObject({ ok: false, code: "batch_item_unknown" });
    expect(await gadget.saveInstructionOverrides({ batchItemId: "item-1", caption: 42 })).toMatchObject({ ok: false, code: "instruction_override_invalid" });
  });
});
