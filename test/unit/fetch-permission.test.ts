import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";
import { LOCALES, t } from "../../src/src/client/i18n.js";
import { classifyRefreshOutcome } from "../../src/refresh-outcome.js";

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

function gadgetWithEnv(env: Record<string, unknown>) {
  const { ctx } = sqliteContext();
  return new Gadget(ctx as never, env as never);
}

describe("adding a public source without metered_fetch", () => {
  it("refuses and stores nothing — the chip must not look watched", async () => {
    const gadget = gadgetWithEnv({
      workspace: { notify: async () => {} },
      social: {},
      schedule: {}
    });

    const result = await gadget.addOpenSource("https://www.instagram.com/favcrm.io/");
    expect(result).toMatchObject({
      ok: false,
      code: "fetch_not_granted"
    });
    expect(result.message).toMatch(/permission|grant/i);

    const summary = await gadget.summary();
    expect(summary.sources).toEqual([]);
    expect(summary.doors.metered_fetch).toBe(false);
  });

  it("stores the account once the door is present", async () => {
    const gadget = gadgetWithEnv({
      workspace: { notify: async () => {} },
      social: {},
      schedule: {},
      metered_fetch: { socialPostsForAccount: async () => ({ ok: true, posts: [] }) }
    });

    const result = await gadget.addOpenSource("https://www.instagram.com/favcrm.io/");
    expect(result).toMatchObject({ ok: true, added: true });
    const summary = await gadget.summary();
    expect(summary.sources.map((row: { binding: string }) => row.binding)).toEqual([
      "open:instagram:favcrm.io"
    ]);
  });
});

describe("refresh announcements", () => {
  it("does not call a failedSafe scan a success", () => {
    const outcome = classifyRefreshOutcome({
      failedSafe: 1,
      unknown: 0,
      new: 0,
      perSource: [{ message: "Public account fetching is not granted for this workspace." }]
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.titleKey).toBe("refreshFailedTitle");
    expect(outcome.detail).toMatch(/not granted/i);
  });

  it("does not call a partial refresh a success", () => {
    const outcome = classifyRefreshOutcome({
      failedSafe: 1,
      unknown: 0,
      new: 2,
      perSource: [{ message: "instagram.com timed out" }, { message: null }]
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.titleKey).toBe("refreshPartialTitle");
  });

  it("announces success only when nothing failed", () => {
    const outcome = classifyRefreshOutcome({
      failedSafe: 0,
      unknown: 0,
      new: 3,
      perSource: []
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.titleKey).toBe("refreshedTitle");
  });
});

describe("the canvas names the missing fetch door", () => {
  const steps = readFileSync(new URL("../../src/src/client/steps.js", import.meta.url), "utf8");
  const client = readFileSync(new URL("../../src/src/client/client.js", import.meta.url), "utf8");

  it("offers Grant through the host, not a silent chip", () => {
    expect(steps).toContain("fetchNeedsPermission");
    expect(steps).toContain("fetchGrant");
    expect(client).toContain("gadget:grant-door");
    expect(client).toContain("metered_fetch");
  });

  it("inspects the refresh result instead of toasting success on return", () => {
    expect(client).toContain("classifyRefreshOutcome");
    expect(client).not.toMatch(/await rpc\.refresh\(\);\s*await loadCollection[\s\S]*announce\(t\(locale, "refreshedTitle"\)/);
  });

  it("names the permission and the next action in both locales", () => {
    for (const locale of LOCALES) {
      for (const key of ["fetchNeedsPermission", "fetchGrant", "refreshPartialTitle"]) {
        expect(t(locale, key), `${locale}.${key}`).not.toBe(key);
      }
    }
  });
});
