// F01: every save that continues into something else — Review, Save and
// leave, Save instructions and generate — keeps edits typed while it was in
// flight, and does not navigate past them.
//
// Runs the UNCHANGED `openBatchDrawer` body from client.js with the actual
// drawer renderers, through the same extracted harness drawer-session.test.ts
// uses (its `rig` is taken from that file's source so the two cannot drift).
// Minimal DOM: not a browser proof of focus, layout or modal behaviour.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";
import * as dom from "../../src/src/client/dom.js";
import * as drawers from "../../src/src/client/drawer.js";
import { t } from "../../src/src/client/i18n.js";
import * as inbox from "../../src/src/client/inbox.js";
import { setNotice } from "../../src/src/client/collection.js";
import { createMediaStage } from "../../src/src/client/preview-media.js";
import { generationMark, generationStage, itemPresentation } from "../../src/model.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom";

type AnyRec = Record<string, any>;

const source = readFileSync(new URL("../../src/src/client/client.js", import.meta.url), "utf8");
const harness = readFileSync(new URL("./drawer-session.test.ts", import.meta.url), "utf8");
const start = harness.indexOf("function extract(");
const end = harness.indexOf("\nconst buttons =", start);
if (start < 0 || end < 0) throw new Error("drawer-session.test.ts harness boundaries moved");
const { rig, post } = new Function(
  "deps",
  `with(deps){${stripTypeScriptTypes(harness.slice(start, end))};return {rig, post};}`
)({ source, dom, drawers, t, ...inbox, setNotice, createMediaStage, generationMark, generationStage, itemPresentation, findAll, flushAsyncWork, installMinimalDom, recordDispatch: async () => {} }) as {
  rig: (options?: AnyRec) => AnyRec;
  post: (id?: string, overrides?: AnyRec) => AnyRec;
};

const byId = (root: unknown, id: string) => findAll(root as never, (e: any) => e.getAttribute("id") === id)[0] as any;
const buttons = (root: unknown) => findAll(root as never, (e: any) => e.tagName === "BUTTON") as any[];
function findButton(root: unknown, label: string) {
  const found = buttons(root).find((b) => b.textContent === label);
  if (!found) throw new Error(`Missing button "${label}"`);
  return found;
}
async function click(root: unknown, label: string) {
  await findButton(root, label).dispatchEvent({ type: "click" });
  await flushAsyncWork();
}
/** Starts a click whose handler waits; returns the handler's promise wrapped. */
async function start_(root: unknown, label: string) {
  const done = findButton(root, label).dispatchEvent({ type: "click" });
  await flushAsyncWork();
  return { done };
}
async function type(field: any, value: string) {
  field.value = value;
  await field.dispatchEvent({ type: "input" });
}
const caption = (r: AnyRec) => byId(r.dialog(), "sl-drawer-caption-input");
const alt = (r: AnyRec) => byId(r.dialog(), "sl-drawer-alt-text");
const saveButton = (r: AnyRec) => findButton(r.dialog(), t("en", "drawerSaveDraft"));
const REVIEW = t("en", "drawerReviewPost");

/** Holds each save RPC until released; a released save persists exactly what it was sent. */
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

/** The unsaved-changes decision answers from a queue; an exhausted queue keeps editing. */
function decisions(r: AnyRec, ...answers: string[]) {
  const asked: string[] = [];
  r.scope.confirmUnsavedNavigation = async () => {
    const answer = answers.shift() ?? "keep";
    asked.push(answer);
    return answer;
  };
  return asked;
}

const reviewed = (r: AnyRec) => r.scope.wizard.batch?.items?.[0] ?? null;

