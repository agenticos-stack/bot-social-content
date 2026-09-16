// The open drawer as a session: live updates (U1), instructions before a
// generation request (U2), one request at a time per post, and the reference
// stage kept across sections (U3).
//
// These run the UNCHANGED `openBatchDrawer`, `handleOperation` and
// `establishLiveUpdates` bodies extracted from client.js (the same technique
// as the 5ccaff1 audit probes) with the actual drawer renderers, over fake
// RPCs shaped like the server contract. Minimal DOM: focus movement, layout
// and real canvas/image decoding are not exercised — not a browser proof.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as dom from "../../src/src/client/dom.js";
import * as drawers from "../../src/src/client/drawer.js";
import { t } from "../../src/src/client/i18n.js";
import { createInboxState, isEditableItem, setInboxSummaries } from "../../src/src/client/inbox.js";
import { setNotice } from "../../src/src/client/collection.js";
import { createMediaStage } from "../../src/src/client/preview-media.js";
import { generationDisplayStage, generationMark, generationStage, itemPresentation, platformStage } from "../../src/model.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom";

type AnyRec = Record<string, any>;

const source = readFileSync(new URL("../../src/src/client/client.js", import.meta.url), "utf8");
function extract(startText: string, endText: string, name: string, scope: AnyRec) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end <= start) throw new Error(`client.js extraction boundary changed for ${name}`);
  return new Function("scope", `with(scope){${source.slice(start, end)}; return ${name};}`)(scope);
}

function post(id = "a", overrides: AnyRec = {}): AnyRec {
  return {
    id,
    batchId: "b",
    revision: 1,
    state: "drafting",
    caption: "Saved caption",
    altText: null,
    acceptedVisualMode: "ai_refinement",
    generatedImage: { id: `gm_${id}`, ready: true, mimeType: "image/jpeg", status: "accepted" },
    generatedCandidate: null,
    generation: null,
    instructionOverrides: { image: null, caption: null },
    sourceItem: { id: `src_${id}`, text: "Reference text", media: [{ id: "m1", kind: "image" }, { id: "m2", kind: "image" }] },
    destinationBindings: ["FB_MAIN"],
    publicationIntent: { publishMode: "save_draft", latePolicy: "hold" },
    publications: [],
    deliveries: [],
    ...overrides
  };
}

const pendingMark = (needs: AnyRec) => ({ id: "gen_1", base: 1, scope: { image: false, caption: false, ...needs }, needs: { image: false, caption: false, ...needs }, at: "2026-09-14T03:00:00.000Z" });

function rig(options: { items?: AnyRec[]; stage?: (target: AnyRec, calls: AnyRec) => AnyRec } = {}) {
  installMinimalDom();
  const db: AnyRec = { id: "b", items: options.items ?? [post()] };
  const calls: AnyRec = { reads: 0, requests: [], instructionWrites: [], revisionWrites: [], submits: [], sequence: [], guards: 0, stagesCreated: 0, stagesDisposed: 0, announced: [] };
  const responses: AnyRec = { requestGeneration: [], saveInstructionOverrides: null };
  const held: Array<(value: AnyRec) => void> = [];
  let holdReads = 0;
  const scope: AnyRec = {
    ...dom, ...drawers, t, createInboxState, isEditableItem, setInboxSummaries, itemPresentation, generationDisplayStage, generationMark, generationStage, platformStage, setNotice,
    drawerRequest: 0, locale: "en", summary: { configured: true }, policy: { posterPrompt: "SAVED DEFAULT" },
    drawerSession: null, collectionState: {}, inboxState: createInboxState(), wizard: {},
    batchDialog: document.createElement("dialog"), leaveDialog: document.createElement("dialog"),
    PHASE_STATE_KEYS: { draft: "stateDraft", regenerating: "stateRegenerating" },
    detectProtectedLiterals: () => [],
    // The real client records the host's filing outcome here; these extraction
    // tests only need it to be callable.
    recordDispatch: async () => {},
    announce: (message: string) => calls.announced.push(message),
    renderCurrentView() {}, refreshSummary: async () => {},
    mergeScanResult: (state: unknown) => state, setLastCheckedAt: (state: unknown) => state,
    wizardHandlers: {}, refusalMessage: (result: AnyRec) => result?.message ?? null,
    resumeBatch: (_old: unknown, batch: unknown) => ({ batch }), refreshPublishState: async () => {},
    loadGeneratedImageAsBlobUrl: async (_rpc: unknown, id: string) => ({ url: `blob:${id}`, mime: "image/jpeg" }),
    mediaStageFor: (target: AnyRec) => {
      if (options.stage) return options.stage(target, calls);
      calls.stagesCreated++;
      return { node: dom.el("div"), strip: null, dispose: () => { calls.stagesDisposed++; } };
    },
    publicationStateSummary: (_locale: string, outcome: string) => outcome,
    confirmUnsavedNavigation: async () => { calls.guards++; return "keep"; },
    GadgetSubscriber: class {},
    window: { addEventListener() {} }
  };
  scope.rpc = {
    getBatch: (_id: string) => {
      calls.reads++;
      if (holdReads > 0) {
        holdReads--;
        return new Promise((resolve) => held.push(resolve));
      }
      return Promise.resolve(structuredClone(db));
    },
    listBatchSummaries: async () => ({ batches: [] }),
    subscribe: async () => { calls.subscribes = (calls.subscribes ?? 0) + 1; },
    requestGeneration: async (...args: unknown[]) => {
      calls.requests.push(args);
      calls.sequence.push("request");
      return responses.requestGeneration.shift() ?? { ok: true };
    },
    saveInstructionOverrides: async (patch: AnyRec) => {
      calls.instructionWrites.push(patch);
      calls.sequence.push("instructions");
      if (responses.saveInstructionOverrides) return responses.saveInstructionOverrides;
      const row = db.items.find((item: AnyRec) => item.id === patch.batchItemId);
      const overrides = { ...row.instructionOverrides };
      for (const part of ["image", "caption"]) if (part in patch) overrides[part] = patch[part];
      row.instructionOverrides = overrides;
      return { ok: true, instructionOverrides: overrides };
    },
    saveRevisions: async (input: AnyRec) => {
      calls.revisionWrites.push(input);
      return { ok: true, results: input.revisions.map(() => ({ ok: true, revision: 2 })) };
    },
    submitForReview: async (input: AnyRec) => {
      calls.submits.push(input);
      return { ok: true, submitted: [] };
    }
  };
  const open = extract("  async function openBatchDrawer(", "\n  function closePreview()", "openBatchDrawer", scope);
  const operation = extract("  async function handleOperation(", "\n  (async function init()", "handleOperation", scope);
  scope.handleOperation = operation;
  const establish = extract("  const liveClientId", "\n  async function handleOperation(", "establishLiveUpdates", scope);
  return {
    scope, db, calls, responses, open, operation, establish,
    dialog: () => scope.batchDialog,
    holdNextRead: () => { holdReads++; },
    release: (snapshot: AnyRec) => held.shift()!(structuredClone(snapshot))
  };
}

