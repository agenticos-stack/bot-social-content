// Audit F03: Review shows — and files — the visual the drawer accepted.
// Content → drawer → Review must agree on image, caption and revision.
import { describe, expect, it } from "vitest";
import { createWizardState, renderPublish, setBatch, submitItemEnabled, acceptedVisualOf } from "../../src/src/client/steps.js";
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

function review(item: Record<string, unknown>) {
  installMinimalDom();
  const loads: string[] = [];
  const root = (globalThis as unknown as { document: { createElement(tag: string): unknown } }).document.createElement("div");
  let wizard = setBatch(createWizardState(), { id: "batch1", items: [item] as never });
  wizard = { ...wizard, publishChoices: { item1: { bindings: ["DEST_A"], intent: { publishMode: "publish_now", latePolicy: "hold" } } } } as never;
  renderPublish(root as never, wizard as never, {
    locale: "en",
    summary: { destinations },
    policy: {},
    handlers: {
      loadGeneratedImage: async (id: string) => { loads.push(id); return { url: `blob:${id}`, mime: "image/jpeg" }; },
      onOpenSettings() {}, onRefreshGrants() {}, onToggleBinding() {},
      onPublishIntent() {}, onEditCaption() {}, onSubmitItem() {},
      onRetry() {}, onCheckManually() {}, onBack() {}
    }
  } as never);
  return { root, wizard, loads };
}

const text = (root: unknown) =>
  findAll(root as never, () => true).map((e: { textContent?: string }) => e.textContent ?? "").join(" ");
const images = (root: unknown) =>
  findAll(root as never, (e: { tagName?: string }) => e.tagName === "IMG") as unknown as { src?: string; getAttribute(n: string): string | null }[];

describe("Review represents the accepted output (F03)", () => {
  it("draws the drawer's accepted generated image, by its stored id, beside the saved caption", async () => {
    const { root, wizard, loads } = review(
      itemWith({ acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_7", ready: true, altText: "A bowl of oats" } })
    );
    await flushAsyncWork();
    expect(loads).toEqual(["gm_7"]);
    const img = images(root)[0];
    expect(img.src ?? img.getAttribute("src")).toBe("blob:gm_7");
    expect(text(root)).toContain("第二稿內容文字");
    expect(text(root)).not.toContain("No poster yet");
    expect(acceptedVisualOf(wizard.batch.items[0], wizard.drafts.item1)).toBe("ai_refinement");
  });

  it("says a generated image is not ready and blocks filing, instead of an empty poster slot", () => {
    const { root, wizard, loads } = review(
      itemWith({ acceptedVisualMode: "ai_refinement", generatedImage: { id: "gm_8", ready: false } })
    );
    expect(loads).toEqual([]);
    expect(text(root)).toContain("Generated image not ready");
    expect(submitItemEnabled(wizard as never, "item1", {}, destinations)).toBe(false);
  });

  it("names a destination that was never filed as not submitted, not as a post with no saved revision", () => {
    const { root } = review(itemWith({ acceptedVisualMode: "keep_original" }));
    expect(text(root)).toContain("Not submitted to this destination yet");
    expect(text(root)).not.toContain("No saved revision");
  });
});
