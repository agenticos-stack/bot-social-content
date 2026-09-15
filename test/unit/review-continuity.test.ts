// Audit F03 and the d57d357 QA follow-up: Review shows — and files — the
// visual the drawer accepted, and submission waits until that image has
// actually rendered for the approver. Fixture coverage, not a browser proof.
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptedVisualOf,
  createWizardState,
  releaseReviewImages,
  renderPublish,
  reviewImageState,
  setBatch,
  submitItemEnabled
} from "../../src/src/client/steps.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom";

const destinations = [{ destinationBinding: "DEST_A", label: "Destination A", provider: "instagram", granted: true }];

function itemWith(overrides: Record<string, unknown>) {
  return {
    id: "item1",
    state: "drafting",
    sourceItem: { sourceLabel: "Synthetic source", provider: "instagram", text: "a post", id: "p1" },
    revision: 2,
    caption: "第二稿內容文字",
    destinationBindings: ["DEST_A"],
    publications: [{ destinationBinding: "DEST_A", revision: 0, state: "bound" }],
    ...overrides
  };
}

type Loader = (id: string) => Promise<{ url: string; mime: string }>;

/** Renders Review the way the client does: every image state change redraws. */
function review(item: Record<string, unknown>, loader: Loader) {
  const { document } = installMinimalDom() as unknown as { document: { createElement(tag: string): unknown } };
  const root = document.createElement("div");
  const loads: string[] = [];
  let wizard = setBatch(createWizardState(), { id: "batch1", items: [item] as never });
  wizard = { ...wizard, publishChoices: { item1: { bindings: ["DEST_A"], intent: { publishMode: "publish_now", latePolicy: "hold" } } } } as never;
  const view = { root, wizard, loads, renders: 0, draw: () => {} };
  const handlers = {
    loadGeneratedImage: (id: string) => { loads.push(id); return loader(id); },
    onReviewImageState: () => view.draw(),
    onOpenSettings() {}, onRefreshGrants() {}, onToggleBinding() {},
    onPublishIntent() {}, onEditCaption() {}, onSubmitItem() {},
    onRetry() {}, onCheckManually() {}, onBack() {}
  };
  view.draw = () => {
    view.renders += 1;
    renderPublish(root as never, view.wizard as never, { locale: "en", summary: { destinations }, policy: {}, handlers } as never);
  };
  view.draw();
  return view;
}

const text = (root: unknown) =>
  findAll(root as never, () => true).map((e: { textContent?: string }) => e.textContent ?? "").join(" ");
const images = (root: unknown) =>
  findAll(root as never, (e: { tagName?: string }) => e.tagName === "IMG") as unknown as { getAttribute(n: string): string | null; src?: string }[];
const buttonNamed = (root: unknown, label: string) =>
  (findAll(root as never, (e: { tagName?: string; textContent?: string }) => e.tagName === "BUTTON" && String(e.textContent).includes(label))[0]) as
    unknown as { dispatchEvent(event: unknown): void } | undefined;
const ok = (id: string) => Promise.resolve({ url: `blob:${id}`, mime: "image/jpeg" });

afterEach(() => releaseReviewImages());

describe("Review represents the accepted output (F03)", () => {
  it("draws the accepted generated image by its pinned id once it has rendered, and only then allows submit", async () => {
    const view = review(itemWith({ acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_7", ready: true, altText: "A bowl of oats" } }), ok);
    const item = view.wizard.batch.items[0];
    expect(text(view.root)).toContain("Loading the generated image for review");
    expect(submitItemEnabled(view.wizard as never, "item1", {}, destinations)).toBe(false);

    await flushAsyncWork();
    expect(view.loads).toEqual(["gm_7"]);
    expect(reviewImageState(item)).toBe("ready");
    const img = images(view.root)[0];
    expect(img.src ?? img.getAttribute("src")).toBe("blob:gm_7");
    expect(text(view.root)).toContain("第二稿內容文字");
    expect(submitItemEnabled(view.wizard as never, "item1", {}, destinations)).toBe(true);
    expect(acceptedVisualOf(item, view.wizard.drafts.item1)).toBe("ai_refinement");
  });

  it("a rendered PNG bound for a JPEG-only destination blocks submit until a JPEG copy is pinned", async () => {
    const view = review(itemWith({ acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_png", ready: true, mimeType: "image/png" } }), ok);
    await flushAsyncWork();
    expect(reviewImageState(view.wizard.batch.items[0])).toBe("ready");
    expect(submitItemEnabled(view.wizard as never, "item1", {}, destinations)).toBe(false);

    const pinned = itemWith({ acceptedVisualMode: "ai_refinement", revision: 3, generatedImage: { id: "gm_jpeg", ready: true, mimeType: "image/jpeg" } });
    const after = review(pinned, ok);
    await flushAsyncWork();
    expect(submitItemEnabled(after.wizard as never, "item1", {}, destinations)).toBe(true);
  });

  it("a stored image whose preview fails blocks submit and offers a retry that loads it again", async () => {
    let fail = true;
    const view = review(
      itemWith({ acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_9", ready: true } }),
      (id) => (fail ? Promise.reject(new Error("attachment read failed")) : ok(id))
    );
    await flushAsyncWork();
    expect(text(view.root)).toContain("could not be shown");
    expect(submitItemEnabled(view.wizard as never, "item1", {}, destinations)).toBe(false);

    fail = false;
    buttonNamed(view.root, "Load image again")!.dispatchEvent({ type: "click" });
    await flushAsyncWork();
    expect(view.loads).toEqual(["gm_9", "gm_9"]);
    expect(submitItemEnabled(view.wizard as never, "item1", {}, destinations)).toBe(true);
  });

  it("a load that finishes after the accepted asset changed cannot unlock the newer image", async () => {
    let release!: (value: { url: string; mime: string }) => void;
    const view = review(
      itemWith({ acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_old", ready: true } }),
      (id) => (id === "gm_old" ? new Promise((resolve) => { release = resolve; }) : new Promise(() => {}))
    );
    // The owner picked a newer image (new revision) before the old one loaded.
    view.wizard = setBatch(createWizardState(), {
      id: "batch1",
      items: [itemWith({ revision: 3, acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_new", ready: true } })] as never
    }) as never;
    view.wizard = { ...view.wizard, publishChoices: { item1: { bindings: ["DEST_A"], intent: { publishMode: "publish_now", latePolicy: "hold" } } } } as never;
    view.draw();
    release({ url: "blob:gm_old", mime: "image/jpeg" });
    await flushAsyncWork();
    expect(reviewImageState(view.wizard.batch.items[0])).toBe("loading");
    expect(submitItemEnabled(view.wizard as never, "item1", {}, destinations)).toBe(false);
  });

  it("says a generated image is not stored yet and blocks filing, instead of an empty poster slot", () => {
    const view = review(itemWith({ acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_8", ready: false } }), ok);
    expect(view.loads).toEqual([]);
    expect(text(view.root)).toContain("Generated image not ready");
    expect(submitItemEnabled(view.wizard as never, "item1", {}, destinations)).toBe(false);
  });

  it("names a destination that was never filed as not submitted, not as a post with no saved revision", () => {
    const view = review(itemWith({ acceptedVisualMode: "keep_original" }), ok);
    expect(text(view.root)).toContain("Not submitted to this destination yet");
    expect(text(view.root)).not.toContain("No saved revision");
  });
});
