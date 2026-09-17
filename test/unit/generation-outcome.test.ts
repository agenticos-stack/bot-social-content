// Outcome reporting for Social Content generation (PR1).
//
// The production failure this pins: an approved request whose seeded turn
// ended without delivering (credits, error, no write call) stays "waiting"
// forever. The action row says `ran`, the footer says the agent finished,
// and `needs` never clears — because nothing reports a turn's end and no
// final state exists.
//
// Covered here, through the real seams (model, server, bundled client):
//   - work requests declare an intake LIST per part; a legacy string still reads
//   - `ran` + a turn outcome maps to `stopped`; `ran` with none maps to
//     `approved_not_started`
//   - filing refusals for credits map to their own stages
//   - a re-request after a final outcome succeeds without `replace`
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { buildClient } from "../../scripts/client.mjs";
import { Gadget } from "../../src/server.js";
import {
  deliveryIntake,
  generationMark,
  generationStage,
  normalizeIntake,
  platformStage
} from "../../src/model.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom";

describe("the intake a work request declares", () => {
  it("lists only the methods the request's parts actually need", () => {
    expect(deliveryIntake({ caption: true, image: false })).toEqual(["saveRevisions", "saveRevision"]);
    expect(deliveryIntake({ caption: false, image: true })).toEqual(["saveGeneratedImage"]);
    expect(deliveryIntake({ caption: true, image: true })).toEqual([
      "saveRevisions",
      "saveRevision",
      "saveGeneratedImage"
    ]);
  });

  it("still reads a legacy string intake", () => {
    expect(normalizeIntake("saveRevision")).toEqual(["saveRevision"]);
    expect(normalizeIntake(["saveRevisions", "saveGeneratedImage"])).toEqual([
      "saveRevisions",
      "saveGeneratedImage"
    ]);
    expect(normalizeIntake(["saveRevision", 42, "", null])).toEqual(["saveRevision"]);
    expect(normalizeIntake(null)).toEqual([]);
    expect(normalizeIntake(undefined)).toEqual([]);
  });
});

describe("stages from platform facts", () => {
  it("maps an executed request with a turn outcome to stopped", () => {
    expect(platformStage({ state: "ran", outcomeStatus: "credits_exhausted" })).toBe("stopped");
    expect(platformStage({ state: "ran", outcomeStatus: "turn_crashed" })).toBe("stopped");
    expect(platformStage({ state: "ran", outcomeStatus: "failed", outcomeCode: "credits_exhausted" })).toBe("stopped");
  });

  it("maps an executed request with no turn outcome to approved-but-not-started", () => {
    expect(platformStage({ state: "ran" })).toBe("approved_not_started");
    expect(platformStage({ state: "ran", outcomeStatus: null })).toBe("approved_not_started");
  });

  it("reads the approval's own execution receipt as approved-but-not-started, never stopped", () => {
    // The drain settles every executed approval with `action_applied` (or
    // `action_reconciled` later) — that receipt says the request was
    // answered, never that a turn reported back.
    expect(platformStage({ state: "ran", outcomeStatus: "succeeded", outcomeCode: "action_applied" })).toBe(
      "approved_not_started"
    );
    expect(platformStage({ state: "ran", outcomeStatus: "succeeded", outcomeCode: "action_reconciled" })).toBe(
      "approved_not_started"
    );
  });

  it("maps credit filing refusals to their own stages", () => {
    const refused = (reason: string) =>
      generationStage(
        JSON.stringify({
          id: "gen_1",
          base: 0,
          scope: { caption: true, image: true },
          needs: { caption: true, image: true },
          dispatch: { filed: false, reason }
        })
      );
    expect(refused("insufficient_credits")).toBe("insufficient_credits");
    expect(refused("credit_check_unavailable")).toBe("credit_check_unavailable");
    expect(refused("no v2 conversation reaches this gadget")).toBe("start_failed");
  });
});

