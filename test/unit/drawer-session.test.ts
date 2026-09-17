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
import { builtinImageInstruction, generationDisplayStage, generationMark, generationStage, itemPresentation, platformStage, sourceImageReferences } from "../../src/model.js";
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
    itemId: `src_${id}`,
    title: null,
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

function rig(options: { items?: AnyRec[]; stage?: (target: AnyRec, calls: AnyRec) => AnyRec; takenSourceIds?: string[] } = {}) {
  installMinimalDom();
  const db: AnyRec = { id: "b", items: options.items ?? [post()] };
  const calls: AnyRec = { reads: 0, requests: [], instructionWrites: [], revisionWrites: [], submits: [], sequence: [], guards: 0, stagesCreated: 0, stagesDisposed: 0, announced: [] };
  const responses: AnyRec = { requestGeneration: [], saveInstructionOverrides: null };
  const held: Array<(value: AnyRec) => void> = [];
  let holdReads = 0;
  const scope: AnyRec = {
    ...dom, ...drawers, t, createInboxState, isEditableItem, setInboxSummaries, itemPresentation, generationDisplayStage, generationMark, generationStage, platformStage, setNotice, builtinImageInstruction, sourceImageReferences,
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
    // REQ-017's pair check, mirrored client-side for the source picker — the
    // rig reports only what the test marks taken.
    takenSourceIds: () => new Set(options.takenSourceIds ?? []),
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
    },
    // The selector's three mutations — the fake DB answers like the real one:
    // rename rewrites the row, remove drops it from the projection, add makes
    // a new item for the picked source.
    renameBatchItem: async (input: AnyRec) => {
      calls.renames = (calls.renames ?? []).concat(input);
      const row = db.items.find((item: AnyRec) => item.id === input.batchItemId);
      if (!row) return { ok: false, code: "post_not_found" };
      row.title = input.title || null;
      return { ok: true, batchItemId: input.batchItemId, title: row.title };
    },
    removeBatchItem: async (input: AnyRec) => {
      calls.removes = (calls.removes ?? []).concat(input);
      if (db.items.length <= 1) return { ok: false, code: "last_post" };
      db.items = db.items.filter((item: AnyRec) => item.id !== input.batchItemId);
      return { ok: true, batchItemId: input.batchItemId };
    },
    addBatchItem: async (input: AnyRec) => {
      calls.adds = (calls.adds ?? []).concat(input);
      if (db.items.some((item: AnyRec) => item.itemId === input.itemId)) return { ok: false, code: "already_in_batch" };
      const source = (responses.sources ?? []).find((entry: AnyRec) => entry.id === input.itemId);
      const added = post(`x${db.items.length}`, { itemId: input.itemId, sourceItem: source ? { id: source.id, text: source.text ?? "", media: [] } : { id: input.itemId, text: "", media: [] } });
      db.items.push(added);
      return { ok: true, item: structuredClone(added) };
    },
    listItems: async () => {
      calls.sourceLists = (calls.sourceLists ?? 0) + 1;
      return { items: responses.sources ?? [] };
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
/** A menu row's textContent is its lead + sub; match on the lead. */
const menuButton = (root: unknown, lead: string) =>
  buttons(root).find((b) => String(b.textContent ?? "").startsWith(lead));
async function click(root: unknown, label: string) {
  await findButton(root, label).dispatchEvent({ type: "click" });
  await flushAsyncWork();
}
/**
 * The regenerate conversation end to end: hover Regenerate, name the
 * correction (a chip), press Generate. Returns the dispatch promise, which
 * stays pending while a decision dialog waits inside the request.
 */
async function startRegen(r: AnyRec, chip = "drawerRegenC1") {
  await click(r.dialog(), t("en", "drawerHoverRegen"));
  await click(r.dialog(), t("en", chip));
  return press(r.dialog(), t("en", "drawerRegenGo"));
}
/** Opens the add-image menu: the quiet ＋ Add image link once a picture
 *  exists, or the dashed add-place tile while the slot is still empty. */
async function openAddMenu(r: AnyRec) {
  const trigger = buttons(r.dialog()).find((b) =>
    String(b.className ?? "").split(" ").some((c) => c === "sl-addquiet" || c === "sl-addplace" || c === "sl-addslot"));
  if (!trigger) throw new Error("Add-image trigger missing in: " + labels(r.dialog()).join(" | "));
  await trigger.dispatchEvent({ type: "click" });
  await flushAsyncWork();
}
/** The ＋ menu's Generate row: a bare press sends the staged brief, no run layer. */
async function pressGenerate(r: AnyRec) {
  await openAddMenu(r);
  const item = menuButton(r.dialog(), t("en", "drawerAddGenerate"));
  if (!item) throw new Error("Generate menu item missing");
  const done = item.dispatchEvent({ type: "click" });
  await flushAsyncWork();
  return done;
}
/** Presses a button whose handler waits on a decision dialog; returns its settled promise. */
async function press(root: unknown, label: string) {
  const done = findButton(root, label).dispatchEvent({ type: "click" });
  await flushAsyncWork();
  return done;
}
const byId = (root: unknown, id: string) => findAll(root as never, (e: any) => e.getAttribute("id") === id || e.id === id)[0] as any;
const tab = (root: unknown, key: string) => byId(root, `sl-drawer-tab-${key}`);
/** Switches posts through the selector: open it if closed, pick the post's row (0-based). */
async function switchPost(r: AnyRec, index: number) {
  const btn = buttons(r.dialog()).find((b) => String(b.className ?? "").split(" ").includes("sl-postbtn"));
  if (!btn) throw new Error("Post selector missing in: " + labels(r.dialog()).join(" | "));
  if (btn.getAttribute("aria-expanded") !== "true") {
    await btn.dispatchEvent({ type: "click" });
    await flushAsyncWork();
  }
  const rows = findAll(r.dialog() as never, (e: any) => {
    const cls = String(e.className ?? "").split(" ");
    return cls.includes("sl-pm-row") && !cls.includes("sl-pm-add") && !cls.includes("sl-pm-back");
  }) as any[];
  if (!rows[index]) throw new Error(`Post row ${index} missing in: ` + labels(r.dialog()).join(" | "));
  await rows[index].dispatchEvent({ type: "click" });
  await flushAsyncWork();
}
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
    await switchPost(r, 1);
    r.db.items[0].caption = "FRESH";
    r.release({ id: "b", items: [post("a", { caption: "STALE" }), post("b", { caption: "Second post caption" })] });
    await pending;
    await flushAsyncWork();
    // The stale answer was dropped and one follow-up read replaced it.
    expect(r.calls.reads).toBe(3);
    expect(captionField(r).value).toBe("Second post caption");
    await switchPost(r, 0);
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
  it("asks before Generate uses stale instructions, and sends nothing yet", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = await pressGenerate(r);
    expect(labels(r.scope.leaveDialog)).toEqual(["Cancel", "Generate with saved instructions", "Save instructions and generate"]);
    expect(r.calls.requests).toHaveLength(0);
    expect(r.calls.instructionWrites).toHaveLength(0);
  });

  it("saves the instructions, then sends exactly one request", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = await pressGenerate(r);
    await click(r.scope.leaveDialog, "Save instructions and generate");
    await done;
    await flushAsyncWork();
    expect(r.calls.sequence).toEqual(["instructions", "request"]);
    expect(r.calls.instructionWrites).toEqual([{ batchItemId: "a", image: "Morning light, outdoors" }]);
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, image: { references: "source", aspectRatio: "4:5" } }]]);
    expect(findButton(r.dialog(), t("en", "drawerSaveDraft")).disabled).toBe(true);
  });

  it("keeps the edits and requests nothing when saving the instructions fails", async () => {
    const r = rig();
    r.responses.saveInstructionOverrides = { ok: false, code: "invalid_argument", message: "Instructions are too long." };
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = await pressGenerate(r);
    await click(r.scope.leaveDialog, "Save instructions and generate");
    await done;
    await flushAsyncWork();
    expect(r.calls.requests).toHaveLength(0);
    expect(r.calls.announced).toContain("Instructions are too long.");
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    expect(byId(r.dialog(), "sl-instructions-image").value).toBe("Morning light, outdoors");
  });

  it("does nothing on Cancel", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = await pressGenerate(r);
    await click(r.scope.leaveDialog, "Cancel");
    await done;
    await flushAsyncWork();
    expect(r.calls.requests).toHaveLength(0);
    expect(r.calls.instructionWrites).toHaveLength(0);
    expect(findButton(r.dialog(), t("en", "drawerSaveDraft")).disabled).toBe(false);
  });

  it("generates with the saved instructions only when chosen, keeping the edits unsaved", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await editImageInstructions(r, "Morning light, outdoors");
    const done = await pressGenerate(r);
    await click(r.scope.leaveDialog, "Generate with saved instructions");
    await done;
    await flushAsyncWork();
    expect(r.calls.instructionWrites).toHaveLength(0);
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, image: { references: "source", aspectRatio: "4:5" } }]]);
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
    const done = await pressGenerate(r);
    await click(r.scope.leaveDialog, "Save instructions and generate");
    await done;
    await flushAsyncWork();
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
    await pressGenerate(r);
    await flushAsyncWork();
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, image: { references: "source", aspectRatio: "4:5" } }]]);
  });
});

