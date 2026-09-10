import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";

/**
 * TASK-020's live bug, pinned: a connector door granted AFTER first setup was
 * silently ignored, because `deriveBindingsFromGrants` ran only inside
 * `saveConfiguration` — on the legacy `setConfig` path, or while no config
 * existed — and the settings form's payload has never carried `sources` or
 * `destinations`. `refreshGrants` is the additive re-check: it inserts the
 * granted-but-unstored binding and disturbs nothing already stored.
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
    }
  };
}

function connectorDoor(description: Record<string, unknown>) {
  return { describe: async () => description };
}

function gadgetWithEnv(env: Record<string, unknown>) {
  const { ctx } = sqliteContext();
  return new Gadget(ctx as never, env as never);
}

describe("refreshGrants", () => {
  it("picks up a connector granted after first setup, which a settings save alone never did", async () => {
    const env: Record<string, unknown> = {
      workspace: { notify: async () => {} },
      IG_SRC: connectorDoor({ provider: "instagram", role: "source", resourceLabel: "@source" })
    };
    const gadget = gadgetWithEnv(env);

    await gadget.saveSetup({ cadence: "daily" });
    let summary = await gadget.summary();
    expect(summary.sources.map((row: { binding: string }) => row.binding)).toEqual(["IG_SRC"]);
    expect(summary.destinations).toEqual([]);

    // The grant lands after first setup — and an ordinary Settings save does
    // not re-derive bindings. That was the bug: the boundary is kept in this
    // assertion so the fix cannot be quietly broadened into "save does it".
    env.FB_OUT = connectorDoor({ provider: "facebook", role: "destination", resourceLabel: "Main page" });
    const saved = await gadget.saveSetup({ cadence: "daily" });
    expect(saved.destinations).toEqual([]);

    const result = await gadget.refreshGrants();
    expect(result.ok).toBe(true);
    expect(result.added.destinations.map((row: { binding: string }) => row.binding)).toEqual(["FB_OUT"]);
    expect(result.added.sources).toEqual([]);

    summary = await gadget.summary();
    expect(summary.destinations.map((row: { binding: string }) => row.binding)).toEqual(["FB_OUT"]);
    expect(summary.destinations[0].label).toBe("Main page");
  });

  it("keeps the existing rows' scan state, and a second check adds nothing", async () => {
    const env: Record<string, unknown> = {
      IG_SRC: connectorDoor({ provider: "instagram", role: "source" }),
      FB_OUT: connectorDoor({ provider: "facebook", role: "destination", resourceLabel: "Main page" })
    };
    const gadget = gadgetWithEnv(env);
    await gadget.saveSetup({ cadence: "daily", rightsPolicy: "trust_connected" });
    gadget.storage.recordSourceOutcome("IG_SRC", { outcome: "confirmed", message: null, cursor: "cur-1" });

    const again = await gadget.refreshGrants();
    // Everything already stored — nothing is "new".
    expect(again.added).toEqual({ sources: [], destinations: [] });
    // The replace-style setSources would have lost this cursor; the additive
    // path must not.
    expect(gadget.storage.getSource("IG_SRC").cursor).toBe("cur-1");
    // And the config the owner saved is not this method's to touch.
    const config = gadget.storage.getConfig();
    expect(config.cadence).toMatchObject({ kind: "daily" });
    expect(config.rightsPolicy).toBe("trust_connected");
  });

  it("splits a role-less door into both lists and skips a door that states no provider", async () => {
    const env: Record<string, unknown> = {
      IG_BOTH: connectorDoor({ provider: "instagram", resourceLabel: "@both" }),
      MYSTERY: connectorDoor({ resourceLabel: "no provider stated" }),
      SILENT: {}
    };
    const gadget = gadgetWithEnv(env);
    const result = await gadget.refreshGrants();
    expect(result.added.sources.map((row: { binding: string }) => row.binding)).toEqual(["IG_BOTH"]);
    expect(result.added.destinations.map((row: { binding: string }) => row.binding)).toEqual(["IG_BOTH"]);
  });
});
