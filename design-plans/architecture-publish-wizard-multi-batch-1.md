---
goal: Generalize the Publish wizard to hold a selection of items spanning multiple server-side batches
version: 1.0
date_created: 2026-09-12
owner: Social Content
status: 'Planned'
tags: [architecture, migration, refactor]
---

# Publish wizard: from one batch to a selection of items

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Context: `agenticos-stack/bot-social-content`, PR #33 (`claude/publish-flow-polish`,
merged Review into Publish, one control scale, the corrected floating-dock
rule). This plan is the next step PR #33 deliberately does not take.

`wizard.batch` is one server-side batch object today: one `id`, one
`approval`, one `generation` mark, one array of `items` that all belong to
it. Every function that reads the wizard assumes that. This plan replaces
that shape with a flat selection of items, each stamped with the batch it
came from, so the wizard can represent "the drafts the owner picked," which
is not the same thing as "one batch."

## Why this exists

An owner's unit on the Content tab is "the drafts I want to publish." A
batch is our bookkeeping for how work arrived — one agent turn, one
`createBatch` call — not a concept the owner holds. Content's card grid is
already flat across batches (`visibleBatchSummaries(state).flatMap(batch =>
items.map(...))`), so a natural multi-select there spans batches by nature:
two items an owner picks together may have been drafted by two different
turns. Today, nothing downstream of that selection can represent it — the
wizard can only ever be `resumeBatch`d from one real batch's items.

## 1. Requirements & Constraints

- **REQ-001**: The wizard must be enterable with a set of items drawn from
  more than one server-side batch, reached from a new Content tray action
  (out of scope for this plan; see GOAL-003).
- **REQ-002**: `onSubmitItem` (per-item `submitForReview`) does not change —
  it is already scoped to one item and does not read `wizard.batch.id`.
- **REQ-003**: The approval note on each card must read that item's OWN
  source batch's approval, not a single shared value.
- **CON-001**: No new RPC methods. No change to what submit sends or how the
  door resolves it.
- **CON-002**: `rpc.getBatch(id)` and `rpc.requestGeneration(id)` remain
  single-batch calls (server-side, unchanged) — the client is responsible for
  calling them once per distinct batch id and merging.
- **CON-003**: Every one of the 13 `setBatch`/`resumeBatch`/`wizard.batch`
  assertions in `test/unit/client.test.ts` (lines 293-390) is written
  against the single-batch shape and must be rewritten, not just relabeled —
  several assert directly on `wizard.batch.items[...]`.
