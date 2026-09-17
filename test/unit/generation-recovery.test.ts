// Recovery for a generation request saved before the attended handoff existed,
// and the control state a Check status must leave behind.
//
// The production shape this pins (design-plans/evidence/
// social-production-start-unconfirmed-2026-09-15/README.md): a revision-0 item
// whose durable mark carries a request id, both parts outstanding, `dispatch`
// absent, and NO platform action row. The drawer said "check status or retry"
// and offered neither a resume nor working body controls:
//
//   F1  no owner action resumes delivery of the existing request identity
//   F2  a Check status leaves the per-part buttons disabled until reopen
//
// Both are asserted here through the REAL bundled client, not a hand-rendered
// footer.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildClient } from "../../scripts/client.mjs";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom";

// Built once for this file, from `src/src/client/*.js` — never a committed copy.
const bundleFile = join(mkdtempSync(join(tmpdir(), "sl-recovery-")), "client.js");
writeFileSync(bundleFile, await buildClient(), "utf8");

const ITEM_ID = "source_1";
const BATCH_ITEM_ID = "bi_bf644e76143b40ac9ce7";
const REQUEST_ID = "gen_e24a7c92752f4bb9b2b2";

/** The mark a pre-handoff request left behind: identity and scope, no dispatch. */
const LEGACY_GENERATION = JSON.stringify({
  id: REQUEST_ID,
  base: 0,
  scope: { caption: true, image: true },
  needs: { caption: true, image: true },
  at: "2026-09-15T03:24:05.276Z",
  instructions: { image: "Draft in Traditional Chinese", caption: "Translate the caption" }
});

function batchSummaries() {
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
            generation: LEGACY_GENERATION
          }
        ]
      }
    ],
    nextCursor: null,
    totals: { batches: 1, items: 1, drafts: 1, review: 0, scheduled: 0, attention: 0 }
  };
}

type Resolution = "found" | "not_found" | "unavailable" | "legacy-host";
type Calls = { status: number; resume: number; resumeArgs: Record<string, unknown>[] };

