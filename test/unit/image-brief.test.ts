// The image brief end to end through the gadget: source references, the
// aspect ratio, the four instruction layers, and the fail-closed refusal when
// a declared reference cannot be resolved. The work-request ROWS are the
// acceptance evidence — never how the generated picture looks.
import { describe, expect, it, afterEach } from "vitest";
import { Gadget } from "../../src/server.js";
import {
  DEFAULT_IMAGE_ASPECT_RATIO,
  builtinImageInstruction,
  effectiveInstructions,
  generationMark,
  sourceImageReferences
} from "../../src/model.js";
import { normalizeConfig } from "../../src/config.js";

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
    ctx: {
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
    }
  };
}

const MEDIA = [{ id: "m1", kind: "image", url: "https://cdn.example.com/p1.jpg" }];

function gadgetWith(media: unknown[] = MEDIA as unknown[]) {
  const { ctx } = sqliteContext();
  const gadget = new Gadget(ctx as never, { workspace: { notify: async () => {} } } as never);
  gadget.storage.setConfig({
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: [],
    posterPrompt: "Saved default image instruction",
    contentPrompt: "Saved default caption instruction"
  });
  gadget.storage.upsertItem({
    id: "instagram:IG_MAIN:p1",
    sourceBinding: "IG_MAIN",
    sourceLabel: "Main Instagram",
    provider: "instagram",
    providerItemId: "p1",
    text: "Source post",
    media,
    metrics: {},
    contentHash: "hash-p1",
    firstSeenAt: "2026-09-10T00:00:00.000Z",
    lastSeenAt: "2026-09-10T00:00:00.000Z"
  });
  return gadget;
}

describe("sourceImageReferences", () => {
  it("accepts only https image entries, preserving the media id", () => {
    const item = {
      media: [
        { id: "img", kind: "image", url: "https://cdn.example.com/a.jpg" },
        { id: "vid", kind: "video", url: "https://cdn.example.com/v.mp4" },
        { id: "http", kind: "image", url: "http://cdn.example.com/b.jpg" },
        { kind: "image", url: "https://cdn.example.com/no-id.jpg" },
        { id: "nourl", kind: "image" }
      ]
    };
    expect(sourceImageReferences(item)).toEqual([
      { id: "img", url: "https://cdn.example.com/a.jpg" },
      { url: "https://cdn.example.com/no-id.jpg" }
    ]);
  });

  it("treats carousel children as the post's images — a video still stays out", () => {
    const carousel = {
      media: [
        { id: "c1", kind: "carousel_child", url: "https://cdn.example.com/c1.jpg" },
        { id: "c2", kind: "carousel_child", url: "https://cdn.example.com/c2.jpg" },
        { id: "v", kind: "video", url: "https://cdn.example.com/v.mp4" },
        { kind: "carousel_child", url: "http://cdn.example.com/plain-http.jpg" }
      ]
    };
    expect(sourceImageReferences(carousel)).toEqual([
      { id: "c1", url: "https://cdn.example.com/c1.jpg" },
      { id: "c2", url: "https://cdn.example.com/c2.jpg" }
    ]);
  });

  it("sends what the post has — the provider's limit is the API's clamp, not this bound", () => {
    const album = {
      media: Array.from({ length: 15 }, (_, i) => ({ kind: "carousel_child", url: `https://cdn.example.com/${i}.jpg` }))
    };
    expect(sourceImageReferences(album).length).toBeGreaterThan(10);
    const many = {
      media: Array.from({ length: 25 }, (_, i) => ({ kind: "image", url: `https://cdn.example.com/${i}.jpg` }))
    };
    // Payload hygiene only: well past any real post, not a provider fact.
    expect(sourceImageReferences(many)).toHaveLength(20);
    expect(sourceImageReferences({ media: [] })).toEqual([]);
    expect(sourceImageReferences(null)).toEqual([]);
    expect(sourceImageReferences({ media: [{ kind: "image", url: "not-a-url" }] })).toEqual([]);
  });
});

describe("the four instruction layers", () => {
  const config = normalizeConfig({ cadence: "daily", posterPrompt: "DEFAULT", contentPrompt: "CAPTION DEFAULT" });

  it("run wins over post, post over default, default over builtin", () => {
    const overrides = { image: "POST", caption: "POST CAPTION" };
    const resolved = effectiveInstructions(config, overrides, { image: "RUN" });
    expect(resolved.image).toEqual({ text: "RUN", source: "run" });
    expect(resolved.caption).toEqual({ text: "POST CAPTION", source: "post" });
    expect(effectiveInstructions(config, overrides).image).toEqual({ text: "POST", source: "post" });
    expect(effectiveInstructions(config, null).image).toEqual({ text: "DEFAULT", source: "default" });
    expect(effectiveInstructions(normalizeConfig({ cadence: "daily" }), null).image).toEqual({
      text: builtinImageInstruction(null),
      source: "builtin"
    });
  });

  it("a blank run instruction falls through to the post layer", () => {
    const resolved = effectiveInstructions(config, { image: "POST" }, { image: "   " });
    expect(resolved.image).toEqual({ text: "POST", source: "post" });
  });
});

