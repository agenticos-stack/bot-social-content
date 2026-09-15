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
    db.prepare("INSERT INTO batches (id, created_at, status, generation) VALUES (?, '2026-09-06T12:00:00Z', 'open', NULL)").run(id);
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

  // §9.A — the Content card is a POST: per-item phases, filter counts and
  // facet totals all read the shared `itemPresentation` roll-up. Fixture
  // mirrors the audited preview: five posts across three batches —
  // a queued revision-0 item, a true draft, a filed review item with no
  // outcome yet, a revision-3 item whose superseded revision-2 "held" must
  // NOT shadow its published readback, and an unknown state.
  describe("per-item phases and totals", () => {
    function source(id: string) {
      db.prepare(
        `INSERT INTO items
        (id,source_binding,source_label,provider,provider_item_id,text,media_json,metrics_json,content_hash,first_seen_at,last_seen_at)
        VALUES (?,'binding','Account','instagram',?,'source text','[]','{}',?,'now','now')`
      ).run(id, `provider-${id}`, `hash-${id}`);
    }
    function batchItem(
      id: string,
      batchId: string,
      sourceId: string,
      { revision = 0, state = "drafting", generation = null as string | null, targets = null as unknown }
    ) {
      db.prepare(
        `INSERT INTO batch_items
        (id,batch_id,item_id,destination_bindings_json,state,current_revision,generation,targets_json,created_at,updated_at)
        VALUES (?,?,?,'[]',?,?,?,?,'2026-09-06T12:00:00Z','2026-09-06T12:00:00Z')`
      ).run(id, batchId, sourceId, state, revision, generation, targets == null ? null : JSON.stringify(targets));
      if (revision > 0) {
        db.prepare(
          `INSERT INTO revisions (batch_item_id,revision,caption,created_at) VALUES (?,?,?,'2026-09-06T12:00:00Z')`
        ).run(id, revision, `Saved caption ${id}`);
      }
    }
    function publication(
      id: string,
      batchItemId: string,
      binding: string,
      { revision, state }: { revision: number; state: string }
    ) {
      db.prepare(
        `INSERT INTO publications
        (id,batch_item_id,destination_binding,revision,intent_json,state,created_at,updated_at)
        VALUES (?,?,?,?,'{}',?,'2026-09-06T12:00:00Z','2026-09-06T12:00:00Z')`
      ).run(id, batchItemId, binding, revision, state);
    }

    it("rolls each item up to its own phase and counts by phase, not row state", () => {
      source("s1"); source("s2"); source("s3"); source("s4"); source("s5");
      batch("b-queued");
      batch("b-mixed");
      batch("b-filed");
      // Queued revision-0: marked, nothing drafted — must not read as output.
      batchItem("bi-q1", "b-queued", "s1", { generation: "requested" });
      // True drafts: one with a saved revision, one mid re-draft.
      batchItem("bi-d1", "b-mixed", "s2", { revision: 1 });
      batchItem("bi-d2", "b-mixed", "s3", { revision: 2, generation: "requested" });
      // Filed: review_requested with no outcome yet → in review.
      batchItem("bi-r1", "b-filed", "s4", { revision: 1, state: "review_requested" });
      publication("p-r1", "bi-r1", "IG_DEST", { revision: 1, state: "submitted" });
      // The audit's core defect: current revision published, an OLDER
      // revision's held filing superseded — the post is published, not held.
      batchItem("bi-p1", "b-filed", "s5", {
        revision: 3,
        state: "review_requested",
        targets: [{ destinationBinding: "IG_DEST", outcome: "published", publicationRevision: 3, receiptUrl: "https://example.test/receipt" }]
      });
      publication("p-old", "bi-p1", "IG_DEST", { revision: 2, state: "superseded" });
      publication("p-live", "bi-p1", "IG_DEST", { revision: 3, state: "submitted" });

      const page = storage.listBatchSummaries();
      const byId = new Map(page.batches.map((b) => [b.id, b]));
      const phaseOf = (batchId: string, itemId: string) =>
        byId.get(batchId)?.items.find((item: any) => item.batchItemId === itemId)?.phase;

      expect(phaseOf("b-queued", "bi-q1")).toBe("queued");
      expect(phaseOf("b-mixed", "bi-d1")).toBe("draft");
      expect(phaseOf("b-mixed", "bi-d2")).toBe("regenerating");
      expect(phaseOf("b-filed", "bi-r1")).toBe("in_review");
      expect(phaseOf("b-filed", "bi-p1")).toBe("published");

      // The published item carries its receipt in deliveries; the superseded
      // hold is history, not the state.
      const published = byId.get("b-filed")?.items.find((item: any) => item.batchItemId === "bi-p1");
      expect(published?.deliveries?.[0]?.outcome).toBe("published");
      expect(published?.deliveries?.[0]?.receiptUrl).toBe("https://example.test/receipt");

      // Batch counts and facet totals agree — five posts, five phases.
      expect(byId.get("b-mixed")?.draftCount).toBe(2);
      expect(byId.get("b-filed")?.reviewCount).toBe(1);
      expect(page.totals).toMatchObject({ items: 5, drafts: 3, review: 1, scheduled: 0, attention: 0 });

      // A limited page must not masquerade as workspace totals.
      expect(storage.listBatchSummaries({ limit: 1 }).totals.items).toBe(5);
    });

    it("marks generation per item and clears one mark without touching siblings", () => {
      source("s1"); source("s2");
      batch("b");
      batchItem("bi-a", "b", "s1", { revision: 1 });
      batchItem("bi-b", "b", "s2", { revision: 1 });

      storage.setGeneration("b", ["bi-a"], "gen-1");
      let items = storage.listBatchSummaries().batches[0].items;
      // The summary projection already parses the mark — `generation` is the
      // { id, base, needs } object, not the raw column text.
      expect(items.find((item: any) => item.batchItemId === "bi-a")?.generation)
        .toMatchObject({ id: "gen-1", base: 1, needs: { caption: true, image: true } });
      expect(items.find((item: any) => item.batchItemId === "bi-b")?.generation).toBeNull();
      expect(items.find((item: any) => item.batchItemId === "bi-a")?.phase).toBe("regenerating");
      expect(items.find((item: any) => item.batchItemId === "bi-b")?.phase).toBe("draft");

      storage.clearItemGeneration("bi-a");
      items = storage.listBatchSummaries().batches[0].items;
      expect(items.find((item: any) => item.batchItemId === "bi-a")?.generation).toBeNull();
      expect(items.find((item: any) => item.batchItemId === "bi-a")?.phase).toBe("draft");
    });

    it("a stale request id and a manual owner save satisfy nothing; only the correlated request completes", () => {
      source("s1");
      batch("b");
      batchItem("bi-a", "b", "s1", { revision: 1 });
      storage.setGeneration("b", ["bi-a"], "gen-1");

      // A write correlated to a superseded request id must not touch the mark.
      storage.satisfyItemGeneration("bi-a", { request: "gen-old", needs: { caption: true, image: true } });
      let generation = JSON.parse(storage.getBatchItem("bi-a").generation);
      expect(generation.id).toBe("gen-1");
      expect(generation.needs).toEqual({ caption: true, image: true });

      // A manual owner save (no request id) completes nothing (audit G1).
      storage.satisfyItemGeneration("bi-a", { request: null, needs: { caption: true, image: false } });
      generation = JSON.parse(storage.getBatchItem("bi-a").generation);
      expect(generation.needs).toEqual({ caption: true, image: true });

      // The correlated caption shrinks `needs`; `scope` stays what was asked.
      storage.satisfyItemGeneration("bi-a", { request: "gen-1", needs: { caption: true } });
      generation = JSON.parse(storage.getBatchItem("bi-a").generation);
      expect(generation.needs).toEqual({ caption: false, image: true });
      expect(generation.scope).toEqual({ caption: true, image: true });

      // The correlated delivery answers the image need; the mark clears,
      // and the batch roll-up follows once no active item is still marked.
      storage.satisfyItemGeneration("bi-a", { request: "gen-1", needs: { image: true } });
      expect(storage.getBatchItem("bi-a").generation).toBeNull();
      storage.clearGenerationIfAllDrafted("b");
      expect(storage.getBatch("b").generation).toBeNull();
    });

    it("counts attention for an unknown item state instead of hiding it", () => {
      source("s1");
      batch("b");
      batchItem("bi-x", "b", "s1", { revision: 1, state: "mystery" });
      const page = storage.listBatchSummaries();
      expect(page.batches[0].items[0].phase).toBe("attention");
      expect(page.totals.attention).toBe(1);
      expect(page.totals.drafts).toBe(0);
    });
  });

  // The attachment→gadget acceptance contract: register first (attachment
  // identity preserved), deliver bytes later, and the newest accepted row is
  // what the drawer and the submit path read.
  describe("generated media", () => {
    function source(id: string) {
      db.prepare(
        `INSERT INTO items
        (id,source_binding,source_label,provider,provider_item_id,text,media_json,metrics_json,content_hash,first_seen_at,last_seen_at)
        VALUES (?,'binding','Account','instagram',?,'source text','[]','{}',?,'now','now')`
      ).run(id, `provider-${id}`, `hash-${id}`);
    }
    function batchItem(id: string, batchId: string, sourceId: string) {
      db.prepare(
        `INSERT INTO batch_items
        (id,batch_id,item_id,destination_bindings_json,state,current_revision,created_at,updated_at)
        VALUES (?,?,?,'[]','drafting',0,'2026-09-06T12:00:00Z','2026-09-06T12:00:00Z')`
      ).run(id, batchId, sourceId);
    }

    it("registers before bytes, stays pending until delivered, and reports the newest row", () => {
      source("s1");
      batch("b");
      batchItem("bi-a", "b", "s1");

      storage.saveGeneratedMedia({ id: "gm-1", batchItemId: "bi-a", attachmentId: "upload-1", altText: "dark poster", mimeType: "image/png" });
      let row = storage.getGeneratedMedia("gm-1");
      expect(row).toMatchObject({ batchItemId: "bi-a", attachmentId: "upload-1", altText: "dark poster", mimeType: "image/png" });
      expect(row.bytes).toBeNull();
      expect(row.deliveredAt).toBeNull();
      expect(storage.pendingGeneratedMedia().map((pending: any) => pending.id)).toEqual(["gm-1"]);

      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      storage.deliverGeneratedMedia("gm-1", { bytes, mimeType: "image/png" });
      row = storage.getGeneratedMedia("gm-1");
      expect(row.byteLength).toBe(8);
      expect(row.deliveredAt).toBeTruthy();
      expect(storage.pendingGeneratedMedia()).toHaveLength(0);
      expect(storage.latestGeneratedMedia("bi-a")?.id).toBe("gm-1");

      // A second acceptance replaces `latest` without losing the first row.
      storage.saveGeneratedMedia({ id: "gm-2", batchItemId: "bi-a", attachmentId: "upload-2", altText: null, mimeType: null });
      expect(storage.latestGeneratedMedia("bi-a")?.id).toBe("gm-2");
      expect(storage.pendingGeneratedMedia().map((pending: any) => pending.id)).toEqual(["gm-2"]);
      expect(storage.getGeneratedMedia("gm-1")?.attachmentId).toBe("upload-1");
    });

    it("a delivered byte payload survives the BLOB round trip", () => {
      source("s1");
      batch("b");
      batchItem("bi-a", "b", "s1");
      storage.saveGeneratedMedia({ id: "gm-1", batchItemId: "bi-a", attachmentId: "u", altText: null, mimeType: null });
      const bytes = new Uint8Array([255, 216, 255, 224, 0, 16]);
      storage.deliverGeneratedMedia("gm-1", { bytes, mimeType: "image/jpeg" });
      const stored = storage.getGeneratedMedia("gm-1");
      expect(new Uint8Array(stored.bytes)).toEqual(bytes);
      expect(stored.mimeType).toBe("image/jpeg");
    });
  });
});
