import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";
import { normalizeConfig, normalizeDrafting } from "../../src/config.js";

/**
 * A scan asking for what it found to be drafted (TASK-019).
 *
 * The gadget calls nothing (SEC-003): it RETURNS a request and the platform
 * files it as an action the owner answers. So what these assert is the shape of
 * a return value, and — more importantly — the two things that must stay true
 * about when one is produced at all: off unless the owner asked, and never
 * decided by the notification settings (REQ-014).
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

/** Records every notice, so a test can prove one was NOT sent. */
function recordingEnv() {
  const notices: { title?: string }[] = [];
  return {
    notices,
    env: { workspace: { notify: async (payload: { title?: string }) => void notices.push(payload) } }
  };
}

function gadgetWith(drafting: string | undefined, notifications?: unknown) {
  const { ctx } = sqliteContext();
  const { env, notices } = recordingEnv();
  const gadget = new Gadget(ctx as never, env as never);

  gadget.storage.setConfig({
    rightsPolicy: "require_confirmation",
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: [],
    ...(drafting === undefined ? {} : { drafting }),
    ...(notifications ? { notifications } : {})
  });
  gadget.storage.setDestinations([
    { binding: "FB_MAIN", label: "Facebook", provider: "facebook" },
    { binding: "IG_OUT", label: "Instagram", provider: "instagram" }
  ]);
  for (const suffix of ["p1", "p2"]) {
    gadget.storage.upsertItem({
      id: `instagram:IG_MAIN:${suffix}`,
      sourceBinding: "IG_MAIN",
      sourceLabel: "Main Instagram",
      provider: "instagram",
      providerItemId: suffix,
      text: `Source ${suffix}`,
      media: [],
      metrics: {},
      contentHash: `hash-${suffix}`,
      firstSeenAt: "2026-09-10T00:00:00.000Z",
      lastSeenAt: "2026-09-10T00:00:00.000Z"
    });
  }
  return { gadget, notices };
}

const found = [
  {
    binding: "IG_MAIN",
    label: "@essentialfoodsofficial",
    outcome: "confirmed",
    new: 2,
    newIds: ["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"],
    changed: 0,
    unchanged: 0
  }
];

describe("the drafting setting", () => {
  it("is off unless the owner turned it on, and unknown reads as off", () => {
    /**
     * The failure of the other default is not a wrong setting: it is a scan that
     * starts putting approvable agent turns in front of an owner, on its own
     * cadence, spending the organization's credits — because they upgraded.
     */
    expect(normalizeDrafting(undefined)).toBe("off");
    expect(normalizeDrafting("on")).toBe("off");
    expect(normalizeDrafting(true)).toBe("off");
    expect(normalizeDrafting("on_new")).toBe("on_new");
    expect(normalizeConfig({ cadence: "daily" }).drafting).toBe("off");
    expect(normalizeConfig({ cadence: "daily", drafting: "on_new" }).drafting).toBe("on_new");
  });
});

describe("what a scan asks for", () => {
  it("asks for nothing when drafting was never turned on", () => {
    const { gadget } = gadgetWith(undefined);
    expect(gadget.workRequestFor(found, gadget.storage.getConfig())).toBeNull();
  });

  it("asks for nothing when the scan found nothing", () => {
    // Every scan returns; almost none of them want drafting.
    const { gadget } = gadgetWith("on_new");
    const nothing = [{ ...found[0], new: 0, newIds: [], unchanged: 12 }];
    expect(gadget.workRequestFor(nothing, gadget.storage.getConfig())).toBeNull();
  });

  it("names the batch, the accounts, the source items and the intake method", () => {
    const { gadget } = gadgetWith("on_new");
    const request = gadget.workRequestFor(found, gadget.storage.getConfig());

    expect(request).toMatchObject({
      sourceLabel: "@essentialfoodsofficial",
      intake: "saveRevision"
    });
    expect(request.batchId).toMatch(/^batch/);
    // Source ids, because they are the observation identity the ledger stands
    // on and what an audit trail links by.
    expect(request.itemIds).toEqual(["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"]);
    // And the batch it named is real, with somewhere for each draft to go.
    expect(gadget.storage.listBatchItems(request.batchId)).toHaveLength(2);
  });

  it("opens the batch against every granted destination", () => {
    // What the client's own picker sends today. A scan has no narrower intent to
    // represent, and inventing one would guess at a choice nobody made.
    const { gadget } = gadgetWith("on_new");
    const request = gadget.workRequestFor(found, gadget.storage.getConfig());
    for (const item of gadget.storage.listBatchItems(request.batchId)) {
      expect(item.destinationBindings).toEqual(["FB_MAIN", "IG_OUT"]);
    }
  });

  it("batches one scan into one request, whatever it found", () => {
    // The unit an owner answers is the scan, not the post: twelve references are
    // one decision about one afternoon's work.
    const { gadget } = gadgetWith("on_new");
    const request = gadget.workRequestFor(found, gadget.storage.getConfig());
    expect(request.itemIds).toHaveLength(2);
    expect(Array.isArray(request)).toBe(false);
  });

  it("asks even when notifications are silenced, and without sending one", async () => {
    /**
     * REQ-014, and the whole reason this is not inside `notifyNewItems`. Quiet
     * hours, `mode: "off"` and a spent digest decide whether somebody is
     * INTERRUPTED. None of them may decide whether the work is asked for — an
     * owner who silenced notices did not cancel the drafting they turned on.
     *
     * And opening the batch must not itself notify: `createBatch`'s notice is
     * the owner's own Continue made visible, and a scan borrowing it would
     * interrupt them past the settings above.
     */
    const { gadget, notices } = gadgetWith("on_new", { mode: "off" });
    const request = gadget.workRequestFor(found, gadget.storage.getConfig());

    expect(request).not.toBeNull();
    expect(notices).toEqual([]);
  });

  it("asks for nothing, rather than throwing, when the batch cannot be opened", () => {
    // By value, never a throw (PAT-007). No destination granted is not a scan
    // failure and is not something to ask an owner about.
    const { gadget } = gadgetWith("on_new");
    gadget.storage.setDestinations([]);
    expect(gadget.workRequestFor(found, gadget.storage.getConfig())).toBeNull();
  });

  it("asks for nothing when those items already have an active localization", () => {
    // The second scan of the same finding is not a second piece of work.
    const { gadget } = gadgetWith("on_new");
    expect(gadget.workRequestFor(found, gadget.storage.getConfig())).not.toBeNull();
    expect(gadget.workRequestFor(found, gadget.storage.getConfig())).toBeNull();
  });
});

describe("opening a batch versus announcing one", () => {
  it("still announces the owner's own Continue", async () => {
    // `createBatch` is that action made visible, and TASK-019 must not have
    // quietly removed it.
    const { gadget, notices } = gadgetWith("on_new");
    await gadget.createBatch({
      itemIds: ["instagram:IG_MAIN:p1"],
      destinationBindings: ["FB_MAIN"]
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain("ready to localize");
  });

  it("does not announce a batch a scan opened", () => {
    const { gadget, notices } = gadgetWith("on_new");
    gadget.openBatch({ itemIds: ["instagram:IG_MAIN:p1"], destinationBindings: ["FB_MAIN"] });
    expect(notices).toEqual([]);
  });
});