describe("generationMark parses the brief", () => {
  it("round-trips aspectRatio, references, instructionSources and runInstructions", () => {
    const mark = generationMark(
      JSON.stringify({
        id: "gen_1",
        base: 2,
        scope: { image: true, caption: false },
        needs: { image: true, caption: false },
        at: "2026-09-17T00:00:00.000Z",
        instructions: { image: "RUN", caption: "" },
        instructionSources: { image: "run", caption: "default" },
        runInstructions: { image: "RUN" },
        imageBrief: { aspectRatio: "9:16", references: [{ id: "m1", url: "https://cdn.example.com/p1.jpg" }] }
      })
    );
    expect(mark?.imageBrief).toEqual({
      aspectRatio: "9:16",
      references: [{ id: "m1", url: "https://cdn.example.com/p1.jpg" }]
    });
    expect(mark?.instructionSources).toEqual({ image: "run", caption: "default" });
    expect(mark?.runInstructions).toEqual({ image: "RUN", caption: null });
  });

  it("reads absent brief fields on a mark written before they existed", () => {
    const mark = generationMark(JSON.stringify({ id: "gen_1", needs: { image: true }, at: "2026-09-01T00:00:00.000Z" }));
    expect(mark?.imageBrief).toBeUndefined();
    expect(mark?.instructionSources).toBeUndefined();
    expect(mark?.runInstructions).toBeUndefined();
  });

  it("drops a malformed brief rather than trusting half of it", () => {
    const mark = generationMark(
      JSON.stringify({ id: "gen_1", needs: { image: true }, imageBrief: { aspectRatio: "wide", references: [] } })
    );
    expect(mark?.imageBrief).toBeUndefined();
  });
});

describe("requestGeneration stamps the brief", () => {
  it("declares the source image reference and the resolved ratio on the work request item", async () => {
    const gadget = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const itemId = opened.items[0].id;
    const asked = await gadget.requestGeneration(opened.id, [itemId], {
      needs: { image: true },
      image: { references: "source", aspectRatio: "1:1" },
      replace: true
    });
    expect(asked.ok).toBe(true);
    expect(asked.workRequest.items[0]).toMatchObject({
      itemId: "instagram:IG_MAIN:p1",
      aspectRatio: "1:1",
      imageReferences: [{ id: "m1", url: "https://cdn.example.com/p1.jpg" }]
    });
    const mark = generationMark(gadget.storage.getBatchItem(itemId).generation);
    expect(mark?.imageBrief).toEqual({
      aspectRatio: "1:1",
      references: [{ id: "m1", url: "https://cdn.example.com/p1.jpg" }]
    });
  });

  it("resolves the configured defaults when options.image is omitted", async () => {
    const gadget = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const asked = await gadget.requestGeneration(opened.id, [opened.items[0].id], { needs: { image: true }, replace: true });
    expect(asked.ok).toBe(true);
    expect(asked.workRequest.items[0]).toMatchObject({
      aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
      imageReferences: [{ id: "m1", url: "https://cdn.example.com/p1.jpg" }]
    });
  });

  it("omits imageReferences when the owner asked for no source", async () => {
    const gadget = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const asked = await gadget.requestGeneration(opened.id, [opened.items[0].id], {
      needs: { image: true },
      image: { references: "none", aspectRatio: "9:16" },
      replace: true
    });
    expect(asked.ok).toBe(true);
    expect(asked.workRequest.items[0].aspectRatio).toBe("9:16");
    expect("imageReferences" in asked.workRequest.items[0]).toBe(false);
    const mark = generationMark(gadget.storage.getBatchItem(opened.items[0].id).generation);
    expect(mark?.imageBrief).toEqual({ aspectRatio: "9:16" });
    expect(mark?.imageBrief && "references" in mark.imageBrief).toBe(false);
  });

  it("fails closed with reference_unavailable: nothing stamped, no request returned", async () => {
    const gadget = gadgetWith([]);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const itemId = opened.items[0].id;
    const before = gadget.storage.getBatchItem(itemId).generation;
    const asked = await gadget.requestGeneration(opened.id, [itemId], {
      needs: { image: true },
      image: { references: "source" },
      replace: true
    });
    expect(asked).toMatchObject({ ok: false, code: "reference_unavailable" });
    expect(asked.workRequest).toBeUndefined();
    // The mark is exactly what the refused call found — no half-written ask.
    expect(gadget.storage.getBatchItem(itemId).generation).toBe(before);
  });

  it("still asks for the caption when a caption-only request is made without an image brief", async () => {
    const gadget = gadgetWith([]);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const asked = await gadget.requestGeneration(opened.id, [opened.items[0].id], {
      needs: { caption: true },
      replace: true
    });
    expect(asked.ok).toBe(true);
    expect(asked.workRequest.items[0].parts).toEqual({ caption: true, image: false });
    expect("aspectRatio" in asked.workRequest.items[0]).toBe(false);
  });

  it("records the one-off instruction as the run layer, not the post override", async () => {
    const gadget = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const itemId = opened.items[0].id;
    const asked = await gadget.requestGeneration(opened.id, [itemId], {
      needs: { image: true },
      instructions: { image: "Bottle facing the camera" },
      image: { references: "none" },
      replace: true
    });
    expect(asked.ok).toBe(true);
    expect(asked.workRequest.items[0].imagePrompt).toBe("Bottle facing the camera");
    const mark = generationMark(gadget.storage.getBatchItem(itemId).generation);
    expect(mark?.instructionSources?.image).toBe("run");
    expect(mark?.runInstructions).toEqual({ image: "Bottle facing the camera", caption: null });
    // The post's saved overrides were not written — the one-off stayed one-off.
    expect(gadget.storage.getBatchItem(itemId).instructionOverrides).toBeNull();
  });

  it("rejects malformed image and instruction options by value", async () => {
    const gadget = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const itemId = opened.items[0].id;
    for (const image of [{ references: "maybe" }, { aspectRatio: "3:2" }, { references: "source", extra: 1 }]) {
      const refused = await gadget.requestGeneration(opened.id, [itemId], { needs: { image: true }, image, replace: true });
      expect(refused).toMatchObject({ ok: false, code: "generation_image_brief_invalid" });
    }
    const badInstructions = await gadget.requestGeneration(opened.id, [itemId], {
      needs: { image: true },
      instructions: { image: 42 },
      replace: true
    });
    expect(badInstructions).toMatchObject({ ok: false, code: "generation_instructions_invalid" });
    const badNeeds = await gadget.requestGeneration(opened.id, [itemId], { needs: { image: false, caption: false }, replace: true });
    expect(badNeeds).toMatchObject({ ok: false, code: "generation_needs_invalid" });
  });
});