// ---------------------------------------------------------------------------
// Serialized generation: a pending request is replaced only on explicit confirm
// ---------------------------------------------------------------------------

describe("one outstanding request per post", () => {
  it("asks before replacing a pending caption request, and sends replace:true only when confirmed", async () => {
    const r = rig({ items: [post("a", { generation: pendingMark({ caption: true }) })] });
    await r.open({ id: "b", itemId: "a" });
    await openAddMenu(r);
    const generate = menuButton(r.dialog(), t("en", "drawerAddGenerate"));
    // The pending honesty moved to the menu row: it names the other part.
    expect(generate.getAttribute("title")).toContain("A caption request is still pending for this post.");
    const done = generate.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    expect(labels(r.scope.leaveDialog)).toContain("Replace the pending caption request");
    expect(r.calls.requests).toHaveLength(0);
    await click(r.scope.leaveDialog, "Replace the pending caption request");
    await done;
    await flushAsyncWork();
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, image: { references: "source", aspectRatio: "4:5" }, replace: true }]]);
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
    await openAddMenu(r);
    const generate = menuButton(r.dialog(), t("en", "drawerAddGenerate"));
    // The outstanding ask marks the row but never disables it — the press still asks first.
    expect(generate.disabled).not.toBe(true);
    const done = generate.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    await click(r.scope.leaveDialog, "Replace the pending image request");
    await done;
    await flushAsyncWork();
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, image: { references: "source", aspectRatio: "4:5" }, replace: true }]]);
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
    await switchPost(r, 1);
    await type(captionField(r), "Second post edit");
    await saves.release();
    await saving;
    await flushAsyncWork();
    expect(r.db.items.map((item: AnyRec) => item.caption)).toEqual(["Caption A", "Second post caption"]);
    expect(captionField(r).value).toBe("Second post edit");
    expect(saveButton(r).disabled).toBe(false);
    await switchPost(r, 0);
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

