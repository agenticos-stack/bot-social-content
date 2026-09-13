import { describe, expect, it, vi } from "vitest";
import { confirmUnsavedNavigation } from "../../src/src/client/navigation.js";
import {
  createInboxState,
  renderInbox,
  setInboxSummaries
} from "../../src/src/client/inbox.js";
import { findAll, installMinimalDom } from "./_helpers/minimal-dom";

describe("unsaved navigation decisions", () => {
  it("resolves Escape as keep, cleans listeners, and can reopen", async () => {
    const { document } = installMinimalDom();
    const dialog = document.createElement("dialog");
    const first = confirmUnsavedNavigation(dialog, "en");
    expect(confirmUnsavedNavigation(dialog, "en")).toBe(first);
    const preventDefault = vi.fn();
    await dialog.dispatchEvent({ type: "cancel", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await expect(first).resolves.toBe("keep");
    expect(dialog.open).toBe(false);
    const second = confirmUnsavedNavigation(dialog, "en");
    const save = findAll(dialog, (el) => el.tagName === "BUTTON").find((el) => el.textContent === "Save and leave")!;
    await save.dispatchEvent({ type: "click" });
    await expect(second).resolves.toBe("save");
  });

  it("settles platform/programmatic close without a button click", async () => {
    const { document } = installMinimalDom();
    const dialog = document.createElement("dialog");
    const decision = confirmUnsavedNavigation(dialog, "en");
    dialog.close();
    await expect(decision).resolves.toBe("keep");
  });

  it.each([
    ["Keep editing", "keep"],
    ["Discard changes", "discard"],
    ["Save and leave", "save"]
  ])("%s resolves exactly its intended choice", async (label, expected) => {
    const { document } = installMinimalDom();
    const dialog = document.createElement("dialog");
    const decision = confirmUnsavedNavigation(dialog, "en");
    const button = findAll(dialog, (el) => el.tagName === "BUTTON").find((el) => el.textContent === label)!;
    await button.dispatchEvent({ type: "click" });
    await expect(decision).resolves.toBe(expected);
    expect(dialog.open).toBe(false);
  });

  it("keeps editing if the dialog cannot open", async () => {
    const { document } = installMinimalDom();
    const dialog = document.createElement("dialog");
    dialog.showModal = () => {
      throw new Error("not available");
    };
    await expect(confirmUnsavedNavigation(dialog, "en")).resolves.toBe("keep");
  });
});

describe("saved card facts", () => {
  it("renders saved metadata independently of the current source page", () => {
    const { document } = installMinimalDom();
    const root = document.createElement("main");
    const state = setInboxSummaries(createInboxState(), {
      batches: [
        {
          id: "batch",
          itemCount: 1,
          draftCount: 1,
          sourceItemIds: ["not-on-page"],
          lastUpdatedAt: "2026-09-06T12:00:00Z",
          preview: {
            sourceLabel: "Original account",
            sourceText: "Source text",
            caption: "Saved caption",
            revision: 7,
            hasMediaReference: true
          }
        }
      ]
    });
    renderInbox(
      root,
      { ...state, sourceItems: [{ id: "not-on-page", text: "Unsaved or newly fetched text" }] },
      { locale: "en", handlers: {} }
    );
    expect(root.textContent).toContain("Original account");
    expect(root.textContent).toContain("Saved caption");
    expect(root.textContent).toContain("Version 7");
    expect(root.textContent).not.toContain("Unsaved or newly fetched text");
  });

  it("does not infer a revision from an updated timestamp", () => {
    const { document } = installMinimalDom();
    const root = document.createElement("main");
    const state = setInboxSummaries(createInboxState(), {
      batches: [
        {
          id: "old",
          itemCount: 1,
          draftCount: 1,
          lastUpdatedAt: "2026-09-06T12:00:00Z"
        }
      ]
    });
    renderInbox(root, state, { locale: "en", handlers: {} });
    expect(root.textContent).toContain("No saved revision");
    expect(root.textContent).not.toContain("Revision saved");
  });
});
