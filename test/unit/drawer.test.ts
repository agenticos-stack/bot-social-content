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
  publicationHint,
  renderDrawerTablist,
  renderHistoryPanel,
  renderInstructionsPanel,
  renderOutputPanel,
  renderPublicationControls,
  renderReferencePanel,
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

function pubsHost(locale: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const patches: Record<string, unknown>[] = [];
  const host = document.createElement("div");
  for (const node of renderPublicationControls(locale, item as never, {
    editable: true,
    buffers: {},
    onPublicationIntent: (patch: Record<string, unknown>) => patches.push(patch),
    ...extra
  } as never)) host.appendChild(node);
  return { root: host, patches };
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

  it("overlays generating on the accepted image instead of a second empty frame", () => {
    const view = output(post({ generatedCandidate: { id: "gm_b", ready: false } }));
    const frames = all(view.root, (e) => String(e.className).includes("sl-output-frame"));
    expect(frames.filter((e) => String(e.className).includes("sl-output-frame-candidate"))).toHaveLength(0);
    const accepted = frames.find((e) => String(e.className).includes("sl-output-frame-accepted"));
    expect(accepted).toBeTruthy();
    expect(String(accepted!.className)).toContain("sl-output-frame-skel");
    expect(view.loads).toEqual(["gm_a"]);
    expect(buttonNamed(view.root, "Use this image")).toBeUndefined();
    expect(imageState(post({ generatedCandidate: { id: "gm_b", ready: false } }) as never)).toBe("generating");
  });

  it("overlays generating on the empty slot instead of a compact note", () => {
    const view = output(post({
      generatedImage: null,
      acceptedVisualMode: null,
      generation: { id: "gen_1", base: 0, needs: { image: true, caption: false } }
    }));
    const frames = all(view.root, (e) => String(e.className).includes("sl-output-frame"));
    expect(frames.some((e) => String(e.className).includes("sl-output-frame-skel"))).toBe(true);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-empty"))).toHaveLength(0);
    expect(view.loads).toEqual([]);
  });

  it("keeps the idle empty image region compact", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: null, generation: null }));
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-skel"))).toHaveLength(0);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-empty")).length).toBeGreaterThan(0);
    expect(view.root.textContent).toContain("No generated image yet.");
  });

  it("does not overlay when the request was never submitted", () => {
    const view = output(post({
      generatedImage: null,
      acceptedVisualMode: null,
      generation: { id: "gen_1", base: 0, needs: { image: true, caption: false } }
    }), { unsubmitted: true });
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-skel"))).toHaveLength(0);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-empty")).length).toBeGreaterThan(0);
  });

  it("rewrites the caption in the same field", () => {
    const view = output(post({ generation: { id: "gen_1", base: 2, needs: { image: false, caption: true } } }));
    const textarea = all(view.root, (e) => e.getAttribute("id") === "sl-drawer-caption-input")[0];
    expect(textarea).toBeTruthy();
    expect(String(textarea.className)).toContain("sl-skel");
  });

  it("lays out a compact thumbnail beside the caption and keeps publish controls in the foot", () => {
    const item = post({ destinationBindings: ["FB_MAIN"] });
    const view = output(item);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-compose"))).toHaveLength(1);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-thumb")).length).toBeGreaterThan(0);
    expect(all(view.root, (e) => e.tagName === "INPUT" && e.getAttribute("name") === "publicationMode")).toHaveLength(0);
    const pubs = pubsHost("en", item);
    expect(all(pubs.root, (e) => e.tagName === "INPUT" && e.getAttribute("name") === "publicationMode")).toHaveLength(3);
  });

  it("offers Generate, Upload and Use reference as the image sources", async () => {
    const adopted: string[] = [];
    const view = output(post(), {
      onAdoptReference: () => adopted.push("reference")
    });
    expect(buttonNamed(view.root, "Generate")).toBeTruthy();
    expect(buttonNamed(view.root, "Upload")).toBeTruthy();
    expect(buttonNamed(view.root, "Use reference")).toBeTruthy();
    await buttonNamed(view.root, "Generate")!.dispatchEvent({ type: "click" });
    expect(view.parts).toEqual(["image"]);
    await buttonNamed(view.root, "Use reference")!.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["reference"]);
  });

  it("shows the chosen upload and adopting it calls onAdoptUpload", async () => {
    const adopted: string[] = [];
    const view = output(post(), {
      buffers: { imageSource: "upload" },
      uploadPreview: { name: "weekend-tray.jpg" },
      onAdoptUpload: () => adopted.push("upload")
    });
    expect(view.root.textContent).toContain("weekend-tray.jpg");
    await buttonNamed(view.root, "Use this image")!.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["upload"]);
  });

  it("saves Use reference as keep_original, not a generated image", () => {
    expect(revisionEntryFor(post() as never, { visualMode: "keep_original" })).toEqual({
      batchItemId: "item-1",
      expectedRevision: 2,
      acceptedVisualMode: "keep_original"
    });
  });

  it("offers Regenerate image and Rewrite caption separately, each naming what it keeps", async () => {
    const view = output(post());
    const image = buttonNamed(view.root, "Generate")!;
    const caption = buttonNamed(view.root, "Rewrite caption")!;
    expect(image.getAttribute("title")).toContain("Keeps the caption as it is.");
    expect(caption.getAttribute("title")).toContain("Keeps the accepted image.");
    expect(view.root.textContent).not.toContain("Keeps the caption as it is.");
    expect(view.root.textContent).not.toContain("Keeps the accepted image.");
    await image.dispatchEvent({ type: "click" });
    await caption.dispatchEvent({ type: "click" });
    expect(view.parts).toEqual(["image", "caption"]);
  });

  it("marks only the requested part as waiting, and neither button replaces it silently", () => {
    const view = output(post({ generation: { id: "gen_1", base: 2, needs: { image: true, caption: false } } }));
    expect(view.root.textContent).not.toContain("waiting for the agent");
    expect(view.root.textContent).not.toContain("An image request is still pending for this post.");
    const image = buttonNamed(view.root, "Generate")!;
    const caption = buttonNamed(view.root, "Rewrite caption")!;
    expect(image.disabled).toBe(false);
    expect(image.getAttribute("data-requested")).toBe("true");
    expect(image.getAttribute("title")).toContain("Already requested");
    expect(caption.disabled).toBe(false);
    expect(caption.getAttribute("data-pending")).toBe("image");
    expect(caption.getAttribute("title")).toContain("image request is still pending");
    expect(view.loads).toEqual(["gm_a"]);
  });

  it("has no visual-mode radios: no text poster, no source photo as output", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: null }));
    const visual = all(view.root, (e) => e.tagName === "INPUT" && String(e.getAttribute("name") ?? "").includes("visual"));
    expect(visual).toHaveLength(0);
    expect(view.root.textContent).toContain("No generated image yet.");
    expect(view.loads).toEqual([]);
  });

  it("offers keep as draft, publish now, and schedule in the foot", async () => {
    const view = pubsHost("en", post({ destinationBindings: ["FB_MAIN"] }), {
      destinationLabel: (binding: string) => (binding === "FB_MAIN" ? "Facebook Main" : binding)
    });
    const radios = all(view.root, (e) => e.tagName === "INPUT" && e.getAttribute("name") === "publicationMode");
    expect(radios).toHaveLength(3);
    expect(view.root.textContent).toContain("Keep as draft");
    expect(view.root.textContent).toContain("Publish now");
    expect(view.root.textContent).toContain("Schedule");
    expect(view.root.textContent).toContain("Facebook Main");
    expect(view.root.textContent).not.toContain("please approve");
    expect(view.root.textContent).not.toContain("Awaiting approval");
    await radios[1].dispatchEvent({ type: "change" });
    expect(view.patches[0]).toMatchObject({ publishMode: "publish_now" });
  });

  it("renders the zh-HK labels", () => {
    const root = renderOutputPanel("zh-HK", post() as never, { editable: true, buffers: {} } as never);
    expect(root.textContent).toContain("生成");
    expect(root.textContent).toContain("上載");
    expect(root.textContent).toContain("採用來源");
    expect(root.textContent).toContain("重新撰寫文案");
    const pubs = pubsHost("zh-HK", post());
    expect(pubs.root.textContent).toContain("立即發佈");
    expect(pubs.root.textContent).toContain("排程發佈");
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
      reason: "Accept a generated image before publishing."
    });
    expect(footerState("en", post({ generatedImage: { id: "gm_a", ready: false } }) as never, {}).review.reason).toBe(
      "The accepted image has not arrived yet."
    );
    // A staged ready candidate is what publish will file once saved.
    expect(footerState("en", post({
      generatedImage: null,
      generatedCandidate: { id: "gm_b", ready: true },
      publicationIntent: { publishMode: "publish_now" },
      destinationBindings: ["FB_MAIN"]
    }) as never, { buffers: { imageId: "gm_b" } }).review.disabled).toBe(false);
  });

  it("names Publish or Schedule from the sheet radios, and keeps draft as Save only", () => {
    const ready = post({ destinationBindings: ["FB_MAIN"] });
    expect(footerState("en", ready as never, {}).primary).toMatchObject({
      disabled: true,
      label: "Publish",
      reason: "This stays a draft until you publish or schedule it."
    });
    expect(footerState("en", post({
      destinationBindings: ["FB_MAIN"],
      publicationIntent: { publishMode: "publish_now" }
    }) as never, {}).primary).toMatchObject({ disabled: false, label: "Publish" });
    expect(footerState("en", post({
      destinationBindings: ["FB_MAIN"],
      publicationIntent: { publishMode: "schedule" }
    }) as never, {}).primary).toMatchObject({
      disabled: true,
      label: "Schedule",
      reason: "Choose a date and time to schedule."
    });
    expect(footerState("en", post({
      destinationBindings: ["FB_MAIN"],
      publicationIntent: { publishMode: "schedule", publishLocalTime: "2026-09-18T11:00", timezone: "Asia/Hong_Kong" }
    }) as never, {}).primary).toMatchObject({ disabled: false, label: "Schedule" });
    expect(footerState("en", post({
      destinationBindings: ["FB_MAIN"],
      publicationIntent: { publishMode: "publish_now" },
      generation: { id: "gen_1", base: 2, needs: { image: true, caption: false } }
    }) as never, {}).primary.reason).toBe("The image is generating in place. Publish when it finishes.");
  });

  it("counts a publication-intent change as unsaved so Save keeps it", () => {
    const item = post({ publicationIntent: { publishMode: "save_draft" } });
    expect(dirtyParts(item as never, { publicationIntent: { publishMode: "publish_now" } })).toMatchObject({ publication: true, any: true });
    expect(revisionEntryFor(item as never, { publicationIntent: { publishMode: "publish_now" } })).toEqual({
      batchItemId: "item-1",
      expectedRevision: 2,
      publicationIntent: { publishMode: "publish_now" }
    });
  });
});

