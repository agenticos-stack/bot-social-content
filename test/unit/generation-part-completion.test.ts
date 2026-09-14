/*
 * Audit b7de9dd R2: a correlated save completes only the generation parts it
 * EXPLICITLY delivered for the matching request. Retained content (an omitted
 * caption, a carried poster layout, a carried pin) is preserved on the
 * revision but never credited as newly generated output. Real node:sqlite
 * harness, same shape as generation-freshness.test.ts.
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
const LAYOUT = {
  template: "1080x1080",
  headline: "Saved legacy poster",
  subline: "",
  background: { kind: "solid", value: "#1c1c1e" },
  textColor: "#ffffff",
  align: "center"
};

function setup() {
  const gadget = new Gadget(sqliteContext() as never, {} as never);
  gadget.storage.setConfig({ protectedTerms: [], protectedHashtags: [], disclaimers: [], claimsRequiringConfirmation: [] });
  gadget.storage.upsertItem({
    id: "source1", sourceBinding: "SOURCE", sourceLabel: "Synthetic", provider: "instagram",
    providerItemId: "p1", text: "A reference", media: [], metrics: {}, contentHash: "x",
    firstSeenAt: "2026-09-10", lastSeenAt: "2026-09-10"
  });
  gadget.storage.createBatch("batch1");
  gadget.storage.createBatchItem({ id: "item1", batchId: "batch1", itemId: "source1", destinationBindings: [], state: "drafting" });
  return gadget;
}

type G = ReturnType<typeof setup>;
const mark = (g: G) => {
  const raw = g.storage.getBatchItem("item1").generation;
  return raw ? JSON.parse(raw) : null;
};
const status = (g: G, id: string) => g.storage.generatedMediaStatuses("item1")(g.storage.getGeneratedMedia(id));

async function deliverImage(g: G, request: string, bytes = JPEG, attachmentId = "upload-A") {
  const image = await g.saveGeneratedImage({ batchItemId: "item1", attachmentId, generationRequest: request });
  expect(image.ok).toBe(true);
  expect(await g.deliverGeneratedImage({ id: image.id, bytes })).toMatchObject({ ok: true });
  return image.id as string;
}

describe("generation part completion (audit b7de9dd R2)", () => {
  it("A: a retained text poster never satisfies a requested AI image; a caption-only save clears only the caption", async () => {
    const g = setup();
    expect(await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字", posterLayout: LAYOUT, acceptedVisualMode: "text_poster" })).toMatchObject({ ok: true });
    const { request } = await g.requestGeneration("batch1", ["item1"]);

    const save = await g.saveRevision({ batchItemId: "item1", expectedRevision: 1, caption: "第二稿內容文字", generationRequest: request });
    expect(save.ok).toBe(true);
    expect(save.generation).toMatchObject({ id: request, needs: { caption: false, image: true } });
    expect(mark(g)).toMatchObject({ id: request, scope: { caption: true, image: true }, needs: { caption: false, image: true } });
    expect(g.storage.latestRevision("item1").posterLayout).toMatchObject({ headline: "Saved legacy poster" });

    const imageId = await deliverImage(g, request);
    expect(status(g, imageId)).toBe("candidate");
    expect(g.storage.latestCandidateGeneratedMedia("item1")?.id).toBe(imageId);
    expect(mark(g)).toBeNull();
  });

  it("A (poster render): savePoster bytes do not complete a correlated image need", async () => {
    const g = setup();
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字", posterLayout: LAYOUT, acceptedVisualMode: "text_poster" });
    const { request } = await g.requestGeneration("batch1", ["item1"], { needs: { image: true } });
    // Minimal PNG header carrying 1080x1080, as revision-node.test.ts builds it.
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(16, 1080);
    new DataView(png.buffer).setUint32(20, 1080);
    const poster = await g.savePoster({ batchItemId: "item1", expectedRevision: 1, template: "1080x1080", png, generationRequest: request });
    expect(poster).toMatchObject({ ok: true });
    expect(mark(g)).toMatchObject({ id: request, needs: { image: true } });
  });

  it("B: an image-only acceptance with no caption field leaves the caption need pending and the caption unchanged", async () => {
    const g = setup();
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字" });
    const { request } = await g.requestGeneration("batch1", ["item1"]);
    const imageId = await deliverImage(g, request);
    expect(mark(g)).toMatchObject({ needs: { caption: true, image: false } });

    const save = await g.saveRevision({ batchItemId: "item1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: imageId, generationRequest: request });
    expect(save.ok).toBe(true);
    expect(g.storage.latestRevision("item1").caption).toBe("第一稿內容文字");
    expect(g.storage.latestRevision("item1").acceptedGeneratedMediaId).toBe(imageId);
    expect(mark(g)).toMatchObject({ id: request, needs: { caption: true, image: false } });
  });

  it("alt-text-only correlated save does not answer caption generation", async () => {
    const g = setup();
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字" });
    const { request } = await g.requestGeneration("batch1", ["item1"], { needs: { caption: true } });
    expect((await g.saveRevision({ batchItemId: "item1", expectedRevision: 1, altText: "A description", generationRequest: request })).ok).toBe(true);
    expect(mark(g)).toMatchObject({ id: request, needs: { caption: true } });
  });

  it("an explicit caption equal to the previous text still completes the caption need", async () => {
    const g = setup();
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字" });
    const { request } = await g.requestGeneration("batch1", ["item1"], { needs: { caption: true } });
    expect((await g.saveRevision({ batchItemId: "item1", expectedRevision: 1, caption: "第一稿內容文字", generationRequest: request })).ok).toBe(true);
    expect(mark(g)).toBeNull();
  });

  it("image first, then a correlated caption save completes the mark", async () => {
    const g = setup();
    const { request } = await g.requestGeneration("batch1", ["item1"]);
    const imageId = await deliverImage(g, request);
    expect(mark(g)).toMatchObject({ needs: { caption: true, image: false } });
    const save = await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字", acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: imageId, generationRequest: request });
    expect(save).toMatchObject({ ok: true, generation: null });
    expect(mark(g)).toBeNull();
  });

  it("caption first, then the correlated image delivery completes the mark", async () => {
    const g = setup();
    const { request } = await g.requestGeneration("batch1", ["item1"]);
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字", generationRequest: request });
    expect(mark(g)).toMatchObject({ needs: { caption: false, image: true } });
    const imageId = await deliverImage(g, request);
    expect(status(g, imageId)).toBe("candidate");
    expect(mark(g)).toBeNull();
  });

  it("duplicate completion is idempotent: the same delivery twice and an unchanged caption need stay consistent", async () => {
    const g = setup();
    const { request } = await g.requestGeneration("batch1", ["item1"]);
    const imageId = await deliverImage(g, request);
    expect(await g.deliverGeneratedImage({ id: imageId, bytes: JPEG })).toMatchObject({ ok: true, unchanged: true });
    expect(mark(g)).toMatchObject({ id: request, scope: { caption: true, image: true }, needs: { caption: true, image: false } });
    // Accepting the same image twice without a caption completes nothing more.
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: imageId, generationRequest: request });
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 1, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: imageId, generationRequest: request });
    expect(mark(g)).toMatchObject({ id: request, needs: { caption: true, image: false } });
  });

  it("owner (uncorrelated) saves never complete generated needs", async () => {
    const g = setup();
    const { request } = await g.requestGeneration("batch1", ["item1"]);
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字" });
    expect(mark(g)).toMatchObject({ id: request, needs: { caption: true, image: true } });
  });

  it("after replace:true, a late save and late delivery for the old request complete nothing on the new mark", async () => {
    const g = setup();
    await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, caption: "第一稿內容文字" });
    const old = (await g.requestGeneration("batch1", ["item1"])).request;
    const lateImage = await g.saveGeneratedImage({ batchItemId: "item1", attachmentId: "upload-old", generationRequest: old });
    const fresh = (await g.requestGeneration("batch1", ["item1"], { replace: true })).request;

    const lateSave = await g.saveRevision({ batchItemId: "item1", expectedRevision: 1, caption: "舊的內容文字", generationRequest: old });
    expect(lateSave).toMatchObject({ ok: false, issues: [{ code: "generation_request_stale" }] });
    expect(await g.deliverGeneratedImage({ id: lateImage.id, bytes: JPEG_2 })).toMatchObject({ ok: true });
    expect(status(g, lateImage.id)).toBe("superseded");
    expect(mark(g)).toMatchObject({ id: fresh, needs: { caption: true, image: true } });

    // Accepting the old image under the new request is refused and completes nothing.
    const wrong = await g.saveRevision({ batchItemId: "item1", expectedRevision: 0, acceptedVisualMode: "ai_refinement", acceptedGeneratedMediaId: lateImage.id, generationRequest: fresh });
    expect(wrong).toMatchObject({ ok: false, issues: [{ code: "generated_media_not_current" }] });
    expect(mark(g)).toMatchObject({ id: fresh, needs: { caption: true, image: true } });
  });
});
