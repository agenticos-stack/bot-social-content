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
  renderPublish,
  applySavedPoster,
  discardDraft,
  draftIsDirty,
  draftFromConfig,
  isApprovalExpired,
  setBatch,
  resumeBatch,
  setPublishError,
  recordDraftConflict,
  resolveDraftConflict,
  submitEnabled,
  toConfigPayload,
  updateDraft
} from "../../src/src/client/steps.js";
import { createInboxState, clearInboxSelection, drawerAction, drawerProjection, groupSourcesWithBatches, inboxSelectionCount, renderInbox, selectedInboxItems, setInboxFilter, setInboxSummaries, toggleInboxItem, visibleBatchSummaries, visibleInboxItems } from "../../src/src/client/inbox.js";
import { suggestProtectedTerms } from "../../src/src/client/steps.js";
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

/*
 * A button that cannot work should say so before it is pressed.
 *
 * With no destination configured, Continue was enabled; pressing it refused
 * with `batch_needs_destinations`, and that refusal went to `console.log` and
 * nowhere else. On screen: nothing at all. Reproduced against the live gadget
 * on 2026-09-10 — "[social-localization] Refresh failed: createBatch needs at
 * least one destination binding."
 */
describe("the selection tray, when nothing is set up to publish to", () => {
  const item = {
    id: "i1", sourceBinding: "open:instagram:acct", sourceLabel: "@acct", provider: "instagram",
    providerItemId: "p1", text: "a post", metrics: {}, publishedAt: "2026-09-01T00:00:00.000Z",
    media: [], selected: true
  };

  function tray(summary: unknown) {
    installMinimalDom();
    const root = (globalThis as unknown as { document: { createElement(tag: string): unknown } })
      .document.createElement("div");
    const state = setItems(createCollectionState(), { items: [item] as never, nextCursor: null });
    renderCollection(root as never, state as never, {
      locale: "en", sources: [], summary,
      handlers: { onSelect() {}, onOpen() {}, onMore() {}, onContinue() {}, onOpenSettings() {} }
    } as never);
    return findAll(root as never, (e: { tagName?: string }) => e.tagName === "BUTTON")
      .map((button: { textContent?: string }) => button.textContent ?? "");
  }

  it("offers the draft action — the destination is picked at submit, never before drafting", () => {
    // TASK-015: the `send` target stopped being a precondition for
    // `generate`. A destinationless workspace drafts first and chooses where
    // it goes on the Publish step.
    const labels = tray({ destinations: [] });
    expect(labels.some((label) => label.includes("Draft 1 post"))).toBe(true);
    expect(labels.some((label) => label.includes("Add a destination"))).toBe(false);
  });

  it("offers the draft action once a destination exists", () => {
    const labels = tray({ destinations: [{ binding: "IG_MAIN" }] });
    expect(labels.some((label) => label.includes("Draft 1 post"))).toBe(true);
    expect(labels.some((label) => label.includes("Add a destination"))).toBe(false);
  });

  /*
   * UNKNOWN IS NOT ZERO. `summary()` has not resolved on the first paint, and
   * reading its absence as "no destinations" would flash a setup prompt at
   * every owner on every load and then take it back.
   */
  it("keeps the draft action while the summary has not arrived", () => {
    const labels = tray(undefined);
    expect(labels.some((label) => label.includes("Draft 1 post"))).toBe(true);
  });

  it("says one post, not 1 post(s)", () => {
    const labels = tray({ destinations: [{ binding: "IG_MAIN" }] });
    expect(labels.join(" ")).toContain("Draft 1 post");
    expect(labels.join(" ")).not.toContain("post(s)");
  });
});

/*
 * #1960 — the publish step's draft cards used to hide behind the
 * zero-destination empty state: the owner could not SEE what they drafted
 * until a destination existed. The cards paint regardless; only the send
 * waits, and the notice above the grid names the way out.
 */
