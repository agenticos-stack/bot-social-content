// Carousel pages end to end through the gadget: the page model itself, the
// migration-20 backfill, page-scoped generation asks and registrations, the
// per-page publish door, and the video disclosure. The drawer-level page UI
// is covered by drawer.test.ts/drawer-session.test.ts — this file pins the
// seams underneath it.
import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";
import {
  defaultRevisionPages,
  effectiveRevisionPages,
  generationMark,
  legacyRevisionPages,
  MAX_PAGES_PER_POST,
  normalizeRevisionPages,
  visualModeFromPages
} from "../../src/model.js";

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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 4, 6, 4, 6, 0, 0]);
const CAPTION = "第一稿內容文字";

/** Two image children and one video — the carousel source the page model keys on. */
const SOURCE_MEDIA = [
  { id: "m1", kind: "image", url: "https://cdn.example.test/m1.jpg" },
  { id: "m2", kind: "image", url: "https://cdn.example.test/m2.jpg" },
  { id: "v1", kind: "video", url: "https://cdn.example.test/v1.mp4" }
];

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
        return { assetId: `asset-${uploaded.length}`, url: `https://cdn.example.test/up-${uploaded.length}.jpg`, mimeType: "image/jpeg", byteSize: 11 };
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

function gadgetWith(media: unknown[] = SOURCE_MEDIA as unknown[], env: Record<string, unknown> = {}) {
  const { ctx } = sqliteContext();
  const gadget = new Gadget(ctx as never, { workspace: { notify: async () => {} }, ...env } as never);
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
    permalink: "https://www.instagram.com/p/p1/",
    publishedAt: "2026-09-06T00:00:00.000Z",
    text: "Original source",
    media,
    metrics: {},
    contentHash: "source-hash",
    firstSeenAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z"
  });
  return gadget;
}

async function draftingItem(gadget: Gadget) {
  const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
  return { batchId: opened.id, batchItemId: opened.items[0].id };
}

// ---------------------------------------------------------------------------
// The page model itself.
// ---------------------------------------------------------------------------
describe("defaultRevisionPages", () => {
  it("makes one empty page per source image child, each bound to its own child", () => {
    expect(defaultRevisionPages({ media: SOURCE_MEDIA })).toEqual([
      { pageId: "pg_src_m1", kind: null, mediaId: null, sourceMediaId: "m1", altText: null, mediaDigest: null, mediaProvenance: null, mediaAcceptance: null },
      { pageId: "pg_src_m2", kind: null, mediaId: null, sourceMediaId: "m2", altText: null, mediaDigest: null, mediaProvenance: null, mediaAcceptance: null }
    ]);
  });

  it("skips video children — they are disclosed as skipped, never bound", () => {
    const pages = defaultRevisionPages({ media: [{ id: "v", kind: "video", url: "https://x/v.mp4" }] });
    expect(pages).toEqual([
      { pageId: "pg_main", kind: null, mediaId: null, sourceMediaId: null, altText: null, mediaDigest: null, mediaProvenance: null, mediaAcceptance: null }
    ]);
  });

  it("caps the list at the post's page bound", () => {
    const media = Array.from({ length: MAX_PAGES_PER_POST + 4 }, (_, i) => ({ id: `m${i}`, kind: "image", url: `https://x/${i}.jpg` }));
    expect(defaultRevisionPages({ media })).toHaveLength(MAX_PAGES_PER_POST);
  });
});

