# Social Content — "generate-first" userflow (PM decision note)

Status: **decisions applied** — see "Decisions" below
Context: `agenticos-stack/bot-social-content`, branch `agent/draft-before-destination`, draft PR #28

## Background

Social Content today is a draft-localize-review-publish pipeline:

1. Sources tab lists observed posts (connected accounts + watched public accounts).
2. Owner selects posts → the action creates batch items in `drafting`.
3. The **Localize** step is where a caption gets written — by the owner, or by
   the conversation agent calling `saveRevision` — with hard validation:
   written-Chinese checks, protected literals, claims requiring confirmation.
4. **Publish**: destination + timing chosen at submit. This is the
   `publications` refactor — it lives on this branch, **unmerged** (PR #28),
   not shipped.

### Correction — generation has never worked by any path

An earlier draft of this note claimed a scan can emit a `workRequest` that "the
platform files as an action." **Verified false** (checked in
`agenticos-stack/api`):

- `workRequestFor` in `server.js` builds `{ batchId, sourceLabel, itemIds,
  intake: "saveRevision" }` and returns it from `runScan`.
- The platform's scheduled-hook path discards it:
  `schedule-room-invoker.ts` parses the room's `/call` response only for
  `error`/`detail` and returns `{ ok: true }` —
  `schedule-delivery.ts` keeps only `ScheduleRunOutcome`
  (`{ ok } | { ok: false, error, blocked }`). The hook's result body goes
  nowhere.
- `workRequest` elsewhere in the API is `ArtifactWorkRequestV1`
  (video/presentation artifacts) — an unrelated type that shares the name.

So `config.drafting === "on_new"` has never produced a revision: the request is
built, returned, and dropped. The gadget has no in-process LLM — the only
generation path is the conversation agent, and nothing has ever filed that
request. Tracked as an api-repo issue (see Decisions 1).

## Proposed userflow

1. Owner selects post(s) on **Sources** and presses **Draft N posts**.
2. The batch opens (items in `drafting`); the **Content** tab shows the pending
   drafts and a ready-to-send message the owner can paste to the workspace
   agent — one agent turn drafts the whole batch.
3. Generated revisions land on **Content** as the agent saves them.
4. Owner opens one generated post, optionally edits in **Localize**.
5. **Publish** — destination + timing at submit (publications model).

## Decisions (PM, applied)

1. **Trigger: chat-driven for now.** After Continue the Content tab shows the
   pending drafts plus the phrasing to send the agent. No platform
   work-request mechanism is built here; an api-repo issue describes what
   would be needed (a `workRequest` surfaced from a gadget *method* result,
   not only a schedule hook — which today is discarded anyway).
2. **Image prompt → text poster scope.** The field is renamed `posterPrompt`
   and labelled as driving the text-poster renderer that already exists. No
   pixel generation is promised.
3. **Protections restored under "Advanced" — plus the bypass fix.** Protected
   product names, protected hashtags, disclaimers and claims-requiring-confirmation
   return in Settings §2 under a collapsed disclosure — `detectProtectedLiterals`
   still gates `saveRevision`, so an invisible gate is worse than none. Accuracy
   note: the gap was vacuous only for *names* — prices and URLs are pattern-detected
   with no policy at all. The real hole was agent-side: any caller-supplied
   `refinementBrief.allowedChanges` routed `saveRevision` to `validateGrounded`,
   which ran ledger checks but no source-preservation — `["tone"]` alone let a
   protected product name translate away and still validate. Now:
   - Source-preservation for product/disclaimer/price/url/hashtag runs on
     **both** validation paths (`sourcePreservationIssues`, shared).
   - Caller `allowedChanges` is honoured only where the org's stored brief
     permits it — otherwise stripped, so the grounded path can't be invoked
     by an unpermitted write.
   - `getBatch` returns each item's `detectProtectedLiterals` spans
     (`protectedSpans`) — the agent is handed the values, not left to infer.
   A "suggest from watched posts" affordance prefills candidate terms.
4. **Rights: `require_confirmation` stays.** No trust option — legal gate.
5. **One agent turn per batch — via `saveRevisions`, not N calls.** The
   original phrasing ("count on the button") missed the platform shape:
   `describeMethodCall` (v2/gadget-actions.ts) marks a non-read gadget method
   a write with **no `routine`**, and `decide.ts`'s only standing-agreement
   path is `agreedTo && action.routine` — so per-item `saveRevision` asks on
   every call and a refusal ends the turn. Twelve posts would be twelve
   approval cards. Built instead: `saveRevisions({ revisions: [...] })` —
   one write, one card, per-item `{ok, revision, issues}` results that refuse
   by value. Singular `saveRevision` stays for edits. The action's count is
   **draftable** items, not selected: posts already in an open draft are
   skipped and named, not sent to a batch the server would refuse.
6. **Publish cardinality: no change** — the publications model already
   handles per-item submit across a batch.
7. **Localize stays** as the edit path for a generated revision and as the
   manual path whenever generation is unavailable — which is every state
   today.
8. **Rights vs drafting (new): SEC-002 wins.** `held_rights` items are
   draftable — a draft with unconfirmed rights may exist; it may not be SENT.
   The gate stays at `submitForReview`, where it already refuses by value
   (`rights_unconfirmed`). Content surfaces the split: "12 drafts, 9 awaiting
   rights". `agent.md` does not drop the prohibition — it narrows it: draft
   only what the owner selected, never unattended — because the blanket rule
   was what stopped scan-triggered drafting spending credits on posts the
   owner may never be allowed to use.

## Durable generation ask (decision 1, refined)

The Content-tab ask is durable state, not client memory: `createBatch` marks
the batch `generation: "requested"` (migration 9 adds the column), the card
reads it off `listBatchSummaries`, so a reload still shows the ask. It clears
when every active item carries a revision, or when the owner dismisses
(`dismissGenerationAsk`).

## Mutation lane (pre-task)

Upstream's workspace-docs blueprint carries a serial `mutationQueue` —
"RPC calls may overlap at await points". Ours had none, and the host-side
queue was replaced with a 4-way pool, so overlapping RPC is real. Every
mutating public method now runs through `enqueueMutation`; internals
(`openBatch`, `runScan`, `saveConfiguration`) are reached only inside a lane.
This predates `saveRevisions` — a batch write makes it more pressing, not less.

## Expected result (acceptance)

- An owner selects posts on Sources, presses **Draft N posts**, and lands on
  Content seeing the new batch's pending drafts plus the exact message to send
  the agent (copyable, names the batch id and both prompts).
- As the agent saves revisions, the drafts appear on Content; Inspect →
  Continue editing opens Localize for edits.
- Publish picks destination + timing at submit; the publications pair rule is
  preserved.
- Validation still applies to generated drafts: a revision that drops a
  protected literal or skips a required claim confirmation cannot submit —
  on **either** validation path, and no caller-supplied brief can widen what
  the org's stored brief permits.
- A `held_rights` item accepts a draft and still refuses submit until the
  owner confirms rights.
- The ask survives a reload (`generation` is a batch column), clears itself
  once every item is drafted, and dismisses durably.
- The manual path survives: with empty prompts or no agent, the owner drafts
  by hand exactly as today.
