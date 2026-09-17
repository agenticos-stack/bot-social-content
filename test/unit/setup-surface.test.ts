// The Settings surface — renderSetup against the minimal DOM, asserting the
// accepted component-study structure (borderless sections, one monitoring
// switch, quiet-hours off/on row) and the unchanged write payload.
import { beforeEach, describe, expect, it } from "vitest";
import { findAll, installMinimalDom } from "./_helpers/minimal-dom";
import { createSetupDraft, draftFromConfig, renderSetup } from "../../src/src/client/steps.js";
import { t } from "../../src/src/client/i18n.js";

type Node = {
  tagName?: string; textContent?: string; className?: string; disabled?: boolean; checked?: boolean; hidden?: boolean;
  value?: string; getAttribute(name: string): string | null; dispatchEvent(event: unknown): Promise<void>;
};

beforeEach(() => {
  installMinimalDom();
});

const all = (root: unknown, predicate: (element: Node) => boolean) => findAll(root as never, predicate as never) as unknown as Node[];

function setupHost(overrides: Record<string, unknown> = {}) {
  const document = (globalThis as Record<string, unknown>).document as { createElement(tag: string): Node };
  const root = document.createElement("div");
  const calls = { changes: [] as Array<Record<string, unknown>>, monitoring: [] as boolean[] };
  const draft = (overrides.draft as ReturnType<typeof createSetupDraft>) ?? createSetupDraft();
  renderSetup(root as never, draft, {
    locale: "en",
    saving: false,
    editing: true,
    dirty: false,
    summary: { configured: true, config: { monitoringEnabled: false }, sources: [], destinations: [] },
    openSources: [],
    fetchGranted: true,
    handlers: {
      onChange: (patch: Record<string, unknown>) => calls.changes.push(patch),
      onMonitoring: (enabled: boolean) => calls.monitoring.push(enabled),
      onSubmit: () => {},
      onCancel: () => {},
      onRefreshGrants: () => {},
      onAddOpenSource: () => {},
      onRemoveOpenSource: () => {},
      onGrantFetch: () => {}
    },
    ...overrides.ctx
  });
  return { root, calls };
}

describe("Settings surface", () => {
  it("renders the three borderless sections in frequency order, with no publication section", () => {
    const { root } = setupHost();
    const titles = all(root, (e) => e.tagName === "H2").map((e) => e.textContent);
    expect(titles).toEqual(["Sources and destinations", "Instructions", "Source monitoring"]);
    expect(root.textContent).not.toContain("Review and publication");
  });

  it("labels the two instruction fields with the drawer's own names", () => {
    const { root } = setupHost();
    const labels = all(root, (e) => e.tagName === "LABEL").map((e) => e.textContent);
    expect(labels).toContain("Image instruction");
    expect(labels).toContain("Content instruction");
  });

  it("one switch carries monitoring state, and only enabling waits on a clean draft", () => {
    // Off + clean: the switch is live and clicking it asks to enable.
    const { root, calls } = setupHost();
    const toggle = all(root, (e) => e.getAttribute?.("role") === "switch")[0];
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("data-monitor-enable")).toBe("true");
    expect(toggle.disabled).not.toBe(true);
    expect(root.textContent).toContain("Monitoring is paused");
    void toggle.dispatchEvent({ type: "click" });
    expect(calls.monitoring).toEqual([true]);

    // Off + dirty: enabling is blocked (the cadence it would use is unsaved).
    const dirty = setupHost({ ctx: { dirty: true } });
    const dirtyToggle = all(dirty.root, (e) => e.getAttribute?.("role") === "switch")[0];
    expect(dirtyToggle.disabled).toBe(true);
    expect(dirty.root.textContent).toContain("Save changes before enabling monitoring.");

    // On + dirty: pausing stays live — it does not consume the draft.
    const on = setupHost({ ctx: { dirty: true, summary: { configured: true, config: { monitoringEnabled: true }, sources: [], destinations: [] } } });
    const onToggle = all(on.root, (e) => e.getAttribute?.("role") === "switch")[0];
    expect(onToggle.getAttribute("aria-checked")).toBe("true");
    expect(onToggle.disabled).not.toBe(true);
    void onToggle.dispatchEvent({ type: "click" });
    expect(on.calls.monitoring).toEqual([false]);
  });

  it("quiet hours are off until the owner sets them, and the toggle reveals the times row", async () => {
    const { root, calls } = setupHost();
    const times = all(root, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "time");
    expect(times).toHaveLength(2);
    const timesRow = all(root, (e) => e.className === "sl-fieldrow" && e.hidden === true);
    expect(timesRow).toHaveLength(1);
    expect(root.textContent).toContain("No quiet hours");

    const checkbox = all(root, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox")[0];
    checkbox.checked = true;
    await checkbox.dispatchEvent({ type: "change" });
    expect(calls.changes).toEqual([{ quietHoursStart: "22:00", quietHoursEnd: "08:00" }]);
    // The row unhid in place — no form redraw was needed mid-interaction.
    expect(all(root, (e) => e.hidden === true)).toHaveLength(0);
    expect(root.textContent).toContain("Quiet hours set");
  });

  it("round-trips saved quiet hours on, and turning them off clears the pair", async () => {
    const draft = draftFromConfig({ notifications: { mode: "immediate", quietHours: { start: "23:00", end: "07:30" } } });
    expect(draft.quietHoursStart).toBe("23:00");
    const { root, calls } = setupHost({ draft });
    const times = all(root, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "time");
    expect((times[0] as Node & { value: string }).value).toBe("23:00");
    expect((times[1] as Node & { value: string }).value).toBe("07:30");
    expect(all(root, (e) => e.hidden === true)).toHaveLength(0);
    expect(root.textContent).toContain("Quiet hours set");

    const checkbox = all(root, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox")[0];
    checkbox.checked = false;
    await checkbox.dispatchEvent({ type: "change" });
    expect(calls.changes).toEqual([{ quietHoursStart: "", quietHoursEnd: "" }]);
  });

  it("the cadence warning sits at the control and disappears once the draft is clean", () => {
    const dirty = setupHost({ ctx: { dirty: true } });
    const warn = all(dirty.root, (e) => e.className === "sl-note-warn")[0];
    expect(warn?.textContent).toBe(t("en", "setupSaveFirst"));
    const clean = setupHost();
    expect(all(clean.root, (e) => e.className === "sl-note-warn")).toHaveLength(0);
  });

  it("renders zh-HK section titles and switch state", () => {
    const { root } = setupHost({ ctx: { locale: "zh-HK" } });
    const titles = all(root, (e) => e.tagName === "H2").map((e) => e.textContent);
    expect(titles).toEqual(["來源與發佈位置", "指示", "來源監察"]);
    expect(root.textContent).toContain("監察已暫停");
    expect(root.textContent).toContain("不設安靜時間");
  });
});