// ---------------------------------------------------------------------------
// Server side: recording the platform's outcome on the mark, and re-asking
// after a final one.
// ---------------------------------------------------------------------------
const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function outcomeGadget() {
  const db = new DatabaseSync(":memory:") as unknown as {
    exec(sql: string): void;
    prepare(sql: string): { all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
    close(): void;
  };
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
    posterPrompt: "Bright product hero.",
    contentPrompt: "Warm, concise Cantonese caption."
  });
  gadget.storage.upsertItem({
    id: "source_1",
    sourceBinding: "SOURCE",
    sourceLabel: "Synthetic",
    provider: "instagram",
    providerItemId: "p1",
    text: "Synthetic reference",
    media: [{ id: "m1", kind: "image", url: "https://cdn.example.com/p1.jpg" }],
    metrics: {},
    contentHash: "synthetic",
    firstSeenAt: "2026-09-15",
    lastSeenAt: "2026-09-15"
  });
  gadget.storage.upsertItem({
    id: "source_2",
    sourceBinding: "SOURCE",
    sourceLabel: "Synthetic",
    provider: "instagram",
    providerItemId: "p2",
    text: "A second synthetic reference",
    media: [{ id: "m2", kind: "image", url: "https://cdn.example.com/p2.jpg" }],
    metrics: {},
    contentHash: "synthetic-2",
    firstSeenAt: "2026-09-15",
    lastSeenAt: "2026-09-15"
  });
  return gadget;
}

async function openBatch(gadget: Gadget) {
  const opened = (await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] })) as {
    id: string;
    items: { id: string }[];
    workRequest: { requestId: string; intake: unknown };
  };
  return { opened, batchItemId: opened.items[0].id };
}

describe("the drafted work request", () => {
  it("declares the intake list the request's parts need", async () => {
    const gadget = outcomeGadget();
    const { opened } = await openBatch(gadget);
    expect(opened.workRequest.intake).toEqual(["saveRevisions", "saveRevision", "saveGeneratedImage"]);
  });
});

