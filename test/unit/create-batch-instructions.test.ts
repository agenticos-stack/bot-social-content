// The owner's first Draft records which instructions it was made under, the
// same snapshot a later Regenerate stamps — so "what produced this output" is
// answerable for posts nobody regenerated.
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
    claimsRequiringConfirmation: [],
    contentPrompt: "Caption rule: Traditional Chinese, keep product names.",
    posterPrompt: "Image rule: natural photograph, no lettering."
  });
  instance.storage.upsertItem({
    id: "instagram:SRC:p1",
    sourceBinding: "SRC",
    sourceLabel: "Synthetic source",
    provider: "instagram",
    providerItemId: "p1",
    text: "Original",
    media: [],
    metrics: {},
    contentHash: "h",
    firstSeenAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z"
  });
  return instance;
}

describe("createBatch records the instructions its first request used", () => {
  it("stamps the saved image and caption instructions on each new item's mark", async () => {
    const g = gadget();
    const batch = await g.createBatch({ itemIds: ["instagram:SRC:p1"] });
    expect(batch.ok).not.toBe(false);
    const stored = JSON.parse(g.storage.getBatchItem(batch.items[0].id).generation);
    expect(stored.scope).toEqual({ caption: true, image: true });
    expect(stored.instructions).toEqual({
      image: "Image rule: natural photograph, no lettering.",
      caption: "Caption rule: Traditional Chinese, keep product names."
    });
  });
});
