// TASK-203 / TEST-001-adjacent: node tests for the Social Localization
// client. The pure parts (collection.js, steps.js, poster.js, i18n.js) are
// plain-object logic and are tested directly; the bundled client.js is
// smoke-loaded into a hand-rolled DOM (see tests/_helpers/minimal-dom.ts —
// neither jsdom, happy-dom nor linkedom is a dependency anywhere in this
// workspace) with a fake `globalThis.gadget`, the same way the sandboxed
// iframe hands the bundle a capnweb stub.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClient } from "../../scripts/client.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { el } from "../../src/src/client/dom.js";

it("sets a textarea's live value rather than an inert value attribute", () => {
  installMinimalDom();
  const textarea = el("textarea", { value: "Saved caption" });
  expect(textarea.value).toBe("Saved caption");
  expect(textarea.getAttribute("value")).toBeNull();
});

import {
  applySelection,
  renderCollection,
  clearNotice,
  clearSelection,
  createCollectionState,
  mergeScanResult,
  newCount,
  selectedCount,
  selectedIds,
  setFilter,
  setItems,
  setNotice,
  setSearch,
  setSourceFilter,
  visibleItems
} from "../../src/src/client/collection.js";
import { computePosterLayout } from "../../src/src/client/poster.js";
import {
  computeIssues,
  createSetupDraft,
  createWizardState,
  applySavedPoster,
  discardDraft,
  draftIsDirty,
  draftFromConfig,
  isApprovalExpired,
  setBatch,
  resumeBatch,
  recordDraftConflict,
  resolveDraftConflict,
  submitEnabled,
  toConfigPayload,
  updateDraft
} from "../../src/src/client/steps.js";
import { createInboxState, drawerAction, drawerProjection, groupSourcesWithBatches, renderInbox, setInboxFilter, setInboxSummaries, visibleBatchSummaries } from "../../src/src/client/inbox.js";
import { LOCALES, STRINGS, t } from "../../src/src/client/i18n.js";
import { normalizeConfig } from "../../src/config.js";
import { findAll, flushAsyncWork, hasClass, installMinimalDom } from "./_helpers/minimal-dom";

it("keeps the Social Content product name in both interface locales", () => {
  expect(t("en", "appTitle")).toBe("Social Content");
  expect(t("zh-HK", "appTitle")).toBe("Social Content");
  expect(t("en", "setupTitle")).toBe("Set up Social Content");
  expect(t("zh-HK", "setupTitle")).toBe("設定 Social Content");
});

/**
 * Spoken-form particles that must never appear in this blueprint's own
 * zh-HK product copy (GUD-002) — the same list model.js's
 * `validateLocalization` rejects a draft for, and the one
 * `tests/social-localization-model.test.ts` already scans model.js's own
 * `messages` with. Kept here rather than imported so this test does not
 * depend on model.js or i18n.js re-exporting an internal list.
 */
const SPOKEN_FORM_TOKENS = ["嘅", "咗", "唔", "呢個", "邊個", "幾多", "睇", "喺", "嗰"];

function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "instagram:IG_MAIN:1",
    provider: "instagram",
    sourceBinding: "IG_MAIN",
    sourceLabel: "Essential Foods",
    providerItemId: "1",
    authorHandle: "@essentialfoods_global",
    permalink: "https://instagram.com/p/1",
    publishedAt: "2026-08-01T00:00:00.000Z",
    text: "A brighter kind of daily. Essential 01 marine collagen.",
    locale: null,
    media: [{ id: "media-1", kind: "image", url: "https://cdn.example/1.jpg" }],
    metrics: { likes: 100, comments: 2, shares: null, views: null },
    contentHash: "hash1",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    seen: false,
    selected: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// collection.js — filters, selection independence, tray count, scan merges
// ---------------------------------------------------------------------------