// ---------------------------------------------------------------------------
// The image brief — what a Generate press asks for
// ---------------------------------------------------------------------------

// The brief lives on the Instructions tab — the settings a Generate ask is
// made under, beside the instructions it amends.
const briefBlock = (root: unknown) => findAll(root as never, (e: any) => e.classList?.contains("sl-brieftab"))[0] as any;
const briefSwitch = (root: unknown) => findAll(root as never, (e: any) => e.tagName === "INPUT" && e.parentNode?.classList?.contains("sl-brief-switch"))[0] as any;
const briefOnceArea = (root: unknown) => findAll(root as never, (e: any) => e.classList?.contains("sl-brief-once"))[0] as any;
const briefSave = (root: unknown) => findAll(root as never, (e: any) => e.tagName === "INPUT" && e.parentNode?.classList?.contains("sl-brief-save"))[0] as any;

describe("the image brief on the Instructions tab", () => {
  it("carries the generation settings, and warns when no usable reference exists", async () => {
    // The fixture's media entries carry ids but no fetchable https URL — the
    // same reading the server makes, so the warning must show.
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    const block = briefBlock(r.dialog());
    expect(block).toBeTruthy();
    expect(findAll(block, (e: any) => e.classList?.contains("sl-brief-warn"))).toHaveLength(1);
    expect(briefSwitch(r.dialog()).checked).toBe(true);
  });

  it("sends references:none when the owner switches the source image off", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    briefSwitch(r.dialog()).checked = false;
    await briefSwitch(r.dialog()).dispatchEvent({ type: "change" });
    await click(r.dialog(), t("en", "drawerTabOutput"));
    await pressGenerate(r);
    await flushAsyncWork();
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true }, image: { references: "none", aspectRatio: "4:5" } }]]);
  });

  it("sends the picked ratio and an unsaved one-off as the run layer, then clears it", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await click(r.dialog(), t("en", "drawerRatioStory"));
    await click(r.dialog(), t("en", "drawerBriefOnceOpen"));
    const area = briefOnceArea(r.dialog());
    area.value = "Bottle facing the camera";
    await area.dispatchEvent({ type: "input" });
    await click(r.dialog(), t("en", "drawerTabOutput"));
    await pressGenerate(r);
    await flushAsyncWork();
    expect(r.calls.instructionWrites).toHaveLength(0);
    expect(r.calls.requests).toEqual([["b", ["a"], {
      needs: { image: true },
      image: { references: "source", aspectRatio: "9:16" },
      instructions: { image: "Bottle facing the camera" }
    }]]);
    // The consumed one-off does not silently ride the next ask.
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    expect(briefOnceArea(r.dialog())?.value ?? "").toBe("");
  });

  it("saves the one-off as the post instruction first when the box is checked", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await click(r.dialog(), t("en", "drawerBriefOnceOpen"));
    const area = briefOnceArea(r.dialog());
    area.value = "Bottle facing the camera";
    await area.dispatchEvent({ type: "input" });
    briefSave(r.dialog()).checked = true;
    await briefSave(r.dialog()).dispatchEvent({ type: "change" });
    await click(r.dialog(), t("en", "drawerTabOutput"));
    await pressGenerate(r);
    await flushAsyncWork();
    // The instruction write precedes the request, and the request carries no
    // run layer — what was saved is what runs.
    expect(r.calls.sequence.slice(0, 2)).toEqual(["instructions", "request"]);
    expect(r.calls.instructionWrites).toEqual([{ batchItemId: "a", image: "Bottle facing the camera" }]);
    expect(r.calls.requests).toEqual([["b", ["a"], {
      needs: { image: true },
      image: { references: "source", aspectRatio: "4:5" }
    }]]);
  });

  it("sends the regenerate conversation's correction as the run layer", async () => {
    const r = rig();
    await r.open({ id: "b", itemId: "a" });
    const done = await startRegen(r); // "Too dark" chip, then Generate
    await done;
    await flushAsyncWork();
    expect(r.calls.instructionWrites).toHaveLength(0);
    expect(r.calls.requests).toEqual([["b", ["a"], {
      needs: { image: true },
      image: { references: "source", aspectRatio: "4:5" },
      instructions: { image: "Too dark" }
    }]]);
  });

  it("announces the translated refusal when the server reports reference_unavailable", async () => {
    const r = rig();
    r.responses.requestGeneration = [{ ok: false, code: "reference_unavailable", message: "raw server wording" }];
    await r.open({ id: "b", itemId: "a" });
    await pressGenerate(r);
    await flushAsyncWork();
    expect(r.calls.announced).toContain(t("en", "drawerRefUnavailable"));
    expect(r.calls.announced).not.toContain("raw server wording");
  });
});