- **GUD-001**: Keep the wizard state shape honest about what it holds. A
  field named `batch` that is only sometimes one batch is the same defect
  wearing a different hat (this repo's own rule, applied to itself).
- **PAT-001**: `post-card.js`'s `selectable`/`selected`/`onSelect` card props
  already exist (built for the Sources tab) — Content's selection reuses
  them; this is not new capability, just a new caller.

## 2. Implementation Steps

### Implementation Phase 1 — state shape

- GOAL-001: Replace the single-batch wizard state with a flat item
  selection, in `src/src/client/steps.js`, verified in isolation before
  anything in `client.js` depends on the new shape.

New shape:

```js
wizard.items;    // BatchItem[] -- flat, each stamped with item.sourceBatchId
wizard.batches;  // { [batchId]: { id, approval, generation } } -- per-batch
                 // metadata, keyed by the id every item in `items` points at
```

`wizard.batch` is removed. `wizard.activeItemId` is unchanged in meaning.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Replace `createWizardState()`'s `batch: null` with `items: []`, `batches: {}` | | |
| TASK-002 | Rewrite `setBatch`/`resumeBatch` to accept an array of `{ item, sourceBatchId, batchMeta }` (or one legacy `{id, items, approval, generation}` batch, stamping every item with that one id, for the single-batch caller in Phase 2) and to MERGE into existing `wizard.items`/`wizard.batches` by id rather than replace — the single-batch entry path becomes the degenerate case of merging into an empty selection | | |
| TASK-003 | Update `recordDraftConflict`/`resolveDraftConflict` to index into `wizard.items` (find-by-id) instead of `state.batch.items.map` | | |
| TASK-004 | Update `applySavedRevision`/`applySavedPoster` the same way | | |
| TASK-005 | Update `reviewEnabled`/`submitEnabled`/`submitItemEnabled` to iterate `state.items` instead of `state.batch.items` | | |
| TASK-006 | `renderPublish`: replace the single `const approval = batch.approval` computed once with a per-item lookup — `wizard.batches[item.sourceBatchId]?.approval` — inside the item map, so each card's approval note reads its own batch's fact. This is a real logic change (approval per item), not a rename | | |
| TASK-007 | `renderPublish`: the `destinations.length ? ... : emptyDestinations` grid maps `wizard.items` directly; drop `const batch = state.batch` | | |
| TASK-008 | `renderResult`: same replacement — iterate `state.items`, drop `const batch = state.batch` | | |
| TASK-009 | Rewrite the 13 `client.test.ts` assertions (lines 293-390) against the new shape: `setBatch`/`resumeBatch` call sites, `wizard.batch.items[...]` reads, `kept.batch.items[0].revision` | | |

Exit criteria: `npx vitest run test/unit --pool=threads --maxWorkers=1
--no-file-parallelism` green, with zero references to `wizard.batch` left in
`steps.js` or its tests. `client.js` is not touched in this phase — it still
imports and calls the old function signatures, so it will not build; that is
expected and closed in Phase 2, not patched around here.

### Implementation Phase 2 — client.js call sites

- GOAL-002: Move `client.js`'s 8 `wizard.batch` references onto the new
  shape, keying the two batch-scoped RPC calls per their item's own
  `sourceBatchId` instead of one shared id.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | `onSubmitItem`'s success re-fetch: today `rpc.getBatch(wizard.batch.id)` once. Replace with: collect the distinct `sourceBatchId`s actually present in `wizard.items`, `Promise.all` a `rpc.getBatch` per distinct id, merge each returned batch's items back into `wizard.items` by id (same merge helper as `resumeBatch`) | | |
| TASK-011 | Regenerate, inside `openBatchDrawer` (client.js `~967`): already keys off the drawer's own local `batch` (from `rpc.getBatch(summaryRow.id)`), not `wizard.batch` — confirm this stays correct once `onEditCaption` (TASK-013) can open the drawer for one item drawn from a multi-batch selection; no change expected here, verify only | | |
| TASK-012 | The queued-scan guard (`if (wizard.batch) return`, client.js `~1711`) becomes `if (wizard.items.length) return` | | |
| TASK-013 | `onEditCaption` (client.js, documented at the call site as of this PR): resolve the clicked item's OWN `sourceBatchId` — `wizard.items.find(i => i.id === itemId)?.sourceBatchId` — and pass that to `openBatchDrawer`, instead of the removed `wizard.batch.id`. Remove the single-batch comment left at this call site once this lands | | |
| TASK-014 | `WIZARD_BACK_TARGET`/`onBack`: `wizard.step` logic is unaffected; the "leaving the batch" comment text should say "leaving the selection" | | |
| TASK-015 | `refreshPublishState` (client.js `~1449`): iterates `wizard.batch.items` today; becomes `wizard.items` | | |

Exit criteria: `npx tsx --test --test-concurrency=1 test/build.test.mjs`
green (confirms the bundle still builds with no stray backtick or reference
error), full unit suite green, existing single-batch flows (open one batch's
drawer → Continue to publish → submit) manually verified unchanged in the
local preview.

### Implementation Phase 3 — Content selection and tray

- GOAL-003: Give Content the same selection shape Sources already has, and
  wire its tray action to the generalized wizard entry point from Phase 1-2.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | Add a Content-scoped selection tracker (`inboxState.selectedIds`, mirroring `collectionState.selectedIds`) — a separate set from Sources', since it is a different list | | |
| TASK-017 | `inbox.js`'s `itemCard`: pass `selectable: true`, `selected`, `onSelect` through to `renderPostCard` — the props already exist (`post-card.js`, built for Sources); this is reuse, not new capability | | |
| TASK-018 | Render the existing `.sl-selection`/`.sl-selection-inner` dock on Content when `selectedIds.size > 0` — this is now a correct use of that dock under the rule fixed in PR #33 (selection-scoped, transient), not a second exception to it | | |
| TASK-019 | Tray action: resolve each selected item's own batch (from `inboxState`'s already-fetched summaries — no new fetch needed to know which batch an item belongs to), call the Phase-1 merge entry point once per distinct batch id, land on the Publish step with exactly the selected items (not every item of every touched batch) | | |
| TASK-020 | If a selected batch's items projection is not yet loaded (`summaryCard`'s no-items branch), decide and document the behaviour: either disable selection on that card or fetch on selection — do not invent a third, undocumented behaviour | | |