function installGadget(resolution: Resolution, calls: Calls) {
  const entry = (extra: Record<string, unknown>) => ({
    batchItemId: BATCH_ITEM_ID,
    requestId: REQUEST_ID,
    scope: { caption: true, image: true },
    needs: { caption: true, image: true },
    dispatch: null,
    stage: "start_unconfirmed",
    ...extra
  });
  const statusEntry = () => {
    if (resolution === "found") {
      return entry({
        dispatch: { filed: true, actionId: "act_real", source: "host" },
        stage: "awaiting_approval",
        resolution: "found",
        platform: { actionId: "act_real", state: "asked", decision: null }
      });
    }
    if (resolution === "unavailable") {
      return entry({ resolution: "unavailable", reason: "the request could not be looked up" });
    }
    if (resolution === "not_found") return entry({ resolution: "not_found" });
    // An older host: the field simply is not there.
    return entry({});
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
      return batchSummaries();
    },
    // The drawer loads the batch it was opened on; without this the open fails
    // before any control is rendered. `getBatch` names each item by `id` (the
    // server's own projection), which is how the drawer picks its subject.
    async getBatch() {
      const summary = batchSummaries().batches[0];
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
      return { ok: true, batchId: "batch_1", at: "2026-09-15T08:15:06.000Z", workRequestStatus: [statusEntry()] };
    },
    async resumeGeneration(input: unknown) {
      calls.resume += 1;
      calls.resumeArgs.push(input as Record<string, unknown>);
      return {
        ok: true,
        workRequest: {
          requestId: REQUEST_ID,
          batchId: "batch_1",
          sourceLabel: "Instagram · main",
          itemIds: [ITEM_ID],
          intake: ["saveRevisions", "saveRevision", "saveGeneratedImage"],
          parts: { caption: true, image: true }
        }
      };
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
const partButton = (root: unknown, part: string) =>
  findAll(root, (element) => element.getAttribute?.("data-part") === part)[0];
// The image part's control is the strip's add menu: the add-place tile (empty
// slot) or the quiet ＋ Add image link opens it, and its Generate row is the
// pressable action. A pending request marks the row (`data-requested`)
// without disabling it — a re-ask always asks first.
const imageAdd = (root: unknown) =>
  findAll(root, (element) => {
    const cls = String(element.className ?? "").split(" ");
    return element.tagName === "BUTTON" && (cls.includes("sl-addplace") || cls.includes("sl-addquiet") || cls.includes("sl-addslot") || element.getAttribute?.("aria-label") === "Add image");
  })[0];
const imageGenerate = (root: unknown) =>
  findAll(
    root,
    (element) =>
      element.getAttribute?.("role") === "menuitem" &&
      String(element.textContent ?? "").startsWith("Generate a new image")
  )[0];

async function click(button: { dispatchEvent: (event: unknown) => unknown } | undefined) {
  await button?.dispatchEvent({ type: "click", preventDefault: () => {} });
  await flushAsyncWork();
}

describe("a generation request saved before the handoff", () => {
  it("offers a resume once the platform confirms no filing, and leaves controls usable after a check", async () => {
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const calls: Calls = { status: 0, resume: 0, resumeArgs: [] };
    installGadget("not_found", calls);
    await openDrawer(document);

    // F2 baseline: the per-part controls start usable. The image part's
    // control is the strip's add menu — the ＋ slot opens it and its Generate
    // row stays pressable (a pending request is named, not locked out).
    expect(imageAdd(document.body)?.disabled).toBe(false);
    await click(imageAdd(document.body));
    expect(imageGenerate(document.body)?.disabled).toBe(false);
    expect(partButton(document.body, "caption")?.disabled).toBe(false);

    // The drawer opened on a request the host cannot confirm, so the automatic
    // status read has already run.
    expect(calls.status).toBeGreaterThan(0);

    // F2: after a manual check settles, the body controls are usable again.
    // The menu may still be open from the baseline probe — only toggle if not.
    await click(buttonText(document.body, "Check status"));
    expect(imageAdd(document.body)?.disabled).toBe(false);
    if (!imageGenerate(document.body)) await click(imageAdd(document.body));
    expect(imageGenerate(document.body)?.disabled).toBe(false);
    expect(partButton(document.body, "caption")?.disabled).toBe(false);

    // The empty image region IS the add control: a dashed placeholder its own
    // size — no framed empty under an "accepted image" heading.
    expect(
      findAll(document.body, (element) => element.classList?.contains("sl-output-frame-empty")),
      "giant empty image frame still rendered"
    ).toHaveLength(0);
    expect(findAll(document.body, (element) => element.classList?.contains("sl-addplace")).length).toBeGreaterThan(0);
    expect(String(document.body.textContent)).not.toContain("Accepted image");
    expect(String(document.body.textContent)).toContain("Add image");

    // Card, drawer and per-part copy agree: nothing implies an agent queue
    // for a request that was never submitted.
    expect(String(document.body.textContent)).toContain("Start not confirmed");
    expect(String(document.body.textContent)).not.toContain("waiting for the agent");
    expect(String(document.body.textContent)).toContain("saved but never submitted");

    // F1: a confirmed absence is a saved-but-not-submitted request with one
    // owner action that resumes the SAME request identity.
    const resume = buttonText(document.body, "Continue generation");
    expect(resume, "no resume action for a confirmed missing filing").toBeTruthy();
    await click(resume);
    expect(calls.resume).toBe(1);
    expect(calls.resumeArgs[0]).toMatchObject({
      batchId: "batch_1",
      batchItemId: BATCH_ITEM_ID,
      generationRequest: REQUEST_ID
    });
  });

  it("does not offer a blind resume when the lookup is unavailable or the host predates explicit status", async () => {
    for (const resolution of ["unavailable", "legacy-host"] as const) {
      const { document } = installMinimalDom();
      document.documentElement.lang = "en";
      const calls: Calls = { status: 0, resume: 0, resumeArgs: [] };
      installGadget(resolution, calls);
      await openDrawer(document);
      expect(buttonText(document.body, "Continue generation"), `${resolution} offered a blind resume`).toBeFalsy();
      expect(calls.resume).toBe(0);
    }
  });

  it("shows the real approval and never a resume when the platform finds the action", async () => {
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";
    const calls: Calls = { status: 0, resume: 0, resumeArgs: [] };
    installGadget("found", calls);
    await openDrawer(document);
    expect(buttonText(document.body, "Continue generation")).toBeFalsy();
    expect(calls.resume).toBe(0);
    expect(String(document.body.textContent)).toContain("Waiting for your approval");
  });

  it("renders the recovery in written zh-HK without implying an agent queue", async () => {
    const { document } = installMinimalDom();
    document.documentElement.lang = "zh-HK";
    const calls: Calls = { status: 0, resume: 0, resumeArgs: [] };
    installGadget("not_found", calls);
    await openDrawer(document);
    await click(buttonText(document.body, "檢查狀態"));

    const text = String(document.body.textContent);
    expect(text).toContain("此請求已儲存但從未送交");
    expect(buttonText(document.body, "繼續生成"), "no zh-HK resume action").toBeTruthy();
    expect(text).toContain("未確認已開始");
    expect(text).not.toContain("正在等待代理處理");
    expect(text).toContain("加入圖片");
    expect(
      findAll(document.body, (element) => element.classList?.contains("sl-output-frame-empty")),
      "giant empty image frame still rendered"
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The server side of the same contract: the resume the canvas asks for must
// keep the durable request exactly as it is.
// ---------------------------------------------------------------------------
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { Gadget } from "../../src/server.js";
import { generationMark } from "../../src/model.js";

const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function recoveryGadget() {
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
  return gadget;
}

describe("resuming a request that was never submitted", () => {
  it("re-delivers the SAME request identity, scope and instructions, and changes nothing", async () => {
    const gadget = recoveryGadget();
    const opened = (await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] })) as {
      id: string;
      items: { id: string }[];
      workRequest: { requestId: string };
    };
    const batchItemId = opened.items[0].id;
    const before = JSON.stringify(gadget.storage.getBatchItem(batchItemId).generation);

    const resumed = (await gadget.resumeGeneration({
      batchId: opened.id,
      batchItemId,
      generationRequest: opened.workRequest.requestId
    })) as { ok: boolean; request: string; workRequest: { requestId: string; parts: unknown; itemIds: string[] } };

    expect(resumed.ok).toBe(true);
    expect(resumed.request).toBe(opened.workRequest.requestId);
    expect(resumed.workRequest.requestId).toBe(opened.workRequest.requestId);
    expect(resumed.workRequest.parts).toEqual({ caption: true, image: true });
    expect(resumed.workRequest.itemIds).toEqual(["source_1"]);
    // No new mark, no new id, no dispatch written by the gadget.
    expect(JSON.stringify(gadget.storage.getBatchItem(batchItemId).generation)).toBe(before);
  });

  it("refuses a superseded request rather than overwriting newer work", async () => {
    const gadget = recoveryGadget();
    const opened = (await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] })) as {
      id: string;
      items: { id: string }[];
      workRequest: { requestId: string };
    };
    const batchItemId = opened.items[0].id;
    const replaced = (await gadget.requestGeneration(opened.id, [batchItemId], { replace: true })) as { request: string };

    const stale = (await gadget.resumeGeneration({
      batchId: opened.id,
      batchItemId,
      generationRequest: opened.workRequest.requestId
    })) as { ok: boolean; code?: string };
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("generation_request_stale");
    // The newer request is untouched.
    expect(generationMark(gadget.storage.getBatchItem(batchItemId).generation).id).toBe(replaced.request);
  });

  it("refuses when nothing is outstanding, and when the request is not the post's", async () => {
    const gadget = recoveryGadget();
    const opened = (await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] })) as {
      id: string;
      items: { id: string }[];
      workRequest: { requestId: string };
    };
    const batchItemId = opened.items[0].id;
    const unknown = (await gadget.resumeGeneration({
      batchId: opened.id,
      batchItemId,
      generationRequest: "gen_not_this_post"
    })) as { ok: boolean; code?: string };
    expect(unknown).toMatchObject({ ok: false, code: "generation_request_stale" });

    // Everything delivered: the mark clears, so there is nothing to resume.
    gadget.storage.clearItemGeneration(batchItemId);
    const done = (await gadget.resumeGeneration({
      batchId: opened.id,
      batchItemId,
      generationRequest: opened.workRequest.requestId
    })) as { ok: boolean; code?: string };
    expect(done.ok).toBe(false);
  });

  it("files only the still-outstanding part when the caption is already saved", async () => {
    const gadget = recoveryGadget();
    const opened = (await gadget.createBatch({ itemIds: ["source_1"], destinationBindings: [] })) as {
      id: string;
      items: { id: string }[];
      workRequest: { requestId: string };
    };
    const batchItemId = opened.items[0].id;
    // The caption half of this same request has been delivered; the image has not.
    gadget.storage.satisfyItemGeneration(batchItemId, {
      request: opened.workRequest.requestId,
      needs: { caption: true }
    });
    expect(generationMark(gadget.storage.getBatchItem(batchItemId).generation).needs).toEqual({
      caption: false,
      image: true
    });

    const resumed = (await gadget.resumeGeneration({
      batchId: opened.id,
      batchItemId,
      generationRequest: opened.workRequest.requestId
    })) as { ok: boolean; request: string; workRequest: { requestId: string; parts: unknown; items: { parts: unknown }[] } };

    // Same identity — but the approval authorizes the image only, never a
    // second caption draft.
    expect(resumed.ok).toBe(true);
    expect(resumed.request).toBe(opened.workRequest.requestId);
    expect(resumed.workRequest.requestId).toBe(opened.workRequest.requestId);
    expect(resumed.workRequest.parts).toEqual({ caption: false, image: true });
    expect(resumed.workRequest.items).toHaveLength(1);
    expect(resumed.workRequest.items[0].parts).toEqual({ caption: false, image: true });
  });
});