// ---------------------------------------------------------------------------
// The post selector and the post's own name (schema 19: batch_items.title)
// ---------------------------------------------------------------------------

describe("the post selector and title", () => {
  /** The selector button says the position once; the menu names every post. */
  it("names each post with its state, and switches on a row", async () => {
    const r = rig({ items: [
      post("a", { title: "週末特輯" }),
      post("b", { caption: "Second post caption", generation: pendingMark({ caption: true }) })
    ] });
    await r.open({ id: "b", itemId: "a" });
    // The button carries the position; the eyebrow does not.
    expect(findButton(r.dialog(), "Post 1 of 2 ▾")).toBeTruthy();
    const meta = findAll(r.dialog() as never, (e: any) => String(e.className ?? "").includes("sl-drawer-meta"))[0];
    expect(String(meta.textContent)).not.toContain("Post 1");

    await click(r.dialog(), "Post 1 of 2 ▾");
    const menu = findAll(r.dialog() as never, (e: any) => String(e.className ?? "").split(" ").includes("sl-postmenu"))[0];
    expect(menu).toBeTruthy();
    // Named rows: the stored title and the derived source head, with states.
    expect(String(menu.textContent)).toContain("週末特輯");
    expect(String(menu.textContent)).toContain("Reference text");
    expect(String(menu.textContent)).toContain("Draft");
    expect(String(menu.textContent)).toContain("Generating");
    expect(String(menu.textContent)).toContain("Add a post from Sources");

    // The row switches the drawer — same contract the old pills had.
    await switchPost(r, 1);
    expect(captionField(r).value).toBe("Second post caption");
    expect(findButton(r.dialog(), "Post 2 of 2 ▾")).toBeTruthy();
  });

  it("commits the title on blur, trims it, and announces the save", async () => {
    const r = rig({ items: [post("a")] });
    await r.open({ id: "b", itemId: "a" });
    const field = byId(r.dialog(), "sl-drawer-title");
    expect(field).toBeTruthy();
    expect(field.getAttribute("aria-label")).toBe(t("en", "drawerTitleAria"));
    await field.dispatchEvent({ type: "focus" });
    field.value = "  Weekend tray  ";
    await field.dispatchEvent({ type: "blur" });
    await flushAsyncWork();
    expect(r.calls.renames).toEqual([{ batchItemId: "a", title: "Weekend tray" }]);
    expect(r.calls.announced).toContain(t("en", "drawerTitleSaved"));
    expect(r.db.items[0].title).toBe("Weekend tray");
  });

  it("Escape restores the pre-edit value and sends nothing", async () => {
    const r = rig({ items: [post("a", { title: "Kept name" })] });
    await r.open({ id: "b", itemId: "a" });
    const field = byId(r.dialog(), "sl-drawer-title");
    expect(field.value).toBe("Kept name");
    await field.dispatchEvent({ type: "focus" });
    field.value = "Typed over";
    await field.dispatchEvent({ type: "keydown", key: "Escape", preventDefault: () => {} });
    await flushAsyncWork();
    expect(field.value).toBe("Kept name");
    expect(r.calls.renames ?? []).toHaveLength(0);
  });

  it("an unchanged blur sends nothing", async () => {
    const r = rig({ items: [post("a", { title: "Same" })] });
    await r.open({ id: "b", itemId: "a" });
    const field = byId(r.dialog(), "sl-drawer-title");
    await field.dispatchEvent({ type: "focus" });
    await field.dispatchEvent({ type: "blur" });
    await flushAsyncWork();
    expect(r.calls.renames ?? []).toHaveLength(0);
  });

  it("the title is read-only on a submitted post", async () => {
    const r = rig({ items: [post("a", {
      title: "Sent one",
      state: "submitted",
      publications: [{ id: "pub_1", destinationBinding: "FB_MAIN", state: "review_requested" }]
    })] });
    await r.open({ id: "b", itemId: "a" });
    const field = byId(r.dialog(), "sl-drawer-title");
    expect(field.value).toBe("Sent one");
    expect(field.readOnly).toBe(true);
  });

  it("removes a post after an in-place confirm that names it", async () => {
    const r = rig({ items: [post("a", { title: "First post" }), post("b", { title: "Second post" })] });
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), "Post 1 of 2 ▾");
    // The ✕ lives on the row it removes.
    const xs = findAll(r.dialog() as never, (e: any) => String(e.className ?? "").split(" ").includes("sl-rowx")) as any[];
    expect(xs).toHaveLength(2);
    await xs[0].dispatchEvent({ type: "click" });
    await flushAsyncWork();
    // The question replaces the row and keeps the post's name.
    expect(String(r.dialog().textContent)).toContain('Remove “First post”?');
    await click(r.dialog(), t("en", "drawerHoverRemove"));
    await flushAsyncWork();
    expect(r.calls.removes).toEqual([{ batchItemId: "a" }]);
    expect(r.calls.announced).toContain(t("en", "drawerRemovedPost"));
    expect(r.db.items.map((item: AnyRec) => item.id)).toEqual(["b"]);
    // The drawer now sits on the surviving post.
    expect(captionField(r).value).toBe("Saved caption");
    expect(findButton(r.dialog(), "Post 1 of 1 ▾")).toBeTruthy();
  });

  it("Cancel keeps the post and re-asks cleanly", async () => {
    const r = rig({ items: [post("a"), post("b")] });
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), "Post 1 of 2 ▾");
    const xs = findAll(r.dialog() as never, (e: any) => String(e.className ?? "").split(" ").includes("sl-rowx")) as any[];
    await xs[1].dispatchEvent({ type: "click" });
    await flushAsyncWork();
    await click(r.dialog(), "Cancel");
    await flushAsyncWork();
    expect(r.calls.removes ?? []).toHaveLength(0);
    expect(String(r.dialog().textContent)).not.toContain("Remove “");
    // Both rows are back.
    const rows = findAll(r.dialog() as never, (e: any) => String(e.className ?? "").split(" ").includes("sl-pm-row")) as any[];
    expect(rows.length).toBeGreaterThanOrEqual(3); // two posts + the add row
  });

  it("the last post's ✕ is disabled and named", async () => {
    const r = rig({ items: [post("a")] });
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), "Post 1 of 1 ▾");
    const xs = findAll(r.dialog() as never, (e: any) => String(e.className ?? "").split(" ").includes("sl-rowx")) as any[];
    expect(xs).toHaveLength(1);
    expect(xs[0].disabled).toBe(true);
    expect(xs[0].getAttribute("title")).toBe(t("en", "drawerRemovePostLast"));
  });

  it("adds a source post through the picker and lands on it", async () => {
    const r = rig({ items: [post("a")], takenSourceIds: ["src_taken"] });
    r.responses.sources = [
      { id: "src_a", text: "Already in the batch" },
      { id: "src_new", text: "A fresh source post", authorHandle: "brandhk" },
      { id: "src_taken", text: "Drafted elsewhere" }
    ];
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), "Post 1 of 1 ▾");
    // The add row opens the source list inside the same menu.
    const addRow = buttons(r.dialog()).find((b) => String(b.className ?? "").split(" ").includes("sl-pm-add"));
    await addRow.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    expect(r.calls.sourceLists).toBe(1);
    const text = String(r.dialog().textContent);
    expect(text).toContain("A fresh source post");
    expect(text).toContain("@brandhk");
    expect(text).toContain(t("en", "drawerSourceInBatch"));
    // src_a is already in this batch → disabled, with the reason beside it.
    const inBatchRow = buttons(r.dialog()).find((b) => String(b.textContent).includes("Already in the batch"));
    expect(inBatchRow.disabled).toBe(true);
    const takenRow = buttons(r.dialog()).find((b) => String(b.textContent).includes("Drafted elsewhere"));
    expect(takenRow.disabled).toBe(true);
    expect(text).toContain(t("en", "drawerSourceHasDraft"));
    // Picking the fresh source sends addBatchItem and selects the new post.
    await click(r.dialog(), `A fresh source post@brandhk`);
    await flushAsyncWork();
    expect(r.calls.adds).toEqual([{ batchId: "b", itemId: "src_new" }]);
    expect(findButton(r.dialog(), "Post 2 of 2 ▾")).toBeTruthy();
  });
});
