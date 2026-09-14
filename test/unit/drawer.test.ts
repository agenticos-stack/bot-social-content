// The single-post drawer's sections, rendered against the minimal DOM.
// Fixture coverage of drawer.js and inbox.js's selection classifier — not a
// browser proof: layout, focus movement and scrolling are not exercised here.
import { beforeEach, describe, expect, it } from "vitest";
import { findAll, installMinimalDom } from "./_helpers/minimal-dom";
import {
  dirtyParts,
  footerState,
  imageState,
  instructionPatchFor,
  renderDrawerTablist,
  renderHistoryPanel,
  renderInstructionsPanel,
  renderOutputPanel,
  revisionEntryFor
} from "../../src/src/client/drawer.js";
import { classifyReviewSelection } from "../../src/src/client/inbox.js";

type Node = { tagName?: string; textContent?: string; className?: string; disabled?: boolean; getAttribute(name: string): string | null; dispatchEvent(event: unknown): Promise<void> };

beforeEach(() => {
  installMinimalDom();
});

const all = (root: unknown, predicate: (element: Node) => boolean) => findAll(root as never, predicate as never) as unknown as Node[];
const buttons = (root: unknown) => all(root, (e) => e.tagName === "BUTTON");
const buttonNamed = (root: unknown, label: string) => buttons(root).find((b) => String(b.textContent).includes(label));

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    batchId: "batch-1",
    state: "drafting",
    active: true,
    revision: 2,
    caption: "第二稿內容文字",
    generation: null,
    generatedImage: { id: "gm_a", ready: true, altText: "A bowl of oats", mimeType: "image/jpeg" },
    generatedCandidate: null,
    acceptedVisualMode: "ai_refinement",
    instructionOverrides: { image: null, caption: null },
    publications: [],
    deliveries: [],
    ...overrides
  };
}

function output(item: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const loads: string[] = [];
  const staged: Array<string | null> = [];
  const parts: string[] = [];
  const root = renderOutputPanel("en", item as never, {
    editable: true,
    saving: false,
    buffers: {},
    loadImage: (generated: { id: string }) => loads.push(generated.id),
    onStageImage: (id: string | null) => staged.push(id),
    onRequestPart: (part: string) => parts.push(part),
    ...extra
  } as never);
  return { root, loads, staged, parts };
}

describe("Output section", () => {
  it("shows a ready candidate beside the accepted image, and accepting it sends acceptedGeneratedMediaId", async () => {
    const item = post({ generatedCandidate: { id: "gm_b", ready: true, altText: "A newer bowl" } });
    const view = output(item);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-accepted"))).toHaveLength(1);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-candidate"))).toHaveLength(1);
    expect(view.loads).toEqual(["gm_a", "gm_b"]);
    expect(view.root.textContent).toContain("Accepted image");
    expect(view.root.textContent).toContain("New image ready");

    await buttonNamed(view.root, "Use this image")!.dispatchEvent({ type: "click" });
    expect(view.staged).toEqual(["gm_b"]);

    expect(revisionEntryFor(item as never, { imageId: "gm_b" })).toEqual({
      batchItemId: "item-1",
      expectedRevision: 2,
      acceptedVisualMode: "ai_refinement",
      acceptedGeneratedMediaId: "gm_b"
    });
  });

  it("says a new image is being generated without replacing the accepted one or offering to use it", () => {
    const view = output(post({ generatedCandidate: { id: "gm_b", ready: false } }));
    expect(view.root.textContent).toContain("New image being generated");
    expect(view.loads).toEqual(["gm_a"]);
    expect(buttonNamed(view.root, "Use this image")).toBeUndefined();
    expect(imageState(post({ generatedCandidate: { id: "gm_b", ready: false } }) as never)).toBe("generating");
  });

  it("offers Regenerate image and Rewrite caption separately, each naming what it keeps", async () => {
    const view = output(post());
    expect(view.root.textContent).toContain("Keeps the caption as it is.");
    expect(view.root.textContent).toContain("Keeps the accepted image.");
    await buttonNamed(view.root, "Regenerate image")!.dispatchEvent({ type: "click" });
    await buttonNamed(view.root, "Rewrite caption")!.dispatchEvent({ type: "click" });
    expect(view.parts).toEqual(["image", "caption"]);
  });

  it("marks only the requested part as waiting — an image request leaves the caption action available", () => {
    const view = output(post({ generation: { id: "gen_1", base: 2, needs: { image: true, caption: false } } }));
    expect(view.root.textContent).toContain("New image requested — waiting for the agent.");
    expect(buttonNamed(view.root, "Regenerate image")!.disabled).toBe(true);
    expect(buttonNamed(view.root, "Rewrite caption")!.disabled).toBe(false);
    // The accepted image is still drawn while the new one is requested.
    expect(view.loads).toEqual(["gm_a"]);
  });

  it("has no visual-mode radios: no text poster, no source photo as output", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: null }));
    expect(all(view.root, (e) => e.tagName === "INPUT")).toHaveLength(0);
    expect(view.root.textContent).toContain("No generated image yet.");
    expect(view.loads).toEqual([]);
  });

  it("renders the zh-HK labels", () => {
    const root = renderOutputPanel("zh-HK", post() as never, { editable: true, buffers: {} } as never);
    expect(root.textContent).toContain("重新生成圖片");
    expect(root.textContent).toContain("重新撰寫文案");
  });
});