describe("F01 control: ordinary Save", () => {
  it("saves A, keeps B visible and dirty, and a second Save persists B", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    const { done } = await start_(r.dialog(), t("en", "drawerSaveDraft"));
    await type(caption(r), "Caption B");
    await saves.release();
    await done;
    expect(r.db.items[0].caption).toBe("Caption A");
    expect(caption(r).value).toBe("Caption B");
    expect(saveButton(r).disabled).toBe(false);
    const second = await start_(r.dialog(), t("en", "drawerSaveDraft"));
    await saves.release();
    await second.done;
    expect(r.db.items[0].caption).toBe("Caption B");
  });
});

describe("F01: Review", () => {
  it("caption: an edit typed during Review's save stops Review; the next Review saves and reviews B", async () => {
    const r = rig();
    const saves = gateSaves(r);
    const asked = decisions(r); // keep editing when asked about B
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    const { done } = await start_(r.dialog(), REVIEW);
    await type(caption(r), "Caption B");
    await saves.release();
    await done;
    expect(r.calls.revisionWrites[0].revisions[0].caption).toBe("Caption A");
    expect(r.db.items[0].caption).toBe("Caption A");
    expect(r.dialog().open).toBe(true);
    expect(reviewed(r)).toBeNull();
    expect(caption(r).value).toBe("Caption B");
    expect(saveButton(r).disabled).toBe(false);
    expect(asked).toEqual(["keep"]);

    const again = await start_(r.dialog(), REVIEW);
    await saves.release();
    await again.done;
    await flushAsyncWork();
    expect(r.db.items[0].caption).toBe("Caption B");
    expect(r.dialog().open).toBe(false);
    expect(reviewed(r)).toMatchObject({ caption: "Caption B", revision: 3 });
  });

  it("answering Save for the newer edit saves it and reviews the acknowledged revision", async () => {
    const r = rig();
    const saves = gateSaves(r);
    const asked = decisions(r, "save");
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    const { done } = await start_(r.dialog(), REVIEW);
    await type(caption(r), "Caption B");
    await saves.release(); // A acknowledged; B asked about and its save starts
    expect(asked).toEqual(["save"]);
    expect(r.dialog().open).toBe(true);
    await saves.release();
    await done;
    await flushAsyncWork();
    expect(r.calls.revisionWrites.map((w: AnyRec) => w.revisions[0].caption)).toEqual(["Caption A", "Caption B"]);
    expect(r.dialog().open).toBe(false);
    expect(reviewed(r)).toMatchObject({ caption: "Caption B", revision: 3 });
  });

  it("alt text: B typed during Review's save is kept dirty and Review does not proceed", async () => {
    const r = rig();
    const saves = gateSaves(r);
    decisions(r);
    await r.open({ id: "b", itemId: "a" });
    await type(alt(r), "Alt A");
    const { done } = await start_(r.dialog(), REVIEW);
    await type(alt(r), "Alt B");
    await saves.release();
    await done;
    expect(r.db.items[0].altText).toBe("Alt A");
    expect(alt(r).value).toBe("Alt B");
    expect(r.dialog().open).toBe(true);
    expect(reviewed(r)).toBeNull();
    const again = await start_(r.dialog(), REVIEW);
    await saves.release();
    await again.done;
    await flushAsyncWork();
    expect(r.db.items[0].altText).toBe("Alt B");
    expect(reviewed(r)).toMatchObject({ altText: "Alt B" });
  });

  it("staged image: a different image staged during Review's save stays staged and Review does not proceed", async () => {
    const r = rig({
      items: [post("a", {
        generatedCandidate: { id: "gm_cand", ready: true, mimeType: "image/jpeg", status: "candidate" },
        generatedHistory: [{ id: "gm_old", ready: true, status: "superseded", createdAt: "2026-09-13T03:00:00.000Z" }]
      })]
    });
    const saves = gateSaves(r);
    decisions(r);
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerUseCandidate"));
    const { done } = await start_(r.dialog(), REVIEW);
    await click(r.dialog(), t("en", "drawerTabHistory"));
    await click(r.dialog(), t("en", "drawerHistoryUseImage"));
    await saves.release();
    await done;
    expect(r.calls.revisionWrites[0].revisions[0].acceptedGeneratedMediaId).toBe("gm_cand");
    expect(r.db.items[0].generatedImage.id).toBe("gm_cand");
    expect(r.dialog().open).toBe(true);
    expect(reviewed(r)).toBeNull();
    expect(saveButton(r).disabled).toBe(false);
    const again = await start_(r.dialog(), REVIEW);
    expect(r.calls.revisionWrites[1].revisions[0].acceptedGeneratedMediaId).toBe("gm_old");
    await saves.release();
    await again.done;
    await flushAsyncWork();
    expect(reviewed(r)?.generatedImage?.id).toBe("gm_old");
  });

  it("an edit typed during Review's post-save read also stops Review before the drawer is disposed", async () => {
    const r = rig();
    decisions(r);
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    r.holdNextRead(); // the save's own refetch
    r.holdNextRead(); // Review's first read of the acknowledged revision
    const { done } = await start_(r.dialog(), REVIEW);
    r.release(r.db);
    await flushAsyncWork();
    await type(caption(r), "Caption B");
    r.release(r.db);
    await done;
    await flushAsyncWork();
    expect(r.calls.revisionWrites[0].revisions[0].caption).toBe("Caption A");
    expect(r.dialog().open).toBe(true);
    expect(reviewed(r)).toBeNull();
    expect(caption(r).value).toBe("Caption B");
  });

  it("a refused save does not navigate and keeps every buffer", async () => {
    const r = rig();
    const saves = gateSaves(r);
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    await type(alt(r), "Alt A");
    const { done } = await start_(r.dialog(), REVIEW);
    await type(caption(r), "Caption B");
    await saves.fail();
    await done;
    expect(r.calls.announced).toContain("Revision conflict.");
    expect(r.dialog().open).toBe(true);
    expect(reviewed(r)).toBeNull();
    expect(caption(r).value).toBe("Caption B");
    expect(alt(r).value).toBe("Alt A");
    expect(r.db.items[0].caption).toBe("Saved caption");
  });
});