describe("Reference section", () => {
  it("is inspection only — adopting the source image lives on the Post tab's source control", async () => {
    const adopted: string[] = [];
    const sourceItem = { text: "Weekend Omega-3 tray", authorHandle: "essentialfoodsofficial", media: [{ id: "m1", kind: "image" }] };
    const root = renderReferencePanel("en", post({ sourceItem }) as never, {
      editable: true,
      onAdoptReference: () => adopted.push("reference")
    } as never);
    expect(root.textContent).toContain("Reference only");
    // No adopt button here at all — even if a stray handler is passed.
    expect(buttonNamed(root, "Use this image")).toBeFalsy();
    // The Post tab's source segment is the one place the choice is made.
    const output = renderOutputPanel("en", post({ sourceItem }) as never, {
      editable: true,
      buffers: {},
      onAdoptReference: () => adopted.push("reference")
    } as never);
    const adopt = all(output, (e) => e.tagName === "BUTTON" && e.getAttribute("data-src") === "reference")[0];
    await adopt.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["reference"]);
  });
});

describe("Instructions section", () => {
  it("prefills both fields, marks own-vs-default truthfully, and resets to default", async () => {
    const item = post({ instructionOverrides: { image: "Outdoor photo", caption: null } });
    const resets: string[] = [];
    const root = renderInstructionsPanel("en", item as never, {
      editable: true,
      buffers: {},
      policy: { posterPrompt: "Default image text", contentPrompt: "Default caption text" },
      onReset: (part: string) => resets.push(part)
    } as never);
    const fields = all(root, (e) => e.tagName === "TEXTAREA") as Array<Node & { value: string }>;
    expect(fields).toHaveLength(2);
    expect(fields[0].value).toBe("Outdoor photo"); // the saved post override wins
    expect(fields[1].value).toBe("Default caption text"); // the workspace default prefills
    expect(root.textContent).toContain("This post's own instruction.");
    expect(root.textContent).toContain("Using the workspace default.");
    const imageReset = all(root, (e) => e.tagName === "BUTTON" && e.getAttribute("data-part") === "image")[0];
    const captionReset = all(root, (e) => e.tagName === "BUTTON" && e.getAttribute("data-part") === "caption")[0];
    expect(imageReset.disabled).toBe(false);
    expect(captionReset.disabled).toBe(true); // no override — nothing to reset
    await imageReset.dispatchEvent({ type: "click" });
    expect(resets).toEqual(["image"]);
    // Reset is an empty draft, saved as null.
    expect(instructionPatchFor(item as never, { instructions: { image: "" } })).toEqual({ batchItemId: "item-1", image: null });
  });

  it("writes no override when the draft equals the prefilled text, and a plain field follows the workspace default", () => {
    const item = post(); // no saved overrides
    const defaults = { image: "Default image text", caption: "Default caption text" };
    // Retyping the prefilled default verbatim is not an override.
    expect(instructionPatchFor(item as never, { instructions: { image: "Default image text" } }, ["image", "caption"], defaults)).toBeNull();
    // Reset on a field that was never overridden clears nothing — the empty
    // draft normalizes to the same null the store already holds.
    expect(instructionPatchFor(item as never, { instructions: { image: "" } }, ["image", "caption"], defaults)).toBeNull();
    // A real difference is.
    expect(instructionPatchFor(item as never, { instructions: { image: "Studio light" } }, ["image", "caption"], defaults))
      .toEqual({ batchItemId: "item-1", image: "Studio light" });
    // And nothing pins the old text — when the workspace default moves, a
    // field with no override prefills the new one.
    const after = renderInstructionsPanel("en", item as never, {
      editable: true, buffers: {}, policy: { posterPrompt: "New workspace text" }
    } as never);
    expect((all(after, (e) => e.tagName === "TEXTAREA")[0] as Node & { value: string }).value).toBe("New workspace text");
  });

  it("keeps request snapshots in History — the editor holds only the two fields", () => {
    const item = post({
      generation: { id: "gen_2", scope: { image: true, caption: false }, needs: { image: true, caption: false }, at: "2026-09-14T04:00:00.000Z", instructions: { image: "Studio light", caption: "Friendly" } },
      lastGeneration: { id: "gen_1", base: 1, needs: { image: true, caption: false }, at: "2026-09-14T03:00:00.000Z", instructions: { image: "Outdoor photo", caption: "Friendly" } }
    });
    const instructions = renderInstructionsPanel("en", item as never, { editable: true, buffers: {}, policy: {} } as never);
    expect(all(instructions, (e) => e.tagName === "TEXTAREA")).toHaveLength(2);
    expect(instructions.textContent).not.toContain("Studio light");
    expect(instructions.textContent).not.toContain("Outdoor photo");
    // The pending request is a History event; the completed request's
    // instruction snapshot follows it under the unified field names.
    const history = renderHistoryPanel("en", item as never, {} as never);
    expect(history.textContent).toContain("Generation request");
    expect(history.textContent).toContain("waiting");
    expect(history.textContent).toContain("Instructions used");
    expect(history.textContent).toContain("Image instruction: Outdoor photo");
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
    // No receipt simply renders nothing — the feed never spends a line on it.
    expect(all(root, (e) => e.tagName === "A")).toHaveLength(0);
    // The failed earlier filing stays visible with an owner-safe explanation
    // that does not claim nothing went out — only failed_safe confirms that.
    expect(root.textContent).toContain("Destination B");
    expect(root.textContent).toContain("the publisher did not confirm what happened");
    expect(root.textContent).not.toContain("nothing was published");
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
    expect(root.textContent).toContain("Publish now");
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