describe("the initial batch ask carries the brief leniently", () => {
  it("declares references when the source has usable media", async () => {
    const gadget = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    expect(opened.workRequest.items[0]).toMatchObject({
      aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
      imageReferences: [{ id: "m1", url: "https://cdn.example.com/p1.jpg" }]
    });
  });

  it("declares no references when the source has none — the auto-ask cannot refuse", async () => {
    const gadget = gadgetWith([]);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    expect(opened.workRequest.items[0].aspectRatio).toBe(DEFAULT_IMAGE_ASPECT_RATIO);
    expect("imageReferences" in opened.workRequest.items[0]).toBe(false);
  });
});

describe("a replacement keeps the original request's brief", () => {
  it("rearmGeneration re-ids the mark without touching brief, sources or one-off", async () => {
    const gadget = gadgetWith();
    gadget.storage.upsertItem({
      id: "instagram:IG_MAIN:p2",
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      provider: "instagram",
      providerItemId: "p2",
      text: "Second source",
      media: [{ id: "m2", kind: "image", url: "https://cdn.example.com/p2.jpg" }],
      metrics: {},
      contentHash: "hash-p2",
      firstSeenAt: "2026-09-10T00:00:00.000Z",
      lastSeenAt: "2026-09-10T00:00:00.000Z"
    });
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"] });
    const [first, second] = opened.items.map((entry: { id: string }) => entry.id);
    // Replace only the first post: the sibling's mark moves onto the new
    // request id carrying ITS OWN brief — not the replacement's.
    const result = await gadget.requestGeneration(opened.id, [first], {
      needs: { image: true },
      image: { references: "none", aspectRatio: "9:16" },
      replace: true
    });
    expect(result.ok).toBe(true);
    const sibling = generationMark(gadget.storage.getBatchItem(second).generation);
    expect(sibling?.id).toBe(result.request);
    expect(sibling?.imageBrief).toEqual({
      aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
      references: [{ id: "m2", url: "https://cdn.example.com/p2.jpg" }]
    });
    // The replaced item itself carries the NEW brief.
    const replaced = generationMark(gadget.storage.getBatchItem(first).generation);
    expect(replaced?.imageBrief).toEqual({ aspectRatio: "9:16" });
    // The work request's items describe each item's own committed mark.
    const byItem = new Map(result.workRequest.items.map((entry: any) => [entry.itemId, entry]));
    expect(byItem.get("instagram:IG_MAIN:p1").aspectRatio).toBe("9:16");
    expect("imageReferences" in byItem.get("instagram:IG_MAIN:p1")).toBe(false);
    expect(byItem.get("instagram:IG_MAIN:p2").imageReferences).toEqual([
      { id: "m2", url: "https://cdn.example.com/p2.jpg" }
    ]);
  });
});
