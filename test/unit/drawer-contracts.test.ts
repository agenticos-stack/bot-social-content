// Remaining drawer/Content UX contracts: editable alt text, provenance
// re-acceptance, instruction snapshots and legacy wording, History receipts,
// last-checked time and asset status, and Content output thumbnails.
// Minimal-DOM fixture coverage shaped like the server projection — not a
// browser proof.
import { beforeEach, describe, expect, it } from "vitest";
import {
  dirtyParts,
  footerState,
  renderHistoryPanel,
  renderInstructionsPanel,
  renderOutputPanel,
  revisionEntryFor
} from "../../src/src/client/drawer.js";
import { createInboxState, renderInbox, setInboxSummaries } from "../../src/src/client/inbox.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom";

type AnyRec = Record<string, any>;

beforeEach(() => {
  installMinimalDom();
});

const all = (root: unknown, predicate: (e: any) => boolean) => findAll(root as never, predicate as never) as any[];
const byId = (root: unknown, id: string) => all(root, (e) => e.getAttribute("id") === id || e.id === id)[0];

function post(overrides: AnyRec = {}): AnyRec {
  return {
    id: "item-1",
    batchId: "batch-1",
    state: "drafting",
    revision: 2,
    caption: "第二稿內容文字",
    altText: "A bowl of oats",
    generation: null,
    generatedImage: { id: "gm_a", ready: true, mimeType: "image/jpeg", status: "accepted" },
    generatedCandidate: null,
    acceptedVisualMode: "ai_refinement",
    acceptedGeneratedMediaProvenance: "recorded",
    instructionOverrides: { image: null, caption: null },
    publications: [],
    deliveries: [],
    ...overrides
  };
}

describe("alt text", () => {
  it("is editable in Post, counts as unsaved work, and saves with the revision", async () => {
    const typed: string[] = [];
    const root = renderOutputPanel("en", post() as never, { editable: true, buffers: {}, onAltTextInput: (v: string) => typed.push(v) } as never);
    const field = byId(root, "sl-drawer-alt-text");
    expect(field.value).toBe("A bowl of oats");
    field.value = "Oats with berries";
    await field.dispatchEvent({ type: "input" });
    expect(typed).toEqual(["Oats with berries"]);

    const buffers = { altText: "Oats with berries" };
    expect(dirtyParts(post() as never, buffers)).toMatchObject({ altText: true, any: true });
    expect(footerState("en", post() as never, { buffers }).save.disabled).toBe(false);
    expect(revisionEntryFor(post() as never, buffers)).toEqual({ batchItemId: "item-1", expectedRevision: 2, altText: "Oats with berries" });
    // Emptying it clears the saved alt text rather than carrying it forward.
    expect(revisionEntryFor(post() as never, { altText: "  " })).toMatchObject({ altText: null });
    expect(dirtyParts(post() as never, { altText: "A bowl of oats" }).any).toBe(false);
  });
});

describe("accepted image provenance", () => {
  it("explains unknown provenance and re-accepts the pinned image on request", async () => {
    const asked: string[] = [];
    const root = renderOutputPanel("en", post({ acceptedGeneratedMediaProvenance: "unknown" }) as never, {
      editable: true, buffers: {}, onReacceptImage: (id: string) => asked.push(id)
    } as never);
    expect(root.textContent).toContain("The accepted image's origin could not be confirmed.");
    const again = all(root, (e) => e.tagName === "BUTTON" && e.getAttribute("data-action") === "reaccept-image")[0];
    await again.dispatchEvent({ type: "click" });
    expect(asked).toEqual(["gm_a"]);
    expect(renderOutputPanel("en", post() as never, { editable: true, buffers: {} } as never).textContent).not.toContain("could not be confirmed");
  });

  it("marks a legacy candidate as needing explicit use", () => {
    const root = renderOutputPanel("en", post({ generatedCandidate: { id: "gm_old", ready: true, status: "legacy" } }) as never, { editable: true, buffers: {} } as never);
    expect(root.textContent).toContain("It is used only if you choose it explicitly.");
  });
});

describe("Instructions snapshots", () => {
  it("separates the instructions used for the accepted output from the pending request's", () => {
    const root = renderInstructionsPanel("en", post({
      generatedImage: { id: "gm_a", ready: true, instructions: { image: "Outdoor photo", caption: "Friendly" } },
      generation: { id: "gen_2", scope: { image: true, caption: false }, needs: { image: true, caption: false }, at: "2026-09-14T03:00:00.000Z", instructions: { image: "Studio light", caption: "Friendly" } }
    }) as never, { editable: true, buffers: {}, policy: {} } as never);
    const text = root.textContent;
    expect(text).toContain("Instructions used for the accepted output");
    expect(text).toContain("Image instructions: Outdoor photo");
    expect(text).toContain("Instructions on the pending request (14 Sept 2026, 03:00 UTC)");
    expect(text).toContain("Image instructions: Studio light");
  });

  it("explains, without rewriting, saved image instructions that still describe a text poster", () => {
    const saved = "Make a text poster with the headline in bold";
    const root = renderInstructionsPanel("en", post({ instructionOverrides: { image: saved, caption: null } }) as never, { editable: true, buffers: {}, policy: {} } as never);
    expect(root.textContent).toContain("New content is never a text poster");
    expect(byId(root, "sl-instructions-image").value).toBe(saved);
    const plain = renderInstructionsPanel("en", post({ instructionOverrides: { image: "Morning light", caption: null } }) as never, { editable: true, buffers: {}, policy: {} } as never);
    expect(plain.textContent).not.toContain("never a text poster");
  });
});

