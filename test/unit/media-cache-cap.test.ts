import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";

const databases: Array<{ close(): void }> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function context() {
  const { DatabaseSync } = (
    globalThis as unknown as { process: { getBuiltinModule(name: string): { DatabaseSync: new (path: string) => any } } }
  ).process.getBuiltinModule("node:sqlite");
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
        try { const r = callback(); db.exec("COMMIT"); return r; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    }
  };
}

/** The metered_fetch door an OPEN source reaches, answering in the door's own shape. */
function openDoorServing(byteLength: number, mime = "image/jpeg", seen?: { url?: string }) {
  return {
    metered_fetch: {
      fetch_media: async (input: { url: string }) => {
        if (seen) seen.url = input.url;
        return { ok: true, mime, bytes: new Uint8Array(byteLength).fill(3), byteLength };
      }
    }
  };
}

/** A connector door that answers `fetch_media` with however many bytes we ask for. */
function doorServing(byteLength: number, mime = "video/mp4") {
  return {
    LOCAL_SAMPLE: {
      fetch_media: async () => ({
        outcome: "confirmed",
        data: { mime, bytes: new Uint8Array(byteLength).fill(7) }
      })
    }
  };
}

function withItem(env: unknown) {
  const gadget = new Gadget(context() as never, env as never);
  gadget.storage.upsertItem({
    id: "item-1",
    sourceBinding: "LOCAL_SAMPLE",
    sourceLabel: "Local sample",
    provider: "instagram",
    providerItemId: "p1",
    text: "a post",
    media: [{ id: "source-media", kind: "video", url: "https://cdn.example.test/o1/AAA.mp4" }],
    metrics: {},
    contentHash: "source-hash",
    firstSeenAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z"
  } as never);
  return gadget;
}

/*
 * A cap is a statement about what this cache will HOLD, not a licence to keep
 * part of what does not fit.
 *
 * `fetchAndCacheMedia` used to do `raw.slice(0, cap)`, so anything larger than
 * the rendition's cap was stored as a corrupt file of exactly the cap's size
 * and reported as success. Every format here is length-sensitive — a truncated
 * MP4 will not play, a truncated JPEG will not decode — and the first item this
 * gadget ever scanned from a real account is a 2.7 MB reel, so the very first
 * real fetch would have cached 1 MB of unusable bytes.
 */
describe("the media cache refuses what it cannot hold", () => {
  it("stores media that fits, whole", async () => {
    const gadget = withItem(doorServing(120 * 1024, "image/jpeg"));
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect((result as { ok?: boolean }).ok).not.toBe(false);
    expect((result as { total: number }).total).toBe(120 * 1024);
  });

  it("holds a full-size feed photo as a thumb, because that is the only rendition there is", async () => {
    // The provider publishes one `image_versions2.candidate` per photo, so a
    // thumb IS the full-size file. At 256KB this cap refused the two largest
    // photos of the first twelve from a real account, after the door had
    // already fetched and been paid for them.
    const gadget = withItem(doorServing(400 * 1024, "image/jpeg"));
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect((result as { ok?: boolean }).ok).not.toBe(false);
    expect((result as { total: number }).total).toBe(400 * 1024);
  });

  it("still refuses a thumb over the cap the door itself would have refused", async () => {
    const gadget = withItem(doorServing(600 * 1024, "image/jpeg"));
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect(result).toMatchObject({ ok: false, code: "media_too_large" });
  });

  it("refuses an oversized rendition instead of storing a prefix of it", async () => {
    const gadget = withItem(doorServing(2_771_211));           // the real reel's size
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "preview" });
    expect(result).toMatchObject({ ok: false, code: "media_too_large" });
    // The message carries both numbers: an owner told "no media" hunts a broken
    // source, one told the size and the cap knows the media is fine.
    expect((result as { message: string }).message).toMatch(/2707KB/);
    expect((result as { message: string }).message).toMatch(/1024KB/);
  });

  it("caches nothing when it refuses, so a later read does not find a corrupt copy", async () => {
    const gadget = withItem(doorServing(2_771_211));
    await gadget.getMedia("item-1", "source-media", { rendition: "preview" });
    expect(gadget.storage.getMedia("item-1", "source-media", "preview")).toBeFalsy();
  });
});

/*
 * Which door owns a source's bytes is decided by its ORIGIN, the same way
 * `scanOneSource` picks its reader — not by the binding's shape, and not by
 * trying one and falling back, which would reach for a grant that does not
 * exist and report its absence as a provider failure.
 */
