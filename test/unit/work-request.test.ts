import { afterEach, describe, expect, it } from "vitest";
import { Gadget } from "../../src/server.js";
import { normalizeConfig, normalizeDrafting } from "../../src/config.js";
import { generationMark, generationStage } from "../../src/model.js";

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
      media: [{ id: `m_${suffix}`, kind: "image", url: `https://cdn.example.com/${suffix}.jpg` }],
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

  it("names the batch, the accounts, the source items and the intake methods", () => {
    const { gadget } = gadgetWith("on_new");
    const request = gadget.workRequestFor(found, gadget.storage.getConfig());

    expect(request).toMatchObject({
      sourceLabel: "@essentialfoodsofficial",
      intake: ["saveRevisions", "saveRevision", "saveGeneratedImage"]
    });
    expect(request.batchId).toMatch(/^batch/);
    // Source ids, because they are the observation identity the ledger stands
    // on and what an audit trail links by.
    expect(request.itemIds).toEqual(["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"]);
    // And the batch it named is real, with somewhere for each draft to go.
    expect(gadget.storage.listBatchItems(request.batchId)).toHaveLength(2);
  });

  it("opens the batch against no destinations — where it goes is decided at submit", () => {
    /**
     * TASK-004: a destination is a `send` target and drafting is `generate`,
     * so the scan's batch binds none — even though this fixture HAS granted
     * destinations. `publications` rows appear when the owner submits, and
     * nowhere before.
     */
    const { gadget } = gadgetWith("on_new");
    const request = gadget.workRequestFor(found, gadget.storage.getConfig());
    for (const item of gadget.storage.listBatchItems(request.batchId)) {
      expect(item.destinationBindings).toEqual([]);
      expect(gadget.storage.publicationsFor(item.id)).toEqual([]);
    }
  });

  it("still asks for drafts when no destination is granted at all", () => {
    // The point of the refactor: a workspace with nowhere to send can still
    // draft. The destinationless refusal moved to submit, where it is true.
    const { gadget } = gadgetWith("on_new");
    gadget.storage.setDestinations([]);
    expect(gadget.workRequestFor(found, gadget.storage.getConfig())).not.toBeNull();
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
    // By value, never a throw (PAT-007): a scan naming posts this gadget has
    // never stored yields an empty batch, and there is nothing to ask about.
    const { gadget } = gadgetWith("on_new");
    const unknown = [{ ...found[0], newIds: ["instagram:IG_MAIN:ghost"] }];
    expect(gadget.workRequestFor(unknown, gadget.storage.getConfig())).toBeNull();
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

/**
 * The attended path: a canvas action returns a request the platform files, and
 * the client stamps the filing outcome back onto the durable mark. A mark alone
 * is a REQUEST — the card must never call it "generating".
 */
describe("a canvas request the platform can file", () => {
  it("createBatch returns a work request naming what was opened", async () => {
    const { gadget } = gadgetWith(undefined);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"] });

    expect(opened.workRequest).toMatchObject({
      sourceLabel: "Main Instagram",
      intake: ["saveRevisions", "saveRevision", "saveGeneratedImage"],
      itemIds: ["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"],
      recipe: "social-content.draft.v1"
    });
    expect(opened.workRequest.batchId).toBe(opened.id);
  });

  it("a replacement covers the whole request it supersedes, not just the post picked", async () => {
    /**
     * ONE ASK, WHOLE. `createBatch` armed both marks under one request. When the
     * owner replaces one of them, the approval covers the request — so the
     * sibling moves onto the new id with it, keeping its own scope and needs,
     * rather than being stranded on an approval that is about to be retired.
     */
    const { gadget } = gadgetWith(undefined);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"] });
    const ids = opened.items.map((entry) => entry.id);

    // `replace: true` because createBatch already armed both marks.
    const result = await gadget.requestGeneration(opened.id, [ids[1]], { replace: true });
    expect(result.ok).toBe(true);
    expect(result.workRequest.batchId).toBe(opened.id);
    // Only the picked post was re-requested...
    expect(result.requested).toEqual([ids[1]]);
    expect(result.replaced).toEqual([{ batchItemId: ids[1], requestId: opened.workRequest.requestId }]);
    // ...but the replacement names the work it supersedes and covers both.
    expect(result.workRequest.replace).toBe(true);
    expect(result.workRequest.replaces).toEqual([opened.workRequest.requestId]);
    expect(result.workRequest.itemIds).toEqual(["instagram:IG_MAIN:p1", "instagram:IG_MAIN:p2"]);
    expect(gadget.storage.getBatchItem(ids[0]).generation).toContain(result.request);
  });

  it("treats a mark with no acknowledgement as not started, never generating", async () => {
    // Every legacy mark and every click whose dispatch outcome never came back
    // reads this way — the conservative, truthful reading.
    const { gadget } = gadgetWith(undefined);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const mark = gadget.storage.getBatchItem(opened.items[0].id).generation;
    expect(generationStage(mark)).toBe("start_unconfirmed");
  });

  it("records one acknowledgement per request, and a later one cannot revise it", async () => {
    /**
     * THE RECEIPT IS WRITTEN ONCE. It is the platform's own account of what it
     * did; a second write — matching or contradictory — is a no-op, because a
     * receipt that can be revised is not a record (audit correction, F4).
     */
    const { gadget } = gadgetWith(undefined);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const batchItemId = opened.items[0].id;
    const request = opened.workRequest.requestId;
    const stored = () => gadget.storage.getBatchItem(batchItemId).generation;

    const accepted = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      batchItemIds: [batchItemId],
      dispatch: { filed: true, actionId: "act_123", conversationTitle: "Pop-up launch" }
    });
    expect(accepted).toMatchObject({ ok: true, updated: 1 });
    expect(generationStage(stored())).toBe("awaiting_approval");
    // The request identity and the part scope survive the stamp.
    expect(generationMark(stored()).dispatch.actionId).toBe("act_123");
    expect(generationMark(stored()).dispatch.conversationTitle).toBe("Pop-up launch");
    expect(generationMark(stored()).needs).toEqual({ caption: true, image: true });

    const later = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      batchItemIds: [batchItemId],
      dispatch: { filed: false, reason: "a later, contradictory value" }
    });
    expect(later.updated).toBe(0);
    expect(generationStage(stored())).toBe("awaiting_approval");
    expect(generationMark(stored()).dispatch.actionId).toBe("act_123");
    expect(generationMark(stored()).dispatch.reason).toBeNull();
  });

  it("refuses an outcome that does not name the request it acknowledges", async () => {
    // The request is what the write is matched against. Without it a delayed
    // outcome for one request could be stamped onto whatever mark happens to be
    // on the post, which is how a refusal for A overwrote B (audit P1).
    const { gadget } = gadgetWith(undefined);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const batchItemId = opened.items[0].id;

    const result = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      dispatch: { filed: true, actionId: "act_123" }
    });
    expect(result).toMatchObject({ ok: false, code: "dispatch_request_required" });
    expect(generationStage(gadget.storage.getBatchItem(batchItemId).generation)).toBe("start_unconfirmed");
  });

  it("refuses an outcome that does not say whether the request was filed", async () => {
    // The outcome decides whether the card says "start not confirmed" or "could
    // not start"; a shape that answers neither is refused rather than guessed at.
    const { gadget } = gadgetWith(undefined);
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const batchItemId = opened.items[0].id;

    const result = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      batchItemIds: [batchItemId],
      dispatch: {}
    });
    expect(result).toMatchObject({ ok: false, code: "dispatch_invalid" });
    expect(generationStage(gadget.storage.getBatchItem(batchItemId).generation)).toBe("start_unconfirmed");
  });

  it("an image-only regenerate names the recipe and the instruction snapshot", async () => {
    const { gadget } = gadgetWith(undefined);
    gadget.storage.setConfig({
      protectedTerms: [],
      protectedHashtags: [],
      disclaimers: [],
      claimsRequiringConfirmation: [],
      posterPrompt: "A bowl of congee with scallions",
      contentPrompt: "Write a caption"
    });
    const opened = await gadget.createBatch({ itemIds: ["instagram:IG_MAIN:p1"] });
    const asked = await gadget.requestGeneration(opened.id, [opened.items[0].id], {
      needs: { image: true },
      replace: true
    });
    expect(asked.ok).toBe(true);
    expect(asked.workRequest).toMatchObject({
      recipe: "social-content.draft.v1",
      parts: { caption: false, image: true },
      items: [
        {
          itemId: "instagram:IG_MAIN:p1",
          parts: { caption: false, image: true },
          imagePrompt: "A bowl of congee with scallions",
          captionPrompt: "Write a caption"
        }
      ]
    });
  });
});