describe("History", () => {
  const ctx = { destinationLabel: (binding: string) => ({ DEST_A: "Destination A" } as AnyRec)[binding] ?? binding, stateLabel: (s: string) => s };

  it("shows last checked (with timezone) and receipt identifiers even without a URL", () => {
    const root = renderHistoryPanel("en", post({
      publications: [{ id: "pub_1", destinationBinding: "DEST_A", revision: 2, state: "published", intent: { publishMode: "publish_now" }, lastCheckedAt: "2026-09-14T03:15:00.000Z", receipt: { postId: "17890001", version: 2, providerId: null, url: null } }],
      deliveries: [{ publicationId: "pub_1", destinationBinding: "DEST_A", outcome: "published", receiptUrl: null, revision: 2 }]
    }) as never, ctx as never);
    const text = root.textContent;
    expect(text).toContain("Post ID 17890001");
    expect(text).toContain("filed version 2");
    expect(text).toContain("14 Sept 2026, 03:15 UTC");
    expect(text).not.toContain("No provider receipt yet.");
    expect(all(root, (e) => e.tagName === "A")).toHaveLength(0);
  });

  it("claims nothing was published only for a confirmed-safe failure", () => {
    const outcome = (state: string) => renderHistoryPanel("en", post({
      publications: [{ id: "pub_1", destinationBinding: "DEST_A", revision: 2, state, intent: {} }],
      deliveries: [{ publicationId: "pub_1", destinationBinding: "DEST_A", outcome: state, revision: 2 }]
    }) as never, ctx as never).textContent;
    expect(outcome("failed_safe")).toContain("nothing was published");
    expect(outcome("failed")).not.toContain("nothing was published");
    expect(outcome("unknown")).not.toContain("nothing was published");
    expect(outcome("unknown")).toContain("it may or may not have been published");
  });

  it("lists superseded and legacy images as history with an explicit Use this image", async () => {
    const used: string[] = [];
    const item = post({
      generatedHistory: [
        { id: "gm_a", status: "accepted", ready: true, createdAt: "2026-09-14T01:00:00.000Z" },
        { id: "gm_old", status: "superseded", stale: true, ready: true, createdAt: "2026-09-13T01:00:00.000Z" },
        { id: "gm_legacy", status: "legacy", ready: true, createdAt: "2026-09-01T01:00:00.000Z" },
        { id: "gm_new", status: "candidate", ready: true, createdAt: "2026-09-14T02:00:00.000Z" }
      ]
    });
    const root = renderHistoryPanel("en", item as never, { ...ctx, editable: true, onUseImage: (id: string) => used.push(id) } as never);
    const text = root.textContent;
    for (const label of ["accepted", "superseded", "earlier image", "new candidate"]) expect(text).toContain(label);
    const uses = all(root, (e) => e.tagName === "BUTTON" && String(e.className).includes("sl-history-use-image"));
    expect(uses.map((b) => b.getAttribute("data-image-id"))).toEqual(["gm_old", "gm_legacy"]);
    await uses[0].dispatchEvent({ type: "click" });
    expect(used).toEqual(["gm_old"]);
    const readOnly = renderHistoryPanel("en", item as never, { ...ctx, editable: false } as never);
    expect(all(readOnly, (e) => String(e.className).includes("sl-history-use-image"))).toHaveLength(0);
  });
});

describe("Content thumbnails", () => {
  it("shows accepted output, an explicit no-output placeholder, and reference imagery only when labelled", async () => {
    const { document } = installMinimalDom() as unknown as { document: { createElement(tag: string): any } };
    const root = document.createElement("div");
    const base = { itemId: "src1", coverMediaId: "m1", caption: "Localized caption", revision: 2, state: "drafting", provider: "instagram", sourceBinding: "IG" };
    const state = setInboxSummaries(createInboxState(), {
      batches: [{
        id: "b1",
        items: [
          { ...base, batchItemId: "bi_output", outputThumbnail: { generatedMediaId: "gm_1", mimeType: "image/jpeg" } },
          { ...base, batchItemId: "bi_none", itemId: "src2", outputThumbnail: null },
          { ...base, batchItemId: "bi_unreported", itemId: "src3" }
        ]
      }]
    } as never);
    const sourceLoads: string[] = [];
    const generatedLoads: string[] = [];
    renderInbox(root, state as never, {
      locale: "en",
      sources: [],
      handlers: { onInspectBatch() {}, onSelectItem() {}, onInboxFilter() {}, onLoadMoreBatches() {}, onClearItemSelection() {}, onReviewSelected() {} },
      loadCover: async (itemId: string, mediaId: string) => { sourceLoads.push(`${itemId}:${mediaId}`); return `blob:${itemId}`; },
      loadGeneratedCover: async (id: string) => { generatedLoads.push(id); return `blob:${id}`; }
    } as never);
    await flushAsyncWork();
    expect(generatedLoads).toEqual(["gm_1"]);
    // Only the projection that does not report output at all falls back to the source photo — labelled.
    expect(sourceLoads).toEqual(["src3:m1"]);
    const placeholders = all(root, (e) => String(e.className).includes("sl-media-placeholder"));
    expect(placeholders.map((e) => e.textContent)).toEqual(["No accepted output yet"]);
    const labels = all(root, (e) => String(e.className).includes("sl-media-label"));
    expect(labels.map((e) => e.textContent)).toEqual(["Reference"]);
  });
});
