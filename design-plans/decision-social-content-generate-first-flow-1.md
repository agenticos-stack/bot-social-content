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
3. **Protections restored under "Advanced".** Protected product names,
   protected hashtags, disclaimers and claims-requiring-confirmation return in
   Settings §2 under a collapsed disclosure — `detectProtectedLiterals` still
   gates `saveRevision`, so an invisible, vacuous gate is worse than none.
   A "suggest from watched posts" affordance prefills candidate terms.
4. **Rights: `require_confirmation` stays.** No trust option — legal gate.
5. **One agent turn per batch.** The action carries the count
   ("Draft 12 posts") so the spend is visible before it happens.
6. **Publish cardinality: no change** — the publications model already
   handles per-item submit across a batch.
7. **Localize stays** as the edit path for a generated revision and as the
   manual path whenever generation is unavailable — which is every state
   today.

## Expected result (acceptance)

- An owner selects posts on Sources, presses **Draft N posts**, and lands on
  Content seeing the new batch's pending drafts plus the exact message to send
  the agent (copyable, names the batch id and both prompts).
- As the agent saves revisions, the drafts appear on Content; Inspect →
  Continue editing opens Localize for edits.
- Publish picks destination + timing at submit; the publications pair rule is
  preserved.
- Validation still applies to generated drafts: a revision that drops a
  protected literal or skips a required claim confirmation cannot submit.
- The manual path survives: with empty prompts or no agent, the owner drafts
  by hand exactly as today.