describe("F01: Save and leave (Close's unsaved-changes decision)", () => {
  it("caption, alt text and staged image typed during the save are asked about again, never discarded", async () => {
    const r = rig({
      items: [post("a", {
        generatedCandidate: { id: "gm_cand", ready: true, mimeType: "image/jpeg", status: "candidate" },
        generatedHistory: [{ id: "gm_old", ready: true, status: "superseded", createdAt: "2026-09-13T03:00:00.000Z" }]
      })]
    });
    const saves = gateSaves(r);
    const asked = decisions(r, "save"); // then keep editing
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    await type(alt(r), "Alt A");
    await click(r.dialog(), t("en", "drawerUseCandidate"));
    const closing = r.scope.drawerSession.requestClose();
    await flushAsyncWork();
    await type(caption(r), "Caption B");
    await type(alt(r), "Alt B");
    await click(r.dialog(), t("en", "drawerTabHistory"));
    await click(r.dialog(), t("en", "drawerHistoryUseImage"));
    await saves.release();
    await closing;
    await flushAsyncWork();
    expect(asked).toEqual(["save", "keep"]);
    expect(r.dialog().open).toBe(true);
    expect(r.db.items[0]).toMatchObject({ caption: "Caption A", altText: "Alt A" });
    expect(r.db.items[0].generatedImage.id).toBe("gm_cand");
    expect(saveButton(r).disabled).toBe(false);
    await click(r.dialog(), t("en", "drawerTabOutput"));
    expect(caption(r).value).toBe("Caption B");
    expect(alt(r).value).toBe("Alt B");

    decisions(r, "save");
    const second = r.scope.drawerSession.requestClose();
    await flushAsyncWork();
    expect(r.calls.revisionWrites[1].revisions[0]).toMatchObject({ caption: "Caption B", altText: "Alt B", acceptedGeneratedMediaId: "gm_old" });
    await saves.release();
    await second;
    await flushAsyncWork();
    expect(r.db.items[0]).toMatchObject({ caption: "Caption B", altText: "Alt B" });
    expect(r.db.items[0].generatedImage.id).toBe("gm_old");
    expect(r.dialog().open).toBe(false);
  });

  it("a refused save does not close and keeps the buffers", async () => {
    const r = rig();
    const saves = gateSaves(r);
    decisions(r, "save");
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    const closing = r.scope.drawerSession.requestClose();
    await flushAsyncWork();
    await saves.fail();
    await closing;
    expect(r.dialog().open).toBe(true);
    expect(caption(r).value).toBe("Caption A");
    expect(saveButton(r).disabled).toBe(false);
  });

  it("a save completing after its drawer was replaced does nothing to the new drawer", async () => {
    const r = rig();
    const saves = gateSaves(r);
    const asked = decisions(r, "save", "save");
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    const closing = r.scope.drawerSession.requestClose();
    await flushAsyncWork();
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Newer drawer edit");
    await saves.release();
    await closing;
    await flushAsyncWork();
    expect(asked).toEqual(["save"]);
    expect(r.dialog().open).toBe(true);
    expect(caption(r).value).toBe("Newer drawer edit");
    expect(saveButton(r).disabled).toBe(false);
    expect(r.calls.revisionWrites).toHaveLength(1);
  });
});

