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

/** A projected page row, shaped like projectBatchItem's `pages[]` entries. */
function pg(pageId: string, kind: string | null, mediaId: string | null, extra: Record<string, unknown> = {}) {
  return {
    pageId, kind, mediaId, sourceMediaId: null, altText: null,
    mediaProvenance: null, mediaAcceptance: null,
    generatedMedia: null, candidate: null,
    ...extra
  };
}

function post(overrides: Record<string, unknown> = {}) {
  const merged: Record<string, any> = {
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
    sourceItem: { id: "src-1", text: "Reference text", media: [{ id: "m1", kind: "image", url: "https://example/m1.jpg" }] },
    instructionOverrides: { image: null, caption: null },
    publications: [],
    deliveries: [],
    ...overrides
  };
  if (merged.pages === undefined) {
    // What the server projects for this shape: a saved ai_refinement post is
    // one generated page; keep_original is one page per source child; a post
    // with no pick yet is one empty page per bindable child.
    const media = (merged.sourceItem?.media ?? []).filter((m: any) => m?.kind === "image" || m?.kind === "carousel_child");
    if (merged.generatedImage) {
      merged.pages = [pg("pg_1", "generated", merged.generatedImage.id, {
        sourceMediaId: "m1",
        generatedMedia: merged.generatedImage,
        candidate: merged.generatedCandidate && merged.generatedCandidate.id !== merged.generatedImage.id ? merged.generatedCandidate : null
      })];
    } else if (merged.acceptedVisualMode === "keep_original" && media.length) {
      merged.pages = media.map((m: any, i: number) => pg(`pg_src_${m.id}`, "original", m.id, { sourceMediaId: m.id }));
    } else if (media.length) {
      merged.pages = media.map((m: any) => pg(`pg_src_${m.id}`, null, null, { sourceMediaId: m.id }));
    } else {
      merged.pages = [pg("pg_1", null, null)];
    }
  }
  return merged;
}