describe("unsaved changes and footer reasons", () => {
  it("counts caption, staged image and instruction edits as unsaved", () => {
    const item = post();
    expect(dirtyParts(item as never, {}).any).toBe(false);
    expect(dirtyParts(item as never, { caption: "改過的文案內容" })).toMatchObject({ caption: true, any: true });
    expect(dirtyParts(item as never, { imageId: "gm_b" })).toMatchObject({ visual: true, any: true });
    expect(dirtyParts(item as never, { instructions: { image: "Morning light" } })).toMatchObject({ instructions: true, any: true });
    // Re-typing the saved value is not a change.
    expect(dirtyParts(item as never, { caption: "第二稿內容文字", imageId: "gm_a", instructions: { caption: "" } }).any).toBe(false);
  });

  it("gives Save and Review a specific reason when disabled", () => {
    expect(footerState("en", post() as never, {}).save).toEqual({ disabled: true, reason: "No unsaved changes." });
    expect(footerState("en", post() as never, { buffers: { caption: "新文案內容" } }).save.disabled).toBe(false);
    expect(footerState("en", post({ generatedImage: null, acceptedVisualMode: null }) as never, {}).review).toEqual({
      disabled: true,
      reason: "Accept a generated image before review."
    });
    expect(footerState("en", post({ generatedImage: { id: "gm_a", ready: false } }) as never, {}).review.reason).toBe(
      "The accepted image has not arrived yet."
    );
    // A staged ready candidate is what review will file once saved.
    expect(footerState("en", post({ generatedImage: null, generatedCandidate: { id: "gm_b", ready: true } }) as never, { buffers: { imageId: "gm_b" } }).review.disabled).toBe(false);
  });
});

describe("Instructions section", () => {
  it("shows the saved defaults against this post's overrides and resets to default", async () => {
    const item = post({ instructionOverrides: { image: "Outdoor photo", caption: null } });
    const resets: string[] = [];
    const root = renderInstructionsPanel("en", item as never, {
      editable: true,
      buffers: {},
      policy: { posterPrompt: "Default image text", contentPrompt: "Default caption text" },
      onReset: (part: string) => resets.push(part)
    } as never);
    expect(root.textContent).toContain("Saved default: Default image text");
    expect(root.textContent).toContain("This post only");
    expect(root.textContent).toContain("Nothing is generated now");
    const reset = all(root, (e) => e.tagName === "BUTTON" && e.getAttribute("data-part") === "image")[0];
    expect(reset.disabled).toBe(false);
    await reset.dispatchEvent({ type: "click" });
    expect(resets).toEqual(["image"]);
    // Reset is an empty draft, saved as null.
    expect(instructionPatchFor(item as never, { instructions: { image: "" } })).toEqual({ batchItemId: "item-1", image: null });
  });

  it("names the instructions the latest request used", () => {
    const root = renderInstructionsPanel("en", post({
      lastGeneration: { id: "gen_1", base: 1, needs: { image: true, caption: false }, at: "2026-09-14T03:00:00.000Z", instructions: { image: "Outdoor photo", caption: "Friendly" } }
    }) as never, { editable: true, buffers: {}, policy: {} } as never);
    expect(root.textContent).toContain("Used for the latest request");
    expect(root.textContent).toContain("Image instructions: Outdoor photo");
  });
});