const buttons = (root: unknown) => findAll(root as never, (e: any) => e.tagName === "BUTTON") as any[];
const labels = (root: unknown) => buttons(root).map((b) => b.textContent);
function findButton(root: unknown, label: string) {
  const found = buttons(root).find((b) => b.textContent === label);
  if (!found) throw new Error(`Missing button "${label}" in: ${labels(root).join(" | ")}`);
  return found;
}
async function click(root: unknown, label: string) {
  await findButton(root, label).dispatchEvent({ type: "click" });
  await flushAsyncWork();
}
/** Presses a button whose handler waits on a decision dialog; returns its settled promise. */
async function press(root: unknown, label: string) {
  const done = findButton(root, label).dispatchEvent({ type: "click" });
  await flushAsyncWork();
  return done;
}
const byId = (root: unknown, id: string) => findAll(root as never, (e: any) => e.getAttribute("id") === id || e.id === id)[0] as any;
const tab = (root: unknown, key: string) => byId(root, `sl-drawer-tab-${key}`);
async function type(field: any, value: string) {
  field.value = value;
  await field.dispatchEvent({ type: "input" });
}
const captionField = (r: AnyRec) => byId(r.dialog(), "sl-drawer-caption-input");
const images = (root: unknown) => findAll(root as never, (e: any) => e.tagName === "IMG") as any[];

// ---------------------------------------------------------------------------
// U1 — live updates
// ---------------------------------------------------------------------------

