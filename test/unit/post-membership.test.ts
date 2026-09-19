// The selector's server side: naming a post, adding one from Sources, and
// removing one. Each mutation answers by value (PAT-007) — refusals carry a
// `code`, never a throw — and removal is supersede, so the row, its revisions
// and its publications stay as the audit trail.
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
    },
    db
  };
}

function gadgetWith(items: string[] = ["p1", "p2", "p3"]) {
  const { ctx, db } = sqliteContext();
  const gadget = new Gadget(ctx as never, { workspace: { notify: async () => {} } } as never);
  gadget.storage.setConfig({ protectedTerms: [], protectedHashtags: [], disclaimers: [], claimsRequiringConfirmation: [] });
  gadget.storage.setDestinations([{ binding: "FB_MAIN", label: "Facebook", provider: "facebook" }]);
  for (const suffix of items) {
    gadget.storage.upsertItem({
      id: `instagram:IG_MAIN:${suffix}`,
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      provider: "instagram",
      providerItemId: suffix,
      text: `Source ${suffix} first line`,
      media: [{ id: `m_${suffix}`, kind: "image", url: `https://cdn.example.com/${suffix}.jpg` }],
      metrics: {},
      contentHash: `hash-${suffix}`,
      firstSeenAt: "2026-09-10T00:00:00.000Z",
      lastSeenAt: "2026-09-10T00:00:00.000Z"
    });
  }
  return { gadget, db };
}

const itemId = (suffix: string) => `instagram:IG_MAIN:${suffix}`;

/** Marks one batch item's publication row as actually filed. */
function filePublication(db: Sqlite, batchItemId: string) {
  db.prepare(
    "UPDATE publications SET state = 'review_requested', post_id = 'post-9', version = 'ver-9' WHERE batch_item_id = ?"
  ).run(batchItemId);
}

describe("renameBatchItem", () => {
  it("stores the name, trims it, and clears back to NULL on empty", async () => {
    const { gadget } = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: [itemId("p1")], destinationBindings: ["FB_MAIN"] });
    const post = opened.items[0];
    expect(post.title).toBeNull();

    expect(await gadget.renameBatchItem({ batchItemId: post.id, title: "  Weekend tray  " })).toMatchObject({
      ok: true, title: "Weekend tray"
    });
    let batch = await gadget.getBatch(opened.id);
    expect(batch.items[0].title).toBe("Weekend tray");

    // Empty clears — the derived source-head name shows again.
    expect(await gadget.renameBatchItem({ batchItemId: post.id, title: "   " })).toMatchObject({ ok: true, title: null });
    batch = await gadget.getBatch(opened.id);
    expect(batch.items[0].title).toBeNull();
  });

  it("refuses by value on an unknown or submitted post", async () => {
    const { gadget, db } = gadgetWith();
    expect(await gadget.renameBatchItem({ batchItemId: "bi_missing", title: "x" })).toMatchObject({
      ok: false, code: "post_not_found"
    });
    const opened = await gadget.createBatch({ itemIds: [itemId("p1")], destinationBindings: ["FB_MAIN"] });
    filePublication(db, opened.items[0].id);
    expect(await gadget.renameBatchItem({ batchItemId: opened.items[0].id, title: "x" })).toMatchObject({
      ok: false, code: "post_locked"
    });
  });
});

