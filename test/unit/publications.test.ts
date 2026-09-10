import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";
import { Storage } from "../../src/storage.js";

/**
 * The plan's §6 cases (refactor-draft-before-destination-1): a destination is
 * a `send` target decided at submit, recorded on `publications` — never a
 * precondition for `generate` work, and never a column on the draft.
 */

type Sqlite = {
  exec(sql: string): void;
  prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
  close(): void;
};

const databases: Sqlite[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function sqlite() {
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
  return { ctx, db, sql };
}

/** The Social Hub as the gadget sees it: createDraft answers, submitForReview files the ask by refusing. */
function mockSocial(created: unknown[]) {
  let version = 0;
  return {
    social: {
      async createDraft(input: { targets?: { destinationBinding: string }[] }) {
        created.push(input);
        version += 1;
        return {
          postId: `post-${version}`,
          versionId: `ver-${version}`,
          versionNumber: 1,
          contentHash: `hash-${version}`,
          targets: (input.targets ?? []).map((target) => ({ ...target, label: target.destinationBinding, outcome: "submitted" }))
        };
      },
      async submitForReview() {
        return { refused: true, code: "submission_required", message: "Needs owner approval.", authority: "send" };
      }
    }
  };
}

function gadgetWith(env: Record<string, unknown>, rightsPolicy = "trust_connected") {
  const { ctx } = sqlite();
  const gadget = new Gadget(ctx as never, env as never);
  gadget.storage.setConfig({
    rightsPolicy,
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: []
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
    media: [],
    metrics: {},
    contentHash: "source-hash",
    firstSeenAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z"
  });
  return gadget;
}

async function draft(gadget: Gadget, itemIds = ["instagram:IG_MAIN:p1"], extra: Record<string, unknown> = {}) {
  const batch = await gadget.createBatch({ itemIds, ...extra });
  if (!batch || batch.ok === false) return batch;
  const item = batch.items[0];
  await gadget.saveRevision({ batchItemId: item.id, expectedRevision: 0, caption: "第一稿內容文字" });
  return { batch, item };
}

describe("TEST-001: drafting needs no destination and no publishing door", () => {
  it("creates the batch and reaches drafting with neither configured", async () => {
    // No social door, no destination row — REQ-001's exact owner.
    const gadget = gadgetWith({ workspace: { notify: async () => {} } });
    const batch = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    expect(batch.ok).not.toBe(false);
    expect(batch.items[0].state).toBe("drafting");
    expect(batch.items[0].destinationBindings).toEqual([]);
    expect(batch.items[0].publications).toEqual([]);
    // And the draft saves without a destination anywhere in sight.
    const saved = await gadget.saveRevision({
      batchItemId: batch.items[0].id,
      expectedRevision: 0,
      caption: "第一稿內容文字"
    });
    expect(saved).toMatchObject({ ok: true, revision: 1 });
  });
});

describe("TEST-002: one active localization per post while it is drafting", () => {
  it("a second Continue refuses duplicate_active, and createNewVersion supersedes it", async () => {
    const gadget = gadgetWith({ workspace: { notify: async () => {} } });
    const first = await draft(gadget);
    const second = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    expect(second).toMatchObject({ ok: false, code: "duplicate_active" });
    expect(second.message).toContain(first.batch.id);

    const renewed = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"], createNewVersion: true });
    expect(renewed.ok).not.toBe(false);
    expect(renewed.items[0].id).not.toBe(first.item.id);
    // The retired row stays readable; it is simply no longer active.
    expect(gadget.storage.getBatchItem(first.item.id)?.active).toBeFalsy();
  });
});

describe("TEST-004/005/012: the pair rule lives at submit", () => {
  it("refuses a submit with no destination, and writes no publication", async () => {
    const created: unknown[] = [];
    const gadget = gadgetWith({ workspace: { notify: async () => {} }, ...mockSocial(created) });
    const { item } = await draft(gadget);

    const refused = await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1, destinationBindings: [] });
    expect(refused).toMatchObject({ ok: false, code: "batch_needs_destinations" });
    // Nothing filed, nothing asked of the door.
    expect(gadget.storage.publicationsFor(item.id)).toEqual([]);
    expect(created).toEqual([]);

    // The implicit default refuses the same way when nothing was recorded.
    const implicit = await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1 });
    expect(implicit).toMatchObject({ ok: false, code: "batch_needs_destinations" });
    expect(gadget.storage.publicationsFor(item.id)).toEqual([]);
  });

  it("files one publication per binding, and the same pair on another localization refuses", async () => {
    const created: unknown[] = [];
    const gadget = gadgetWith({ workspace: { notify: async () => {} }, ...mockSocial(created) });
    const first = await draft(gadget);

    const submitted = await gadget.submitForReview({
      batchItemId: first.item.id,
      expectedRevision: 1,
      destinationBindings: ["FB_MAIN"],
      intent: { publishMode: "publish_now" }
    });
    expect(submitted.ok).not.toBe(false);
    expect(submitted.submitted).toHaveLength(1);
    // One publication row: the pair, its revision, the intent, the receipt.
    expect(gadget.storage.publicationsFor(first.item.id)).toMatchObject([
      { destinationBinding: "FB_MAIN", revision: 1, state: "review_requested", postId: "post-1", version: "ver-1" }
    ]);
    // Each binding is its own draft: the door saw exactly one target.
    expect((created[0] as { targets: unknown[] }).targets).toEqual([{ destinationBinding: "FB_MAIN" }]);

    // The owner's new version leaves the filed localization active — REQ-017's
    // pair, not the item, is now what a second draft would collide with.
    const second = await draft(gadget, ["instagram:IG_MAIN:p1"], { createNewVersion: true });
    expect(second.ok).not.toBe(false);
    expect(gadget.storage.getBatchItem(first.item.id)?.active).toBeTruthy();

    const collided = await gadget.submitForReview({
      batchItemId: second.item.id,
      expectedRevision: 1,
      destinationBindings: ["FB_MAIN"]
    });
    expect(collided).toMatchObject({ ok: false, code: "duplicate_active" });
    expect(collided.message).toContain(first.batch.id);
    expect(gadget.storage.publicationsFor(second.item.id)).toEqual([]);

    // A different destination is a different pair — it files.
    const other = await gadget.submitForReview({
      batchItemId: second.item.id,
      expectedRevision: 1,
      destinationBindings: ["IG_OUT"]
    });
    expect(other.ok).not.toBe(false);
    expect(gadget.storage.publicationsFor(second.item.id)).toMatchObject([
      { destinationBinding: "IG_OUT", state: "review_requested" }
    ]);

    // And the explicit opt-in retires the claimed pair as the filing lands.
    const retaken = await gadget.submitForReview({
      batchItemId: second.item.id,
      expectedRevision: 1,
      destinationBindings: ["FB_MAIN"],
      createNewVersion: true
    });
    expect(retaken.ok).not.toBe(false);
    expect(gadget.storage.publicationsFor(first.item.id)[0].state).toBe("superseded");
    expect(
      gadget.storage
        .publicationsFor(second.item.id)
        .map((row) => `${row.destinationBinding}:${row.state}`)
        .sort()
    ).toEqual(["FB_MAIN:review_requested", "IG_OUT:review_requested"]);
  });
});