describe("legacyRevisionPages", () => {
  const base = { batchItemId: "item-1", revision: 3, altText: "Saved alt" };

  it("maps a pinned generated image to one generated page carrying the legacy facts", () => {
    expect(
      legacyRevisionPages(
        {
          ...base,
          acceptedVisualMode: "ai_refinement",
          acceptedGeneratedMediaId: "gm_a",
          acceptedGeneratedMediaDigest: "digest",
          acceptedGeneratedMediaProvenance: "recorded",
          acceptanceSource: "generation"
        },
        SOURCE_MEDIA
      )
    ).toEqual([
      {
        pageId: "pg_leg_item-1_3_1",
        kind: "generated",
        mediaId: "gm_a",
        sourceMediaId: "m1",
        altText: "Saved alt",
        mediaDigest: "digest",
        mediaProvenance: "recorded",
        mediaAcceptance: "generation"
      }
    ]);
  });

  it("maps keep_original to one original page per source media entry — video included, the exact pack it shipped", () => {
    const pages = legacyRevisionPages({ ...base, acceptedVisualMode: "keep_original" }, SOURCE_MEDIA);
    expect(pages.map((page) => [page.kind, page.mediaId])).toEqual([
      ["original", "m1"],
      ["original", "m2"],
      ["original", "v1"]
    ]);
    expect(pages[0].altText).toBe("Saved alt");
    expect(pages[1].altText).toBeNull();
  });

  it("lets non-empty derived refs win over whatever the mode said — they shipped under the old packer", () => {
    const pages = legacyRevisionPages(
      { ...base, acceptedVisualMode: "keep_original", derivedMediaRefs: [{ assetId: "gm_d", kind: "image" }] },
      SOURCE_MEDIA
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ kind: "generated", mediaId: "gm_d" });
  });

  it("maps text_poster to one poster page, and a NULL mode keeps the stored-poster behaviour", () => {
    expect(legacyRevisionPages({ ...base, acceptedVisualMode: "text_poster" }, SOURCE_MEDIA)).toEqual([
      { pageId: "pg_leg_item-1_3_1", kind: "poster", mediaId: null, sourceMediaId: "m1", altText: "Saved alt", mediaDigest: null, mediaProvenance: null, mediaAcceptance: null }
    ]);
    // A NULL pick with a stored poster shipped the poster; without one it
    // shipped the source pack.
    expect(legacyRevisionPages({ ...base, acceptedVisualMode: null }, SOURCE_MEDIA, { hasPoster: true })[0].kind).toBe("poster");
    expect(legacyRevisionPages({ ...base, acceptedVisualMode: null }, SOURCE_MEDIA).map((page) => page.kind)).toEqual([
      "original",
      "original",
      "original"
    ]);
  });
});

describe("normalizeRevisionPages", () => {
  it("round-trips a valid list, preserving per-page alt and provenance facts", () => {
    const result = normalizeRevisionPages([
      { pageId: "pg_1", kind: "generated", mediaId: "gm_a", sourceMediaId: "m1", altText: "Alt one", mediaDigest: "d", mediaProvenance: "recorded", mediaAcceptance: "owner_explicit" },
      { pageId: "pg_2", kind: "original", mediaId: "m2", sourceMediaId: "m2", altText: "Alt two" },
      { pageId: "pg_3", kind: null }
    ]);
    expect(result).toMatchObject({
      ok: true,
      pages: [
        { pageId: "pg_1", kind: "generated", mediaId: "gm_a", altText: "Alt one", mediaProvenance: "recorded", mediaAcceptance: "owner_explicit" },
        { pageId: "pg_2", kind: "original", mediaId: "m2", altText: "Alt two" },
        { pageId: "pg_3", kind: null, mediaId: null }
      ]
    });
  });

  it("refuses the structural violations by name", () => {
    expect(normalizeRevisionPages("nope")).toMatchObject({ ok: false, code: "pages_invalid" });
    expect(normalizeRevisionPages([])).toMatchObject({ ok: false, code: "pages_invalid" });
    expect(
      normalizeRevisionPages(Array.from({ length: MAX_PAGES_PER_POST + 1 }, (_, i) => ({ pageId: `p${i}` })))
    ).toMatchObject({ ok: false, code: "pages_invalid" });
    expect(normalizeRevisionPages([{ pageId: "p" }, { pageId: "p" }])).toMatchObject({ ok: false, code: "page_id_invalid" });
    expect(normalizeRevisionPages([{ pageId: "p", kind: "generated" }])).toMatchObject({ ok: false, code: "page_media_invalid" });
    expect(normalizeRevisionPages([{ pageId: "p", kind: "original" }])).toMatchObject({ ok: false, code: "page_media_invalid" });
    expect(normalizeRevisionPages([{ pageId: "p", kind: "poster", mediaId: "x" }])).toMatchObject({ ok: false, code: "page_media_invalid" });
    expect(normalizeRevisionPages([{ pageId: "p", kind: "mystery" }])).toMatchObject({ ok: false, code: "page_kind_invalid" });
    expect(normalizeRevisionPages([{ kind: "generated", mediaId: "x" }])).toMatchObject({ ok: false, code: "page_id_invalid" });
  });
});

