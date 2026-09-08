import { el, replace } from "./dom.js";
import { t } from "./i18n.js";

// One decision per open dialog, including repeated navigation clicks.
const pendingDecisions = new WeakMap();

export function confirmUnsavedNavigation(dialog, locale) {
  const pending = pendingDecisions.get(dialog);
  if (pending) return pending;
  let resolveDecision;
  const decision = new Promise((resolve) => {
    resolveDecision = resolve;
  });
  pendingDecisions.set(dialog, decision);
  let settled = false;
  function finish(value) {
    if (settled) return;
    settled = true;
    dialog.removeEventListener("cancel", cancel);
    dialog.removeEventListener("close", close);
    pendingDecisions.delete(dialog);
    if (dialog.open) dialog.close();
    resolveDecision(value);
  }
  function cancel(event) {
    event.preventDefault();
    finish("keep");
  }
  function close() {
    finish("keep");
  }
  replace(dialog, [
    el("div", { class: "sl-preview-sheet" }, [
      el("header", { class: "sl-preview-head" }, [el("strong", null, t(locale, "unsavedTitle"))]),
      el("div", { class: "sl-preview-scroll" }, [el("p", null, t(locale, "unsavedBody"))]),
      el(
        "footer",
        { class: "sl-preview-actions" },
        [
          ["keep", "keepEditing"],
          ["discard", "discardChanges"],
          ["save", "saveAndLeave"]
        ].map(([value, label]) =>
          el(
            "button",
            {
              type: "button",
              class: value === "save" ? "sl-primary" : "sl-secondary",
              onclick: () => finish(value)
            },
            t(locale, label)
          )
        )
      )
    ])
  ]);
  dialog.addEventListener("cancel", cancel);
  dialog.addEventListener("close", close);
  try {
    dialog.showModal();
  } catch {
    finish("keep");
  }
  return decision;
}