describe("TEST-006: rights are enforced before a publication exists", () => {
  it("refuses unconfirmed rights at submit and writes nothing", async () => {
    const created: unknown[] = [];
    const gadget = gadgetWith({ workspace: { notify: async () => {} }, ...mockSocial(created) }, "require_confirmation");
    const { item } = await draft(gadget);
    expect(item.state).toBe("held_rights");

    const refused = await gadget.submitForReview({
      batchItemId: item.id,
      expectedRevision: 1,
      destinationBindings: ["FB_MAIN"]
    });
    expect(refused).toMatchObject({ ok: false, code: "rights_unconfirmed" });
    expect(gadget.storage.publicationsFor(item.id)).toEqual([]);
    expect(created).toEqual([]);

    await gadget.confirmRights({ batchItemId: item.id, status: "confirmed", by: "owner" });
    const submitted = await gadget.submitForReview({
      batchItemId: item.id,
      expectedRevision: 1,
      destinationBindings: ["FB_MAIN"]
    });
    expect(submitted.ok).not.toBe(false);
  });
});

describe("TEST-007: migration 8 backfills live rows", () => {
  it("creates one publication per recorded binding and preserves post_id, version and approval_id", () => {
    const { db, ctx } = sqlite();
    // A schema-version-7 database, the shape live instances actually carry.
    db.exec(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    // The real v7 shape carries the batches row too — migration 9 alters it.
    db.exec(`CREATE TABLE batches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL)`);
    db.exec(`CREATE TABLE batch_items (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, item_id TEXT NOT NULL,
      destination_bindings_json TEXT NOT NULL, state TEXT NOT NULL,
      rights_status TEXT NOT NULL DEFAULT 'pending', rights_confirmed_by TEXT, rights_confirmed_at TEXT,
      current_revision INTEGER NOT NULL DEFAULT 0, approved_revision INTEGER, active INTEGER NOT NULL DEFAULT 1,
      approval_id TEXT, content_hash TEXT, post_id TEXT, version TEXT, targets_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE revisions (
      batch_item_id TEXT NOT NULL, revision INTEGER NOT NULL, caption TEXT,
      poster_layout_json TEXT, confirmed_claims_json TEXT, issues_json TEXT,
      derived_media_refs_json TEXT, publication_intent_json TEXT, ledger_json TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (batch_item_id, revision))`);
    db.exec("INSERT INTO schema_version VALUES (1, 7)");
    // A submitted row — the receipt (approval/post/version) must survive.
    db.exec(`INSERT INTO batch_items
      (id, batch_id, item_id, destination_bindings_json, state, current_revision, approved_revision,
       approval_id, post_id, version, created_at, updated_at)
      VALUES ('bi-old', 'b-old', 'item-x', '["FB_MAIN","IG_OUT"]', 'review_requested', 3, 3,
              'appr-9', 'post-9', 'ver-9', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`);
    db.exec(`INSERT INTO revisions (batch_item_id, revision, publication_intent_json, created_at)
      VALUES ('bi-old', 3, '{"publishMode":"schedule","publishLocalTime":"2026-09-20T09:00","timezone":"Asia/Hong_Kong"}', '2026-09-01T00:00:00Z')`);
    // A drafted row that never went anywhere — its bindings were only recorded.
    db.exec(`INSERT INTO batch_items
      (id, batch_id, item_id, destination_bindings_json, state, current_revision, created_at, updated_at)
      VALUES ('bi-draft', 'b-old', 'item-y', '["FB_MAIN"]', 'drafting', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`);

    const storage = new Storage(ctx as never);
    storage.migrate();

    const filed = storage.publicationsFor("bi-old");
    expect(filed).toHaveLength(2);
    expect(filed.map((row) => row.destinationBinding).sort()).toEqual(["FB_MAIN", "IG_OUT"]);
    for (const row of filed) {
      expect(row).toMatchObject({ revision: 3, state: "review_requested", approvalId: "appr-9", postId: "post-9", version: "ver-9" });
      expect(row.intent).toMatchObject({ publishMode: "schedule", timezone: "Asia/Hong_Kong" });
    }
    const bound = storage.publicationsFor("bi-draft");
    expect(bound).toMatchObject([{ destinationBinding: "FB_MAIN", revision: 1, state: "bound", postId: null, version: null }]);
  });
});

describe("TEST-008: a legacy caller's destinationBindings still land", () => {
  it("records them as bound publications and defaults the submit picker", async () => {
    const created: unknown[] = [];
    const gadget = gadgetWith({ workspace: { notify: async () => {} }, ...mockSocial(created) });
    const batch = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"], destinationBindings: ["FB_MAIN", "IG_OUT"] });
    const item = batch.items[0];
    // The column stays empty — the bindings live as `bound` publications.
    expect(gadget.storage.getBatchItem(item.id)?.destinationBindings).toEqual([]);
    expect(
      gadget.storage
        .publicationsFor(item.id)
        .map((row) => `${row.destinationBinding}:${row.state}`)
        .sort()
    ).toEqual(["FB_MAIN:bound", "IG_OUT:bound"]);
    // The projected item shows them — the picker's default (CON-004).
    expect([...item.destinationBindings].sort()).toEqual(["FB_MAIN", "IG_OUT"]);

    await gadget.saveRevision({ batchItemId: item.id, expectedRevision: 0, caption: "第一稿內容文字" });
    // A caller that sends nothing files the recorded set — the old shape's
    // meaning preserved.
    const submitted = await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1 });
    expect(submitted.ok).not.toBe(false);
    expect(submitted.submitted.map((row: { destinationBinding: string }) => row.destinationBinding).sort()).toEqual(["FB_MAIN", "IG_OUT"]);
    // The bound rows became the filings — no second row for the same pair.
    expect(
      gadget.storage
        .publicationsFor(item.id)
        .map((row) => `${row.destinationBinding}:${row.state}:r${row.revision}`)
        .sort()
    ).toEqual(["FB_MAIN:review_requested:r1", "IG_OUT:review_requested:r1"]);
    // Two bindings, two separate drafts — each door call saw its own pair.
    expect(
      created.map((input) => (input as { targets: { destinationBinding: string }[] }).targets[0].destinationBinding).sort()
    ).toEqual(["FB_MAIN", "IG_OUT"]);
  });
});