describe("removeBatchItem", () => {
  it("supersedes the row — it leaves the batch's projection and stays as audit", async () => {
    const { gadget, db } = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: [itemId("p1"), itemId("p2")], destinationBindings: ["FB_MAIN"] });
    const [first] = opened.items;
    await gadget.saveRevision({ batchItemId: first.id, expectedRevision: 0, caption: "第一稿" });

    expect(await gadget.removeBatchItem({ batchItemId: first.id })).toMatchObject({ ok: true, batchItemId: first.id });
    const batch = await gadget.getBatch(opened.id);
    expect(batch.items.map((item: { id: string }) => item.id)).toEqual([opened.items[1].id]);

    // The audit rows survive: the batch item, its revision, its bound default.
    const rows = db.prepare("SELECT id, active FROM batch_items WHERE id = ?").all(first.id) as Array<{ active: number }>;
    expect(rows[0].active).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE batch_item_id = ?").all(first.id)).toEqual([{ n: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM publications WHERE batch_item_id = ?").all(first.id)).toEqual([{ n: 1 }]);
  });

  it("refuses the last post and a submitted one", async () => {
    const { gadget, db } = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: [itemId("p1")], destinationBindings: ["FB_MAIN"] });
    expect(await gadget.removeBatchItem({ batchItemId: opened.items[0].id })).toMatchObject({ ok: false, code: "last_post" });
    filePublication(db, opened.items[0].id);
    const second = await gadget.createBatch({ itemIds: [itemId("p2"), itemId("p3")] });
    const filed = second.items[0];
    db.prepare("INSERT INTO publications (id, batch_item_id, destination_binding, revision, intent_json, state, created_at, updated_at) VALUES ('pub_f', ?, 'FB_MAIN', 0, '{}', 'review_requested', 'x', 'x')").run(filed.id);
    expect(await gadget.removeBatchItem({ batchItemId: filed.id })).toMatchObject({ ok: false, code: "post_locked" });
    expect(await gadget.removeBatchItem({ batchItemId: "bi_missing" })).toMatchObject({ ok: false, code: "post_not_found" });
  });
});

describe("addBatchItem", () => {
  it("adds a source post to the batch with the siblings' bound destinations", async () => {
    const { gadget, db } = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: [itemId("p1")], destinationBindings: ["FB_MAIN"] });
    const added = await gadget.addBatchItem({ batchId: opened.id, itemId: itemId("p2") });
    expect(added).toMatchObject({ ok: true });
    expect(added.item.itemId).toBe(itemId("p2"));
    expect(added.item.state).toBe("drafting");
    // The new post inherits the batch's recorded destination defaults as `bound`.
    const pubs = db.prepare("SELECT destination_binding, state FROM publications WHERE batch_item_id = ?").all(added.item.id) as Array<{ destination_binding: string; state: string }>;
    expect(pubs).toEqual([{ destination_binding: "FB_MAIN", state: "bound" }]);
    const batch = await gadget.getBatch(opened.id);
    expect(batch.items.map((item: { itemId: string }) => item.itemId)).toEqual([itemId("p1"), itemId("p2")]);
  });

  it("refuses a source already in the batch and one drafted elsewhere", async () => {
    const { gadget } = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: [itemId("p1"), itemId("p2")] });
    expect(await gadget.addBatchItem({ batchId: opened.id, itemId: itemId("p1") })).toMatchObject({
      ok: false, code: "already_in_batch"
    });
    // p3 was drafted in its own batch — REQ-017 refuses the pair.
    await gadget.createBatch({ itemIds: [itemId("p3")] });
    const duplicate = await gadget.addBatchItem({ batchId: opened.id, itemId: itemId("p3") });
    expect(duplicate).toMatchObject({ ok: false, code: "duplicate_active" });
    expect(await gadget.addBatchItem({ batchId: opened.id, itemId: "instagram:IG_MAIN:gone" })).toMatchObject({
      ok: false, code: "item_not_found"
    });
    expect(await gadget.addBatchItem({ batchId: "b_missing", itemId: itemId("p3") })).toMatchObject({
      ok: false, code: "batch_not_found"
    });
  });

  it("a removed post's source becomes pickable again", async () => {
    const { gadget } = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: [itemId("p1"), itemId("p2")] });
    await gadget.removeBatchItem({ batchItemId: opened.items[0].id });
    // The superseded row no longer blocks: the same source re-enters.
    const reAdded = await gadget.addBatchItem({ batchId: opened.id, itemId: itemId("p1") });
    expect(reAdded).toMatchObject({ ok: true });
  });
});

describe("the name follows the post", () => {
  it("a superseding draft inherits the title (REVIEW.md, schema 19)", async () => {
    const { gadget } = gadgetWith();
    const opened = await gadget.createBatch({ itemIds: [itemId("p1")] });
    await gadget.renameBatchItem({ batchItemId: opened.items[0].id, title: "週末特輯" });
    const second = await gadget.createBatch({ itemIds: [itemId("p1")], createNewVersion: true });
    expect(second.items[0].title).toBe("週末特輯");
    expect(second.items[0].id).not.toBe(opened.items[0].id);
  });
});