describe("recording a turn's terminal outcome on the mark", () => {
  it("stores the bounded outcome without touching identity, scope or needs", async () => {
    const gadget = outcomeGadget();
    const { opened, batchItemId } = await openBatch(gadget);
    // The platform filed this request, so the receipt exists to record onto.
    const stamped = (await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      dispatch: { filed: true, actionId: "act_1" }
    })) as { ok: boolean; updated: number };
    expect(stamped).toMatchObject({ ok: true, updated: 1 });
    const before = generationMark(gadget.storage.getBatchItem(batchItemId).generation);
    expect(before?.dispatch?.filed).toBe(true);

    const recorded = (await gadget.recordGenerationOutcome({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      generationRequest: opened.workRequest.requestId,
      outcome: { status: "stopped", code: "credits_exhausted" }
    })) as { ok: boolean; outcome: { status: string; code: string; at: string } };
    expect(recorded.ok).toBe(true);
    expect(recorded.outcome.status).toBe("stopped");
    expect(recorded.outcome.code).toBe("credits_exhausted");
    expect(typeof recorded.outcome.at).toBe("string");

    const after = generationMark(gadget.storage.getBatchItem(batchItemId).generation);
    expect(after?.id).toBe(before?.id);
    expect(after.scope).toEqual(before.scope);
    expect(after.needs).toEqual(before.needs);
    expect(after.dispatch.outcome.status).toBe("stopped");
  });

  it("refuses a stale request, an unknown status, an unfiled mark and a missing batch", async () => {
    const gadget = outcomeGadget();
    const { opened, batchItemId } = await openBatch(gadget);
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      dispatch: { filed: true, actionId: "act_1" }
    });

    const stale = (await gadget.recordGenerationOutcome({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      generationRequest: "gen_not_this_post",
      outcome: { status: "stopped", code: "credits_exhausted" }
    })) as { ok: boolean; code?: string };
    expect(stale).toMatchObject({ ok: false, code: "generation_request_stale" });

    const unknown = (await gadget.recordGenerationOutcome({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      generationRequest: opened.workRequest.requestId,
      outcome: { status: "delivered" }
    })) as { ok: boolean; code?: string };
    expect(unknown.ok).toBe(false);

    // A turn outcome for a request the platform never filed is impossible:
    // a fresh mark with no receipt refuses the write.
    const fresh = (await gadget.createBatch({ itemIds: ["source_2"], destinationBindings: [] })) as {
      id: string;
      items: { id: string }[];
      workRequest: { requestId: string };
    };
    const unfiled = (await gadget.recordGenerationOutcome({
      batchId: fresh.id,
      batchItemIds: [fresh.items[0].id],
      generationRequest: fresh.workRequest.requestId,
      outcome: { status: "stopped", code: "credits_exhausted" }
    })) as { ok: boolean; code?: string };
    expect(unfiled).toMatchObject({ ok: false, code: "generation_request_stale" });

    const missing = (await gadget.recordGenerationOutcome({
      batchId: "batch_missing",
      batchItemIds: [batchItemId],
      generationRequest: opened.workRequest.requestId,
      outcome: { status: "stopped", code: "credits_exhausted" }
    })) as { ok: boolean; code?: string };
    expect(missing).toMatchObject({ ok: false, code: "batch_not_found" });
  });

  it("lets a later outcome for the same request replace the earlier one, like the API", async () => {
    // The API keeps the latest turn report per seed row; the mark must agree
    // with it, or card and drawer read different endings. A stale request id
    // is still refused.
    const gadget = outcomeGadget();
    const { opened, batchItemId } = await openBatch(gadget);
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      dispatch: { filed: true, actionId: "act_1" }
    });
    await gadget.recordGenerationOutcome({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      generationRequest: opened.workRequest.requestId,
      outcome: { status: "stopped", code: "credits_exhausted" }
    });
    const replaced = (await gadget.recordGenerationOutcome({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      generationRequest: opened.workRequest.requestId,
      outcome: { status: "execution_failed", code: "turn_crashed" }
    })) as { ok: boolean; updated: number };
    expect(replaced).toMatchObject({ ok: true, updated: 1 });
    const after = generationMark(gadget.storage.getBatchItem(batchItemId).generation);
    expect(after?.dispatch?.outcome).toMatchObject({ status: "execution_failed", code: "turn_crashed" });
  });

  it("carries the filing-time approval on the receipt, so the card never waits for one that ran", async () => {
    // The room stamps `approved` when the row is already approved at filing
    // (an owner's click). Absent on older receipts, which keep the old reading.
    const gadget = outcomeGadget();
    const { opened, batchItemId } = await openBatch(gadget);
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      dispatch: { filed: true, actionId: "act_1", approved: true }
    });
    const approved = generationMark(gadget.storage.getBatchItem(batchItemId).generation);
    expect(approved?.dispatch?.approved).toBe(true);

    const fresh = (await gadget.createBatch({ itemIds: ["source_2"], destinationBindings: [] })) as {
      id: string;
      items: { id: string }[];
      workRequest: { requestId: string };
    };
    await gadget.recordGenerationDispatch({
      batchId: fresh.id,
      generationRequest: fresh.workRequest.requestId,
      dispatch: { filed: true, actionId: "act_2" }
    });
    const plain = generationMark(gadget.storage.getBatchItem(fresh.items[0].id).generation);
    expect(plain?.dispatch?.approved).toBe(false);
  });
});

