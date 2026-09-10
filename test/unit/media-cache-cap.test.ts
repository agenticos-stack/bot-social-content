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