describe("visualModeFromPages", () => {
  it("keeps the legacy column honest for old readers", () => {
    const page = (kind: string | null) => ({ pageId: "p", kind });
    expect(visualModeFromPages([page("original"), page("original")])).toBe("keep_original");
    expect(visualModeFromPages([page("original"), page("generated")])).toBe("ai_refinement");
    expect(visualModeFromPages([page("poster")])).toBe("text_poster");
    expect(visualModeFromPages([page("generated"), page(null)])).toBe("ai_refinement");
    expect(visualModeFromPages([page(null)])).toBeNull();
    expect(visualModeFromPages([])).toBeNull();
  });
});

describe("generationMark page scope", () => {
  it("round-trips needs/scope imagePages; a pre-carousel mark reads unscoped", () => {
    const mark = generationMark(
      JSON.stringify({
        id: "gen_1",
        base: 1,
        scope: { image: true, caption: false, imagePages: ["pg_src_m2"] },
        needs: { image: true, caption: false, imagePages: ["pg_src_m2"] }
      })
    );
    expect(mark?.scope.imagePages).toEqual(["pg_src_m2"]);
    expect(mark?.needs.imagePages).toEqual(["pg_src_m2"]);
    const legacy = generationMark(JSON.stringify({ id: "gen_1", needs: { image: true } }));
    expect(legacy?.needs.imagePages).toBeUndefined();
    expect(legacy?.scope.imagePages).toBeUndefined();
  });
});