describe("U1: the open drawer follows generation completion", () => {
  it("shows a delivered image while Post is open, without reopening", async () => {
    const r = rig({ items: [post("a", { generatedImage: null, acceptedVisualMode: null, generation: pendingMark({ image: true }) })] });
    await r.open({ id: "b", itemId: "a" });
    expect(images(r.dialog())).toHaveLength(0);
    r.db.items[0] = post("a", { revision: 2, generatedImage: { id: "gm_new", ready: true, mimeType: "image/jpeg", status: "accepted" } });
    await r.operation({ type: "generated_image", batchItemId: "a", generatedMediaId: "gm_new" });
    await flushAsyncWork();
    expect(r.calls.reads).toBe(2);
    expect(images(r.dialog()).map((img) => img.src ?? img.getAttribute("src"))).toContain("blob:gm_new");
  });

  it("keeps the Instructions section open, and Post shows the new caption when revisited", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    Object.assign(r.db.items[0], { caption: "New generated caption", revision: 2 });
    await r.operation({ type: "revision", batchItemId: "a", revision: 2 });
    expect(tab(r.dialog(), "instructions").getAttribute("aria-selected")).toBe("true");
    expect(byId(r.dialog(), "sl-instructions-image")).toBeTruthy();
    await click(r.dialog(), t("en", "drawerTabOutput"));
    expect(captionField(r).value).toBe("New generated caption");
  });

  it("never overwrites an unsaved caption: it shows the conflict, and keeping yours leaves the buffer dirty", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "The owner's own caption");
    Object.assign(r.db.items[0], { caption: "New generated caption", revision: 2 });
    await r.operation({ type: "revision", batchItemId: "a", revision: 2 });
    expect(r.dialog().textContent).toContain("A new generated caption is ready");
    expect(r.dialog().textContent).toContain("New generated caption");
    expect(captionField(r).value).toBe("The owner's own caption");

    await click(r.dialog(), "Keep yours");
    expect(r.dialog().textContent).not.toContain("A new generated caption is ready");
    expect(captionField(r).value).toBe("The owner's own caption");
    expect(findButton(r.dialog(), t("en", "drawerSaveDraft")).disabled).toBe(false);
  });

  it("using the new caption discards the local buffer", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "The owner's own caption");
    Object.assign(r.db.items[0], { caption: "New generated caption", revision: 2 });
    await r.operation({ type: "revision", batchItemId: "a", revision: 2 });
    await click(r.dialog(), "Use the new caption");
    expect(captionField(r).value).toBe("New generated caption");
    expect(findButton(r.dialog(), t("en", "drawerSaveDraft")).disabled).toBe(true);
  });

  it("ignores a read that was in flight when the owner switched posts", async () => {
    const r = rig({ items: [post("a"), post("b", { caption: "Second post caption" })] });
    await r.open({ id: "b", itemId: "a" });
    r.holdNextRead();
    const pending = r.operation({ type: "revision", batchItemId: "a", revision: 2 });
    await flushAsyncWork();
    expect(r.calls.reads).toBe(2);
    await click(r.dialog(), t("en", "drawerPostNofM", { n: 2, total: 2 }));
    r.db.items[0].caption = "FRESH";
    r.release({ id: "b", items: [post("a", { caption: "STALE" }), post("b", { caption: "Second post caption" })] });
    await pending;
    await flushAsyncWork();
    // The stale answer was dropped and one follow-up read replaced it.
    expect(r.calls.reads).toBe(3);
    expect(captionField(r).value).toBe("Second post caption");
    await click(r.dialog(), t("en", "drawerPostNofM", { n: 1, total: 2 }));
    expect(captionField(r).value).toBe("FRESH");
  });

  it("stops updating a closed drawer, and a reopened drawer has exactly one registration", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    r.holdNextRead();
    const inFlight = r.operation({ type: "revision", batchItemId: "a" });
    await flushAsyncWork();
    const close = buttons(r.dialog()).find((b) => b.getAttribute("aria-label") === t("en", "drawerClose"));
    await close.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    expect(r.scope.drawerSession).toBeNull();
    r.release({ id: "b", items: [post("a", { caption: "LATE" })] });
    await inFlight;
    await flushAsyncWork();
    expect(captionField(r).value).toBe("Saved caption");

    const readsWhileClosed = r.calls.reads;
    await r.operation({ type: "revision", batchItemId: "a" });
    expect(r.calls.reads).toBe(readsWhileClosed);

    await r.open({ id: "b", itemId: "a" });
    const afterReopen = r.calls.reads;
    await r.operation({ type: "revision", batchItemId: "a" });
    expect(r.calls.reads).toBe(afterReopen + 1);
  });

  it("ends the previous session when another post's drawer opens", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    const first = r.scope.drawerSession;
    await r.open({ id: "b", itemId: "a" });
    expect(r.scope.drawerSession).not.toBe(first);
    const before = r.calls.reads;
    await first.refresh({ type: "revision", batchItemId: "a" });
    expect(r.calls.reads).toBe(before);
  });

  it("reconciles after re-subscribing", async () => {
    const r = rig();
    await r.establish();
    await r.open({ id: "b", itemId: "a" });
    Object.assign(r.db.items[0], { caption: "Caption saved while offline", revision: 2 });
    await r.establish();
    await flushAsyncWork();
    expect(r.calls.subscribes).toBe(2);
    expect(captionField(r).value).toBe("Caption saved while offline");
  });

  it("collapses duplicate events for one completion into one follow-up read and one rendered conflict", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Mine");
    Object.assign(r.db.items[0], { caption: "Generated", revision: 2 });
    r.holdNextRead();
    const events = [
      r.operation({ type: "generated_image", batchItemId: "a" }),
      r.operation({ type: "revision", batchItemId: "a", revision: 2 }),
      r.operation({ type: "drafts_changed" }),
      r.operation({ type: "revision", batchItemId: "a", revision: 2 })
    ];
    await flushAsyncWork();
    r.release(r.db);
    await Promise.all(events);
    await flushAsyncWork();
    expect(r.calls.reads).toBe(3); // open + the in-flight read + one coalesced re-read
    const conflicts = findAll(r.dialog() as never, (e: any) => String(e.className).includes("sl-caption-conflict") && !String(e.className).includes("-text"));
    expect(conflicts).toHaveLength(1);
    expect(findAll(r.dialog() as never, (e: any) => e.getAttribute("id") === "sl-drawer-caption-input")).toHaveLength(1);
    expect(captionField(r).value).toBe("Mine");
  });
});

// ---------------------------------------------------------------------------
// U2 — instructions before generation
// ---------------------------------------------------------------------------

async function editImageInstructions(r: AnyRec, value: string) {
  await click(r.dialog(), t("en", "drawerTabInstructions"));
  await type(byId(r.dialog(), "sl-instructions-image"), value);
  await click(r.dialog(), t("en", "drawerTabOutput"));
}

