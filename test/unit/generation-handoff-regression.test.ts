import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Gadget } from "../../src/server.js";
import { generationMark, generationStage } from "../../src/model.js";

/**
 * The attended generation handoff, at the durable boundaries the audit found
 * broken (design-plans/evidence/social-generation-handoff-2026-09-15).
 *
 * These are not display assertions. Every one reads the stored batch-item mark
 * or the stored request identity, because the defects the audit reproduced were
 * durable-state defects: a refusal overwriting a newer acknowledgement, a
 * partial completion deleting the dispatch, an empty scope widening to the
 * whole batch. A test that only checked the rendered string would have passed
 * on the broken head.
 *
 * Real Gadget and Storage over in-memory SQLite with the Cloudflare base class
 * shimmed — the same seam the original probes used. No provider, approval or
 * paid execution.
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

function setup() {
  const db = new DatabaseSync(":memory:") as unknown as Sqlite;
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
  const gadget = new Gadget(
    {
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
    } as never,
    {} as never
  );
  gadget.storage.setConfig({
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: [],
    // A non-empty snapshot, so the work request's instruction fingerprint has
    // something to fingerprint.
    posterPrompt: "Bright product hero on a neutral background.",
    contentPrompt: "Warm, concise Cantonese caption."
  });
  for (const suffix of ["1", "2"]) {
    gadget.storage.upsertItem({
      id: `source_${suffix}`,
      sourceBinding: "SOURCE",
      sourceLabel: "Synthetic",
      provider: "instagram",
      providerItemId: suffix,
      text: `Synthetic reference ${suffix}`,
      media: [{ id: `m${suffix}`, kind: "image", url: `https://cdn.example.com/p${suffix}.jpg` }],
      metrics: {},
      contentHash: `synthetic-${suffix}`,
      firstSeenAt: "2026-09-15",
      lastSeenAt: "2026-09-15"
    });
  }
  return gadget;
}

const markOf = (gadget: any, batchItemId: string) => generationMark(gadget.storage.getBatchItem(batchItemId).generation);

describe("the work request names the work", () => {
  it("carries one request identity, the part scope and the instruction fingerprint", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({
      itemIds: ["source_1", "source_2"],
      destinationBindings: []
    });

    const { workRequest } = opened;
    expect(typeof workRequest.requestId).toBe("string");
    expect(workRequest.requestId).toMatch(/^gen/);
    expect(workRequest.parts).toEqual({ caption: true, image: true });
    // A durable reference to the snapshot, not a second copy that could drift.
    expect(workRequest.instructionsRef).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    // ONE createBatch is ONE request: every item opened together shares it.
    const marks = opened.items.map((entry: { id: string }) => markOf(gadget, entry.id));
    expect(new Set(marks.map((mark: { id: string }) => mark.id))).toEqual(new Set([workRequest.requestId]));
  });

  it("moves a replaced request onto a fresh identity, keeping every item it covered", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1", "source_2"], destinationBindings: [] });
    const [first, second] = opened.items.map((entry: { id: string }) => entry.id);
    const original = opened.workRequest.requestId;

    const result = await gadget.requestGeneration(opened.id, [second], {
      replace: true,
      needs: { image: true, caption: false }
    });
    expect(result.ok).toBe(true);
    expect(result.workRequest.requestId).toBe(result.request);
    expect(result.workRequest.requestId).not.toBe(original);
    // The picked post was re-scoped...
    expect(result.requested).toEqual([second]);
    expect(result.workRequest.items.find((entry: { batchItemId: string }) => entry.batchItemId === second).parts).toEqual({
      caption: false,
      image: true
    });
    // ...and the sibling came with it, keeping its own both-parts scope and
    // moving off the request that is about to be retired.
    expect(result.workRequest.itemIds).toEqual(["source_1", "source_2"]);
    expect(result.workRequest.parts).toEqual({ caption: true, image: true });
    expect(markOf(gadget, first).id).toBe(result.request);
    expect(markOf(gadget, first).scope).toEqual({ caption: true, image: true });
    expect(markOf(gadget, second).scope).toEqual({ caption: false, image: true, imagePages: ["pg_src_m2"] });
  });
});

describe("dispatch is correlated to the request it acknowledges", () => {
  it("a delayed refusal for an old request cannot overwrite the replacement's acknowledgement", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] });
    const batchItemId = opened.items[0].id;
    const a = opened.workRequest.requestId;
    const b = (await gadget.requestGeneration(opened.id, [batchItemId], { replace: true })).request;

    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: b,
      dispatch: { filed: true, actionId: "act_B" }
    });
    const stale = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: a,
      dispatch: { filed: false, reason: "synthetic old filing refusal" }
    });

    expect(stale.updated).toBe(0);
    expect(markOf(gadget, batchItemId).id).toBe(b);
    expect(markOf(gadget, batchItemId).dispatch).toMatchObject({ filed: true, actionId: "act_B" });
    expect(generationStage(markOf(gadget, batchItemId))).toBe("awaiting_approval");
  });

  it("a host outcome outranks a browser's later, different value", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] });
    const batchItemId = opened.items[0].id;
    const request = opened.workRequest.requestId;

    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      source: "host",
      dispatch: { filed: true, actionId: "act_host" }
    });
    const browser = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      dispatch: { filed: false, reason: "browser thinks otherwise" }
    });

    expect(browser.updated).toBe(0);
    expect(markOf(gadget, batchItemId).dispatch).toMatchObject({ filed: true, actionId: "act_host", source: "host" });
  });
});

describe("scope is exact, and omitted is not empty", () => {
  it("an explicit empty item list updates nothing", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] });
    const batchItemId = opened.items[0].id;

    const result = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      batchItemIds: [],
      dispatch: { filed: true, actionId: "act_unrelated" }
    });

    expect(result.updated).toBe(0);
    expect(markOf(gadget, batchItemId).dispatch).toBeUndefined();
  });

  it("an omitted item list stamps every item carrying that request, and nothing else", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1", "source_2"], destinationBindings: [] });
    const [first, second] = opened.items.map((entry: { id: string }) => entry.id);
    const request = opened.workRequest.requestId;

    const result = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      dispatch: { filed: true, actionId: "act_both" }
    });

    expect(result.updated).toBe(2);
    expect(markOf(gadget, first).dispatch.actionId).toBe("act_both");
    expect(markOf(gadget, second).dispatch.actionId).toBe("act_both");

    // A request nobody holds stamps nothing, however wide the scope.
    const stranger = await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: "gen_not_this_batch",
      dispatch: { filed: false, reason: "who?" }
    });
    expect(stranger.updated).toBe(0);
    expect(markOf(gadget, first).dispatch.actionId).toBe("act_both");
  });
});

describe("partial completion keeps the execution context", () => {
  it("a correlated caption save keeps the dispatch while the image is still pending", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] });
    const batchItemId = opened.items[0].id;
    const request = opened.workRequest.requestId;
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      source: "host",
      dispatch: { filed: true, actionId: "act_caption_and_image", conversationTitle: "Pop-up launch" }
    });

    const result = await gadget.saveRevision({
      batchItemId,
      expectedRevision: 0,
      caption: "這是一段已完成的文案。",
      generationRequest: request
    });

    expect(result.ok).toBe(true);
    const mark = markOf(gadget, batchItemId);
    expect(mark.needs).toEqual({ caption: false, image: true });
    // The image ask is still the same request, and the acknowledgement that
    // started it is still readable — the caption did not erase it.
    expect(mark.dispatch).toMatchObject({ filed: true, actionId: "act_caption_and_image", source: "host" });
    expect(mark.dispatch.conversationTitle).toBe("Pop-up launch");
    expect(generationStage(mark)).toBe("awaiting_approval");
  });

  it("an image-first satisfaction keeps the dispatch while the caption is pending", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] });
    const batchItemId = opened.items[0].id;
    const request = opened.workRequest.requestId;
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      dispatch: { filed: true, actionId: "act_image_first" }
    });

    gadget.storage.satisfyItemGeneration(batchItemId, { request, needs: { image: true } });

    const mark = markOf(gadget, batchItemId);
    expect(mark.needs).toEqual({ caption: true, image: false });
    expect(mark.dispatch).toMatchObject({ filed: true, actionId: "act_image_first" });
  });
});

describe("check status is a read", () => {
  it("reports the durable projection and changes nothing", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] });
    const batchItemId = opened.items[0].id;
    const request = opened.workRequest.requestId;
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: request,
      source: "host",
      dispatch: { filed: true, actionId: "act_1", conversationTitle: "Pop-up launch" }
    });

    const before = JSON.stringify(gadget.storage.getBatchItem(batchItemId).generation);
    const status = await gadget.checkGenerationStatus({ batchId: opened.id, batchItemId });

    expect(status.ok).toBe(true);
    expect(status.workRequestStatus).toHaveLength(1);
    expect(status.workRequestStatus[0]).toMatchObject({
      batchItemId,
      requestId: request,
      stage: "awaiting_approval",
      dispatch: { filed: true, actionId: "act_1" }
    });
    // Read-only: nothing about the mark changed, and no revision appeared.
    expect(JSON.stringify(gadget.storage.getBatchItem(batchItemId).generation)).toBe(before);
    expect(gadget.storage.listRevisions(batchItemId)).toHaveLength(0);
  });

  it("says start not confirmed when no acknowledgement was ever recorded", async () => {
    const gadget = setup();
    const opened = await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] });
    const status = await gadget.checkGenerationStatus({ batchId: opened.id, batchItemId: opened.items[0].id });
    expect(status.workRequestStatus[0].stage).toBe("start_unconfirmed");
    expect(status.workRequestStatus[0].dispatch).toBeNull();
  });
});
