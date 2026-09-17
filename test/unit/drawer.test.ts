// The single-post drawer's sections, rendered against the minimal DOM.
// Fixture coverage of drawer.js and inbox.js's selection classifier — not a
// browser proof: layout, focus movement and scrolling are not exercised here.
import { beforeEach, describe, expect, it } from "vitest";
import { findAll, installMinimalDom } from "./_helpers/minimal-dom";
import {
  destinationBlock,
  dirtyParts,
  footerState,
  imageState,
  instructionPatchFor,
  publicationHint,
  recordedBindings,
  renderDrawerTablist,
  renderHistoryPanel,
  renderInstructionsPanel,
  renderOutputPanel,
  renderPublishControls,
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
  const toggled: string[] = [];
  const scheduled: Array<string | null> = [];
  const host = document.createElement("div");
  for (const node of renderPublishControls(locale, item as never, {
    editable: true,
    buffers: {},
    destinationLabel: (binding: string) => binding,
    onToggleDestination: (binding: string) => toggled.push(binding),
    onScheduleChange: (value: string | null) => scheduled.push(value),
    ...extra
  } as never)) host.appendChild(node);
  return { root: host, toggled, scheduled };
}

describe("Output section", () => {
  it("shows a ready candidate beside the accepted image, and accepting it sends acceptedGeneratedMediaId", async () => {
    const item = post({ generatedCandidate: { id: "gm_b", ready: true, altText: "A newer bowl" } });
    const view = output(item);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-accepted"))).toHaveLength(1);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-candidate"))).toHaveLength(1);
    // Accepted first, candidate beside it — the strip order is the load order.
    expect(view.loads).toEqual(["gm_a", "gm_b"]);
    // One image is not a set: no Cover caption even with a candidate beside it.
    expect(view.root.textContent).not.toContain("Cover");
    expect(view.root.textContent).toContain("New image");

    await buttonNamed(view.root, "Use this image")!.dispatchEvent({ type: "click" });
    expect(view.staged).toEqual(["gm_b"]);

    expect(revisionEntryFor(item as never, { imageId: "gm_b" })).toEqual({
      batchItemId: "item-1",
      expectedRevision: 2,
      acceptedVisualMode: "ai_refinement",
      acceptedGeneratedMediaId: "gm_b"
    });
  });

  it("renders the accepted image with per-picture hover actions and no set furniture", () => {
    const view = output(post());
    const slots = all(view.root, (e) => {
      const cls = String(e.className).split(" ");
      return cls.includes("sl-slot") && !cls.includes("sl-slot-candidate");
    });
    expect(slots).toHaveLength(1);
    // A single picture is not a set: no number badge, no "Cover" caption,
    // and no second empty tile — that furniture names an ordered collection.
    expect(view.root.textContent).not.toContain("Cover");
    expect(all(view.root, (e) => String(e.className).includes("sl-slot-num"))).toHaveLength(0);
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-addslot"))).toHaveLength(0);
    // The picture's own actions: regenerate, remove, view — never a blind retry.
    const hover = all(view.root, (e) => String(e.className).includes("sl-hover-btn"));
    expect(hover.map((b) => String(b.textContent))).toEqual(["Regenerate", "Remove", "View"]);
    // Once a picture exists, the quiet add action moves to the column label.
    expect(all(view.root, (e) => String(e.className).includes("sl-addquiet"))).toHaveLength(1);
  });

  it("the strip still renders one slot when only a legacy visual exists", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: "keep_original" }));
    expect(view.root.textContent).toContain("source media");
    expect(all(view.root, (e) => String(e.className).includes("sl-hover-btn")).length).toBeGreaterThan(0);
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

  it("the empty image region IS the add control — a dashed placeholder, not a note", async () => {
    const toggles: string[] = [];
    const view = output(post({ generatedImage: null, acceptedVisualMode: null, generation: null }), {
      strip: { menuOpen: false, onToggleMenu: () => toggles.push("menu") }
    });
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-skel"))).toHaveLength(0);
    expect(all(view.root, (e) => String(e.className).includes("sl-output-empty"))).toHaveLength(0);
    const place = all(view.root, (e) => String(e.className).split(" ").includes("sl-addplace"));
    expect(place).toHaveLength(1);
    expect(String(place[0].textContent)).toContain("＋");
    expect(String(place[0].textContent)).toContain("Add image");
    expect(String(place[0].textContent)).toContain("Generate, upload, or use the post's picture");
    await place[0].dispatchEvent({ type: "click" });
    expect(toggles).toEqual(["menu"]);
    // No quiet link beside it — that only exists once a picture does.
    expect(all(view.root, (e) => String(e.className).includes("sl-addquiet"))).toHaveLength(0);
  });

  it("does not overlay when the request was never submitted", () => {
    const view = output(post({
      generatedImage: null,
      acceptedVisualMode: null,
      generation: { id: "gen_1", base: 0, needs: { image: true, caption: false } }
    }), { unsubmitted: true });
    expect(all(view.root, (e) => String(e.className).includes("sl-output-frame-skel"))).toHaveLength(0);
    // Unsubmitted is not "generating": the add placeholder is usable again.
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-addplace"))).toHaveLength(1);
  });

  it("rewrites the caption in the same field", () => {
    const view = output(post({ generation: { id: "gen_1", base: 2, needs: { image: false, caption: true } } }));
    const textarea = all(view.root, (e) => e.getAttribute("id") === "sl-drawer-caption-input")[0];
    expect(textarea).toBeTruthy();
    expect(String(textarea.className)).toContain("sl-skel");
  });

  it("renders the strip beside the caption and keeps publish controls in the foot", () => {
    const item = post({ destinationBindings: ["FB_MAIN"] });
    const view = output(item);
    expect(all(view.root, (e) => String(e.className).includes("sl-strip"))).toHaveLength(1);
    expect(all(view.root, (e) => String(e.className).includes("sl-slot")).length).toBeGreaterThan(0);
    // No timing radios anywhere — the intent is which button was pressed.
    expect(all(view.root, (e) => e.tagName === "INPUT" && e.getAttribute("name") === "publicationMode")).toHaveLength(0);
    const pubs = pubsHost("en", item);
    expect(all(pubs.root, (e) => e.tagName === "INPUT" && e.getAttribute("name") === "publicationMode")).toHaveLength(0);
    expect(pubs.root.textContent).toContain("Publishes to");
  });

  it("the add-image menu offers Generate, Upload and the post's own picture", async () => {
    const adopted: string[] = [];
    const uploaded: string[] = [];
    const view = output(post(), {
      imageRefsAvailable: true,
      strip: {
        menuOpen: true,
        onMenuGenerate: () => view.parts.push("image"),
        onMenuAdoptSource: () => adopted.push("reference"),
        onMenuUpload: () => uploaded.push("upload")
      }
    });
    const generate = buttonNamed(view.root, "Generate a new image")!;
    expect(generate).toBeTruthy();
    // The row says the resolved brief it would run under.
    expect(generate.textContent).toContain("4:5");
    await generate.dispatchEvent({ type: "click" });
    expect(view.parts).toEqual(["image"]);
    await buttonNamed(view.root, "Upload an image")!.dispatchEvent({ type: "click" });
    expect(uploaded).toEqual(["upload"]);
    await buttonNamed(view.root, "Use the post's own picture")!.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["reference"]);
  });

  it("says so when the post has no usable picture to adopt", () => {
    const view = output(post(), { imageRefsAvailable: false, strip: { menuOpen: true } });
    const adopt = buttonNamed(view.root, "Use the post's own picture")!;
    expect(adopt).toBeTruthy();
    expect(adopt.disabled).toBe(true);
    expect(adopt.textContent).toContain("no usable picture");
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

  it("offers image generation through the menu and Rewrite caption inline, each honest about what it keeps", async () => {
    const view = output(post(), { strip: { menuOpen: true, onMenuGenerate: () => view.parts.push("image") } });
    const image = buttonNamed(view.root, "Generate a new image")!;
    const caption = buttonNamed(view.root, "Rewrite caption")!;
    expect(caption.getAttribute("title")).toContain("Keeps the accepted image.");
    await image.dispatchEvent({ type: "click" });
    await caption.dispatchEvent({ type: "click" });
    expect(view.parts).toEqual(["image", "caption"]);
  });

  it("marks only the requested part as waiting, and neither control replaces it silently", () => {
    const view = output(post({ generation: { id: "gen_1", base: 2, needs: { image: true, caption: false } } }), { strip: { menuOpen: true } });
    expect(view.root.textContent).not.toContain("waiting for the agent");
    expect(view.root.textContent).not.toContain("An image request is still pending for this post.");
    const image = buttonNamed(view.root, "Generate a new image")!;
    const caption = buttonNamed(view.root, "Rewrite caption")!;
    expect(image.disabled).toBe(false);
    expect(image.getAttribute("data-requested")).toBe("true");
    expect(image.getAttribute("title")).toContain("Already requested");
    expect(caption.disabled).toBe(false);
    expect(caption.getAttribute("data-pending")).toBe("image");
    expect(caption.getAttribute("title")).toContain("image request is still pending");
    expect(view.loads).toEqual(["gm_a"]);
  });

  it("regenerate is a conversation: name the change, see plan and price, then generate once", async () => {
    const submits: number[] = [];
    const regen = { slot: 1, notes: ["drawerRegenC1"], other: "", otherOpen: true, sent: false };
    const view = output(post(), {
      imageBrief: { useSource: true, ratio: "4:5", oneOff: "", saveOneOff: false },
      strip: { regen, onRegenSubmit: () => submits.push(1), onRegenChip: () => {}, onRegenCancel: () => {} }
    });
    expect(view.root.textContent).toContain("What should change about image 1?");
    // The plan restates the named correction, the ratio and the spend.
    expect(view.root.textContent).toContain("Image 1 · Too dark · 4:5");
    expect(view.root.textContent).toContain("One generation");
    await buttonNamed(view.root, "Generate")!.dispatchEvent({ type: "click" });
    expect(submits).toEqual([1]);
    // Chips not yet pressed → nothing is filed; the ask stands alone.
    const empty = output(post(), { strip: { regen: { slot: 1, notes: [], other: "", otherOpen: false, sent: false } } });
    expect(empty.root.textContent).toContain("Name one thing to change before generating.");
    expect(buttonNamed(empty.root, "Generate")).toBeUndefined();
    // A sent request reads as running — never a second submit.
    const sent = output(post(), { strip: { regen: { slot: 1, notes: ["drawerRegenC1"], other: "", otherOpen: false, sent: true } } });
    expect(sent.root.textContent).toContain("Generating image 1.");
    expect(buttonNamed(sent.root, "Generate")).toBeUndefined();
  });

  it("has no visual-mode radios: no text poster, no source photo as output", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: null }));
    const visual = all(view.root, (e) => e.tagName === "INPUT" && String(e.getAttribute("name") ?? "").includes("visual"));
    expect(visual).toHaveLength(0);
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-addplace"))).toHaveLength(1);
    expect(view.loads).toEqual([]);
  });

  it("the foot's publish row is a destination multi-select — what is picked is what files", async () => {
    const destinations = [
      { binding: "FB_MAIN", label: "Facebook Main", provider: "facebook", providerLabel: "Facebook", granted: true },
      { binding: "IG_MAIN", label: "Instagram Main", provider: "instagram", providerLabel: "Instagram", granted: true },
      { binding: "IG_OLD", label: "Instagram Old", provider: "instagram", providerLabel: "Instagram", granted: false }
    ];
    const view = pubsHost("en", post({ destinationBindings: ["FB_MAIN"] }), { destinations, picked: ["FB_MAIN", "IG_MAIN"], menuOpen: true });
    expect(view.root.textContent).toContain("Publishes to");
    expect(view.root.textContent).toContain("Facebook Main");
    const boxes = all(view.root, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox");
    expect(boxes).toHaveLength(3);
    // A revoked grant stays visible but cannot be picked, and says why.
    const revoked = all(view.root, (e) => String(e.textContent).includes("access revoked"));
    expect(revoked.length).toBeGreaterThan(0);
    await boxes[1].dispatchEvent({ type: "change" });
    expect(view.toggled).toEqual(["IG_MAIN"]);
    expect(view.root.textContent).not.toContain("please approve");
    expect(view.root.textContent).not.toContain("Awaiting approval");
  });

  it("a recorded binding no destination row describes stays pickable", () => {
    const item = post({ destinationBindings: ["LEGACY_ACC"] });
    const view = pubsHost("en", item, { destinations: [], menuOpen: true });
    expect(view.root.textContent).toContain("LEGACY_ACC");
    const box = all(view.root, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox")[0];
    expect(box.disabled).toBe(false);
  });

  it("Schedule… arms the field; a chosen time becomes the schedule intent", async () => {
    const view = pubsHost("en", post({ destinationBindings: ["FB_MAIN"] }), { picking: true });
    const when = all(view.root, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "datetime-local")[0] as Node & { value: string };
    expect(when).toBeTruthy();
    when.value = "2026-09-18T11:00";
    await when.dispatchEvent({ type: "change" });
    expect(view.scheduled).toEqual(["2026-09-18T11:00"]);
    expect(publicationHint("en", { scheduledAt: "2026-09-18T11:00" })).toContain("Schedules on confirm");
    expect(publicationHint("en", {})).toContain("Publishes the accepted image");
  });

  it("renders the zh-HK labels", () => {
    const root = renderOutputPanel("zh-HK", post() as never, {
      editable: true,
      buffers: {},
      strip: { menuOpen: true, regen: { slot: 1, notes: ["drawerRegenC1"], other: "", otherOpen: false, sent: false } }
    } as never);
    expect(root.textContent).toContain("＋ 加入圖片");
    expect(root.textContent).toContain("重新生成");
    expect(root.textContent).toContain("生成新圖片");
    expect(root.textContent).toContain("採用原帖圖片");
    expect(root.textContent).toContain("重新撰寫文案");
    expect(root.textContent).toContain("第 1 張要改甚麼？");
    const pubs = pubsHost("zh-HK", post({ destinationBindings: ["FB_MAIN"] }));
    expect(pubs.root.textContent).toContain("發佈至");
    expect(pubs.root.textContent).toContain("FB_MAIN");
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

  it("names the destination on the primary, and a chosen time turns it into Schedule", () => {
    const destinations = [{ binding: "FB_MAIN", label: "Facebook Main", provider: "facebook", granted: true }];
    const ready = post({ destinationBindings: ["FB_MAIN"] });
    // The recorded bindings are the default pick — the primary names them.
    expect(footerState("en", ready as never, { destinations }).primary).toMatchObject({
      disabled: false,
      label: "Publish to Facebook Main"
    });
    // Two picked destinations name the count, not a guess at either.
    expect(footerState("en", ready as never, { destinations, picked: ["FB_MAIN", "IG_MAIN"] }).primary.label).toBe("Publish to 2 accounts");
    // An emptied pick is honest — publish to nothing files nothing.
    expect(footerState("en", ready as never, { destinations, picked: [] }).primary).toMatchObject({
      disabled: true,
      reason: "Choose a destination account before publishing."
    });
    // A chosen time is the schedule intent — the press itself carries it.
    expect(footerState("en", ready as never, { destinations, scheduledAt: "2026-09-18T11:00" }).primary).toMatchObject({
      disabled: false,
      label: "Schedule for 2026-09-18 11:00"
    });
    // A busy image still blocks the press.
    expect(footerState("en", post({
      destinationBindings: ["FB_MAIN"],
      generation: { id: "gen_1", base: 2, needs: { image: true, caption: false } }
    }) as never, { destinations }).primary.reason).toBe("The image is generating in place. Publish when it finishes.");
  });

  it("a destination that cannot take the post is named on its own row, and dropped from what files", () => {
    const destinations = [
      { binding: "FB_MAIN", label: "Facebook Main", provider: "facebook", granted: true },
      { binding: "IG_MAIN", label: "Instagram Main", provider: "instagram", granted: false }
    ];
    const item = post({ destinationBindings: ["FB_MAIN", "IG_MAIN"] });
    // The revoked grant blocks its own row…
    expect(destinationBlock(item as never, {}, destinations as never, "IG_MAIN")).toBe("publishAccessRevoked");
    expect(destinationBlock(item as never, {}, destinations as never, "FB_MAIN")).toBeNull();
    // …and cannot silently join what the primary files.
    expect(footerState("en", item as never, { destinations: destinations as never }).primary.label).toBe("Publish to Facebook Main");
    // A PNG heading only to Instagram is told why before the press.
    const png = post({ destinationBindings: ["IG_MAIN"], generatedImage: { id: "gm_a", ready: true, mimeType: "image/png" } });
    const igOnly = [{ binding: "IG_MAIN", label: "Instagram", provider: "instagram", granted: true }];
    expect(destinationBlock(png as never, {}, igOnly as never, "IG_MAIN")).toBe("drawerDestNeedsJpeg");
    expect(footerState("en", png as never, { destinations: igOnly as never }).primary.disabled).toBe(true);
    // And no image at all cannot go to Instagram either.
    const bare = post({ destinationBindings: ["IG_MAIN"], generatedImage: null, acceptedVisualMode: null });
    expect(destinationBlock(bare as never, {}, igOnly as never, "IG_MAIN")).toBe("drawerDestIgNeedsImage");
  });

  it("a publication pick or a chosen time is never unsaved content", () => {
    const item = post({ destinationBindings: ["FB_MAIN"] });
    // Destination picks and the schedule field live in the footer's transient
    // state — neither is a buffer, so neither counts toward unsaved changes.
    expect(dirtyParts(item as never, {})).toMatchObject({ any: false });
    expect(dirtyParts(item as never, {}).publication).toBeUndefined();
    // Removing the accepted visual IS a revision change — it writes a clear.
    expect(revisionEntryFor(item as never, { visualMode: null })).toEqual({
      batchItemId: "item-1",
      expectedRevision: 2,
      acceptedVisualMode: null
    });
  });
});

describe("Reference section", () => {
  it("owns its adopt affordance — the same action the Post tab's add menu carries", async () => {
    const adopted: string[] = [];
    const sourceItem = { text: "Weekend Omega-3 tray", authorHandle: "essentialfoodsofficial", media: [{ id: "m1", kind: "image" }] };
    const root = renderReferencePanel("en", post({ sourceItem }) as never, {
      editable: true,
      imageRefsAvailable: true,
      onAdoptSource: () => adopted.push("reference")
    } as never);
    expect(root.textContent).toContain("Source image");
    const adopt = buttonNamed(root, "Use the post's own picture")!;
    await adopt.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["reference"]);
    // The Post tab's add menu carries the same choice, the same rule.
    const output = renderOutputPanel("en", post({ sourceItem }) as never, {
      editable: true,
      buffers: {},
      imageRefsAvailable: true,
      strip: { menuOpen: true, onMenuAdoptSource: () => adopted.push("reference") }
    } as never);
    await buttonNamed(output, "Use the post's own picture")!.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["reference", "reference"]);
    // Already the adopted source, or no usable picture: disabled, not hidden.
    const adoptedAlready = renderReferencePanel("en", post({ sourceItem, acceptedVisualMode: "keep_original" }) as never, {
      editable: true, imageRefsAvailable: true, onAdoptSource: () => adopted.push("again")
    } as never);
    expect(buttonNamed(adoptedAlready, "Use the post's own picture")!.disabled).toBe(true);
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

  it("carries the generation brief — price, reference toggle, ratio, this-run instruction", async () => {
    const patched: Record<string, unknown>[] = [];
    const root = renderInstructionsPanel("en", post() as never, {
      editable: true,
      buffers: {},
      policy: {},
      imageBrief: { useSource: true, ratio: "4:5", oneOffOpen: true, oneOff: "Warmer light", saveOneOff: false },
      imageRefsAvailable: true,
      onPatchImageBrief: (patch: Record<string, unknown>) => patched.push(patch)
    } as never);
    // The price line leads the fields.
    expect(root.textContent).toContain("priced as an edit");
    expect(root.textContent).toContain("Start from the post's image");
    // The ratio chips and the this-run field with its save-as-post offer.
    const ratios = all(root, (e) => String(e.className).split(" ").includes("sl-brief-ratio"));
    expect(ratios.map((r) => String(r.textContent))).toEqual(["Match the post (4:5)", "Square (1:1)", "Story (9:16)"]);
    const once = all(root, (e) => e.getAttribute("id") === "sl-brief-once")[0] as Node & { value: string };
    expect(once.value).toBe("Warmer light");
    expect(root.textContent).toContain("Also save as this post's instruction");
    expect(root.textContent).toContain("In effect:");
    await ratios[1].dispatchEvent({ type: "click" });
    expect(patched).toEqual([{ ratio: "1:1" }]);
    // The Output tab no longer carries the settings panel.
    const out = renderOutputPanel("en", post() as never, { editable: true, buffers: {} } as never);
    expect(all(out, (e) => String(e.className).includes("sl-brieftab"))).toHaveLength(0);
    expect(all(out, (e) => String(e.className).includes("sl-brief-ratio"))).toHaveLength(0);
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