describe("U2: unsaved instructions are decided before a request", () => {
  it("asks before Regenerate image uses stale instructions, and sends nothing yet", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    void press(r.dialog(), t("en", "drawerRegenerateImage"));
    await flushAsyncWork();
    expect(labels(r.scope.leaveDialog)).toEqual(["Cancel", "Generate with saved instructions", "Save instructions and generate"]);
    expect(r.calls.requests).toHaveLength(0);
    expect(r.calls.instructionWrites).toHaveLength(0);
  });

  it("saves the instructions, then sends exactly one request", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = press(r.dialog(), t("en", "drawerRegenerateImage"));
    await click(r.scope.leaveDialog, "Save instructions and generate");
    await done;
    await flushAsyncWork();
    expect(r.calls.sequence).toEqual(["instructions", "request"]);
    expect(r.calls.instructionWrites).toEqual([{ batchItemId: "a", image: "Morning light, outdoors" }]);
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true } }]]);
    expect(findButton(r.dialog(), t("en", "drawerSaveDraft")).disabled).toBe(true);
  });

  it("keeps the edits and requests nothing when saving the instructions fails", async () => {
    const r = rig();
    r.responses.saveInstructionOverrides = { ok: false, code: "invalid_argument", message: "Instructions are too long." };
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = press(r.dialog(), t("en", "drawerRegenerateImage"));
    await click(r.scope.leaveDialog, "Save instructions and generate");
    await done;
    expect(r.calls.requests).toHaveLength(0);
    expect(r.calls.announced).toContain("Instructions are too long.");
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    expect(byId(r.dialog(), "sl-instructions-image").value).toBe("Morning light, outdoors");
  });

  it("does nothing on Cancel", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = press(r.dialog(), t("en", "drawerRegenerateImage"));
    await click(r.scope.leaveDialog, "Cancel");
    await done;
    expect(r.calls.requests).toHaveLength(0);
    expect(r.calls.instructionWrites).toHaveLength(0);
    expect(findButton(r.dialog(), t("en", "drawerSaveDraft")).disabled).toBe(false);
  });

  it("generates with the saved instructions only when chosen, keeping the edits unsaved", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = press(r.dialog(), t("en", "drawerRegenerateImage"));
    await click(r.scope.leaveDialog, "Generate with saved instructions");
    await done;
    expect(r.calls.instructionWrites).toHaveLength(0);
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true } }]]);
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    expect(byId(r.dialog(), "sl-instructions-image").value).toBe("Morning light, outdoors");
  });

  it("saves only the requested part's instructions and leaves unrelated edits unsaved", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await type(byId(r.dialog(), "sl-instructions-caption"), "Warmer tone");
    await click(r.dialog(), t("en", "drawerTabOutput"));
    await editImageInstructions(r, "Morning light, outdoors");
    const done = press(r.dialog(), t("en", "drawerRegenerateImage"));
    await click(r.scope.leaveDialog, "Save instructions and generate");
    await done;
    expect(r.calls.instructionWrites).toEqual([{ batchItemId: "a", image: "Morning light, outdoors" }]);
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    expect(byId(r.dialog(), "sl-instructions-caption").value).toBe("Warmer tone");
  });

  it("does not ask when only the other part's instructions are unsaved", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await type(byId(r.dialog(), "sl-instructions-caption"), "Warmer tone");
    await click(r.dialog(), t("en", "drawerTabOutput"));
    await click(r.dialog(), t("en", "drawerRegenerateImage"));
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true } }]]);
  });
});

// ---------------------------------------------------------------------------
// Serialized generation: a pending request is replaced only on explicit confirm
// ---------------------------------------------------------------------------