describe("History section", () => {
  const scheduled = {
    publications: [
      { id: "pub_1", destinationBinding: "DEST_A", revision: 2, state: "scheduled", intent: { publishMode: "schedule", publishLocalTime: "2026-09-16T10:30", timezone: "Asia/Hong_Kong" } },
      { id: "pub_0", destinationBinding: "DEST_B", revision: 1, state: "failed", intent: {} }
    ],
    deliveries: [
      { publicationId: "pub_1", destinationBinding: "DEST_A", outcome: "scheduled", receiptUrl: null, revision: 2, filedAt: "2026-09-14T02:00:00.000Z" }
    ],
    approval: { approvedRevision: 2, currentRevision: 2 },
    revisionHistory: [{ revision: 1, createdAt: "2026-09-13T00:00:00.000Z", acceptedVisualMode: "ai_refinement" }, { revision: 2, createdAt: "2026-09-14T00:00:00.000Z", acceptedVisualMode: "ai_refinement" }]
  };
  const ctx = { destinationLabel: (binding: string) => ({ DEST_A: "Destination A", DEST_B: "Destination B" })[binding] ?? binding, stateLabel: (s: string) => s };

  it("renders the scheduled time with its timezone, and no receipt link the data does not carry", () => {
    const root = renderHistoryPanel("en", post(scheduled) as never, ctx as never);
    expect(root.textContent).toContain("Scheduled for 2026-09-16 10:30 (Asia/Hong_Kong)");
    expect(root.textContent).toContain("No provider receipt yet.");
    expect(all(root, (e) => e.tagName === "A")).toHaveLength(0);
    // The failed earlier filing stays visible with an owner-safe explanation.
    expect(root.textContent).toContain("Destination B");
    expect(root.textContent).toContain("nothing was published to this destination");
    expect(root.textContent).toContain("Version 2");
  });

  it("links the receipt only when the delivery row carries one, and explains an unknown outcome", () => {
    const root = renderHistoryPanel("en", post({
      publications: [{ id: "pub_1", destinationBinding: "DEST_A", revision: 2, state: "submitted", intent: { publishMode: "publish_now" } }],
      deliveries: [
        { publicationId: "pub_1", destinationBinding: "DEST_A", outcome: "unknown", receiptUrl: "https://provider.example/receipt/1", revision: 2 }
      ]
    }) as never, ctx as never);
    const links = all(root, (e) => e.tagName === "A");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://provider.example/receipt/1");
    expect(root.textContent).toContain("Outcome not confirmed");
    expect(root.textContent).toContain("Publish after approval");
  });
});

describe("drawer tabs", () => {
  it("is a tablist with one tab stop that arrow keys, Home and End move through", async () => {
    const selected: Array<[string, unknown]> = [];
    const root = renderDrawerTablist("en", { active: "output", onSelect: (key: string, opts: unknown) => selected.push([key, opts]) });
    expect(root.getAttribute("role")).toBe("tablist");
    const tabs = all(root, (e) => e.getAttribute("role") === "tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
    expect(tabs[0].getAttribute("aria-controls")).toBe("sl-drawer-panel-output");
    await tabs[0].dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault() {} });
    await tabs[0].dispatchEvent({ type: "keydown", key: "ArrowLeft", preventDefault() {} });
    await tabs[0].dispatchEvent({ type: "keydown", key: "End", preventDefault() {} });
    expect(selected).toEqual([
      ["reference", { focus: true }],
      ["history", { focus: true }],
      ["history", { focus: true }]
    ]);
  });
});

describe("Content multi-select across batches", () => {
  it("keeps each entry's batch identity and never lets a filed post through", () => {
    const entries = [
      { batchItemId: "bi_draft", batchId: "batch_a" },
      { batchItemId: "bi_filed", batchId: "batch_b" },
      { batchItemId: "bi_empty", batchId: "batch_b" },
      { batchItemId: "bi_gone", batchId: "batch_c" }
    ];
    const batches = new Map<string, unknown>([
      ["batch_a", { id: "batch_a", items: [{ id: "bi_draft", state: "drafting", active: true, revision: 2 }] }],
      ["batch_b", { id: "batch_b", items: [
        { id: "bi_filed", state: "awaiting_approval", active: true, revision: 3 },
        { id: "bi_empty", state: "drafting", active: true, revision: 0 }
      ] }],
      ["batch_c", null]
    ]);
    const { eligible, blocked } = classifyReviewSelection(entries, batches);
    expect(eligible.map((entry: { batchId: string; item: { id: string } }) => [entry.batchId, entry.item.id])).toEqual([["batch_a", "bi_draft"]]);
    expect(blocked.map((entry: { entry: { batchItemId: string }; reason: string }) => [entry.entry.batchItemId, entry.reason])).toEqual([
      ["bi_filed", "reviewBlockedFiled"],
      ["bi_empty", "reviewBlockedNoDraft"],
      ["bi_gone", "reviewBlockedUnavailable"]
    ]);
  });
});