describe("bytes come from the door that owns the source", () => {
  function withOpenItem(env: unknown, media: Record<string, unknown>) {
    const gadget = new Gadget(context() as never, env as never);
    gadget.storage.addOpenSource({
      binding: "open:instagram:acct", platform: "instagram", accountKey: "acct", displayName: "@acct"
    } as never);
    gadget.storage.upsertItem({
      id: "item-1", sourceBinding: "open:instagram:acct", sourceLabel: "@acct",
      provider: "instagram", providerItemId: "p1", text: "a post",
      media: [media], metrics: {}, contentHash: "h",
      firstSeenAt: "2026-09-06T00:00:00.000Z", lastSeenAt: "2026-09-06T00:00:00.000Z"
    } as never);
    return gadget;
  }

  it("an open source reaches metered_fetch, not a connector it does not have", async () => {
    const gadget = withOpenItem(
      openDoorServing(2048),
      { id: "source-media", kind: "image", url: "https://cdn.example.test/o1/a.jpg" }
    );
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect((result as { ok?: boolean }).ok).not.toBe(false);
    expect((result as { total: number }).total).toBe(2048);
  });

  it("a video fetches its poster, never its file", async () => {
    const seen: { url?: string } = {};
    const gadget = withOpenItem(openDoorServing(1024, "image/jpeg", seen), {
      id: "source-media", kind: "video",
      url: "https://cdn.example.test/v/reel.mp4",
      posterUrl: "https://cdn.example.test/t/poster.jpg"
    });
    await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect(seen.url).toBe("https://cdn.example.test/t/poster.jpg");
    expect(seen.url).not.toContain(".mp4");
  });

  it("says so plainly when the open source has no fetch door granted", async () => {
    const gadget = withOpenItem({}, { id: "source-media", kind: "image", url: "https://cdn.example.test/a.jpg" });
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect(result).toMatchObject({ ok: false });
  });
});

/*
 * Bytes do not survive the facet RPC as a typed array.
 *
 * A door hands back a `Uint8Array`; by the time the gadget sees it, Node has
 * serialised it to `{ type: "Buffer", data: [...] }`. Every `instanceof` check
 * missed that, `toBytes` returned null, and the caller reported "No thumb
 * media" — a sentence about the source, and false. The door had been working
 * for some time before this could tell.
 */
describe("bytes that crossed the RPC", () => {
  function doorReturning(bytes: unknown) {
    return {
      metered_fetch: {
        fetch_media: async () => ({ ok: true, mime: "image/jpeg", bytes, byteLength: 3 })
      }
    };
  }
  function gadgetWith(env: unknown) {
    const gadget = new Gadget(context() as never, env as never);
    gadget.storage.addOpenSource({
      binding: "open:instagram:acct", platform: "instagram", accountKey: "acct", displayName: "@acct"
    } as never);
    gadget.storage.upsertItem({
      id: "item-1", sourceBinding: "open:instagram:acct", sourceLabel: "@acct",
      provider: "instagram", providerItemId: "p1", text: "a post",
      media: [{ id: "source-media", kind: "image", url: "https://cdn.example.test/a.jpg" }],
      metrics: {}, contentHash: "h",
      firstSeenAt: "2026-09-06T00:00:00.000Z", lastSeenAt: "2026-09-06T00:00:00.000Z"
    } as never);
    return gadget;
  }

  it("reads a Buffer's JSON form, which is what actually arrives", async () => {
    const gadget = gadgetWith(doorReturning({ type: "Buffer", data: [1, 2, 3] }));
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect((result as { ok?: boolean }).ok).not.toBe(false);
    expect((result as { total: number }).total).toBe(3);
  });

  it("still reads a real Uint8Array, for a caller that does not cross a boundary", async () => {
    const gadget = gadgetWith(doorReturning(new Uint8Array([1, 2, 3])));
    expect((await gadget.getMedia("item-1", "source-media", { rendition: "thumb" }) as { total: number }).total).toBe(3);
  });

  it("names an unreadable shape rather than reporting no media", async () => {
    const gadget = gadgetWith(doorReturning({ nonsense: true }));
    const result = await gadget.getMedia("item-1", "source-media", { rendition: "thumb" });
    expect(result).toMatchObject({ ok: false, code: "media_unreadable" });
  });
});