function output(item: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const loads: string[] = [];
  const staged: Array<[string | null, string | null]> = [];
  const parts: string[] = [];
  const root = renderOutputPanel("en", item as never, {
    editable: true,
    saving: false,
    buffers: {},
    loadImage: (generated: { id: string }) => loads.push(generated.id),
    // Stage is per page: (pageId, mediaId) — null mediaId unstages that page.
    onStageImage: (pageId: string, id: string | null) => staged.push([pageId, id]),
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

    await buttonNamed(view.root, "Use")!.dispatchEvent({ type: "click" });
    expect(view.staged).toEqual([["pg_1", "gm_b"]]);

    // The staged candidate lands in the page list the save writes — the
    // legacy singular fields stay out of the entry entirely.
    expect(revisionEntryFor(item as never, {
      pages: [{ pageId: "pg_1", kind: "generated", mediaId: "gm_b", sourceMediaId: "m1", altText: null, mediaDigest: null, mediaProvenance: null, mediaAcceptance: null }]
    })).toEqual({
      batchItemId: "item-1",
      expectedRevision: 2,
      pages: [{ pageId: "pg_1", kind: "generated", mediaId: "gm_b", sourceMediaId: "m1", altText: null, mediaDigest: null, mediaProvenance: null, mediaAcceptance: null }]
    });
  });

  it("renders the accepted image with one ⋯ menu and no set furniture", () => {
    const view = output(post(), { imageRefsAvailable: true, strip: { menuOpen: true, menuAnchor: "pg_1" } });
    const slots = all(view.root, (e) => {
      const cls = String(e.className).split(" ");
      return cls.includes("sl-slot") && !cls.includes("sl-slot-candidate");
    });
    expect(slots).toHaveLength(1);
    // A single picture is not a set: no number badge, no "Cover" caption,
    // and no second empty tile — that furniture names an ordered collection.
    expect(view.root.textContent).not.toContain("Cover");
    expect(all(view.root, (e) => String(e.className).includes("sl-slot-num"))).toHaveLength(0);
    // One ⋯ on the picture is the whole per-image action surface — nothing
    // in the column header, no hover bar, no second tile.
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-picbtn"))).toHaveLength(1);
    const leads = all(view.root, (e) => String(e.className).split(" ").includes("sl-menu-lead")).map((s) => String(s.textContent));
    expect(leads).toEqual(["Regenerate…", "Upload a replacement…", "Use the original image", "View", "Remove page"]);
    // Removal is the danger row.
    const remove = buttons(view.root).find((b) => String(b.textContent).includes("Remove page"));
    expect(String(remove!.className)).toContain("sl-menu-danger");
    // A fresh generate from the same brief is never offered on an existing
    // picture — Regenerate… is the ask that names what is wrong first.
    expect(buttonNamed(view.root, "Generate a new image")).toBeUndefined();
  });

  it("the strip still renders one slot when only a legacy visual exists", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: "keep_original" }));
    expect(view.root.textContent).toContain("Source image");
    expect(all(view.root, (e) => String(e.className).includes("sl-picbtn")).length).toBeGreaterThan(0);
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

  it("marks the empty slot as live while its page generates, not with a compact note", () => {
    const view = output(post({
      generatedImage: null,
      acceptedVisualMode: null,
      generation: { id: "gen_1", base: 0, needs: { image: true, caption: false } }
    }));
    // The mark names no page scope — a pre-pages "the image" need — so the
    // post's only page reads live: its dashed frame carries the arriving
    // label and its ⋯ stays out of reach.
    const empty = all(view.root, (e) => String(e.className).includes("sl-slot-frame-empty"));
    expect(empty).toHaveLength(1);
    expect(all(empty[0], (e) => String(e.className).includes("sl-skel-label"))).toHaveLength(1);
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-picbtn"))).toHaveLength(0);
    expect(view.loads).toEqual([]);
  });

  it("an empty page IS a page — dashed, numbered, with its own ⋯; the add tile grows the list", async () => {
    const toggles: string[] = [];
    const view = output(post({ generatedImage: null, acceptedVisualMode: null, generation: null }), {
      strip: { menuOpen: false, onToggleMenu: (pageId: string) => toggles.push(pageId) }
    });
    expect(all(view.root, (e) => String(e.className).includes("sl-skel-label"))).toHaveLength(0);
    const empty = all(view.root, (e) => String(e.className).split(" ").includes("sl-slot-frame-empty"));
    expect(empty).toHaveLength(1);
    expect(String(empty[0].textContent)).toContain("Page 1 — empty");
    // Growth is its own explicit tile, never a side effect.
    const addPage = all(view.root, (e) => String(e.className).split(" ").includes("sl-addpage"));
    expect(addPage).toHaveLength(1);
    expect(String(addPage[0].textContent)).toContain("＋");
    expect(String(addPage[0].textContent)).toContain("Add a page");
    // The empty page's own ⋯ opens its menu — generate, upload, adopt, remove.
    const picbtn = all(view.root, (e) => String(e.className).split(" ").includes("sl-picbtn"));
    expect(picbtn).toHaveLength(1);
    await picbtn[0].dispatchEvent({ type: "click" });
    expect(toggles).toEqual(["pg_src_m1"]);
  });

  it("does not overlay when the request was never submitted", () => {
    const view = output(post({
      generatedImage: null,
      acceptedVisualMode: null,
      generation: { id: "gen_1", base: 0, needs: { image: true, caption: false } }
    }), { unsubmitted: true });
    expect(all(view.root, (e) => String(e.className).includes("sl-skel-label"))).toHaveLength(0);
    // Unsubmitted is not "generating": the page's ⋯ and the add tile are usable.
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-picbtn"))).toHaveLength(1);
    const addPage = all(view.root, (e) => String(e.className).split(" ").includes("sl-addpage"))[0];
    expect(addPage.disabled).toBe(false);
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

  it("an empty page's menu offers Generate, Upload and the post's own picture", async () => {
    const adopted: Array<[unknown, unknown]> = [];
    const uploaded: unknown[] = [];
    const generated: unknown[] = [];
    const view = output(post({ generatedImage: null, acceptedVisualMode: null }), {
      imageRefsAvailable: true,
      strip: {
        menuOpen: true,
        menuAnchor: "pg_src_m1",
        onMenuGenerate: (slot: unknown) => generated.push(slot),
        onMenuAdoptSource: (slot: unknown, child: unknown) => adopted.push([slot, child]),
        onMenuUpload: (slot: unknown) => uploaded.push(slot)
      }
    });
    const generate = buttonNamed(view.root, "Generate a new image")!;
    expect(generate).toBeTruthy();
    // The row says the resolved brief it would run under.
    expect(generate.textContent).toContain("4:5");
    await generate.dispatchEvent({ type: "click" });
    expect(generated).toHaveLength(1);
    expect((generated[0] as { page: { pageId: string } }).page.pageId).toBe("pg_src_m1");
    await buttonNamed(view.root, "Upload an image")!.dispatchEvent({ type: "click" });
    expect((uploaded[0] as { page: { pageId: string } }).page.pageId).toBe("pg_src_m1");
    await buttonNamed(view.root, "Use the original image")!.dispatchEvent({ type: "click" });
    expect(adopted).toHaveLength(1);
    expect((adopted[0][0] as { page: { pageId: string } }).page.pageId).toBe("pg_src_m1");
    expect(adopted[0][1]).toBe("m1");
  });

  it("says so when the post has no usable picture to adopt", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: null, sourceItem: { id: "s", text: "", media: [] } }), {
      imageRefsAvailable: false,
      strip: { menuOpen: true, menuAnchor: "pg_1" }
    });
    const adopt = buttonNamed(view.root, "Use the original image")!;
    expect(adopt).toBeTruthy();
    expect(adopt.disabled).toBe(true);
    expect(adopt.textContent).toContain("no usable picture");
  });

  it("swaps the generate row's brief for the no-caption warning — a soft gate, not a block", () => {
    // An image made before the text exists is likely to be made again once
    // the brief changes: the row stays pressable and names the quality risk —
    // never a price, which the owner never weighs.
    const view = output(post({ caption: "", generatedImage: null, acceptedVisualMode: null }), { strip: { menuOpen: true, menuAnchor: "pg_src_m1" } });
    const row = buttonNamed(view.root, "Generate a new image")!;
    expect(row.disabled).toBe(false);
    const warn = all(row, (e) => String(e.className).split(" ").includes("sl-menu-warn"))[0];
    expect(warn?.textContent).toContain("No caption yet");
    expect(row.textContent).not.toContain("priced as");
    // A post that does have a caption keeps the brief summary — basis and
    // ratio, with no spend named anywhere.
    const captioned = output(post({ generatedImage: null, acceptedVisualMode: null }), { strip: { menuOpen: true, menuAnchor: "pg_src_m1" } });
    const captionRow = buttonNamed(captioned.root, "Generate a new image")!;
    expect(captionRow.textContent).toContain("From the post's image");
    expect(captionRow.textContent).toContain("4:5");
    expect(captionRow.textContent).not.toContain("priced as");
  });

  it("shows the chosen upload and adopting it calls onAdoptUpload", async () => {
    const adopted: string[] = [];
    const view = output(post(), {
      buffers: { imageSource: "upload" },
      uploadPreview: { name: "weekend-tray.jpg" },
      onAdoptUpload: () => adopted.push("upload")
    });
    expect(view.root.textContent).toContain("weekend-tray.jpg");
    await buttonNamed(view.root, "Use")!.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["upload"]);
  });

  it("saves Use reference as keep_original, not a generated image", () => {
    expect(revisionEntryFor(post() as never, { visualMode: "keep_original" })).toEqual({
      batchItemId: "item-1",
      expectedRevision: 2,
      acceptedVisualMode: "keep_original"
    });
  });

  it("offers image generation through the empty page's menu and Rewrite caption inline, each honest about what it keeps", async () => {
    const generated: unknown[] = [];
    const view = output(post({ generatedImage: null, acceptedVisualMode: null }), {
      strip: { menuOpen: true, menuAnchor: "pg_src_m1", onMenuGenerate: (slot: unknown) => generated.push(slot) }
    });
    const image = buttonNamed(view.root, "Generate a new image")!;
    const caption = buttonNamed(view.root, "Rewrite caption")!;
    expect(caption.getAttribute("title")).toContain("Keeps the accepted image.");
    await image.dispatchEvent({ type: "click" });
    await caption.dispatchEvent({ type: "click" });
    expect((generated[0] as { page: { pageId: string } }).page.pageId).toBe("pg_src_m1");
    expect(view.parts).toEqual(["caption"]);
  });

  it("offers no second ask while the image request runs — no page ⋯ and the add tile disabled", () => {
    const view = output(post({ generation: { id: "gen_1", base: 2, needs: { image: true, caption: false } } }), { strip: { menuOpen: true, menuAnchor: "pg_1" } });
    expect(view.root.textContent).not.toContain("waiting for the agent");
    expect(view.root.textContent).not.toContain("An image request is still pending for this post.");
    // There is nothing to act on while the post's image need is outstanding:
    // no ⋯ trigger, so no Generate row exists to double the spend — and
    // adding a page waits for the run to settle.
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-picbtn"))).toHaveLength(0);
    const addPage = all(view.root, (e) => String(e.className).split(" ").includes("sl-addpage"))[0];
    expect(addPage === undefined || addPage.disabled).toBe(true);
    expect(buttonNamed(view.root, "Generate a new image")).toBeUndefined();
    // The caption side still names what is outstanding rather than looking
    // like an unfilled form.
    const caption = buttonNamed(view.root, "Rewrite caption")!;
    expect(caption.disabled).toBe(false);
    expect(caption.getAttribute("data-pending")).toBe("image");
    expect(caption.getAttribute("title")).toContain("image request is still pending");
    expect(view.loads).toEqual(["gm_a"]);
  });

  it("keeps the generate row honest while the other part is pending — marked, still pressable", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: null, generation: { id: "gen_1", base: 2, needs: { image: false, caption: true } } }), {
      strip: { menuOpen: true, menuAnchor: "pg_src_m1" }
    });
    const image = buttonNamed(view.root, "Generate a new image")!;
    expect(image.disabled).toBe(false);
    expect(image.getAttribute("data-pending")).toBe("caption");
    expect(image.getAttribute("title")).toContain("caption request is still pending");
    const caption = buttonNamed(view.root, "Rewrite caption")!;
    expect(caption.getAttribute("data-requested")).toBe("true");
    expect(caption.getAttribute("title")).toContain("Already requested");
  });

  it("the ⋯ Regenerate… row hands the page to the host's conversation — or says why it cannot", async () => {
    const slots: unknown[] = [];
    const view = output(post(), { strip: { menuOpen: true, menuAnchor: "pg_1", agentIntent: true, onRegenIntent: (slot: unknown) => slots.push(slot) } });
    const row = buttonNamed(view.root, "Regenerate…")!;
    expect(row.disabled).toBe(false);
    expect(row.textContent).toContain("Say what should change in the conversation");
    await row.dispatchEvent({ type: "click" });
    expect(slots).toHaveLength(1);
    // The hand-off names THIS page — its id and its place in the strip.
    expect((slots[0] as { page: { pageId: string }; index: number }).page.pageId).toBe("pg_1");
    expect((slots[0] as { page: { pageId: string }; index: number }).index).toBe(1);
    // A host that never announced the contract: the row stays visible but
    // disabled, naming the reason — no inline fallback ever renders.
    const off = output(post(), { strip: { menuOpen: true, menuAnchor: "pg_1", agentIntent: false } });
    const dead = buttonNamed(off.root, "Regenerate…")!;
    expect(dead.disabled).toBe(true);
    expect(dead.textContent).toContain("This workspace can't open the conversation.");
    expect(all(off.root, (e) => String(e.className).split(" ").includes("sl-regen"))).toHaveLength(0);
    expect(off.root.textContent).not.toContain("What should change about image");
    // Funding is never weighed in the drawer — no price copy anywhere.
    expect(view.root.textContent).not.toContain("credit");
    expect(view.root.textContent).not.toContain("One generation");
  });

  it("has no visual-mode radios: no text poster, no source photo as output", () => {
    const view = output(post({ generatedImage: null, acceptedVisualMode: null }));
    const visual = all(view.root, (e) => e.tagName === "INPUT" && String(e.getAttribute("name") ?? "").includes("visual"));
    expect(visual).toHaveLength(0);
    expect(all(view.root, (e) => String(e.className).split(" ").includes("sl-addpage"))).toHaveLength(1);
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
      strip: { menuOpen: true, menuAnchor: "pg_1", agentIntent: true }
    } as never);
    // The picture's ⋯ menu — regenerate is the conversation, not a blind retry.
    expect(root.textContent).toContain("重新生成…");
    expect(root.textContent).toContain("在對話說明要改之處");
    expect(root.textContent).toContain("上載替換…");
    expect(root.textContent).toContain("改用原帖圖片");
    expect(root.textContent).toContain("檢視");
    expect(root.textContent).toContain("移除此頁");
    expect(root.textContent).toContain("重新撰寫文案");
    // No image yet — the page is a dashed slot, the add tile its own control.
    const empty = renderOutputPanel("zh-HK", post({ generatedImage: null, acceptedVisualMode: null }) as never, {
      editable: true,
      buffers: {},
      strip: { menuOpen: true, menuAnchor: "pg_src_m1" }
    } as never);
    expect(empty.textContent).toContain("第 1 頁 — 空白");
    expect(empty.textContent).toContain("新增一頁");
    expect(empty.textContent).toContain("生成新圖片");
    expect(empty.textContent).toContain("改用原帖圖片");
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
    // An unfilled page blocks the review — named by its own number.
    expect(footerState("en", post({ generatedImage: null, acceptedVisualMode: null }) as never, {}).review).toEqual({
      disabled: true,
      reason: "Page 1 has no image — fill it or remove the page."
    });
    expect(footerState("en", post({ generatedImage: { id: "gm_a", ready: false } }) as never, {}).review.reason).toBe(
      "The accepted image has not arrived yet."
    );
    // A staged ready candidate is what publish will file once saved — the
    // staged page list carries it.
    expect(footerState("en", post({
      generatedImage: null,
      generatedCandidate: { id: "gm_b", ready: true },
      publicationIntent: { publishMode: "publish_now" },
      destinationBindings: ["FB_MAIN"]
    }) as never, {
      buffers: { pages: [{ pageId: "pg_src_m1", kind: "generated", mediaId: "gm_b", sourceMediaId: "m1", altText: null, mediaDigest: null, mediaProvenance: null, mediaAcceptance: null }] }
    }).review.disabled).toBe(false);
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
    const adopt = buttonNamed(root, "Use original")!;
    await adopt.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["reference"]);
    // The Post tab's page menu carries the same choice, the same rule.
    const output = renderOutputPanel("en", post({ sourceItem }) as never, {
      editable: true,
      buffers: {},
      imageRefsAvailable: true,
      strip: { menuOpen: true, menuAnchor: "pg_1", onMenuAdoptSource: () => adopted.push("reference") }
    } as never);
    await buttonNamed(output, "Use the original image")!.dispatchEvent({ type: "click" });
    expect(adopted).toEqual(["reference", "reference"]);
    // Already the adopted source — every bindable child is an original page —
    // or no usable picture: disabled, not hidden.
    const adoptedAlready = renderReferencePanel("en", post({ sourceItem, acceptedVisualMode: "keep_original", generatedImage: null }) as never, {
      editable: true, imageRefsAvailable: true, onAdoptSource: () => adopted.push("again")
    } as never);
    expect(buttonNamed(adoptedAlready, "Use original")!.disabled).toBe(true);
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

  it("carries the generation brief — reference toggle, ratio, and no run layer or price", async () => {
    const patched: Record<string, unknown>[] = [];
    const root = renderInstructionsPanel("en", post() as never, {
      editable: true,
      buffers: {},
      policy: {},
      imageBrief: { useSource: true, ratio: "4:5", oneOff: "", saveOneOff: false },
      imageRefsAvailable: true,
      onPatchImageBrief: (patch: Record<string, unknown>) => patched.push(patch)
    } as never);
    // Funding is never a field here — no price line anywhere in the brief.
    expect(root.textContent).not.toContain("priced as");
    expect(root.textContent).toContain("Start from the post's image");
    const ratios = all(root, (e) => String(e.className).split(" ").includes("sl-brief-ratio"));
    expect(ratios.map((r) => String(r.textContent))).toEqual(["Match the post (4:5)", "Square (1:1)", "Story (9:16)"]);
    // A per-run correction is the regenerate conversation's, not a field that
    // waits here for a request that may never be asked.
    expect(all(root, (e) => e.getAttribute("id") === "sl-brief-once")).toHaveLength(0);
    expect(root.textContent).not.toContain("Adjust for this run");
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