describe("one outstanding request per post", () => {
  it("asks before replacing a pending caption request, and sends replace:true only when confirmed", async () => {
    const r = rig({ items: [post("a", { generation: pendingMark({ caption: true }) })] });
    await r.open({ id: "b", itemId: "a" });
    expect(r.dialog().textContent).toContain("A caption request is still pending for this post.");
    const done = press(r.dialog(), t("en", "drawerRegenerateImage"));
    expect(labels(r.scope.leaveDialog)).toContain("Replace the pending caption request");
    expect(r.calls.requests).toHaveLength(0);
    await click(r.scope.leaveDialog, "Replace the pending caption request");
    await done;
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, replace: true }]]);
  });

  it("sends nothing when the owner cancels the replacement", async () => {
    const r = rig({ items: [post("a", { generation: pendingMark({ image: true }) })] });
    await r.open({ id: "b", itemId: "a" });
    const done = press(r.dialog(), t("en", "drawerRewriteCaption"));
    await click(r.scope.leaveDialog, "Cancel");
    await done;
    expect(r.calls.requests).toHaveLength(0);
  });

  it("a new post's initial request (both parts) is replaced only explicitly", async () => {
    const r = rig({ items: [post("a", { revision: 0, caption: "", generatedImage: null, acceptedVisualMode: null, generation: pendingMark({ image: true, caption: true }) })] });
    await r.open({ id: "b", itemId: "a" });
    const regenerate = findButton(r.dialog(), t("en", "drawerRegenerateImage"));
    expect(regenerate.disabled).toBe(false);
    const done = press(r.dialog(), t("en", "drawerRegenerateImage"));
    await click(r.scope.leaveDialog, "Replace the pending image request");
    await done;
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, replace: true }]]);
  });

  it("answers a generation_pending refusal with the same explicit decision", async () => {
    const r = rig();
    r.responses.requestGeneration = [
      {
        ok: false, code: "generation_pending", message: "A request is already pending.",
        pending: { requestId: "gen_9", scope: { image: true, caption: false }, needs: { image: true, caption: false } },
        pendingItems: [{ batchItemId: "a", requestId: "gen_9", scope: { image: true, caption: false }, needs: { image: true, caption: false } }]
      },
      { ok: true, replaced: [{ batchItemId: "a", requestId: "gen_9" }] }
    ];
    await r.open({ id: "b", itemId: "a" });
    const done = press(r.dialog(), t("en", "drawerRewriteCaption"));
    await flushAsyncWork();
    expect(labels(r.scope.leaveDialog)).toContain("Replace the pending image request");
    await click(r.scope.leaveDialog, "Replace the pending image request");
    await done;
    expect(r.calls.requests).toEqual([
      ["b", ["a"], { needs: { caption: true } }],
      ["b", ["a"], { needs: { caption: true }, replace: true }]
    ]);
    expect(r.calls.announced).not.toContain("A request is already pending.");
  });

  it("does not replace when the refusal's decision is cancelled", async () => {
    const r = rig();
    r.responses.requestGeneration = [{ ok: false, code: "generation_pending", message: "pending", pending: { requestId: "gen_9", needs: { image: true, caption: false } } }];
    await r.open({ id: "b", itemId: "a" });
    const done = press(r.dialog(), t("en", "drawerRewriteCaption"));
    await flushAsyncWork();
    await click(r.scope.leaveDialog, "Cancel");
    await done;
    expect(r.calls.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// U3 — the reference stage survives section switches
// ---------------------------------------------------------------------------

/**
 * A gadget whose `getMedia` the test controls. Counts are GADGET READS: a
 * read may be answered from the gadget's own media cache, so nothing here
 * claims how many provider fetches happened.
 */
function mediaGadget() {
  const reads: string[] = [];
  const answers: Record<string, AnyRec> = {};
  const waiting: Array<() => void> = [];
  let hold = false;
  const host: Array<(answer: AnyRec) => void> = [];
  return {
    reads, answers, host,
    holdReads: (value: boolean) => { hold = value; },
    releaseReads: () => { for (const go of waiting.splice(0)) go(); },
    answerHost: (answer: AnyRec) => host.shift()!(answer),
    stage: (target: AnyRec, calls: AnyRec) => {
      calls.stagesCreated++;
      const stage = createMediaStage({
        getMedia: async (_itemId: string, mediaId: string) => {
          reads.push(mediaId); // one gadget read
          if (hold) await new Promise<void>((go) => waiting.push(go));
          const answer = answers[mediaId] ?? { bytes: [255, 216, 255, 217] };
          if (answer.ok === false) return answer;
          return { mime: "image/jpeg", total: answer.bytes.length, chunk: 0, chunks: 1, bytes: answer.bytes };
        }
      } as never, target, "en", {
        requestGrant: () => new Promise((resolve) => host.push(resolve)),
        requestActivation: () => new Promise((resolve) => host.push(resolve)),
        refreshSources: () => {}
      });
      const dispose = stage.dispose;
      return Object.assign(stage, { dispose: () => { calls.stagesDisposed++; dispose(); } });
    }
  };
}

async function switchAwayAndBack(r: AnyRec) {
  await click(r.dialog(), t("en", "drawerTabReference"));
  await click(r.dialog(), t("en", "drawerTabInstructions"));
  await click(r.dialog(), t("en", "drawerTabReference"));
}

describe("U3: one reference stage per post per drawer session", () => {
  it("keeps a loading frame's single read across section switches", async () => {
    const gadget = mediaGadget();
    const r = rig({ stage: gadget.stage });
    gadget.holdReads(true);
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabReference"));
    expect(gadget.reads).toEqual(["m1"]);
    await switchAwayAndBack(r);
    gadget.releaseReads();
    await flushAsyncWork();
    expect(gadget.reads).toEqual(["m1"]); // one gadget read total
    expect(r.calls.stagesCreated).toBe(1);
    expect(r.calls.stagesDisposed).toBe(0);
  });

  it("applies a consent answer that arrives after the owner switched sections", async () => {
    const gadget = mediaGadget();
    gadget.answers.m1 = { ok: false, code: "fetch_permission_required", message: "Public account fetching is not granted." };
    const r = rig({ stage: gadget.stage });
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabReference"));
    void press(r.dialog(), t("en", "drawerMediaGrant"));
    await switchAwayAndBack(r);
    gadget.answers.m1 = { bytes: [255, 216, 255, 217] };
    gadget.answerHost({ outcome: "activated" });
    await flushAsyncWork();
    expect(gadget.reads).toEqual(["m1", "m1"]); // the refused read, then the one the answer allowed
    const stage = r.scope.drawerSession && images(r.dialog());
    expect(stage.map((img: AnyRec) => img.src ?? img.getAttribute("src")).some((src: string) => String(src).startsWith("blob:"))).toBe(true);
    expect(r.calls.stagesCreated).toBe(1);
  });

  it("keeps the cancellation note after switching sections", async () => {
    const gadget = mediaGadget();
    gadget.answers.m1 = { ok: false, code: "fetch_permission_required", message: "Public account fetching is not granted." };
    const r = rig({ stage: gadget.stage });
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabReference"));
    void press(r.dialog(), t("en", "drawerMediaGrant"));
    gadget.answerHost({ outcome: "cancelled" });
    await flushAsyncWork();
    expect(r.dialog().textContent).toContain(t("en", "drawerMediaCancelled"));
    await switchAwayAndBack(r);
    expect(r.dialog().textContent).toContain(t("en", "drawerMediaCancelled"));
    expect(gadget.reads).toEqual(["m1"]);
  });

  it("keeps the loaded state after a successful recovery, without reading again", async () => {
    const gadget = mediaGadget();
    gadget.answers.m1 = { ok: false, code: "fetch_permission_required", message: "Public account fetching is not granted." };
    const r = rig({ stage: gadget.stage });
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabReference"));
    void press(r.dialog(), t("en", "drawerMediaGrant"));
    gadget.answers.m1 = { bytes: [255, 216, 255, 217] };
    gadget.answerHost({ outcome: "activated" });
    await flushAsyncWork();
    const readsAfterRecovery = gadget.reads.length;
    await switchAwayAndBack(r);
    await flushAsyncWork();
    expect(gadget.reads.length).toBe(readsAfterRecovery);
    expect(images(r.dialog()).some((img: AnyRec) => String(img.src ?? img.getAttribute("src")).startsWith("blob:"))).toBe(true);
  });

  it("disposes the stage when the drawer closes, and when the post's source item is replaced", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabReference"));
    r.db.items[0].sourceItem = { id: "src_other", text: "Another source", media: [{ id: "m9", kind: "image" }] };
    await r.operation({ type: "revision", batchItemId: "a" });
    expect(r.calls.stagesDisposed).toBe(1);
    expect(r.calls.stagesCreated).toBe(2);
    const close = buttons(r.dialog()).find((b) => b.getAttribute("aria-label") === t("en", "drawerClose"));
    await close.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    expect(r.calls.stagesDisposed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R3 — owner edits made while Save is in flight survive its acknowledgment
// ---------------------------------------------------------------------------

/** Holds each save RPC until released; a released save persists what it was sent. */
function gateSaves(r: AnyRec) {
  const gates: Array<(fail: boolean) => void> = [];
  const hold = () => new Promise<boolean>((go) => gates.push(go));
  r.scope.rpc.saveRevisions = async (input: AnyRec) => {
    r.calls.revisionWrites.push(input);
    if (await hold()) return { ok: true, results: input.revisions.map(() => ({ ok: false, issues: [{ message: "Revision conflict." }] })) };
    const results = input.revisions.map((rev: AnyRec) => {
      const row = r.db.items.find((item: AnyRec) => item.id === rev.batchItemId);
      if (rev.caption !== undefined) row.caption = rev.caption;
      if (rev.altText !== undefined) row.altText = rev.altText;
      if (rev.acceptedGeneratedMediaId) {
        row.generatedImage = { id: rev.acceptedGeneratedMediaId, ready: true, mimeType: "image/jpeg", status: "accepted" };
        row.generatedCandidate = null;
      }
      row.revision = (row.revision ?? 0) + 1;
      return { ok: true, revision: row.revision };
    });
    return { ok: true, results };
  };
  const instructions = r.scope.rpc.saveInstructionOverrides;
  r.scope.rpc.saveInstructionOverrides = async (patch: AnyRec) => {
    if (await hold()) return { ok: false, message: "Instructions are too long." };
    return instructions(patch);
  };
  return {
    release: async () => { gates.shift()!(false); await flushAsyncWork(); },
    fail: async () => { gates.shift()!(true); await flushAsyncWork(); },
    pending: () => gates.length
  };
}
const saveButton = (r: AnyRec) => findButton(r.dialog(), t("en", "drawerSaveDraft"));
async function startSave(r: AnyRec) {
  const done = saveButton(r).dispatchEvent({ type: "click" });
  await flushAsyncWork();
  // Wrapped: returning the promise itself would make `await startSave()` wait for the save.
  return { done };
}

describe("R3: typing during a pending Save keeps the newer edit", () => {
  it("caption: A is saved, B stays visible and dirty, and a second save persists B", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Caption A");
    const { done: saving } = await startSave(r);
    expect(saveButton(r).disabled).toBe(true);
    await type(captionField(r), "Caption B");
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(r.calls.revisionWrites[0].revisions[0].caption).toBe("Caption A");
    expect(r.db.items[0].caption).toBe("Caption A");
    expect(captionField(r).value).toBe("Caption B");
    expect(saveButton(r).disabled).toBe(false);
    // The unsaved guard still counts B.
    const close = buttons(r.dialog()).find((b) => b.getAttribute("aria-label") === t("en", "drawerClose"));
    await close.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    expect(r.calls.guards).toBe(1);

    const { done: second } = await startSave(r);
    expect(r.calls.revisionWrites[1].revisions[0]).toMatchObject({ caption: "Caption B", expectedRevision: 2 });
    await saves.release();
    await second;
    await flushAsyncWork();
    expect(r.db.items[0].caption).toBe("Caption B");
    expect(captionField(r).value).toBe("Caption B");
    expect(saveButton(r).disabled).toBe(true);
  });

  it("clears the buffer when nothing was typed during the save", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Caption A");
    const { done: saving } = await startSave(r);
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(captionField(r).value).toBe("Caption A");
    expect(saveButton(r).disabled).toBe(true);
  });

  it("an edit typed back to the submitted text during the save is still acknowledged as saved", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Caption A");
    const { done: saving } = await startSave(r);
    await type(captionField(r), "Caption A!");
    await type(captionField(r), "Caption A");
    await saves.release();
    await saving;
    await flushAsyncWork();
    // Newer edit version kept, but it equals the saved caption: not dirty.
    expect(captionField(r).value).toBe("Caption A");
    expect(saveButton(r).disabled).toBe(true);
  });

  it("alt text: A is saved, B is retained dirty", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    const alt = () => byId(r.dialog(), "sl-drawer-alt-text");
    await type(alt(), "Alt A");
    const { done: saving } = await startSave(r);
    await type(alt(), "Alt B");
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(r.db.items[0].altText).toBe("Alt A");
    expect(alt().value).toBe("Alt B");
    expect(saveButton(r).disabled).toBe(false);
    const { done: second } = await startSave(r);
    await saves.release();
    await second;
    expect(r.db.items[0].altText).toBe("Alt B");
  });

  it("instruction overrides: only the part still as submitted is cleared", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await type(byId(r.dialog(), "sl-instructions-image"), "Image A");
    await type(byId(r.dialog(), "sl-instructions-caption"), "Caption tone A");
    const { done: saving } = await startSave(r);
    await type(byId(r.dialog(), "sl-instructions-image"), "Image B");
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(r.db.items[0].instructionOverrides).toEqual({ image: "Image A", caption: "Caption tone A" });
    expect(tab(r.dialog(), "instructions").getAttribute("aria-selected")).toBe("true");
    expect(byId(r.dialog(), "sl-instructions-image").value).toBe("Image B");
    expect(byId(r.dialog(), "sl-instructions-caption").value).toBe("Caption tone A");
    expect(saveButton(r).disabled).toBe(false);
    const { done: second } = await startSave(r);
    await saves.release();
    await second;
    expect(r.db.items[0].instructionOverrides).toEqual({ image: "Image B", caption: "Caption tone A" });
    expect(saveButton(r).disabled).toBe(true);
  });

  it("staged image: the submitted candidate is accepted, a different image staged during the save stays staged", async () => {
    const r = rig({
      items: [post("a", {
        generatedCandidate: { id: "gm_cand", ready: true, mimeType: "image/jpeg", status: "candidate" },
        generatedHistory: [{ id: "gm_old", ready: true, status: "superseded", createdAt: "2026-09-13T03:00:00.000Z" }]
      })]
    });
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerUseCandidate"));
    const { done: saving } = await startSave(r);
    await click(r.dialog(), t("en", "drawerTabHistory"));
    await click(r.dialog(), t("en", "drawerHistoryUseImage"));
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(r.calls.revisionWrites[0].revisions[0].acceptedGeneratedMediaId).toBe("gm_cand");
    expect(r.db.items[0].generatedImage.id).toBe("gm_cand");
    expect(saveButton(r).disabled).toBe(false);
    const { done: second } = await startSave(r);
    expect(r.calls.revisionWrites[1].revisions[0].acceptedGeneratedMediaId).toBe("gm_old");
    await saves.release();
    await second;
    expect(r.db.items[0].generatedImage.id).toBe("gm_old");
  });

  it("switching sibling posts during the save: the acknowledgment lands on the saved post only", async () => {
    const r = rig({ items: [post("a"), post("b", { caption: "Second post caption" })] });
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Caption A");
    const { done: saving } = await startSave(r);
    await click(r.dialog(), t("en", "drawerPostNofM", { n: 2, total: 2 }));
    await type(captionField(r), "Second post edit");
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(r.db.items.map((item: AnyRec) => item.caption)).toEqual(["Caption A", "Second post caption"]);
    expect(captionField(r).value).toBe("Second post edit");
    expect(saveButton(r).disabled).toBe(false);
    await click(r.dialog(), t("en", "drawerPostNofM", { n: 1, total: 2 }));
    expect(captionField(r).value).toBe("Caption A");
    expect(saveButton(r).disabled).toBe(true);
  });

  it("a live generation refresh during the save merges server data and keeps the newer buffer", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Caption A");
    const { done: saving } = await startSave(r);
    await type(captionField(r), "Caption B");
    r.db.items[0].generatedCandidate = { id: "gm_live", ready: true, mimeType: "image/jpeg", status: "candidate" };
    await r.operation({ type: "generated_image", batchItemId: "a" });
    await flushAsyncWork();
    expect(captionField(r).value).toBe("Caption B");
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(r.db.items[0].caption).toBe("Caption A");
    expect(captionField(r).value).toBe("Caption B");
    expect(images(r.dialog()).map((img) => img.src ?? img.getAttribute("src"))).toContain("blob:gm_live");
    expect(r.dialog().textContent).not.toContain("A new generated caption is ready");
    expect(saveButton(r).disabled).toBe(false);
  });

  it("a failed save keeps every buffer and shows the error", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Caption A");
    await type(byId(r.dialog(), "sl-drawer-alt-text"), "Alt A");
    const { done: saving } = await startSave(r);
    await type(captionField(r), "Caption B");
    await saves.fail();
    await saving;
    await flushAsyncWork();
    expect(r.calls.announced).toContain("Revision conflict.");
    expect(captionField(r).value).toBe("Caption B");
    expect(byId(r.dialog(), "sl-drawer-alt-text").value).toBe("Alt A");
    expect(r.db.items[0].caption).toBe("Saved caption");
    expect(saveButton(r).disabled).toBe(false);
  });

  it("a failed instruction save keeps the instruction buffers", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await type(byId(r.dialog(), "sl-instructions-image"), "Image A");
    const { done: saving } = await startSave(r);
    await saves.fail();
    await saving;
    await flushAsyncWork();
    expect(r.calls.announced).toContain("Instructions are too long.");
    expect(byId(r.dialog(), "sl-instructions-image").value).toBe("Image A");
    expect(saveButton(r).disabled).toBe(false);
  });

  it("ignores the acknowledgment for a drawer session that was replaced", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Caption A");
    const { done: saving } = await startSave(r);
    await r.open({ id: "b", itemId: "a" });
    const readsAfterReopen = r.calls.reads;
    await type(captionField(r), "Newer drawer edit");
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(captionField(r).value).toBe("Newer drawer edit");
    expect(r.calls.reads).toBe(readsAfterReopen);
  });

  it("keeps focus and caret in the field being typed in across the acknowledgment re-render", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    (document.body as any).appendChild(r.dialog());
    const proto = Object.getPrototypeOf(captionField(r));
    const selections: Array<[unknown, number, number]> = [];
    const restore = { focus: proto.focus, setSelectionRange: proto.setSelectionRange };
    proto.focus = function focus() { (document as any).activeElement = this; };
    proto.setSelectionRange = function setSelectionRange(start: number, end: number) { selections.push([this, start, end]); };
    try {
      await type(captionField(r), "Caption A");
      const { done: saving } = await startSave(r);
      const typing = captionField(r);
      await type(typing, "Caption B typed");
      typing.focus();
      Object.assign(typing, { selectionStart: 9, selectionEnd: 9 });
      await saves.release();
      await saving;
      await flushAsyncWork();
      const after = captionField(r);
      expect(after.value).toBe("Caption B typed");
      expect((document as any).activeElement).toBe(after);
      // The minimal DOM rebuilds the field; the caret is restored onto it.
      if (after !== typing) expect(selections.at(-1)).toEqual([after, 9, 9]);
    } finally {
      Object.assign(proto, restore);
    }
  });
});