describe("re-requesting after a final outcome", () => {
  it("succeeds without replace once the turn ended, still refuses while asked", async () => {
    const gadget = outcomeGadget();
    const { opened, batchItemId } = await openBatch(gadget);
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      dispatch: { filed: true, actionId: "act_1" }
    });

    // While the request is merely filed, a second ask still needs replace.
    const pending = (await gadget.requestGeneration(opened.id, [batchItemId], {})) as {
      ok: boolean;
      code?: string;
    };
    expect(pending).toMatchObject({ ok: false, code: "generation_pending" });

    // The turn ended with work outstanding: the same mark can be re-asked
    // under a new identity, without retiring anything (nothing is pending).
    await gadget.recordGenerationOutcome({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      generationRequest: opened.workRequest.requestId,
      outcome: { status: "stopped", code: "credits_exhausted" }
    });
    const retried = (await gadget.requestGeneration(opened.id, [batchItemId], {})) as {
      ok: boolean;
      request: string;
    };
    expect(retried.ok).toBe(true);
    expect(retried.request).not.toBe(opened.workRequest.requestId);
  });

  it("succeeds without replace after a recorded refusal", async () => {
    const gadget = outcomeGadget();
    const { opened, batchItemId } = await openBatch(gadget);
    await gadget.recordGenerationDispatch({
      batchId: opened.id,
      generationRequest: opened.workRequest.requestId,
      dispatch: { filed: true, actionId: "act_1" }
    });
    await gadget.recordGenerationOutcome({
      batchId: opened.id,
      batchItemIds: [batchItemId],
      generationRequest: opened.workRequest.requestId,
      outcome: { status: "refused" }
    });
    const retried = (await gadget.requestGeneration(opened.id, [batchItemId], {})) as { ok: boolean };
    expect(retried.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The drawer, through the real bundled client: a stopped request says so and
// offers a retry; an approved-but-not-started one never reads as finished.
// ---------------------------------------------------------------------------
const bundleFile = join(mkdtempSync(join(tmpdir(), "sl-outcome-")), "client.js");
writeFileSync(bundleFile, await buildClient(), "utf8");

const ITEM_ID = "source_1";
const BATCH_ITEM_ID = "bi_1";
const REQUEST_ID = "gen_outcome_1";

function markJson(extra: Record<string, unknown>) {
  return JSON.stringify({
    id: REQUEST_ID,
    base: 0,
    scope: { caption: true, image: true },
    needs: { caption: true, image: true },
    at: "2026-09-15T03:24:05.276Z",
    dispatch: { filed: true, actionId: "act_1", source: "host" },
    ...extra
  });
}

function batchSummaries(mark: string) {
  return {
    batches: [
      {
        id: "batch_1",
        status: "open",
        generation: "requested",
        itemCount: 1,
        draftCount: 1,
        reviewCount: 0,
        scheduledCount: 0,
        attentionCount: 0,
        sourceItemIds: [ITEM_ID],
        preview: {
          batchItemId: BATCH_ITEM_ID,
          sourceLabel: "Instagram · main",
          sourceText: "Reference caption",
          caption: null,
          revision: null,
          hasMediaReference: false
        },
        items: [
          {
            batchItemId: BATCH_ITEM_ID,
            itemId: ITEM_ID,
            state: "drafting",
            revision: 0,
            sourceLabel: "Instagram · main",
            provider: "instagram",
            sourceBinding: "IG_MAIN",
            sourceText: "Reference caption",
            coverMediaId: null,
            caption: null,
            generation: mark
          }
        ]
      }
    ],
    nextCursor: null,
    totals: { batches: 1, items: 1, drafts: 1, review: 0, scheduled: 0, attention: 0 }
  };
}

function installGadget(
  platform: Record<string, unknown> | null,
  calls: { status: number; requests?: unknown[] },
  markExtra: Record<string, unknown> = {}
) {
  const entry = {
    batchItemId: BATCH_ITEM_ID,
    requestId: REQUEST_ID,
    scope: { caption: true, image: true },
    needs: { caption: true, image: true },
    dispatch: { filed: true, actionId: "act_1", source: "host" },
    stage: "awaiting_approval",
    resolution: "found" as const,
    ...(platform ? { platform } : {})
  };
  (globalThis as any).gadget = {
    async summary() {
      return {
        configured: true,
        sources: [{ binding: "IG_MAIN", provider: "instagram", label: "Instagram · main" }],
        destinations: [],
        config: {}
      };
    },
    async listItems() {
      return {
        items: [{ id: ITEM_ID, provider: "instagram", text: "Reference caption", media: [], metrics: {}, seen: false, selected: true }],
        nextCursor: null
      };
    },
    async setSelection() {},
    async clearSelection() {},
    async refresh() {},
    async markSeen() {},
    async createBatch() {
      return { id: "batch_1", items: [], workRequest: null };
    },
    async listBatchSummaries() {
      return batchSummaries(markJson(markExtra));
    },
    async getBatch() {
      const summary = batchSummaries(markJson(markExtra)).batches[0];
      return {
        id: summary.id,
        createdAt: "2026-09-15T03:24:00.000Z",
        status: summary.status,
        generation: summary.generation,
        items: summary.items.map((item) => ({ ...item, id: item.batchItemId }))
      };
    },
    async checkGenerationStatus() {
      calls.status += 1;
      return { ok: true, batchId: "batch_1", at: "2026-09-15T08:15:06.000Z", workRequestStatus: [entry] };
    },
    async requestGeneration(...args: unknown[]) {
      calls.requests = [...(calls.requests ?? []), args];
      return { ok: true, request: "gen_outcome_2" };
    },
    async subscribe() {
      return {};
    }
  };
}

async function openDrawer(document: { body: unknown }) {
  await import(pathToFileURL(bundleFile).href + `?case=${Date.now()}-${Math.random()}`);
  await flushAsyncWork();
  const open = findAll(document.body, (element) => element.classList?.contains("sl-post-open"))[0];
  await open?.dispatchEvent({ type: "click", preventDefault: () => {} });
  await flushAsyncWork();
}

const buttonText = (root: unknown, text: string) =>
  findAll(root, (element) => element.tagName === "BUTTON" && String(element.textContent ?? "").trim() === text)[0];

async function click(button: { dispatchEvent: (event: unknown) => unknown } | undefined) {
  await button?.dispatchEvent({ type: "click", preventDefault: () => {} });
  await flushAsyncWork();
}

describe("a request whose turn ended with work outstanding", () => {
  const headerState = (root: unknown) =>
    findAll(root, (element) => element.classList?.contains("sl-drawer-state"))
      .map((element) => String(element.textContent ?? ""))
      .join(" ");

  it("reads an approved receipt in the header and footer, never awaiting approval", async () => {
    // Blocker 3: an auto-approved owner request agrees on all four surfaces
    // before any status read. The mark carries the approval on its receipt.
    for (const lang of ["en", "zh-HK"] as const) {
      const { document } = installMinimalDom();
      document.documentElement.lang = lang;
      const calls = { status: 0 };
      installGadget(null, calls, {
        dispatch: { filed: true, actionId: "act_1", source: "host", approved: true }
      });
      await openDrawer(document);

      const header = headerState(document.body);
      expect(header).not.toContain("Awaiting approval");
      expect(header).not.toContain("等待批核");
      expect(header).toMatch(lang === "en" ? /Approved/ : /已批核/);
      // The footer agrees before any status read: the approval ran, and the
      // turn has not reported back — never a wait for approval.
      const text = String(document.body.textContent);
      expect(text).toMatch(lang === "en" ? /hasn't reported back/ : /尚未回報/);
      expect(text).not.toContain("Waiting for your approval");
      expect(text).not.toContain("等待你在對話中批核");
      expect(
        buttonText(document.body, lang === "en" ? "Check status" : "檢查狀態"),
        `${lang}: Check status stays off while generation is in flight`
      ).toBeFalsy();
    }
  });

  it("says stopped with the reason and offers a retry, in English and zh-HK", async () => {
    for (const lang of ["en", "zh-HK"] as const) {
      const { document } = installMinimalDom();
      document.documentElement.lang = lang;
      const calls = { status: 0 };
      installGadget({ actionId: "act_1", state: "ran", decision: "approved", outcomeStatus: "credits_exhausted" }, calls);
      await openDrawer(document);
      await click(buttonText(document.body, lang === "en" ? "Check status" : "檢查狀態"));

      const text = String(document.body.textContent);
      expect(calls.status).toBeGreaterThan(0);
      expect(text).not.toContain("finished this request");
      expect(text).not.toContain("已完成此請求");
      expect(
        buttonText(document.body, lang === "en" ? "Retry" : "重試"),
        `${lang}: no retry for a stopped request`
      ).toBeTruthy();
    }
  });

  it("names the stopped reason in readable words, never the raw outcome code", async () => {
    // Should-fix 15: raw codes like `turn_crashed` must not reach zh-HK or en
    // sentences. The code (the turn's own report) maps to readable text.
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const calls = { status: 0 };
    installGadget(
      { actionId: "act_1", state: "ran", decision: "approved", outcomeStatus: "failed", outcomeCode: "turn_crashed" },
      calls
    );
    await openDrawer(document);
    await click(buttonText(document.body, "Check status"));

    expect(calls.status).toBeGreaterThan(0);
    const text = String(document.body.textContent);
    expect(text).toContain("turn crashed");
    expect(text).not.toContain("turn_crashed");
  });

  it("offers a status check for a credit refusal, as its own copy promises", async () => {
    // Should-fix 15: `drawerCreditCheckUnavailable` says "Check status, then
    // retry", so the button must be rendered even with no canonical state.
    for (const lang of ["en", "zh-HK"] as const) {
      const { document } = installMinimalDom();
      document.documentElement.lang = lang;
      const calls = { status: 0 };
      installGadget(null, calls, { dispatch: { filed: false, reason: "credit_check_unavailable" } });
      await openDrawer(document);
      expect(
        buttonText(document.body, lang === "en" ? "Check status" : "檢查狀態"),
        `${lang}: status check offered for a credit refusal`
      ).toBeTruthy();
    }
  });

  it("retries a declined or failed request with replace, a stopped one without", async () => {
    // Should-fix 10: nothing stamps declined/failed onto the mark, so the
    // server would refuse a replace-less re-ask as generation_pending. A
    // stopped request carries its outcome and re-asks cleanly.
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const declinedCalls = { status: 0, requests: [] as unknown[] };
    installGadget({ actionId: "act_1", state: "refused" }, declinedCalls);
    await openDrawer(document);
    await click(buttonText(document.body, "Check status"));
    await click(buttonText(document.body, "Retry"));
    const declinedOptions = declinedCalls.requests[0]?.[2] as { replace?: boolean };
    expect(declinedOptions?.replace).toBe(true);
  });

  it("retries a stopped request without replacing live work", async () => {
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const stoppedCalls = { status: 0, requests: [] as unknown[] };
    installGadget(
      { actionId: "act_1", state: "ran", decision: "approved", outcomeStatus: "stopped", outcomeCode: "credits_exhausted" },
      stoppedCalls
    );
    await openDrawer(document);
    await click(buttonText(document.body, "Check status"));
    await click(buttonText(document.body, "Retry"));
    const stoppedOptions = stoppedCalls.requests[0]?.[2] as { replace?: boolean };
    expect(stoppedOptions?.replace).not.toBe(true);
  });

  it("keeps the other outstanding part when re-requesting one part after a final outcome", async () => {
    // Should-fix 15: after a final outcome, re-asking one part must not
    // silently drop the other outstanding part (union of needs).
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const calls = { status: 0, requests: [] as unknown[] };
    installGadget(
      { actionId: "act_1", state: "ran", decision: "approved", outcomeStatus: "stopped", outcomeCode: "credits_exhausted" },
      calls
    );
    await openDrawer(document);
    await click(buttonText(document.body, "Check status"));
    // The image part's control is the strip's add menu: ＋ → Generate row.
    await click(findAll(document.body, (element) => element.getAttribute?.("aria-label") === "Add image")[0]);
    await click(
      findAll(
        document.body,
        (element) =>
          element.getAttribute?.("role") === "menuitem" &&
          String(element.textContent ?? "").startsWith("Generate a new image")
      )[0]
    );
    const sent = calls.requests[0]?.[2] as { needs?: Record<string, boolean>; replace?: boolean };
    expect(sent?.needs).toMatchObject({ image: true, caption: true });
    expect(sent?.replace).not.toBe(true);
  });

  it("reads a pushed turn outcome back without a manual press, exactly once", async () => {
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const calls = { status: 0 };
    // The mark already carries the turn's outcome (stamped when the turn
    // ended) while the status read still shows an outcome-less `ran`.
    installGadget(
      { actionId: "act_1", state: "ran", decision: "approved" },
      calls,
      { dispatch: { filed: true, actionId: "act_1", source: "host", outcome: { status: "stopped", code: "turn_crashed" } } }
    );
    await openDrawer(document);
    // One automatic read for the pushed outcome — and then silence. The mark
    // already carries the turn's end, so there is no stale awaiting-approval
    // to correct first: exactly one read, never a poll, never a manual press.
    await flushAsyncWork();
    expect(calls.status).toBe(1);
  });

  it("never reads an outcome-less approval as finished", async () => {
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const calls = { status: 0 };
    installGadget({ actionId: "act_1", state: "ran", decision: "approved" }, calls);
    await openDrawer(document);

    const text = String(document.body.textContent);
    expect(text).not.toContain("finished this request");
    expect(text).toContain("hasn't reported back");
    expect(buttonText(document.body, "Check status")).toBeFalsy();
  });
});
