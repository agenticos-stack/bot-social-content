import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";

/**
 * Account identity, selection and authorization — synthetic accounts only.
 *
 * Four things stay distinct: the env alias the owner picked at grant time
 * (`ALPHA_7`), the display label the door reports (`resourceLabel`), the
 * stable resource identity the publisher addresses (`resolvedId`, `crb_…`),
 * and live authorization (`__consent`). Provider and role come from
 * `describe()`, never from an alias or a label.
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

function context() {
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
}

type Description = Record<string, unknown> | { refused: true; code: string };

/** A connector door whose describe() is mutable, so a rename is one assignment. */
function door(description: Description | (() => never)) {
  const state = { description, calls: 0 };
  return {
    state,
    async describe() {
      state.calls += 1;
      if (typeof state.description === "function") return (state.description as () => never)();
      return state.description;
    }
  };
}

function account(resolvedId: string, resourceLabel: string, role: string | null, provider = "instagram") {
  return door({ provider, role, resourceLabel, resolvedId });
}

function publisher(created: { targets?: { destinationBinding: string }[] }[]) {
  let version = 0;
  return {
    async createDraft(input: { targets?: { destinationBinding: string }[] }) {
      created.push(input);
      version += 1;
      return {
        postId: `post-${version}`,
        versionId: `ver-${version}`,
        versionNumber: 1,
        contentHash: `hash-${version}`,
        targets: (input.targets ?? []).map((target) => ({ ...target, outcome: "submitted" }))
      };
    },
    async submitForReview() {
      return { refused: true, code: "submission_required", message: "Needs owner approval.", authority: "send" };
    }
  };
}

async function gadgetWith(env: Record<string, unknown>) {
  const gadget = new Gadget(context() as never, env as never);
  gadget.storage.setConfig({ protectedTerms: [], protectedHashtags: [], disclaimers: [], claimsRequiringConfirmation: [] });
  gadget.storage.upsertItem({
    id: "instagram:SRC_ANY:p1",
    sourceBinding: "SRC_ANY",
    sourceLabel: "Synthetic source",
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

async function drafted(gadget: Gadget, extra: Record<string, unknown> = {}) {
  const batch = await gadget.createBatch({ itemIds: ["instagram:SRC_ANY:p1"], ...extra });
  const item = batch.items[0];
  await gadget.saveRevision({ batchItemId: item.id, expectedRevision: 0, caption: "第一稿內容文字" });
  return item;
}

const notify = { workspace: { notify: async () => {} } };

describe("projection: provider and role come from describe(), never the alias or label", () => {
  it("two Instagram accounts under arbitrary aliases land by their stated role", async () => {
    const gadget = await gadgetWith({
      "zz-inbound": account("crb_101", "Account One", "source"),
      ALPHA_7: account("crb_202", "Account Two", "destination")
    });
    const { added } = await gadget.refreshGrants();
    expect(added.sources).toEqual([{ binding: "zz-inbound", label: "Account One", provider: "instagram" }]);
    expect(added.destinations).toEqual([{ binding: "ALPHA_7", label: "Account Two", provider: "instagram" }]);
  });

  it("an alias that reads like a provider or role changes nothing", async () => {
    const gadget = await gadgetWith({
      FACEBOOK_SOURCE: account("crb_1", "Looks like Facebook", "destination", "instagram"),
      IG_DESTINATION: account("crb_2", "Looks like a destination", "source", "facebook")
    });
    const { added } = await gadget.refreshGrants();
    expect(added.sources).toEqual([{ binding: "IG_DESTINATION", label: "Looks like a destination", provider: "facebook" }]);
    expect(added.destinations).toEqual([
      { binding: "FACEBOOK_SOURCE", label: "Looks like Facebook", provider: "instagram" }
    ]);
  });

  it("a door with no provider is skipped, and a door with no role is offered as both (the stated legacy rule)", async () => {
    const gadget = await gadgetWith({
      NO_PROVIDER: door({ role: "destination", resourceLabel: "Unknown", resolvedId: "crb_9" }),
      NO_ROLE: account("crb_8", "Either", null)
    });
    const { added } = await gadget.refreshGrants();
    expect(added.sources.map((row: { binding: string }) => row.binding)).toEqual(["NO_ROLE"]);
    expect(added.destinations.map((row: { binding: string }) => row.binding)).toEqual(["NO_ROLE"]);
  });

  it("a refused or throwing describe() projects nothing rather than guessing", async () => {
    const gadget = await gadgetWith({
      REFUSED: door({ refused: true, code: "not_granted" }),
      THROWS: door(() => {
        throw new Error("door offline");
      })
    });
    const { added } = await gadget.refreshGrants();
    expect(added).toEqual({ sources: [], destinations: [] });
  });
});

describe("selection: the publisher is addressed by resolvedId, one resource per chosen binding", () => {
  it("identical display labels on different resources send only to the chosen one", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const gadget = await gadgetWith({
      ...notify,
      social: publisher(created),
      DEST_A: account("crb_a", "Shop", "destination"),
      DEST_B: account("crb_b", "Shop", "destination")
    });
    await gadget.refreshGrants();
    const item = await drafted(gadget);

    const result = await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1, destinationBindings: ["DEST_B"] });
    expect(result.ok).not.toBe(false);
    expect(created.map((input) => input.targets)).toEqual([[{ destinationBinding: "crb_b" }]]);
    expect(gadget.storage.publicationsFor(item.id).map((row: { destinationBinding: string }) => row.destinationBinding)).toEqual([
      "DEST_B"
    ]);
  });

  it("a rename keeps the stored binding and its history; the next send still addresses the same resource", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const renamed = account("crb_r", "Before", "destination");
    const gadget = await gadgetWith({ ...notify, social: publisher(created), DEST_R: renamed });
    await gadget.refreshGrants();
    const item = await drafted(gadget);
    await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1, destinationBindings: ["DEST_R"] });

    renamed.state.description = { provider: "instagram", role: "destination", resourceLabel: "After", resolvedId: "crb_r" };
    await gadget.saveRevision({ batchItemId: item.id, expectedRevision: 1, caption: "第二稿內容文字" });
    await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 2, destinationBindings: ["DEST_R"] });

    expect(created.map((input) => input.targets)).toEqual([
      [{ destinationBinding: "crb_r" }],
      [{ destinationBinding: "crb_r" }]
    ]);
    const bindings = gadget.storage.publicationsFor(item.id).map((row: { destinationBinding: string }) => row.destinationBinding);
    expect(new Set(bindings)).toEqual(new Set(["DEST_R"]));
  });

  it("revoking one destination leaves the other usable, and revoke/regrant keeps the row", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const consent: Record<string, boolean> = { social: true, "destination:DEST_1": true, "destination:DEST_2": true };
    const gadget = await gadgetWith({
      ...notify,
      __consent: consent,
      social: publisher(created),
      DEST_1: account("crb_1", "One", "destination"),
      DEST_2: account("crb_2", "Two", "destination")
    });
    await gadget.refreshGrants();
    const item = await drafted(gadget);

    consent["destination:DEST_1"] = false;
    const mixed = await gadget.submitForReview({
      batchItemId: item.id,
      expectedRevision: 1,
      destinationBindings: ["DEST_1", "DEST_2"]
    });
    expect(created.map((input) => input.targets)).toEqual([[{ destinationBinding: "crb_2" }]]);
    expect(JSON.stringify(mixed)).toContain("destination_not_granted");
    expect(gadget.storage.getDestination("DEST_1")).not.toBeNull();

    consent["destination:DEST_1"] = true;
    await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1, destinationBindings: ["DEST_1"] });
    expect(created.map((input) => input.targets)).toEqual([
      [{ destinationBinding: "crb_2" }],
      [{ destinationBinding: "crb_1" }]
    ]);
  });
});

