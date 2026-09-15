// One dialog, two prompts in a row: Regenerate image asks to replace the
// pending request, then about unsaved instructions. A dialog's `close` event
// arrives after `close()` returns, so the first prompt's close reaches the
// second prompt. It must not answer it.
import { beforeEach, describe, expect, it } from "vitest";
import { confirmDrawerChoice } from "../../src/src/client/drawer.js";
import { findAll, flushAsyncWork, installMinimalDom } from "./_helpers/minimal-dom";

let document: { createElement(tag: string): unknown };

beforeEach(() => {
  ({ document } = installMinimalDom() as unknown as { document: { createElement(tag: string): unknown } });
});

type Clickable = { getAttribute(name: string): string | null; dispatchEvent(event: unknown): Promise<void> };
const choiceButton = (dialog: unknown, value: string) =>
  findAll(dialog as never, (node: { tagName?: string; getAttribute?: (n: string) => string | null }) => node.tagName === "BUTTON" && node.getAttribute?.("data-choice") === value)[0] as unknown as Clickable;

describe("confirmDrawerChoice on a shared dialog", () => {
  it("the first prompt's late close does not cancel the prompt that follows it", async () => {
    const dialog = document.createElement("dialog") as { open: boolean };
    const first = confirmDrawerChoice(dialog, {
      title: "Replace the pending request?",
      body: "",
      choices: [{ value: "cancel", label: "Cancel" }, { value: "replace", label: "Replace", primary: true }]
    });
    await choiceButton(dialog, "replace").dispatchEvent({ type: "click" });
    expect(await first).toBe("replace");

    // Opened straight away, before the first close event has been delivered.
    let secondAnswer: string | null = null;
    const second = confirmDrawerChoice(dialog, {
      title: "Your instruction edits are not saved",
      body: "",
      choices: [{ value: "cancel", label: "Cancel" }, { value: "save", label: "Save instructions and generate", primary: true }]
    }).then((value) => { secondAnswer = value; return value; });
    // A browser delivers the first prompt's `close` as a later task, after the
    // second prompt has attached its own listener and reopened the dialog.
    // The DOM shim dispatches synchronously, so that ordering is recreated here.
    expect(dialog.open).toBe(true);
    await (dialog as unknown as { dispatchEvent(event: unknown): Promise<void> }).dispatchEvent({ type: "close" });
    await flushAsyncWork();
    expect(secondAnswer).toBeNull();
    expect(dialog.open).toBe(true);

    await choiceButton(dialog, "save").dispatchEvent({ type: "click" });
    expect(await second).toBe("save");
  });

  it("a real dismissal still answers cancel", async () => {
    const dialog = document.createElement("dialog") as { open: boolean; close(): void };
    const pending = confirmDrawerChoice(dialog, {
      title: "Your instruction edits are not saved",
      body: "",
      choices: [{ value: "cancel", label: "Cancel" }, { value: "save", label: "Save", primary: true }]
    });
    dialog.close();
    await flushAsyncWork();
    expect(await pending).toBe("cancel");
  });
});
