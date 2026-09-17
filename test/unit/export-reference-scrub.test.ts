// The image brief's reference carries the connector-minted fetch URL so the
// platform can pull the source image — that path is internal, not owner
// content. `exportAs("json")` already strips item media to {id, kind}; the
// generation mark must make the same trade, or the export leaks the fetch
// address. Caught by the platform's workerd export contract test.
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

function gadget() {
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
  const instance = new Gadget(ctx as never, { workspace: { notify: async () => {} } } as never);
  instance.storage.setConfig({
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: []
  });
  instance.storage.upsertItem({
    id: "instagram:SRC:p1",
    sourceBinding: "SRC",
    sourceLabel: "Synthetic source",
    provider: "instagram",
    providerItemId: "p1",
    text: "Original",
    media: [{ id: "p1", kind: "image", url: "https://cdn.example.test/p1.jpg" }],
    metrics: {},
    contentHash: "h",
    firstSeenAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z"
  });
  return instance;
}

describe("exportAs json does not export a reference's fetch URL", () => {
  it("keeps the reference's media id and drops its connector URL", async () => {
    const g = gadget();
    const batch = await g.createBatch({ itemIds: ["instagram:SRC:p1"] });
    expect(batch.ok).not.toBe(false);

    // The stored mark keeps the whole brief — the URL is how the platform
    // reaches the source image, so the row must still carry it.
    const stored = JSON.parse(g.storage.getBatchItem(batch.items[0].id).generation);
    expect(stored.imageBrief.references).toEqual([{ id: "p1", url: "https://cdn.example.test/p1.jpg" }]);

    const exported = (await g.exportAs("json")) as { body: string; contentType: string };
    expect(exported.body).not.toContain("cdn.example.test");
    const parsed = JSON.parse(exported.body) as {
      batches: Array<{ items: Array<{ generation: string; lastGeneration: string | null }> }>;
    };
    const mark = JSON.parse(parsed.batches[0].items[0].generation);
    expect(mark.imageBrief).toEqual({ aspectRatio: "4:5", references: [{ id: "p1" }] });
  });
});