describe("effectiveRevisionPages", () => {
  it("prefers the stored list, then the legacy derivation, then the source default", () => {
    const stored = [{ pageId: "pg_x", kind: "generated", mediaId: "gm_x", sourceMediaId: "m1", altText: null, mediaDigest: null, mediaProvenance: null, mediaAcceptance: null }];
    expect(effectiveRevisionPages({ pages: stored, acceptedVisualMode: "keep_original" }, { media: SOURCE_MEDIA })).toEqual(stored);
    expect(
      effectiveRevisionPages({ batchItemId: "i", revision: 1, acceptedVisualMode: "keep_original" }, { media: SOURCE_MEDIA })
    ).toHaveLength(3);
    expect(effectiveRevisionPages(null, { media: SOURCE_MEDIA })).toHaveLength(2);
    expect(effectiveRevisionPages(null, { media: [] })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Page-scoped generation asks.
// ---------------------------------------------------------------------------
describe("requestGeneration page scope", () => {
  it("fans the ask out per page: each item names its page and resolves only that page's own reference", async () => {
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    const asked = await gadget.requestGeneration(batchId, [batchItemId], {
      needs: { image: true, imagePages: ["pg_src_m2"] },
      image: { references: "source", aspectRatio: "4:5" },
      replace: true
    });
    expect(asked.ok).toBe(true);
    // One paged image item — pg_src_m2's own child, never the post's other image.
    expect(asked.workRequest.items).toHaveLength(1);
    expect(asked.workRequest.items[0]).toMatchObject({
      itemId: "instagram:IG_MAIN:p1",
      batchItemId,
      pageId: "pg_src_m2",
      parts: { caption: false, image: true },
      aspectRatio: "4:5",
      imageReferences: [{ id: "m2", url: "https://cdn.example.test/m2.jpg" }]
    });
    const mark = generationMark(gadget.storage.getBatchItem(batchItemId).generation);
    expect(mark?.needs.imagePages).toEqual(["pg_src_m2"]);
    expect(mark?.scope.imagePages).toEqual(["pg_src_m2"]);
    expect(mark?.imageBrief).toMatchObject({
      aspectRatio: "4:5",
      references: [{ id: "m2", url: "https://cdn.example.test/m2.jpg" }],
      pages: [{ pageId: "pg_src_m2", references: [{ id: "m2", url: "https://cdn.example.test/m2.jpg" }] }]
    });
  });

  it("a caption+pages ask is one unpaged caption item plus one image item per page", async () => {
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    const asked = await gadget.requestGeneration(batchId, [batchItemId], {
      needs: { caption: true, image: true, imagePages: ["pg_src_m1", "pg_src_m2"] },
      image: { references: "source", aspectRatio: "1:1" },
      replace: true
    });
    expect(asked.ok).toBe(true);
    expect(asked.workRequest.items).toHaveLength(3);
    const [captionItem, ...imageItems] = asked.workRequest.items;
    expect(captionItem).toMatchObject({ parts: { caption: true, image: false } });
    expect("pageId" in captionItem).toBe(false);
    expect(imageItems.map((item: any) => [item.pageId, item.imageReferences?.[0]?.id])).toEqual([
      ["pg_src_m1", "m1"],
      ["pg_src_m2", "m2"]
    ]);
  });

  it("refuses a page the post does not have before anything is stamped or charged", async () => {
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    const before = gadget.storage.getBatchItem(batchItemId).generation;
    const asked = await gadget.requestGeneration(batchId, [batchItemId], {
      needs: { image: true, imagePages: ["pg_elsewhere"] },
      image: { references: "source" },
      replace: true
    });
    expect(asked).toMatchObject({ ok: false, code: "generation_page_unknown" });
    expect(asked.workRequest).toBeUndefined();
    expect(gadget.storage.getBatchItem(batchItemId).generation).toBe(before);
  });

  it("refuses a declared reference that cannot resolve — per page, before charging", async () => {
    // A page bound to a VIDEO child can never produce an image reference —
    // the ask is refused rather than silently degrading to a plain generate.
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    const saved = await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      caption: CAPTION,
      pages: [{ pageId: "pg_b", kind: null, sourceMediaId: "v1" }]
    });
    expect(saved).toMatchObject({ ok: true });
    const asked = await gadget.requestGeneration(batchId, [batchItemId], {
      needs: { image: true, imagePages: ["pg_b"] },
      image: { references: "source" },
      replace: true
    });
    expect(asked).toMatchObject({ ok: false, code: "reference_unavailable" });
    expect(asked.workRequest).toBeUndefined();
  });
});

describe("saveGeneratedImage page admission", () => {
  it("a scoped registration names its page and stores it; the sibling page stays owed", async () => {
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    const request = (
      await gadget.requestGeneration(batchId, [batchItemId], {
        needs: { image: true, imagePages: ["pg_src_m1", "pg_src_m2"] },
        image: { references: "source" },
        replace: true
      })
    ).request;
    const registered = await gadget.saveGeneratedImage({ batchItemId, attachmentId: "att-1", generationRequest: request, pageId: "pg_src_m1" });
    expect(registered).toMatchObject({ ok: true });
    expect(gadget.storage.getGeneratedMedia(registered.id)).toMatchObject({ pageId: "pg_src_m1" });
    // Delivered bytes satisfy only that page — the sibling's need survives.
    expect(await gadget.deliverGeneratedImage({ id: registered.id, bytes: JPEG })).toMatchObject({ ok: true });
    const mark = generationMark(gadget.storage.getBatchItem(batchItemId).generation);
    expect(mark?.needs.imagePages).toEqual(["pg_src_m2"]);
  });

  it("an unpaged registration on a multi-page scope is refused — the platform must say which page it generated", async () => {
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    const request = (
      await gadget.requestGeneration(batchId, [batchItemId], {
        needs: { image: true, imagePages: ["pg_src_m1", "pg_src_m2"] },
        image: { references: "none" },
        replace: true
      })
    ).request;
    expect(await gadget.saveGeneratedImage({ batchItemId, attachmentId: "att", generationRequest: request })).toMatchObject({
      ok: false,
      issues: [{ code: "generation_page_unknown" }]
    });
    // And a page the scope never asked for is refused the same way.
    expect(await gadget.saveGeneratedImage({ batchItemId, attachmentId: "att", generationRequest: request, pageId: "pg_src_m1".replace("m1", "mX") })).toMatchObject({
      ok: false,
      issues: [{ code: "generation_page_unknown" }]
    });
  });

  it("a one-page scope binds an unpaged registration to that page", async () => {
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    const request = (
      await gadget.requestGeneration(batchId, [batchItemId], {
        needs: { image: true, imagePages: ["pg_src_m2"] },
        image: { references: "none" },
        replace: true
      })
    ).request;
    const registered = await gadget.saveGeneratedImage({ batchItemId, attachmentId: "att", generationRequest: request });
    expect(registered).toMatchObject({ ok: true });
    expect(gadget.storage.getGeneratedMedia(registered.id)).toMatchObject({ pageId: "pg_src_m2" });
  });

  it("an owner-side registration names only a page the post actually has", async () => {
    const gadget = gadgetWith();
    const { batchItemId } = await draftingItem(gadget);
    expect(await gadget.saveGeneratedImage({ batchItemId, attachmentId: "att", pageId: "pg_nowhere" })).toMatchObject({
      ok: false,
      issues: [{ code: "generation_page_unknown" }]
    });
    const registered = await gadget.saveGeneratedImage({ batchItemId, attachmentId: "att", pageId: "pg_src_m1" });
    expect(registered).toMatchObject({ ok: true });
    expect(gadget.storage.getGeneratedMedia(registered.id)).toMatchObject({ pageId: "pg_src_m1" });
  });
});

// ---------------------------------------------------------------------------
// Pages through saveRevision and the publish door.
// ---------------------------------------------------------------------------
describe("saveRevision + publish across pages", () => {
  async function twoGeneratedPages(gadget: Gadget, batchItemId: string) {
    const first = await gadget.saveGeneratedImage({ batchItemId, attachmentId: "a1", pageId: "pg_src_m1" });
    await gadget.deliverGeneratedImage({ id: first.id, bytes: JPEG });
    const second = await gadget.saveGeneratedImage({ batchItemId, attachmentId: "a2", pageId: "pg_src_m2" });
    await gadget.deliverGeneratedImage({ id: second.id, bytes: JPEG });
    return { first: first.id, second: second.id };
  }

  it("a two-page post files both media in page order", async () => {
    const created: unknown[] = [];
    const uploaded: unknown[] = [];
    const gadget = gadgetWith(SOURCE_MEDIA as unknown[], mockSocial(created, uploaded) as Record<string, unknown>);
    gadget.storage.setDestinations([{ binding: "IG_DEST", label: "Instagram", provider: "instagram" }]);
    const { batchId, batchItemId } = await draftingItem(gadget);
    const { first, second } = await twoGeneratedPages(gadget, batchItemId);
    const saved = await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      caption: CAPTION,
      pages: [
        { pageId: "pg_src_m1", kind: "generated", mediaId: first, sourceMediaId: "m1" },
        { pageId: "pg_src_m2", kind: "generated", mediaId: second, sourceMediaId: "m2" }
      ]
    });
    expect(saved).toMatchObject({ ok: true, revision: 1 });
    const item = (await gadget.getBatch(batchId))!.items[0];
    expect(item.pages).toHaveLength(2);
    // The singular columns mirror the page list for pre-pages readers.
    expect(item.acceptedVisualMode).toBe("ai_refinement");
    expect(item.generatedImage?.id).toBe(first);

    const submitted = await gadget.submitForReview({ batchItemId, expectedRevision: 1, destinationBindings: ["IG_DEST"] });
    expect(submitted).not.toMatchObject({ ok: false });
    expect((created[0] as any).media).toHaveLength(2);
    expect(uploaded).toHaveLength(2);
  });

  it("one filled page files a single image — the carousel collapses honestly", async () => {
    const created: unknown[] = [];
    const gadget = gadgetWith(SOURCE_MEDIA as unknown[], mockSocial(created, []) as Record<string, unknown>);
    gadget.storage.setDestinations([{ binding: "IG_DEST", label: "Instagram", provider: "instagram" }]);
    const { batchItemId } = await draftingItem(gadget);
    const { first } = await twoGeneratedPages(gadget, batchItemId);
    await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      caption: CAPTION,
      pages: [{ pageId: "pg_src_m1", kind: "generated", mediaId: first, sourceMediaId: "m1" }]
    });
    const submitted = await gadget.submitForReview({ batchItemId, expectedRevision: 1, destinationBindings: ["IG_DEST"] });
    expect(submitted).not.toMatchObject({ ok: false });
    expect((created[0] as any).media).toHaveLength(1);
  });

  it("an empty page refuses filing by name — page N has no image", async () => {
    const created: unknown[] = [];
    const gadget = gadgetWith(SOURCE_MEDIA as unknown[], mockSocial(created, []) as Record<string, unknown>);
    gadget.storage.setDestinations([{ binding: "IG_DEST", label: "Instagram", provider: "instagram" }]);
    const { batchItemId } = await draftingItem(gadget);
    const { first } = await twoGeneratedPages(gadget, batchItemId);
    await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      caption: CAPTION,
      pages: [
        { pageId: "pg_src_m1", kind: "generated", mediaId: first, sourceMediaId: "m1" },
        { pageId: "pg_src_m2", kind: null, sourceMediaId: "m2" }
      ]
    });
    const refused = await gadget.submitForReview({ batchItemId, expectedRevision: 1, destinationBindings: ["IG_DEST"] });
    expect(refused).toMatchObject({ ok: false, code: "page_empty" });
    expect(String((refused as any).message)).toContain("2");
    expect(created).toEqual([]);
  });

  it("a new original page cannot bind a video child — videos are disclosed, never paged", async () => {
    const gadget = gadgetWith();
    const { batchItemId } = await draftingItem(gadget);
    const refused = await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      caption: CAPTION,
      pages: [
        { pageId: "pg_src_m1", kind: "original", mediaId: "m1", sourceMediaId: "m1" },
        { pageId: "pg_v", kind: "original", mediaId: "v1", sourceMediaId: "v1" }
      ]
    });
    expect(refused).toMatchObject({ ok: false, issues: [{ code: "page_source_video" }] });
  });

  it("a save correlated to a page-scoped ask cannot grow a generated page the ask never named", async () => {
    const gadget = gadgetWith();
    const { batchId, batchItemId } = await draftingItem(gadget);
    // Ask for a caption plus BOTH pages; delivering only page 1's media
    // leaves page 2 outstanding, so the correlated save reaches the
    // page-scope check instead of tripping the stale-request guard on a
    // satisfied mark. (The caption scope is what lets the save carry one.)
    const request = (
      await gadget.requestGeneration(batchId, [batchItemId], {
        needs: { caption: true, image: true, imagePages: ["pg_src_m1", "pg_src_m2"] },
        image: { references: "none" },
        replace: true
      })
    ).request;
    const registered = await gadget.saveGeneratedImage({ batchItemId, attachmentId: "a", generationRequest: request, pageId: "pg_src_m1" });
    await gadget.deliverGeneratedImage({ id: registered.id, bytes: JPEG });
    // The correlated save may pin the delivered media on the asked page — a
    // second generated page the ask never scoped is refused by name.
    const refused = await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      generationRequest: request,
      caption: CAPTION,
      pages: [
        { pageId: "pg_src_m1", kind: "generated", mediaId: registered.id, sourceMediaId: "m1" },
        { pageId: "pg_extra", kind: "generated", mediaId: registered.id }
      ]
    });
    expect(refused).toMatchObject({ ok: false, issues: [{ code: "generation_page_not_requested" }] });
    // The same list WITHOUT the extra page files the delivery cleanly.
    const saved = await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      generationRequest: request,
      caption: CAPTION,
      pages: [{ pageId: "pg_src_m1", kind: "generated", mediaId: registered.id, sourceMediaId: "m1" }]
    });
    expect(saved).toMatchObject({ ok: true });
    // Page 2 is still outstanding — the save satisfied page 1's part of the
    // ask without fabricating the rest.
    const mark = generationMark(gadget.storage.getBatchItem(batchItemId).generation);
    expect(mark?.needs.imagePages).toEqual(["pg_src_m2"]);
  });
});