describe("collection.js state", () => {
  it("filters New to unseen items and All to everything, independent of selection", () => {
    let state = createCollectionState();
    state = setItems(state, {
      items: [makeItem({ id: "a", seen: false, selected: true }), makeItem({ id: "b", seen: true, selected: false })]
    });

    expect(visibleItems(state).map((item) => item.id)).toEqual(["a"]); // default filter is "new"

    state = setFilter(state, "all");
    expect(visibleItems(state).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("search narrows the visible set without touching selection or the filter", () => {
    let state = createCollectionState();
    state = setItems(state, {
      items: [makeItem({ id: "a", seen: true, text: "Morning ritual", selected: true }), makeItem({ id: "b", seen: true, text: "Evening reset" })]
    });
    state = setFilter(state, "all");
    state = setSearch(state, "morning");

    expect(visibleItems(state).map((item) => item.id)).toEqual(["a"]);
    expect(state.filter).toBe("all");
    expect(selectedIds(state)).toEqual(["a"]); // selection survived the search narrowing
  });

  it("the checkbox (setSelection) and opening the preview are unrelated — REQ-006", () => {
    let state = createCollectionState();
    state = setItems(state, { items: [makeItem({ id: "a" }), makeItem({ id: "b" })] });

    // Selecting "a" must not select or otherwise touch "b".
    state = applySelection(state, "a", true);
    expect(selectedIds(state)).toEqual(["a"]);
    expect(state.items.find((item) => item.id === "b")!.selected).toBe(false);

    state = applySelection(state, "b", true);
    expect(selectedCount(state)).toBe(2);

    state = clearSelection(state);
    expect(selectedCount(state)).toBe(0);
  });

  it("the sticky tray's count is exactly the selected count, filter-independent", () => {
    let state = createCollectionState();
    state = setItems(state, {
      items: [makeItem({ id: "a", seen: false, selected: true }), makeItem({ id: "b", seen: true, selected: true }), makeItem({ id: "c", seen: true, selected: false })]
    });
    expect(selectedCount(state)).toBe(2);
    state = setFilter(state, "all");
    expect(selectedCount(state)).toBe(2); // switching filters never changes what's selected
  });

  it("a scan event's fresh items update the New count without discarding an in-flight local selection", () => {
    let state = createCollectionState();
    state = setItems(state, { items: [makeItem({ id: "a", seen: true, selected: false })] });
    state = applySelection(state, "a", true); // optimistic local selection, ahead of any server refetch

    expect(newCount(state)).toBe(0);

    // The scan refetch reports "a" (still) seen, and two brand-new unseen items.
    state = mergeScanResult(state, [makeItem({ id: "a", seen: true, selected: false }), makeItem({ id: "b", seen: false }), makeItem({ id: "c", seen: false })]);

    expect(newCount(state)).toBe(2);
    expect(state.items.find((item) => item.id === "a")!.selected).toBe(true); // local selection preserved through the merge
  });

  it("a provider/account chip narrows by sourceBinding and toggles off on a second click", () => {
    let state = createCollectionState();
    state = setItems(state, { items: [makeItem({ id: "a", sourceBinding: "IG_MAIN", seen: true }), makeItem({ id: "b", sourceBinding: "FB_MAIN", seen: true })] });
    state = setFilter(state, "all");
    state = setSourceFilter(state, "IG_MAIN");
    expect(visibleItems(state).map((item) => item.id)).toEqual(["a"]);
    state = setSourceFilter(state, "IG_MAIN"); // clicking the active chip again clears it
    expect(state.sourceFilter).toBeNull();
  });

  // REQ-017: the refusal the server answers Continue with has to become a
  // choice on screen, not a console line. The notice is generic (PAT-003) —
  // a message and at most one way forward — so the duplicate wording lives in
  // client.js and this module only carries it.
  it("a notice carries a refusal message and its single way forward, and clears again", () => {
    let state = createCollectionState();
    expect(state.notice).toBeNull();

    state = setNotice(state, {
      message: "instagram:IG_MAIN:p1 already has an active localization for FB_MAIN in batch batch_1 (item bi_1).",
      actionLabel: "Create a new version"
    });
    expect(state.notice?.message).toContain("batch_1");
    expect(state.notice?.actionLabel).toBe("Create a new version");

    state = clearNotice(state);
    expect(state.notice).toBeNull();

    // A message-less notice is no notice, rather than an empty banner.
    expect(setNotice(state, { actionLabel: "x" }).notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// steps.js — Continue -> Localize, block issues gate Submit, expired approval
// ---------------------------------------------------------------------------

describe("steps.js transitions", () => {
  const sourceItem = { text: "Suggested retail HK$268 today only." };
  const baseBatch = {
    id: "batch1",
    items: [{ id: "item1", sourceItem, destinationBindings: ["IG_MAIN"], revision: 0, caption: "", confirmedClaims: [] }]
  };

  it("Continue creates a batch and moves the wizard from select to localize", () => {
    let wizard = createWizardState();
    expect(wizard.step).toBe("select");
    wizard = setBatch(wizard, baseBatch);
    expect(wizard.step).toBe("localize");
    expect(wizard.activeItemId).toBe("item1");
    expect(wizard.drafts.item1.caption).toBe(""); // draft seeded from the (empty) saved caption
  });

  it("an empty batch never advances the wizard past select", () => {
    let wizard = createWizardState();
    wizard = setBatch(wizard, { id: "batch1", items: [] });
    expect(wizard.step).toBe("select");
  });

  it("a blocking validation issue (a protected price dropped from the draft) disables Submit", () => {
    let wizard = createWizardState();
    wizard = setBatch(wizard, baseBatch);
    const policy = {};

    // The draft still preserves the protected price, and reads as written
    // Chinese overall: submittable.
    wizard = setBatch(wizard, { ...baseBatch, items: [{ ...baseBatch.items[0], caption: "今日優惠，建議零售價 HK$268，數量有限，售完即止。" }] });
    expect(submitEnabled(wizard, policy)).toBe(true);

    // Drop the protected price from the draft: a block issue appears, and Submit must disable.
    wizard = updateDraft(wizard, "item1", { caption: "今日優惠，數量有限，售完即止。" });
    const issues = computeIssues(wizard.batch!.items[0], wizard.drafts.item1, policy).issues;
    expect(issues.some((issue: { severity: string }) => issue.severity === "block")).toBe(true);
    expect(submitEnabled(wizard, policy)).toBe(false);
  });

  it("resolves one conflict without discarding other drafts or saving automatically", () => {
    let state = setBatch(createWizardState(), { ...baseBatch, items: [...baseBatch.items, { ...baseBatch.items[0], id: "other" }] });
    state = updateDraft(state, "item1", { caption: "My unsaved text" });
    state = updateDraft(state, "other", { caption: "Other unsaved text" });
    const saved = { ...baseBatch.items[0], state: "drafting", revision: 7, caption: "Server caption" };
    state = recordDraftConflict(state, "item1", saved);
    expect(submitEnabled(state, {})).toBe(false);
    const kept = resolveDraftConflict(state, "item1", true);
    expect(kept.batch.items[0].revision).toBe(7);
    expect(kept.drafts.item1.caption).toBe("My unsaved text");
    expect(kept.acknowledged.item1.caption).toBe("Server caption");
    expect(draftIsDirty(kept, "item1")).toBe(true);
    const reloaded = resolveDraftConflict(state, "item1", false);
    expect(reloaded.drafts.item1.caption).toBe("Server caption");
    expect(reloaded.drafts.other.caption).toBe("Other unsaved text");
    expect(draftIsDirty(reloaded, "item1")).toBe(false);
    const locked = recordDraftConflict(state, "item1", { ...saved, state: "submitted" });
    expect(resolveDraftConflict(locked, "item1", true)).toBe(locked);
  });

  it("resumes later drafts without exposing submitted siblings as editable", () => {
    const submitted = { ...baseBatch.items[0], id: "submitted", state: "awaiting_approval" };
    const draft = { ...baseBatch.items[0], id: "draft", state: "drafting" };
    const wizard = resumeBatch(createWizardState(), { id: "mixed", items: [submitted, draft] });
    expect(wizard.activeItemId).toBe("draft");
    expect(wizard.batch.items.map((item) => item.id)).toEqual(["draft"]);
    expect(wizard.drafts.submitted).toBeUndefined();
    expect(drawerAction({ state: "expired" }).kind).toBe("resume");
    expect(drawerAction({ state: "published" }).kind).toBe("unavailable");
  });

  it("blocks dirty or in-flight submissions and rejects edits while submitting", () => {
    const saved = setBatch(createWizardState(), { ...baseBatch, items: [{ ...baseBatch.items[0], caption: "今日優惠，建議零售價 HK$268，數量有限，售完即止。" }] });
    expect(submitEnabled(saved, {})).toBe(true);
    expect(submitEnabled(updateDraft(saved, "item1", { caption: `${saved.drafts.item1.caption}歡迎選購。` }), {})).toBe(false);
    expect(submitEnabled({ ...saved, savingByItem: { item1: true } }, {})).toBe(false);
    const sending = { ...saved, submitting: true };
    expect(submitEnabled(sending, {})).toBe(false);
    expect(updateDraft(sending, "item1", { caption: "changed" })).toBe(sending);
  });

  it("rights pending on any item blocks Submit even with a clean draft", () => {
    let wizard = createWizardState();
    wizard = setBatch(wizard, { id: "batch1", items: [{ ...baseBatch.items[0], rightsStatus: "pending" }] });
    wizard = updateDraft(wizard, "item1", { caption: "今日優惠，建議零售價 HK$268，數量有限，售完即止。" });
    expect(submitEnabled(wizard, {})).toBe(false);
  });

  it("does not block Submit when rights are pending but the ledger is original-only", () => {
    let wizard = createWizardState();
    wizard = setBatch(wizard, {
      id: "batch1",
      items: [{ ...baseBatch.items[0], rightsStatus: "pending", rightsRequired: false, caption: "今日優惠，建議零售價 HK$268，數量有限，售完即止。" }]
    });
    expect(submitEnabled(wizard, {})).toBe(true);
  });

  it("Review flips to expired once the item's current revision has moved past the approved one", () => {
    expect(isApprovalExpired(null)).toBe(false);
    expect(isApprovalExpired({ approvedRevision: 3, currentRevision: 3 })).toBe(false);
    expect(isApprovalExpired({ approvedRevision: 3, currentRevision: 4 })).toBe(true); // "Approval expired because this version changed"
  });

  it("tracks dirty edits against acknowledged state and restores on discard", () => {
    let wizard = setBatch(createWizardState(), baseBatch);
    wizard = updateDraft(wizard, "item1", { caption: "local edit" });
    expect(draftIsDirty(wizard, "item1")).toBe(true);
    wizard = discardDraft(wizard, "item1");
    expect(draftIsDirty(wizard, "item1")).toBe(false);
    expect(wizard.drafts.item1.caption).toBe("");
  });

  it("advances revision after a successful poster save", () => {
    let wizard = setBatch(createWizardState(), baseBatch);
    wizard = updateDraft(wizard, "item1", { headline: "Poster" });
    wizard = applySavedPoster(wizard, "item1", { ok: true, revision: 1 });
    expect(wizard.batch?.items[0].revision).toBe(1);
    expect(draftIsDirty(wizard, "item1")).toBe(true); // headline was not persisted by savePoster
  });
});

describe("inbox.js projections", () => {
  it("filters summaries while preserving independent full-facet totals", () => {
    let state = setInboxSummaries(createInboxState(), {
      batches: [
        { id: "b1", draftCount: 1, reviewCount: 0, scheduledCount: 0, attentionCount: 0 },
        { id: "b2", draftCount: 0, reviewCount: 1, scheduledCount: 0, attentionCount: 0 }
      ],
      totals: { batches: 61, items: 70, drafts: 4, review: 2, scheduled: 1, attention: 3 }
    });
    state = setInboxFilter(state, "review");
    expect(state.totals?.batches).toBe(61);
    expect(visibleBatchSummaries(state).map((batch) => batch.id)).toEqual(["b2"]);
  });

  it("projects drawer data and contextual actions without mutation", () => {
    const drawer = drawerProjection({ id: "b1", items: [{ id: "bi1", revision: 2, caption: "Saved", state: "drafting", destinationBindings: ["IG"] }] });
    expect(drawer?.items[0].revision).toBe(2);
    expect(drawerAction(drawer?.items[0]).kind).toBe("resume");
    expect(drawerAction({ state: "scheduled" }).kind).toBe("schedule");
  });

  it("links a saved batch only to its source item, never every source card", () => {
    const grouped = groupSourcesWithBatches([{ id: "source-a" }, { id: "source-b" }], [{ id: "batch-a", sourceItemIds: ["source-a"] }]);
    expect(grouped[0].summaries.map((batch) => batch.id)).toEqual(["batch-a"]);
    expect(grouped[1].summaries).toEqual([]);
    expect(visibleBatchSummaries(setInboxFilter(setInboxSummaries(createInboxState(), { batches: [{ id: "b", draftCount: 1, reviewCount: 0, scheduledCount: 0, attentionCount: 0 }] }), "new"))).toEqual([]);
  });

  it("renders filter tabs and dispatches inspect without changing source selection", async () => {
    installMinimalDom();
    const root = document.createElement("main");
    const calls: string[] = [];
    renderInbox(root, setInboxSummaries(createInboxState(), { batches: [{ id: "b1", itemCount: 1, draftCount: 1, reviewCount: 0, scheduledCount: 0, attentionCount: 0 }], totals: { batches: 1, new: 2, drafts: 1 } }), {
      locale: "en",
      handlers: { onInboxFilter: (filter: string) => calls.push(`filter:${filter}`), onInspectBatch: (batch: { id: string }) => calls.push(`inspect:${batch.id}`), onLoadMoreBatches: () => calls.push("more") }
    });
    const buttons = findAll(root, (node) => node.tagName === "BUTTON");
    expect(buttons.some((button) => button.textContent?.includes("Draft items"))).toBe(true);
    await buttons.find((button) => button.textContent?.includes("Inspect"))?.dispatchEvent({ type: "click" });
    expect(calls).toEqual(["inspect:b1"]);
  });
});

// ---------------------------------------------------------------------------
// poster.js — layout maths
// ---------------------------------------------------------------------------

describe("poster.js layout maths", () => {
  it("sizes the canvas to the template's fixed pixel dimensions", () => {
    const portrait = computePosterLayout({ template: "1080x1350", headline: "日常，由今天開始" });
    expect(portrait.width).toBe(1080);
    expect(portrait.height).toBe(1350);

    const square = computePosterLayout({ template: "1080x1080", headline: "日常，由今天開始" });
    expect(square.width).toBe(1080);
    expect(square.height).toBe(1080);
  });

  it("omits the sub-line block entirely when there is no sub-line", () => {
    const withSubline = computePosterLayout({ template: "1080x1080", headline: "標題", subline: "副標題" });
    const without = computePosterLayout({ template: "1080x1080", headline: "標題" });
    expect(withSubline.subline).not.toBeNull();
    expect(without.subline).toBeNull();
    // Removing the sub-line frees vertical space, so the headline block sits lower (larger y).
    expect(without.headline.y).toBeGreaterThan(withSubline.headline.y);
  });

  it("a longer headline wraps to more lines and grows the block upward", () => {
    const short = computePosterLayout({ template: "1080x1080", headline: "日常" });
    const long = computePosterLayout({
      template: "1080x1080",
      headline: "日常保養，從簡單開始，Essential 01 海洋膠原蛋白胜肽配方，有助支持肌膚彈性與保濕"
    });
    expect(long.headline.lines).toBeGreaterThan(short.headline.lines);
    expect(long.headline.y).toBeLessThan(short.headline.y); // more lines pushes the block's top further up
  });

  it("respects the requested text alignment", () => {
    const left = computePosterLayout({ template: "1080x1080", headline: "H", align: "left" });
    const center = computePosterLayout({ template: "1080x1080", headline: "H", align: "center" });
    const right = computePosterLayout({ template: "1080x1080", headline: "H", align: "right" });
    expect(left.headline.align).toBe("left");
    expect(center.headline.align).toBe("center");
    expect(right.headline.align).toBe("right");
    expect(left.headline.x).toBeLessThan(center.headline.x);
    expect(center.headline.x).toBeLessThan(right.headline.x);
  });
});

// ---------------------------------------------------------------------------
// i18n.js — no spoken Cantonese in this blueprint's own product copy
// ---------------------------------------------------------------------------

describe("i18n.js", () => {
  it("declares only the two supported locales", () => {
    expect(LOCALES).toEqual(["en", "zh-HK"]);
  });

  it("contains no spoken-form particle in any zh-HK string (GUD-002)", () => {
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(STRINGS["zh-HK"])) {
      for (const token of SPOKEN_FORM_TOKENS) {
        if (value.includes(token)) offenders.push(`${key} contains "${token}": ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("falls back to English for an unknown key and substitutes {vars}", () => {
    expect(t("zh-HK", "nope-not-a-key")).toBe("nope-not-a-key");
    expect(t("en", "selectedCount", { n: 3 })).toBe("3 selected");
    expect(t("zh-HK", "selectedCount", { n: 3 })).toBe("已選取 3 則");
  });

  it("every English key has a zh-HK translation and vice versa", () => {
    const enKeys = Object.keys(STRINGS.en).sort();
    const zhKeys = Object.keys(STRINGS["zh-HK"]).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});

// ---------------------------------------------------------------------------
// Bundled client.js smoke test — the archive's actual artifact, not the
// source modules, so a bundling regression (a bad external, a missed
// polyfill) fails here too.
// ---------------------------------------------------------------------------

// Built once for the whole file: esbuild on every case would dominate the run.
const builtBundleDir = mkdtempSync(join(tmpdir(), "social-content-client-"));
const builtBundlePath = join(builtBundleDir, "client.js");
writeFileSync(builtBundlePath, await buildClient(), "utf8");

describe("bundled client.js smoke test", () => {
  // The bundle under test is BUILT, never a committed artifact. `build.mjs`
  // regenerates the client from `src/src/client/*.js` on every build, so a
  // checked-in copy would let these assertions pass against code that no
  // longer ships — which is exactly what happened while this lived in the API.
  const bundlePath = builtBundlePath;

  beforeEach(() => {
    // Confirms the pack script has actually been run — a stale/missing
    // bundle should fail loudly here rather than the smoke test silently
    // importing nothing.
    expect(() => readFileSync(bundlePath, "utf8")).not.toThrow();
  });

  it("renders N source-item cards from a fake gadget and toggles selection on checkbox change without opening the preview", async () => {
    const { document } = installMinimalDom();
    document.documentElement.lang = "en";

    const items = [
      makeItem({ id: "a", seen: false, selected: false, text: "A brighter kind of daily" }),
      makeItem({ id: "b", seen: false, selected: true, text: "Start with morning light" }),
      makeItem({ id: "c", seen: true, selected: false, text: "Blend it your way" }) // filtered out by the default "new" filter
    ];
    const setSelectionCalls: Array<[string, boolean]> = [];

    (globalThis as any).gadget = {
      async summary() {
        return {
          configured: true,
          // Exactly what `summary()` returns (server.js's `describeRows`) and
          // nothing more. It used to also carry `sourceBinding`, a name no
          // server row has, because the chip row read that — a fake agreeing
          // with our code instead of with the platform, which is why a filter
          // that never worked had a passing test beside it.
          sources: [
            {
              binding: "IG_MAIN",
              provider: "instagram",
              glyphKey: "instagram",
              label: "Instagram Business · @test",
              lastOutcome: "confirmed"
            }
          ],
          destinations: [{ destinationBinding: "IG_MAIN", provider: "instagram", label: "Instagram Business · @test" }],
          config: {}
        };
      },
      async listItems({ filter }: { filter: string }) {
        return { items: filter === "all" ? items : items.filter((item) => !item.seen), nextCursor: null };
      },
      async setSelection(id: string, selected: boolean) {
        setSelectionCalls.push([id, selected]);
      },
      async clearSelection() {},
      async refresh() {},
      async markSeen() {},
      async subscribe() {
        return {};
      }
    };

    await import(pathToFileURL(bundlePath).href + `?case=collection-smoke-${Date.now()}`);
    await flushAsyncWork();

    const cards = findAll(document.body, (element) => element.classList.contains("sl-post"));
    expect(cards).toHaveLength(2); // only the two unseen ("new") items render by default

    const checkboxes = findAll(document.body, (element) => element.classList.contains("sl-post-check"));
    expect(checkboxes).toHaveLength(2);
    const firstChecked = checkboxes.map((box) => box.checked);
    expect(firstChecked).toEqual([false, true]); // mirrors items "a" (unselected) and "b" (selected)

    const previewDialog = findAll(document.body, (element) => element.tagName === "DIALOG")[0];
    expect(previewDialog.open).toBe(false);

    // Toggle the first (unselected) card's checkbox — a real browser flips
    // `.checked` before dispatching `change`, so the test does too.
    const target = checkboxes[0];
    target.checked = true;
    await target.dispatchEvent({ type: "change" });
    await flushAsyncWork();

    expect(setSelectionCalls).toContainEqual(["a", true]);
    // The preview drawer never opened — the checkbox and the card body are
    // independent controls (REQ-006).
    expect(previewDialog.open).toBe(false);

    // The DOM re-rendered: the same logical checkbox (now re-created, since
    // renderCollection rebuilds the grid) reflects the new selection.
    const checkboxesAfter = findAll(document.body, (element) => element.classList.contains("sl-post-check"));
    expect(checkboxesAfter.map((box) => box.checked)).toEqual([true, true]);

    // REQ-016: the glyph is the key the DOOR reported, carried verbatim so a
    // brand mark can be styled from it — not a provider table kept in the
    // client, which is the copy that goes stale the day a provider is added.
    const glyphs = findAll(document.body, (element) => element.classList.contains("sl-provider-glyph"));
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0].getAttribute("data-glyph")).toBe("instagram");
    expect(glyphs[0].textContent).toBe("IN");

  });

  it("a source chip actually narrows the grid to that source", async () => {
    installMinimalDom();
    document.documentElement.lang = "en";

    /**
     * The chip read `source.sourceBinding` — a name only ITEMS carry;
     * `summary().sources` rows carry `binding` (server.js's `describeRows`).
     * It therefore handed `undefined` to the handler, and
     * `renderCollection`'s `if (state.sourceFilter)` reads `undefined` as no
     * filter, so the control did nothing in every state and reported nothing.
     *
     * TWO sources, so the assertion is what an owner would notice — the grid
     * narrowing — rather than the chip's own pressed state, which flipped
     * correctly even while the filter was `undefined` (`undefined ===
     * undefined`) and hid the defect from a one-source test.
     */
    (globalThis as any).gadget = {
      async summary() {
        return {
          configured: true,
          sources: [
            { binding: "IG_MAIN", provider: "instagram", glyphKey: "instagram", label: "Instagram · main" },
            { binding: "FB_PAGE", provider: "facebook", glyphKey: "facebook", label: "Facebook · page" }
          ],
          destinations: [],
          config: {}
        };
      },
      async listItems() {
        return {
          items: [
            makeItem({ id: "a", sourceBinding: "IG_MAIN", text: "from instagram" }),
            makeItem({ id: "b", sourceBinding: "FB_PAGE", text: "from facebook" })
          ],
          nextCursor: null
        };
      },
      async setSelection() {},
      async clearSelection() {},
      async refresh() {},
      async markSeen() {},
      async subscribe() {
        return {};
      }
    };

    await import(pathToFileURL(bundlePath).href + `?case=chip-filter-${Date.now()}`);
    await flushAsyncWork();

    const chips = findAll(document.body, (element) => element.classList.contains("sl-chip"));
    expect(chips).toHaveLength(2);
    expect(findAll(document.body, (element) => element.classList.contains("sl-post"))).toHaveLength(2);

    await chips[0].dispatchEvent({ type: "click" });
    await flushAsyncWork();

    const remaining = findAll(document.body, (element) => element.classList.contains("sl-post"));
    expect(remaining).toHaveLength(1);
    expect(document.body.textContent).toContain("from instagram");
    expect(document.body.textContent).not.toContain("from facebook");
  });

  it("falls back to the provider mark only when the door reported no glyph key", async () => {
    installMinimalDom();
    document.documentElement.lang = "en";

    (globalThis as any).gadget = {
      async summary() {
        return {
          configured: true,
          // No `glyphKey` — a door that told us nothing.
          sources: [{ binding: "IG_MAIN", provider: "instagram", label: "Instagram Business · @test" }],
          destinations: [],
          config: {}
        };
      },
      async listItems() {
        return { items: [makeItem({ id: "a", seen: false, selected: false, text: "no glyph key" })], nextCursor: null };
      },
      async setSelection() {},
      async clearSelection() {},
      async refresh() {},
      async markSeen() {},
      async subscribe() {
        return {};
      }
    };

    await import(pathToFileURL(bundlePath).href + `?case=glyph-fallback-${Date.now()}`);
    await flushAsyncWork();

    const glyphs = findAll(document.body, (element) => element.classList.contains("sl-provider-glyph"));
    expect(glyphs[0].getAttribute("data-glyph")).toBe("");
    expect(glyphs[0].textContent).toBe("IG");
  });

  // -------------------------------------------------------------------------
  // Finding C (design-plans/evidence/social-localization-gadget-1/
  // verification.md): the local end-to-end browser walk showed the first-run
  // form's submit never persisting config — `summary().configured` stayed
  // `false` after clicking "開始監察來源" twice, and the identical payload
  // sent directly through a Node capnweb script succeeded instantly. So the
  // config.js validator and server.js's setConfig were never the problem;
  // this drives the REAL bundled client.js's own first-run submit against a
  // fake `gadget` whose `setConfig` records its argument, the same shape the
  // sandboxed iframe hands the bundle.
  // -------------------------------------------------------------------------
  describe("bundled client.js first-run submit (Finding C)", () => {
    it("has no submit control anywhere, because the sandbox blocks form submission", () => {
      // Finding C's root cause, pinned. The frame is sandboxed
      // `allow-scripts allow-popups allow-popups-to-escape-sandbox` with a CSP
      // `form-action 'none'`; a frame without `allow-forms` blocks submission
      // BEFORE dispatching `submit`, so an `onsubmit` handler never runs and
      // the click silently does nothing. Every action here is a click handler.
      const source = readFileSync(bundlePath, "utf8");
      expect(source).not.toMatch(/type\s*:\s*["']submit["']/);
      expect(source).not.toMatch(/type=["']submit["']/);
    });

    function unconfiguredGadget(setConfigImpl: (config: unknown) => Promise<unknown>) {
      let configured = false;
      const summaryCalls: unknown[] = [];
      return {
        gadget: {
          async summary() {
            summaryCalls.push(null);
            return { configured, sources: [], destinations: [], config: configured ? {} : null };
          },
          async saveSetup(config: unknown) {
            const result = await setConfigImpl(config);
            configured = true;
            return result;
          },
          async listItems() {
            return { items: [], nextCursor: null };
          },
          async subscribe() {
            return {};
          }
        },
        summaryCallCount: () => summaryCalls.length
      };
    }

    function findSetupForm(document: ReturnType<typeof installMinimalDom>["document"]) {
      return findAll(document.body, (element) => hasClass(element, "sl-setup-form"))[0];
    }

    // The primary control is found by CLASS, never by `type="submit"`: this
    // client has no submit control, and must not grow one. See below.
    function findPrimaryButton(document: ReturnType<typeof installMinimalDom>["document"]) {
      return findAll(document.body, (element) => element.tagName === "BUTTON" && hasClass(element, "sl-primary"))[0];
    }

    it("saves setup without enabling monitoring and stays for explicit activation", async () => {
      const { document } = installMinimalDom();
      document.documentElement.lang = "en";

      let capturedConfig: unknown = null;
      const { gadget } = unconfiguredGadget(async (config) => {
        capturedConfig = config;
        return { configured: true };
      });
      (globalThis as any).gadget = gadget;

      await import(pathToFileURL(bundlePath).href + `?case=first-run-submit-${Date.now()}`);
      await flushAsyncWork();

      // The setup screen owns the view until configured (REQ-032) — confirm
      // it actually rendered before driving the submit.
      const form = findSetupForm(document);
      expect(form).toBeTruthy();

      // Mirrors the walk's own interaction: add a protected term via the
      // tag input's Enter-to-add (steps.js `renderTagList`), so the
      // submitted payload is not just the bare default draft.
      const termInput = findAll(document.body, (element) => hasClass(element, "sl-field-input"))[0];
      termInput.value = "AgenticOS Pro";
      await termInput.dispatchEvent({ type: "keydown", key: "Enter", preventDefault: () => {} });
      await flushAsyncWork();

      const submitButton = findPrimaryButton(document);
      expect(submitButton.disabled).toBe(false);

      // CLICK, not a dispatched `submit`. The earlier version of this test
      // dispatched `submit` on the form, which passed while the real browser
      // never fired it: the gadget's iframe is sandboxed without
      // `allow-forms`, so submission is blocked before the event exists.
      // Driving the click is what the owner actually does.
      await submitButton.dispatchEvent({ type: "click", preventDefault: () => {} });
      await flushAsyncWork();

      expect(capturedConfig).toBeTruthy();
      // `config.js` accepts the client's own flat shape (`toConfigPayload`)
      // directly — no adapter at the call site (see config.js's own header).
      // Running the exact recorded payload through the real validator is
      // the assertion the task calls for: config.js never threw on this
      // shape, so a defect here is not a payload-shape mismatch.
      expect(() => normalizeConfig(capturedConfig)).not.toThrow();
      const normalized = normalizeConfig(capturedConfig);
      expect(normalized.protectedTerms).toEqual(["AgenticOS Pro"]);
      expect(normalized.locale).toEqual({ from: "en", to: "zh-HK" });

      // No leftover error banner, and the setup form is gone — the view
      // moved on once `setConfig` resolved (`refreshSummary` +
      // `loadCollection("new")`).
      expect(findAll(document.body, (element) => hasClass(element, "sl-setup-error"))).toHaveLength(0);
      expect(findSetupForm(document)).toBeTruthy();
      expect(document.body.textContent).toContain("Settings saved. Monitoring was not changed.");
    });

    it("surfaces a failed setConfig inline (no alert) instead of silently resetting", async () => {
      const { document } = installMinimalDom();
      document.documentElement.lang = "en";

      const originalAlert = (globalThis as any).alert;
      let alertCalled = false;
      (globalThis as any).alert = () => {
        alertCalled = true;
      };

      const { gadget } = unconfiguredGadget(async () => {
        throw new Error("gadget door call failed: binding_revoked");
      });
      (globalThis as any).gadget = gadget;

      try {
        await import(pathToFileURL(bundlePath).href + `?case=first-run-submit-error-${Date.now()}`);
        await flushAsyncWork();

        // Click, for the reason the happy path clicks: this frame's sandbox
        // never dispatches `submit`.
        expect(findSetupForm(document)).toBeTruthy();
        await findPrimaryButton(document).dispatchEvent({ type: "click", preventDefault: () => {} });
        await flushAsyncWork();

        // The setup screen is still there — a rejected setConfig must not
        // silently advance the view — and it now carries a visible error.
        expect(findSetupForm(document)).toBeTruthy();
        const errorBanner = findAll(document.body, (element) => hasClass(element, "sl-setup-error"))[0];
        expect(errorBanner).toBeTruthy();
        expect(errorBanner.textContent).toBe("gadget door call failed: binding_revoked");
        expect(alertCalled).toBe(false);

        // The button is re-enabled — the owner can retry rather than being
        // stuck behind a permanently disabled "Saving…" button.
        const submitButton = findPrimaryButton(document);
        expect(submitButton.disabled).toBe(false);

        // Editing a field clears the stale error rather than leaving it
        // stuck until the next submit resolves.
        const termInput = findAll(document.body, (element) => hasClass(element, "sl-field-input"))[0];
        await termInput.dispatchEvent({ type: "keydown", key: "Enter", preventDefault: () => {} });
        await flushAsyncWork();
        expect(findAll(document.body, (element) => hasClass(element, "sl-setup-error"))).toHaveLength(0);
      } finally {
        (globalThis as any).alert = originalAlert;
      }
    });
  });
});


describe("settings: the setup form is no longer a one-way door", () => {
  /**
   * `runSetup()` ran only while `!summary.configured`, so cadence, timezone,
   * rights policy and the protected-term lists were fixed at first run for the
   * life of the gadget. Door grants and schedules were never part of this —
   * the workspace page has owned both, with revoke and stop.
   */
  it("round-trips a stored config back into the form it was written from", () => {
    const draft = {
      ...createSetupDraft(),
      cadence: "weekly",
      timezone: "Asia/Tokyo",
      rightsPolicy: "trust_connected",
      notificationPolicy: "daily",
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      protectedTerms: ["Essential 01"],
      protectedHashtags: ["#EssentialFoods"],
      disclaimers: ["Not medical advice"],
      claimsRequiringConfirmation: ["clinically proven"]
    };
    const { baseConfig, ...roundTrip } = draftFromConfig(toConfigPayload(draft));
    expect(roundTrip).toEqual(draft);
    expect(baseConfig).toEqual(toConfigPayload(draft));
  });

  it("reads an absent quietHours as no quiet hours, not as a blank the owner chose", () => {
    const draft = { ...createSetupDraft(), quietHoursStart: "", quietHoursEnd: "" };
    const payload = toConfigPayload(draft);
    expect(payload.quietHours).toBeNull();
    const back = draftFromConfig(payload);
    expect(back.quietHoursStart).toBe("");
    expect(back.quietHoursEnd).toBe("");
  });

  it("falls back to a fresh draft's defaults for a field the stored config predates", () => {
    // A config written before a field existed must open on that field's
    // default, never on an empty value nobody picked.
    const partial = { cadence: "hourly" };
    const back = draftFromConfig(partial);
    const fresh = createSetupDraft();
    expect(back.cadence).toBe("hourly");
    expect(back.rightsPolicy).toBe(fresh.rightsPolicy);
    expect(back.notificationPolicy).toBe(fresh.notificationPolicy);
    expect(back.protectedTerms).toEqual(fresh.protectedTerms);
  });

  it("survives a null config rather than throwing on first render", () => {
    expect(draftFromConfig(null)).toEqual(createSetupDraft());
    expect(draftFromConfig(undefined)).toEqual(createSetupDraft());
  });

  it("has the words for both modes in both locales", () => {
    for (const locale of LOCALES) {
      for (const key of ["settingsOpen", "settingsTitle", "settingsDesc", "settingsSave", "settingsCancel"]) {
        expect(t(locale, key), `${locale}.${key}`).not.toBe(key);
        expect(String(t(locale, key)).trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("a card's cover comes from cached bytes", () => {
  /*
   * The canvas is served `img-src blob: data:` with `connect-src 'none'`, so a
   * cover cannot be a remote URL however convenient — it has to be bytes the
   * gadget already holds, handed over as a `blob:`. A direct `<img src=https…>`
   * was tried first and refused by policy, which is the containment working.
   *
   * The grid had no `<img>` at all before this, and the development canvas
   * painted a stand-in over the gap, so a grid of identical grey boxes went
   * unnoticed — while an owner's whole job here is choosing a post to derive
   * from by looking at it.
   */
  function grid(item: Record<string, unknown>, loadCover?: (i: string, m: string) => Promise<string>) {
    installMinimalDom();
    const root = (globalThis as unknown as { document: { createElement(tag: string): unknown } })
      .document.createElement("div");
    const state = setItems(createCollectionState(), { items: [item] as never, nextCursor: null });
    renderCollection(root as never, state as never, {
      locale: "en", sources: [], handlers: { onSelect() {}, onOpen() {}, onMore() {} }, loadCover
    } as never);
    return root;
  }
  const base = {
    id: "i1", sourceBinding: "open:instagram:acct", sourceLabel: "@acct", provider: "instagram",
    providerItemId: "p1", text: "a post", metrics: {}, publishedAt: "2026-09-01T00:00:00.000Z",
    media: [{ id: "0", kind: "image", url: "https://cdn.test/a.jpg" }]
  };
  const images = (root: unknown) => findAll(root as never, (e: { tagName?: string }) => e.tagName === "IMG");

  it("draws the blob it is given", async () => {
    const root = grid(base, async () => "blob:fake-url");
    await flushAsyncWork();
    const img = images(root)[0] as { getAttribute(n: string): string | null };
    expect(img).toBeDefined();
    expect(img.getAttribute("src")).toBe("blob:fake-url");
  });

  it("keeps the glyph when the bytes cannot be fetched, rather than showing a broken image", async () => {
    const root = grid(base, async () => { throw new Error("no cached bytes"); });
    await flushAsyncWork();
    expect(images(root)).toHaveLength(0);
  });

  it("asks for nothing when the item has no media", async () => {
    let asked = 0;
    grid({ ...base, media: [] }, async () => { asked += 1; return "blob:x"; });
    await flushAsyncWork();
    expect(asked).toBe(0);
  });
});