describe("F01: Save instructions and generate", () => {
  it("generates on the acknowledged instructions A; B typed during the save stays visible and dirty", async () => {
    const r = rig();
    const saves = gateSaves(r);
    const requested = r.scope.rpc.requestGeneration;
    const savedAtRequest: AnyRec[] = [];
    r.scope.rpc.requestGeneration = async (...args: unknown[]) => {
      savedAtRequest.push({ ...r.db.items[0].instructionOverrides });
      return requested(...args);
    };
    await r.open({ id: "b", itemId: "a" });
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await type(byId(r.dialog(), "sl-instructions-image"), "Image A");
    await click(r.dialog(), t("en", "drawerTabOutput"));
    const { done } = await start_(r.dialog(), t("en", "drawerRegenerateImage"));
    await click(r.scope.leaveDialog, "Save instructions and generate");
    await click(r.dialog(), t("en", "drawerTabInstructions"));
    await type(byId(r.dialog(), "sl-instructions-image"), "Image B");
    await saves.release();
    await done;
    await flushAsyncWork();
    expect(r.calls.instructionWrites).toEqual([{ batchItemId: "a", image: "Image A" }]);
    expect(savedAtRequest).toEqual([{ image: "Image A", caption: null }]);
    expect(r.calls.requests).toEqual([["b", ["a"], { needs: { image: true } }]]);
    expect(byId(r.dialog(), "sl-instructions-image").value).toBe("Image B");
    expect(saveButton(r).disabled).toBe(false);

    const second = await start_(r.dialog(), t("en", "drawerSaveDraft"));
    await saves.release();
    await second.done;
    expect(r.db.items[0].instructionOverrides).toEqual({ image: "Image B", caption: null });
    expect(saveButton(r).disabled).toBe(true);
  });

  it("caption: a caption typed while Rewrite caption's chosen save was in flight is asked about again", async () => {
    const r = rig();
    const saves = gateSaves(r);
    const asked = decisions(r, "save"); // then keep editing
    await r.open({ id: "b", itemId: "a" });
    await type(caption(r), "Caption A");
    const { done } = await start_(r.dialog(), t("en", "drawerRewriteCaption"));
    await type(caption(r), "Caption B");
    await saves.release();
    await done;
    await flushAsyncWork();
    expect(asked).toEqual(["save", "keep"]);
    expect(r.db.items[0].caption).toBe("Caption A");
    expect(r.calls.requests).toHaveLength(0);
    expect(caption(r).value).toBe("Caption B");
    expect(saveButton(r).disabled).toBe(false);
  });
});