// ---------------------------------------------------------------------------
// Migration 20: the backfill a pre-pages store receives.
// ---------------------------------------------------------------------------
describe("migration 20 backfill", () => {
  it("derives pages_json from the legacy columns and adds generated_media.page_id", async () => {
    const { ctx, db } = sqliteContext();
    const gadget = new Gadget(ctx as never, { workspace: { notify: async () => {} } } as never);
    gadget.storage.setConfig({ protectedTerms: [], protectedHashtags: [], disclaimers: [], claimsRequiringConfirmation: [] });
    gadget.storage.upsertItem({
      id: "instagram:IG_MAIN:p1",
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      provider: "instagram",
      providerItemId: "p1",
      text: "Source",
      media: SOURCE_MEDIA,
      metrics: {},
      contentHash: "h",
      firstSeenAt: "2026-09-06T00:00:00.000Z",
      lastSeenAt: "2026-09-06T00:00:00.000Z"
    });
    gadget.storage.createBatch("batch-1");
    gadget.storage.createBatchItem({ id: "item-1", batchId: "batch-1", itemId: "instagram:IG_MAIN:p1", state: "drafting" });
    gadget.storage.saveGeneratedMedia({ id: "gm_pin", batchItemId: "item-1", attachmentId: "a", mimeType: "image/jpeg", generationRequest: null, pageId: null, stale: false });
    db.prepare("UPDATE generated_media SET bytes = ?, byte_length = ?, delivered_at = '2026-09-10T00:00:01.000Z' WHERE id = 'gm_pin'").run(JPEG, JPEG.byteLength);
    db.prepare(
      "INSERT INTO revisions (batch_item_id, revision, caption, accepted_visual_mode, accepted_generated_media_id, accepted_generated_media_provenance, accepted_generated_media_source, alt_text, created_at) VALUES ('item-1', 1, ?, 'ai_refinement', 'gm_pin', 'recorded', 'generation', ?, '2026-09-10T00:00:02.000Z')"
    ).run(CAPTION, "Pinned alt");
    db.prepare(
      "INSERT INTO revisions (batch_item_id, revision, caption, accepted_visual_mode, created_at) VALUES ('item-1', 2, ?, 'keep_original', '2026-09-11T00:00:02.000Z')"
    ).run(CAPTION);
    db.prepare("UPDATE batch_items SET current_revision = 2 WHERE id = 'item-1'").run();

    // Rewind the schema-20 columns the migration owns, then replay it.
    db.exec("ALTER TABLE revisions DROP COLUMN pages_json");
    db.exec("ALTER TABLE generated_media DROP COLUMN page_id");
    db.exec("UPDATE schema_version SET version = 19");
    expect(gadget.storage.migrate()).toBe(20);

    const pinned = gadget.storage.getRevision("item-1", 1);
    expect(pinned?.pages).toEqual([
      {
        pageId: "pg_leg_item-1_1_1",
        kind: "generated",
        mediaId: "gm_pin",
        sourceMediaId: "m1",
        altText: "Pinned alt",
        mediaDigest: null,
        mediaProvenance: "recorded",
        mediaAcceptance: "generation"
      }
    ]);
    const originals = gadget.storage.getRevision("item-1", 2);
    expect(originals?.pages?.map((page: any) => [page.kind, page.mediaId])).toEqual([
      ["original", "m1"],
      ["original", "m2"],
      ["original", "v1"]
    ]);
    // The pinned media set now includes page mediaIds — gm_pin stays
    // "accepted" rather than drifting to "candidate" when a newer ask lands.
    const classify = gadget.storage.generatedMediaStatuses("item-1");
    expect(classify(gadget.storage.getGeneratedMedia("gm_pin"))).toBe("accepted");
  });
});