// ---------------------------------------------------------------------------
// R4 — the host's `reconnected` reconciles the open drawer
// ---------------------------------------------------------------------------

describe("R4: a stream reconnect reconciles missed updates", () => {
  it("shows a candidate that arrived while disconnected, preserving buffers and section, in one read per burst", async () => {
    const r = rig({ items: [post("a", { generation: pendingMark({ image: true }) })] });
    await r.open({ id: "b", itemId: "a" });
    await type(captionField(r), "Unsaved owner caption");
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await type(byId(r.dialog(), "sl-instructions-image"), "Unsaved image note");
    await click(r.dialog(), t("en", "drawerTabOutput"));
    Object.assign(r.db.items[0], { generation: null, generatedCandidate: { id: "gm_missed", ready: true, mimeType: "image/jpeg", status: "candidate" } });
    const readsBefore = r.calls.reads;
    await Promise.all([r.operation({ type: "reconnected" }), r.operation({ type: "reconnected" }), r.operation({ type: "reconnected" })]);
    await flushAsyncWork();
    expect(r.calls.reads).toBe(readsBefore + 1);
    expect(images(r.dialog()).map((img) => img.src ?? img.getAttribute("src"))).toContain("blob:gm_missed");
    expect(tab(r.dialog(), "output").getAttribute("aria-selected")).toBe("true");
    expect(captionField(r).value).toBe("Unsaved owner caption");
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    expect(byId(r.dialog(), "sl-instructions-image").value).toBe("Unsaved image note");
    expect(r.calls.requests).toHaveLength(0);
    expect(r.calls.revisionWrites).toHaveLength(0);
    expect(r.calls.instructionWrites).toHaveLength(0);
  });

  it("a later non-reconnect event during the reconnect read still owes a follow-up read", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    r.holdNextRead();
    const first = r.operation({ type: "reconnected" });
    await flushAsyncWork();
    const second = r.operation({ type: "revision", batchItemId: "a" });
    const third = r.operation({ type: "reconnected" });
    r.release(r.db);
    await Promise.all([first, second, third]);
    await flushAsyncWork();
    expect(r.calls.reads).toBe(3);
  });

  it("is ignored after the drawer closes", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    const close = buttons(r.dialog()).find((b) => b.getAttribute("aria-label") === t("en", "drawerClose"));
    await close.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    const reads = r.calls.reads;
    await r.operation({ type: "reconnected" });
    expect(r.calls.reads).toBe(reads);
  });
});