describe("authorization: nothing reaches the provider for a resource this workspace was not granted", () => {
  it("a raw resource id from elsewhere is refused before any door call", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const gadget = await gadgetWith({
      ...notify,
      __consent: { social: true, "destination:DEST_OK": true },
      social: publisher(created),
      DEST_OK: account("crb_ok", "Mine", "destination")
    });
    await gadget.refreshGrants();
    const item = await drafted(gadget);

    for (const foreign of ["crb_other_org", "DEST_UNKNOWN"]) {
      const result = await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1, destinationBindings: [foreign] });
      expect(JSON.stringify(result)).toContain("destination_not_granted");
    }
    expect(created).toEqual([]);
  });

  it("a describe-capable door that cannot name its resource refuses destination_unresolved", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const gadget = await gadgetWith({
      ...notify,
      social: publisher(created),
      DEST_X: door({ refused: true, code: "resource_revoked" })
    });
    const item = await drafted(gadget);
    const result = await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1, destinationBindings: ["DEST_X"] });
    expect(JSON.stringify(result)).toContain("destination_unresolved");
    expect(created).toEqual([]);
  });

  it("a plain door with no describe() keeps env-name addressing (explicitly supported legacy shape)", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const gadget = await gadgetWith({ ...notify, social: publisher(created), LEGACY_DEST: {} });
    const item = await drafted(gadget);
    await gadget.submitForReview({ batchItemId: item.id, expectedRevision: 1, destinationBindings: ["LEGACY_DEST"] });
    expect(created.map((input) => input.targets)).toEqual([[{ destinationBinding: "LEGACY_DEST" }]]);
  });
});

describe("duplicate protection follows the resource, not the alias", () => {
  it("a second alias for the same resource cannot file the same post again", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const gadget = await gadgetWith({
      ...notify,
      social: publisher(created),
      FIRST_ALIAS: account("crb_same", "Same account", "destination"),
      SECOND_ALIAS: account("crb_same", "Same account", "destination")
    });
    await gadget.refreshGrants();
    const first = await drafted(gadget);
    await gadget.submitForReview({ batchItemId: first.id, expectedRevision: 1, destinationBindings: ["FIRST_ALIAS"] });

    // Another draft of the same source post, sent through the other alias.
    const second = await drafted(gadget, { createNewVersion: true });
    const refused = await gadget.submitForReview({
      batchItemId: second.id,
      expectedRevision: 1,
      destinationBindings: ["SECOND_ALIAS"]
    });
    expect(refused).toMatchObject({ ok: false, code: "duplicate_active" });
    expect(created).toHaveLength(1);
  });

  it("both aliases in one submission file the resource once", async () => {
    const created: { targets?: { destinationBinding: string }[] }[] = [];
    const gadget = await gadgetWith({
      ...notify,
      social: publisher(created),
      FIRST_ALIAS: account("crb_same", "Same account", "destination"),
      SECOND_ALIAS: account("crb_same", "Same account", "destination")
    });
    await gadget.refreshGrants();
    const item = await drafted(gadget);
    await gadget.submitForReview({
      batchItemId: item.id,
      expectedRevision: 1,
      destinationBindings: ["FIRST_ALIAS", "SECOND_ALIAS"]
    });
    expect(created.map((input) => input.targets)).toEqual([[{ destinationBinding: "crb_same" }]]);
  });
});