describe("the Publish step, when nothing is set up to publish to", () => {
  const item = {
    id: "item1",
    state: "drafting",
    sourceItem: { sourceLabel: "@acct", provider: "instagram", text: "a post", id: "p1" },
    revision: 1,
    destinationBindings: [],
    publications: []
  };

  function publishView(summary: unknown) {
    installMinimalDom();
    const root = (globalThis as unknown as { document: { createElement(tag: string): unknown } })
      .document.createElement("div");
    const wizard = setBatch(createWizardState(), { id: "batch1", items: [item] as never });
    renderPublish(root as never, wizard as never, {
      locale: "en",
      summary,
      policy: {},
      handlers: {
        onOpenSettings() {}, onRefreshGrants() {}, onToggleBinding() {},
        onPublishIntent() {}, onEditCaption() {}, onSubmitItem() {},
        onRetry() {}, onCheckManually() {}, onBack() {}
      }
    } as never);
    return root;
  }

  const cards = (root: unknown) =>
    findAll(root as never, (e: { className?: string }) => String(e.className ?? "").includes("sl-preview-card"));
  const submitButtons = (root: unknown) =>
    findAll(
      root as never,
      (e: { tagName?: string; textContent?: string }) =>
        e.tagName === "BUTTON" && String(e.textContent ?? "").includes("Submit for review")
    );

  const notices = (root: unknown) =>
    findAll(root as never, (e: { classList?: { contains(n: string): boolean } }) =>
      e.classList?.contains("sl-notice") === true);

  it("renders the draft cards under the no-destination notice", () => {
    const root = publishView({ destinations: [] });
    expect(cards(root)).toHaveLength(1);
    expect(notices(root)).toHaveLength(1);
  });

  it("keeps the card's own submit visible, disabled, and naming the missing destination", () => {
    const root = publishView({ destinations: [] });
    const submit = submitButtons(root)[0] as { disabled?: boolean; getAttribute(n: string): string | null };
    expect(submit).toBeDefined();
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("title")).toBe("No destination set up yet");
  });

  it("does not let a since-revoked destination binding submit through", () => {
    installMinimalDom();
    const root = (globalThis as unknown as { document: { createElement(tag: string): unknown } })
      .document.createElement("div");
    // The item still carries the binding a removed destination left behind —
    // the picker cannot render it, so it is not a choice the owner made.
    const wizard = setBatch(createWizardState(), {
      id: "batch1",
      items: [{ ...item, destinationBindings: ["IG_GONE"] }] as never
    });
    renderPublish(root as never, wizard as never, {
      locale: "en",
      summary: { destinations: [] },
      policy: {},
      handlers: {
        onOpenSettings() {}, onRefreshGrants() {}, onToggleBinding() {},
        onPublishIntent() {}, onEditCaption() {}, onSubmitItem() {},
        onRetry() {}, onCheckManually() {}, onBack() {}
      }
    } as never);
    const submit = submitButtons(root)[0] as { disabled?: boolean };
    expect(submit).toBeDefined();
    expect(submit.disabled).toBe(true);
  });

  /*
   * The stored-but-revoked case: the destination row still exists (history
   * is not rewritten) but the server's live read says its grant is gone.
   * The row renders marked and untouchable; a submit resting on it alone
   * stays disabled — and re-granting flips `granted` back, re-enabling the
   * owner's original selection instead of re-pointing it elsewhere.
   */
  it("shows a revoked destination marked and keeps a submit resting on it alone disabled", () => {
    installMinimalDom();
    const root = (globalThis as unknown as { document: { createElement(tag: string): unknown } })
      .document.createElement("div");
    // The item still points at the destination it was drafted for — the
    // picker's seeded selection — while the summary says its grant is gone.
    const wizard = setBatch(createWizardState(), {
      id: "batch1",
      items: [{ ...item, destinationBindings: ["IG_MAIN"] }] as never
    });
    renderPublish(root as never, wizard as never, {
      locale: "en",
      summary: { destinations: [{ binding: "IG_MAIN", label: "IG", provider: "instagram", granted: false }] },
      policy: {},
      handlers: {
        onOpenSettings() {}, onRefreshGrants() {}, onToggleBinding() {},
        onPublishIntent() {}, onEditCaption() {}, onSubmitItem() {},
        onRetry() {}, onCheckManually() {}, onBack() {}
      }
    } as never);
    const rows = findAll(root as never, (e: { className?: string }) => String(e.className ?? "").includes("sl-dest-row"));
    expect(rows).toHaveLength(1);
    expect(String((rows[0] as { className?: string }).className)).toContain("sl-dest-row-revoked");
    const checkbox = findAll(rows[0] as never, (e: { tagName?: string }) => e.tagName === "INPUT")[0] as { disabled?: boolean };
    expect(checkbox.disabled).toBe(true);
    expect(findAll(rows[0] as never, (e: { textContent?: string }) => String(e.textContent ?? "").includes("access revoked"))).toHaveLength(1);
    const submit = submitButtons(root)[0] as { disabled?: boolean };
    expect(submit.disabled).toBe(true);
  });

  it("re-enables the same selection once the grant is back", () => {
    const root = publishView({ destinations: [{ binding: "IG_MAIN", label: "IG", provider: "instagram", granted: true }] });
    const rows = findAll(root as never, (e: { className?: string }) => String(e.className ?? "").includes("sl-dest-row"));
    expect(rows).toHaveLength(1);
    expect(String((rows[0] as { className?: string }).className)).not.toContain("sl-dest-row-revoked");
  });

  it("shows no notice once a destination exists", () => {
    const root = publishView({ destinations: [{ binding: "IG_MAIN", label: "IG" }] });
    expect(cards(root)).toHaveLength(1);
    expect(notices(root)).toHaveLength(0);
  });
});

