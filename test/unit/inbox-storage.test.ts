import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "../../src/storage.js";

// Run the actual facet SQL and migrations, without importing the host Worker graph.
describe("saved inbox SQL", () => {
  let db: DatabaseSync;
  let storage: Storage;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    storage = new Storage({
      storage: {
        sql: {
          exec(query: string, ...params: any[]) {
            const statement = db.prepare(query);
            const result = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
            return { toArray: () => result };
          }
        },
        transactionSync<T>(run: () => T): T {
          db.exec("BEGIN");
          try {
            const result = run();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
      }
    });
    storage.migrate();
  });
  afterEach(() => db.close());

  function batch(id: string) {
    db.prepare("INSERT INTO batches VALUES (?, '2026-09-06T12:00:00Z', 'open')").run(id);
  }
  function item(id: string, batchId: string, sourceId: string, revision: number) {
    db.prepare(
      `INSERT INTO batch_items
      (id,batch_id,item_id,destination_bindings_json,state,current_revision,created_at,updated_at)
      VALUES (?,?,?,'[]','drafting',?,'2026-09-06T12:00:00Z','2026-09-06T12:00:00Z')`
    ).run(id, batchId, sourceId, revision);
    db.prepare(
      `INSERT INTO revisions (batch_item_id,revision,caption,created_at) VALUES (?,?,?,'2026-09-06T12:00:00Z')`
    ).run(id, revision, "Saved caption " + id);
  }
  it("returns actual saved revision/caption with bounded representative metadata", () => {
    batch("b");
    db.prepare(
      `INSERT INTO items
      (id,source_binding,source_label,provider,provider_item_id,text,media_json,metrics_json,content_hash,first_seen_at,last_seen_at)
      VALUES ('source','binding','Account','instagram','provider-id',?,'[{"id":"media"}]','{}','hash','now','now')`
    ).run("x".repeat(500));
    item("second", "b", "source", 9);
    item("first", "b", "source", 7);
    const result = storage.listBatchSummaries();
    expect(result.batches[0].itemCount).toBe(2); // joins do not multiply counts
    expect(result.batches[0].preview).toMatchObject({
      batchItemId: "first",
      revision: 7,
      caption: "Saved caption first",
      sourceLabel: "Account",
      hasMediaReference: true
    });
    expect(result.batches[0].preview.sourceText).toHaveLength(160);
    db.prepare("DELETE FROM items").run();
    expect(storage.listBatchSummaries().batches[0].preview).toMatchObject({
      revision: 7,
      caption: "Saved caption first",
      sourceText: null
    });
  });
  it("pages more than 50 equal-timestamp batches exactly once and keeps full totals", () => {
    for (let i = 0; i < 55; i++) batch("b" + String(i).padStart(3, "0"));
    const first = storage.listBatchSummaries();
    const second = storage.listBatchSummaries({ cursor: first.nextCursor });
    expect(first.batches).toHaveLength(50);
    expect(second.batches).toHaveLength(5);
    expect(new Set([...first.batches, ...second.batches].map((b) => b.id)).size).toBe(55);
    expect(first.totals.batches).toBe(55);
    expect(second.nextCursor).toBeNull();
    expect(storage.listBatchSummaries({ limit: 2.8 }).batches).toHaveLength(2);
  });
});