Exit criteria: an owner can select two drafts from two different batches on
Content, press the tray action, and land on Publish showing exactly those
two cards — each with its own poster, its own approval note (its own
batch's fact), and its own submit. `onSubmitItem`, `saveRevisions`,
`savePoster`, and `submitForReview`'s arguments are byte-identical to today.

## 3. Alternatives

- **ALT-001**: Constrain Content's selection to one batch at a time —
  grey out a second card's checkbox once one is picked from a different
  batch. Rejected: cheaper to build (no state-shape change), but the owner
  discovers the rule by being refused, and the rule teaches them a concept
  ("batch") that is our bookkeeping, not theirs. Fixing the data structure
  instead of adding a case is the tiebreaker this repo's own taste note
  states directly.
- **ALT-002**: Keep `wizard.batch` as the name and just let it sometimes
  hold items from several sources without a shape change (duck-type it).
  Rejected outright by GUD-001 — a name that stops being true is the exact
  defect this plan exists to fix, not a shortcut around it.

## 4. Dependencies

- **DEP-001**: PR #33 (`claude/publish-flow-polish`) merged first — this
  plan's file/line references (`onEditCaption`, the merged Publish card,
  the corrected `.sl-selection` rule) assume that state.
- **DEP-002**: `post-card.js`'s existing `selectable`/`selected`/`onSelect`
  props (Phase 3, TASK-017) — no version or API change needed, already
  shipped.

## 5. Files

- **FILE-001**: `src/src/client/steps.js` — state shape (`createWizardState`,
  `setBatch`, `resumeBatch`, `recordDraftConflict`, `resolveDraftConflict`,
  `applySavedRevision`, `applySavedPoster`, `reviewEnabled`, `submitEnabled`,
  `submitItemEnabled`, `renderPublish`, `renderResult`).
- **FILE-002**: `src/src/client/client.js` — the 8 `wizard.batch` call sites
  (`onSubmitItem`, `onEditCaption`, the queued-scan guard, `onBack`,
  `refreshPublishState`, plus `openBatchDrawer`'s own local `batch`, verified
  unaffected).
- **FILE-003**: `src/src/client/inbox.js` — Content's new selection state and
  tray wiring (Phase 3).
- **FILE-004**: `src/src/client/post-card.js` — read only; confirms the
  `selectable`/`selected`/`onSelect` contract Phase 3 reuses.
- **FILE-005**: `test/unit/client.test.ts` — the 13 assertions at lines
  293-390 built against the single-batch shape.

## 6. Testing

- **TEST-001**: Rewrite `test/unit/client.test.ts`'s `setBatch`/`resumeBatch`
  suite (lines 293-390) against the new shape — same behaviors asserted
  (conflict resolution keeps unrelated drafts, a submitted sibling stays
  non-editable, a blocking issue disables submit), new data shape.
- **TEST-002**: New: two `resumeBatch`-equivalent calls into the same wizard
  state, from two different batch ids, assert `wizard.items` holds both and
  `wizard.batches` holds both metadata entries, no cross-contamination.
- **TEST-003**: New: the Phase-2 merge-fetch (TASK-010) with two distinct
  batch ids present — assert exactly one `getBatch` call per distinct id,
  not one per item.
- **TEST-004**: New (Phase 3): tray action with a selection spanning two
  batches lands the wizard on exactly the selected items, not every item of
  the touched batches.
- **TEST-005**: `npx tsx --test --test-concurrency=1 test/build.test.mjs`
  after every phase — the CSS-in-JS backtick trap and bundler integrity
  check this repo has hit twice before.

## 7. Risks & Assumptions

- **RISK-001**: The per-item approval lookup (TASK-006) is a real behavior
  change, not a rename — a card's approval note can now say something
  different from its neighbor's on the same screen for the first time.
  Verify this reads correctly to an owner (two drafts, two different
  approval states, side by side) before shipping, not just that it compiles.
- **RISK-002**: `openBatchDrawer`'s Regenerate re-queues generation for a
  whole real batch. Once the drawer can be opened for one item drawn out of
  a multi-batch selection (TASK-013), confirm Regenerate still visibly
  affects only THAT item's siblings (the ones sharing its `sourceBatchId`),
  not the owner's whole multi-batch selection — the drawer already shows
  only that one batch's items, so this should hold, but state it as a
  explicit check, not an assumption.
- **ASSUMPTION-001**: `listBatchSummaries` (already fetched for the Content
  tab) carries enough per-item batch attribution to build `sourceBatchId`
  without a new RPC call. Confirm against the current summary shape before
  starting Phase 3 (TASK-019/020) — if it does not, that is new scope this
  plan does not currently price.
- **ASSUMPTION-002**: No other caller outside `steps.js`/`client.js`
  constructs or reads `wizard.batch` (checked at plan time: `inbox.js` and
  `collection.js` do not).

## 8. Related Specifications / Further Reading

- PR #33 — `agenticos-stack/bot-social-content#33`, `claude/publish-flow-polish`
  (the Review→Publish merge, one control scale, `onEditCaption`'s
  single-batch comment, the `.sl-selection` dock rule this plan's Phase 3
  now satisfies rather than works around).
- `design-plans/decision-social-content-generate-first-flow-1.md` — this
  repo's house style for a decision/plan note; followed here for section
  register even though this file uses the stricter phase/task template.