describe("suggestProtectedTerms", () => {
  it("offers repeated capitalized names and hashtags from the owner's own posts", () => {
    const items = [
      { text: "Essential Marine Collagen back in stock. #essentialfoods #hk" },
      { text: "Essential Marine Collagen pairs with breakfast. #essentialfoods" },
      { text: "The usual roundup. #hk" }
    ];
    const { terms, hashtags } = suggestProtectedTerms(items as never);
    expect(terms).toContain("Essential Marine Collagen");
    expect(terms).not.toContain("The"); // sentence-opener, not a product name
    expect(hashtags).toEqual(["essentialfoods", "hk"]); // sorted by frequency
  });

  it("suggests nothing seen only once, and nothing from an empty list", () => {
    expect(suggestProtectedTerms([{ text: "AgenticOS Pro once." }] as never).terms).toEqual([]);
    expect(suggestProtectedTerms([] as never)).toEqual({ terms: [], hashtags: [] });
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

  it("Continue creates a batch and moves the wizard from select to publish", () => {
    let wizard = createWizardState();
    expect(wizard.step).toBe("select");
    wizard = setBatch(wizard, baseBatch);
    expect(wizard.step).toBe("publish");
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
    // A state with no delivery evidence is an outcome to inspect, not a
    // silent draft and not "unavailable" — unknown maps to attention.
    expect(drawerAction({ state: "published" }).kind).toBe("outcome");
    // The real published path: a live delivery at the current revision
    // whose canonical outcome reads back published shows its receipt.
    expect(drawerAction({
      state: "review_requested",
      phase: "published"
    }).kind).toBe("receipt");
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
    // The whole card is the open affordance — the Sources shape's
    // `.sl-post-open` button — which opens the drawer for its batch.
    await buttons.find((button) => button.classList?.contains("sl-post-open"))?.dispatchEvent({ type: "click" });
    expect(calls).toEqual(["inspect:b1"]);
  });

  // §9 — the Content card IS a post: per-item chips, per-item drawer
  // targeting, per-item selection across batches.
  const phaseBatch = (id: string, items: any[], extra: Record<string, unknown> = {}) => ({
    id,
    draftCount: 0, reviewCount: 0, scheduledCount: 0, attentionCount: 0,
    items,
    ...extra
  });
  const summaryItem = (batchItemId: string, patch: Record<string, unknown> = {}) => ({
    batchItemId,
    batchId: "b",
    itemId: `src-${batchItemId}`,
    state: "drafting",
    revision: 1,
    phase: "draft",
    deliveries: [],
    sourceLabel: "Account",
    sourceText: "Source post text",
    caption: "Saved caption",
    ...patch
  });

  it("targets the drawer at the one clicked post, not its batch", () => {
    const drawer = drawerProjection(
      { id: "b1", items: [summaryItem("bi-1"), summaryItem("bi-2", { caption: "Other" })] },
      null,
      "bi-2"
    );
    expect(drawer?.batchItemId).toBe("bi-2");
    // Siblings stay available for navigation without becoming the subject.
    expect(drawer?.items).toHaveLength(2);
  });

  it("selects posts across batches and keeps the selection through filter changes", () => {
    let state = setInboxSummaries(createInboxState(), {
      batches: [
        phaseBatch("b1", [summaryItem("bi-1"), summaryItem("bi-2")], { draftCount: 2 }),
        phaseBatch("b2", [summaryItem("bi-3", { batchId: "b2", phase: "in_review" })], { reviewCount: 1 })
      ],
      totals: { batches: 2, items: 3, drafts: 2, review: 1 }
    });
    state = toggleInboxItem(state, "bi-1", { batchId: "b1", itemId: "src-bi-1", revision: 1 });
    state = toggleInboxItem(state, "bi-3", { batchId: "b2", itemId: "src-bi-3", revision: 2 });
    expect(inboxSelectionCount(state)).toBe(2);

    // A filter that hides a selected post does not drop the selection.
    state = setInboxFilter(state, "review");
    expect(inboxSelectionCount(state)).toBe(2);
    expect(visibleInboxItems(state).map(({ item }) => item.batchItemId)).toEqual(["bi-3"]);

    // A summaries refresh carries the freshest observed revision forward.
    state = setInboxFilter(state, "all");
    state = setInboxSummaries(state, {
      batches: [
        phaseBatch("b1", [summaryItem("bi-1", { revision: 4 }), summaryItem("bi-2")], { draftCount: 2 }),
        phaseBatch("b2", [summaryItem("bi-3", { batchId: "b2", phase: "in_review" })], { reviewCount: 1 })
      ]
    });
    expect(selectedInboxItems(state).find((entry) => entry.batchItemId === "bi-1")?.revision).toBe(4);

    state = clearInboxSelection(state);
    expect(inboxSelectionCount(state)).toBe(0);
  });

  it("checkboxes select without opening, and the dock reports the count", async () => {
    installMinimalDom();
    const root = document.createElement("main");
    const calls: string[] = [];
    renderInbox(root, setInboxSummaries(createInboxState(), {
      batches: [phaseBatch("b1", [summaryItem("bi-1")], { draftCount: 1 })],
      totals: { batches: 1, items: 1, drafts: 1 }
    }), {
      locale: "en",
      handlers: {
        onInspectBatch: (batch: { id: string }, itemId: string) => calls.push(`inspect:${batch.id}:${itemId}`),
        onSelectItem: (id: string, entry: { revision: number }) => calls.push(`select:${id}:${entry.revision}`),
        onClearItemSelection: () => calls.push("clear"),
        onReviewSelected: () => calls.push("review"),
        onInboxFilter: () => {},
        onLoadMoreBatches: () => {}
      }
    });
    // The checkbox is a sibling of the open button — change selects only.
    const checkbox = findAll(root, (node) => node.classList?.contains("sl-post-check"))[0];
    expect(checkbox).toBeTruthy();
    await checkbox.dispatchEvent({ type: "change", currentTarget: { checked: true } });
    expect(calls).toEqual(["select:bi-1:1"]);

    // The card body still opens — and names the ITEM, not just the batch.
    await findAll(root, (node) => node.classList?.contains("sl-post-open"))[0]?.dispatchEvent({ type: "click" });
    expect(calls[1]).toBe("inspect:b1:bi-1");
  });

  it("renders the dock once posts are selected, wired to clear and review", async () => {
    installMinimalDom();
    const root = document.createElement("main");
    const calls: string[] = [];
    const state = toggleInboxItem(
      setInboxSummaries(createInboxState(), {
        batches: [phaseBatch("b1", [summaryItem("bi-1")], { draftCount: 1 })],
        totals: { batches: 1, items: 1, drafts: 1 }
      }),
      "bi-1",
      { batchId: "b1", itemId: "src-bi-1", revision: 1 }
    );
    renderInbox(root, state, {
      locale: "en",
      handlers: {
        onInspectBatch: () => {},
        onSelectItem: () => {},
        onClearItemSelection: () => calls.push("clear"),
        onReviewSelected: () => calls.push("review"),
        onInboxFilter: () => {},
        onLoadMoreBatches: () => {}
      }
    });
    expect(root.textContent).toContain("1 selected");
    const buttons = findAll(root, (node) => node.tagName === "BUTTON");
    await buttons.find((button) => button.textContent === "Clear")?.dispatchEvent({ type: "click" });
    await buttons.find((button) => button.textContent === "Review selected")?.dispatchEvent({ type: "click" });
    expect(calls).toEqual(["clear", "review"]);
  });

  it("maps every shared phase to its drawer action, queued included", () => {
    // A marked, un-drafted item is queued — the action is to wait, not
    // "continue" into output that does not exist.
    expect(drawerAction({ state: "drafting", revision: 0, generation: "requested" }).kind).toBe("waiting");
    expect(drawerAction({ state: "drafting", revision: 2, generation: "requested" }).kind).toBe("resume");
    expect(drawerAction({ phase: "queued" }).kind).toBe("waiting");
    expect(drawerAction({ phase: "in_review" }).kind).toBe("approval");
    expect(drawerAction({ phase: "scheduled" }).kind).toBe("schedule");
    expect(drawerAction({ phase: "published" }).kind).toBe("receipt");
    expect(drawerAction({ phase: "attention" }).kind).toBe("outcome");
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

  it("Draft N posts lands on Content, records the filing, and the card says how it stands", async () => {
    installMinimalDom();
    document.documentElement.lang = "en";

    const item = makeItem({ id: "a", seen: false, selected: true });
    let createdArgs: unknown = null;
    (globalThis as any).gadget = {
      async summary() {
        return {
          configured: true,
          sources: [{ binding: "IG_MAIN", provider: "instagram", label: "Instagram · main" }],
          destinations: [],
          config: {}
        };
      },
      async listItems() {
        return { items: [item], nextCursor: null };
      },
      async setSelection() {},
      async clearSelection() {},
      async refresh() {},
      async markSeen() {},
      async createBatch(args: unknown) {
        createdArgs = args;
        return {
          id: "batch_test1",
          items: [{ id: "bi_1", sourceItem: item, state: "drafting", revision: 0, destinationBindings: [], publications: [] }],
          // What the host hands back: the gadget's request, annotated with the
          // governed filing outcome (`attended-work-request.ts`). The request id
          // travels with it so the client's stamp can be matched to the ask.
          workRequest: {
            requestId: "gen_1",
            batchId: "batch_test1",
            sourceLabel: "Instagram · main",
            itemIds: ["a"],
            intake: ["saveRevisions", "saveRevision", "saveGeneratedImage"],
            parts: { caption: true, image: true },
            filed: true,
            actionId: "act_1"
          }
        };
      },
      async listBatchSummaries() {
        // Empty until the batch exists — otherwise the view opens on Content
        // before the click this test is about. The item's mark carries the
        // dispatch the ROOM recorded, because the canvas no longer records it
        // itself (audit correction, F4).
        if (!createdArgs) return { batches: [], nextCursor: null, totals: { batches: 0, items: 0, drafts: 0, review: 0, scheduled: 0, attention: 0 } };
        const generation = JSON.stringify({
          id: "gen_1",
          base: 0,
          scope: { caption: true, image: true },
          needs: { caption: true, image: true },
          at: "2026-09-10T00:00:00.000Z",
          dispatch: { filed: true, actionId: "act_1", reason: null, source: "host" }
        });
        return {
          batches: [{
            id: "batch_test1", status: "open", generation: "requested", itemCount: 1, draftCount: 1, reviewCount: 0, scheduledCount: 0, attentionCount: 0,
            sourceItemIds: ["a"],
            preview: { batchItemId: "bi_1", sourceLabel: "Instagram · main", sourceText: item.text, caption: null, revision: null, hasMediaReference: false },
            items: [{ batchItemId: "bi_1", itemId: "a", state: "drafting", revision: 0, sourceLabel: "Instagram · main", provider: "instagram", sourceBinding: "IG_MAIN", sourceText: item.text, coverMediaId: null, caption: null, generation }]
          }],
          nextCursor: null,
          totals: { batches: 1, items: 1, drafts: 1, review: 0, scheduled: 0, attention: 0 }
        };
      },
      async subscribe() {
        return {};
      }
    };

    await import(pathToFileURL(bundlePath).href + `?case=draft-ask-${Date.now()}`);
    await flushAsyncWork();

    // The batch's creation call-to-action wears the brand variant, not primary.
    const primary = findAll(document.body, (element) => element.tagName === "BUTTON" && element.classList.contains("sl-brand"))[0];
    expect(primary.textContent).toBe("Draft 1 post");
    await primary.dispatchEvent({ type: "click", preventDefault: () => {} });
    await flushAsyncWork();

    // The batch was created with no destination precondition — an empty
    // list is the recorded default, not a refusal.
    expect(createdArgs).toBeTruthy();
    expect((createdArgs as { destinationBindings: string[] }).destinationBindings).toEqual([]);

    // The canvas did NOT record the filing outcome: that receipt is the room's
    // own account, written before the result reached the page. There is no
    // browser method to claim it.
    expect((globalThis as any).gadget.recordGenerationDispatch).toBeUndefined();

    // Content tab shows the selected post as a card immediately — the
    // Sources shape (article.sl-post). With the filing accepted, the chip
    // reads "Awaiting approval", not "generating" (agenticos#1861). There is
    // no ask card: the owner is not the courier.
    expect(findAll(document.body, (element) => element.classList.contains("sl-ask"))).toHaveLength(0);
    const card = findAll(document.body, (element) => element.classList.contains("sl-post"))[0];
    expect(card).toBeTruthy();
    expect(card.textContent).toContain(item.text.split("\n")[0].slice(0, 90));
    expect(findAll(card, (element) => element.classList.contains("sl-state-chip")).map((c) => c.textContent)).toContain("Awaiting approval");
    // The wizard's Localize step never opened.
    expect(findAll(document.body, (element) => element.classList.contains("sl-zh-edit"))).toHaveLength(0);
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

      // Fill the content prompt, so the submitted payload is not just the
      // bare default draft.
      const promptInput = findAll(document.body, (element) => element.getAttribute?.("name") === "setupContentPrompt")[0];
      promptInput.value = "Keep AgenticOS Pro verbatim.";
      await promptInput.dispatchEvent({ type: "change" });
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
      expect(normalized.contentPrompt).toBe("Keep AgenticOS Pro verbatim.");
      expect(normalized.locale).toEqual({ from: "en", to: "zh-HK" });

      // No leftover error banner, and the setup form is gone — the view
      // moved on once `setConfig` resolved (`refreshSummary` +
      // `loadCollection("new")`).
      expect(findAll(document.body, (element) => hasClass(element, "sl-setup-error"))).toHaveLength(0);
      expect(findSetupForm(document)).toBeTruthy();
      expect(document.body.textContent).toContain("Settings saved. Monitoring was not changed.");

      // Staying is for explicit activation, not a dead end: once the first
      // save makes the gadget configured, the way back to the posts is drawn.
      // Before, it rendered only when the form was re-opened from Settings,
      // so a new owner had nothing to press but reload.
      const back = findAll(document.body, (element) => element.tagName === "BUTTON" && element.textContent === "Cancel");
      expect(back).toHaveLength(1);
    });

    it("offers the scan cadence grant when turning monitoring on is refused for it", async () => {
      const { document } = installMinimalDom();
      document.documentElement.lang = "en";
      const { gadget } = unconfiguredGadget(async () => ({ configured: true }));
      (gadget as Record<string, unknown>).setMonitoring = async () => ({
        ok: false,
        code: "schedule_not_granted",
        requirementKey: "schedule",
        message: "Grant the scan cadence before turning monitoring on."
      });
      (globalThis as any).gadget = gadget;

      await import(pathToFileURL(bundlePath).href + `?case=schedule-not-granted-${Date.now()}`);
      await flushAsyncWork();
      await findPrimaryButton(document).dispatchEvent({ type: "click", preventDefault: () => {} });
      await flushAsyncWork();

      const enable = findAll(document.body, (element) => element.tagName === "BUTTON" && element.getAttribute?.("data-monitor-enable") === "true")[0];
      expect(enable.disabled).toBe(false);
      await enable.dispatchEvent({ type: "click", preventDefault: () => {} });
      await flushAsyncWork();

      const banner = findAll(document.body, (element) => hasClass(element, "sl-setup-error"))[0];
      expect(banner?.textContent).toContain(t("en", "scheduleNotGrantedBody"));
      // The owner's language, not the server's diagnostic sentence.
      expect(banner?.textContent).not.toContain("Grant the scan cadence before turning monitoring on.");
      const grant = findAll(banner, (element) => element.tagName === "BUTTON")[0];
      expect(grant?.textContent).toBe(t("en", "scheduleGrantAction"));
      for (const locale of LOCALES) {
        for (const key of ["scheduleNotGrantedBody", "scheduleGrantAction"]) expect(t(locale, key), `${locale}.${key}`).not.toBe(key);
      }
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
        const promptInput = findAll(document.body, (element) => element.getAttribute?.("name") === "setupContentPrompt")[0];
        promptInput.value = "changed";
        await promptInput.dispatchEvent({ type: "change" });
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

  /*
   * ONE AT A TIME.
   *
   * Every cover used to be requested at once, which does not make them arrive
   * sooner — the transport under `getMedia` runs one call at a time — but does
   * start every call's timeout while it is still waiting its turn. On a real
   * fifteen-post grid the first three covers arrived and the other nine died on
   * a timeout they spent entirely in the queue, which looks exactly like a
   * broken fetch door.
   */
  function gridOf(count: number, loadCover: (i: string, m: string) => Promise<string>) {
    installMinimalDom();
    const root = (globalThis as unknown as { document: { createElement(tag: string): unknown } })
      .document.createElement("div");
    const items = Array.from({ length: count }, (_, index) => ({
      ...base, id: `i${index}`, providerItemId: `p${index}`
    }));
    const state = setItems(createCollectionState(), { items: items as never, nextCursor: null });
    renderCollection(root as never, state as never, {
      locale: "en", sources: [], handlers: { onSelect() {}, onOpen() {}, onMore() {} }, loadCover
    } as never);
    return root;
  }

  it("fetches a few covers at a time, and never the whole grid at once", async () => {
    let inFlight = 0;
    let mostAtOnce = 0;
    const order: string[] = [];
    const root = gridOf(12, async (itemId) => {
      inFlight += 1;
      mostAtOnce = Math.max(mostAtOnce, inFlight);
      order.push(itemId);
      await Promise.resolve();
      inFlight -= 1;
      return `blob:${itemId}`;
    });
    await flushAsyncWork(12);
    // Strictly sequential made the grid the sum of its parts; all-at-once
    // rebuilds the queue on the host's side of the wire, which is what timed
    // nine covers out in the first place. Four is the host's pool.
    expect(mostAtOnce).toBe(4);
    // Started in the order the cards are read, whatever order they finish in.
    expect(order.slice(0, 4)).toEqual(["i0", "i1", "i2", "i3"]);
    expect(images(root)).toHaveLength(12);
  });

  it("lets a stalled cover hold up only itself", async () => {
    let release: (() => void) | null = null;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const done: string[] = [];
    const root = gridOf(8, async (itemId) => {
      if (itemId === "i0") await stalled;
      done.push(itemId);
      return `blob:${itemId}`;
    });
    await flushAsyncWork(12);
    // Seven of eight drew while the first was still waiting; a single line
    // would have drawn none of them.
    expect(images(root)).toHaveLength(7);
    expect(done).not.toContain("i0");
    release!();
    await flushAsyncWork(12);
    expect(images(root)).toHaveLength(8);
  });

  it("keeps going after one cover fails, instead of stopping the rest of the grid", async () => {
    const root = gridOf(3, async (itemId) => {
      if (itemId === "i1") throw new Error("no cached bytes");
      return `blob:${itemId}`;
    });
    await flushAsyncWork();
    expect(images(root)).toHaveLength(2);
  });
});


// ---------------------------------------------------------------------------
// steps.js — draft first: publishing authority is asked for at submit
// ---------------------------------------------------------------------------

describe("the publish step, when publishing authority is missing", () => {
  it("says so in the owner's language and asks the host for the Social Hub publisher", async () => {
    installMinimalDom();
    const root = document.createElement("main");
    const calls: string[] = [];
    const batch = {
      id: "b1",
      items: [
        {
          id: "bi1",
          revision: 1,
          caption: "第一稿內容文字",
          state: "drafting",
          destinationBindings: [],
          publications: [],
          posterLayout: null,
          sourceItem: { sourceLabel: "@essentialfoodsofficial", provider: "instagram" }
        }
      ]
    };
    let state = resumeBatch(createWizardState(), batch as never);
    state = setPublishError(state, "bi1", {
      code: "publisher_not_granted",
      message: "Grant the Social Hub publisher before submitting for review."
    });
    const handlers = new Proxy(
      { onGrantPublishing: (id: string) => calls.push(`grant:${id}`) } as Record<string, unknown>,
      { get: (target, key: string) => (key in target ? target[key] : () => {}) }
    );
    renderPublish(root, state, {
      locale: "en",
      handlers,
      policy: normalizeConfig({ cadence: "daily" }),
      summary: { destinations: [{ destinationBinding: "IG_FAVCRM", label: "@favcrm.io", provider: "instagram" }] }
    });

    const alert = findAll(root, (node) => node.getAttribute?.("role") === "alert")[0];
    expect(alert?.textContent).toContain(t("en", "publisherNotGrantedBody"));
    expect(alert?.textContent).not.toContain("Grant the Social Hub publisher before submitting for review.");

    const grant = findAll(root, (node) => node.tagName === "BUTTON" && (node.textContent ?? "").includes(t("en", "publisherGrantAction")))[0];
    expect(grant).toBeTruthy();
    await grant.dispatchEvent({ type: "click" });
    expect(calls).toEqual(["grant:bi1"]);
  });

  it("has the refusal and its action in every locale", () => {
    for (const locale of LOCALES) {
      for (const key of ["publisherNotGrantedTitle", "publisherNotGrantedBody", "publisherGrantAction"]) {
        expect({ locale, key, present: Boolean((STRINGS as Record<string, Record<string, string>>)[locale]?.[key]) }).toEqual({ locale, key, present: true });
      }
    }
  });
});
