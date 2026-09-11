# QA check — Social Content "generate-first" flow

Scope: PR #28 (`agent/draft-before-destination`), tip `69fa14a`.
Product: `agenticos-stack/bot-social-content` gadget.

## Rig

```bash
cd ~/Project/agenticos-stack/worktrees/social-content-fetch-door
SOCIAL_CONTENT_PREVIEW_MODE=connected-prod \
BOT_SDK_SOURCE=~/Project/agenticos-stack/sdk \
SOCIAL_CONTENT_FRONTEND_ORIGIN=http://social.localhost:18000 \
SOCIAL_CONTENT_PREVIEW_PORT=17923 \
bot-dev dev --gadget social_localization -- npm run preview
```

- Browser: `http://social.localhost:18000/` (gateway) → "Start development session".
- The gadget canvas is a sandboxed OOPIF (`/dev-canvas` iframe). Direct DOM
  reads need the frame's CDP target; `gadget.*` is callable inside it and hits
  the real bridge.
- State: `.bot-local/connected/0e72610a…/runtime` currently holds REAL data —
  15 items from `open:instagram:essentialfoodsofficial` (Norwegian + English
  captions, real product names, four third-party-author posts → `held_rights`).
  The prior seeded runtime is preserved at `runtime.seeded-keep` — restore by
  swapping the directories back with the preview stopped.
- `runtime.lock` is single-writer. A 409 "Local state is locked" means a live
  preview owns it; only `rmdir` the lock after confirming the owner is gone.
- Media >256 KiB requires API ≥ `587400dc` (thumb cap 512 KiB, agenticos#1834).
- After touching `scripts/local-runtime.mjs` or `scripts/preview.mjs`, RESTART
  the preview — hot reload covers `src/` only.

## Config state left behind by verification

`saveSetup` was called with
`protectedTerms: ["Nautical living", "ESSENTIAL BALANCE PÂTÉ", "FISH DELIGHTS"]`.
`protectedSpans` in `getBatch` is only non-empty while this (or equivalent)
config stands — an empty `protectedTerms` correctly yields `spans: []`.

## Checks (ordered — each names the observed expected result)

1. **Draft count = draftable.** Sources → select posts → tray reads
   "Draft N posts". Select posts already inside an open draft batch plus fresh
   ones: N counts only the fresh; a `skippedDrafts` notice names the skipped.
   All-taken selection still submits so the server can refuse `duplicate_active`
   → "Create a new version".
2. **Content cards = Sources shape.** Each selected post lands on Content
   immediately as an `article.sl-post` — cover from the source post's media
   (same `loadCover`/`fillCovers` path), caption snapshot (draft when saved,
   source marked "source" otherwise), and a state chip:
   queued / drafting / awaiting rights / submitted / scheduled /
   needs attention. The whole card opens the batch drawer; revision history,
   rights detail, publications and issues stay inside it.
   **No ask card.** The copyable-message banner was removed — the owner is
   not the courier. A `queued` chip per item carries the durable
   `generation: "requested"` state; drafts appear as they are saved.
3. **Durability.** Reload the page → queued chips still show (they read
   `batches.generation`, not memory). `dismissGenerationAsk` remains as the
   durable clear for an abandoned batch.
4. **Auto-clear.** Draft every item in a requested batch (via `saveRevisions`
   or Localize save) → `getBatch(batchId).generation` becomes `null`; queued
   chips flip to drafting.
5. **Protected spans.** `getBatch` → each item's `protectedSpans` lists
   `{kind:"product", value:"Nautical living", start, end}` (with the config
   above). `null`/absent config → `[]`.
6. **Bypass fix (the security case) — refuse AND pass.** `saveRevision({batchItemId,
   expectedRevision, caption: "<zh-HK text without the product name>",
   refinementBrief: { allowedChanges: ["tone"] }})` where the org's stored
   brief does NOT allow "tone" → `{ ok:false, issues:[protected_literal_missing:
   block] }`. Same caption through `saveRevisions` → per-item refusal inside
   `results`.
   **Positive case (the gate must be shown to pass):** with the org's stored
   brief permitting "tone" (set `refinementBrief.allowedChanges: ["tone"]` via
   `saveSetup`), a zh-HK caption that keeps "Nautical living" verbatim with the
   text reordered around it → `ok:true` with an EMPTY `issues` array.
   Observed on `bi_65b0c872…`: revision 2 saved, `issues: []`; the same shape
   dropping the name refused `protected_literal_missing` in the next call.
7. **Rights vs drafting.** A `held_rights` item accepts a revision (state stays
   `held_rights`), and `submitForReview` refuses `rights_unconfirmed` — the
   gate sits at submit only. Cards chip "awaiting rights".
   **The owner can act on it:** the item's drawer shows "Confirm reuse rights"
   / "Deny reuse" while `pending` (and Confirm while `denied`). Observed live:
   confirm → drawer line flips to "Rights confirmed" and the card chip moves
   `awaiting rights` → `drafting` without a reload.
8. **Media without doors.** `getMedia(itemId, "0", {rendition:"thumb"})`
   returns bytes from the local cache with zero doors granted — observed
   `image/jpeg, 176,621 bytes` for `…3977958365829308919`. A cache MISS should
   refuse `media_missing`/`provider_unavailable` by value, not throw.
9. **Mutation lane.** Fire two `createBatch` calls for overlapping items
   concurrently → second gets `duplicate_active` (serialized, not raced).
   Same for overlapping `saveRevision`s on one item → a clean
   `expected_revision` conflict, never a lost update.
10. **Publish step.** Inspect → Continue editing → Localize → Review →
    Publish: destination picker lists granted destinations, timing controls per
    item; a destinationless session shows the Settings empty-state (not a
    refusal to draft).
11. **zh-HK parity.** `document.documentElement.lang = "zh-HK"` — every new
    string has a zh counterpart (`draftPost(s)`, `askAgent*`, `inboxAwaitingRights`,
    `skippedDrafts`, Advanced-protection labels). i18n unit test enforces key
    parity.

## What was NOT verified — do not treat as covered

- **A live agent turn.** `saveRevisions` was called via `gadget.*` in the
  canvas, not by a conversation agent. The ask-card message is the handoff;
  the agent path itself is untested.
- **Real Social Hub submit.** No publishing door is granted in this session —
  everything past `provider_unavailable` is untested.
- **Copy button** — clipboard may be denied in the sandboxed frame.
- **Suggest from watched posts** — chips appear only with repeated
  hashtags/capitalized names across `listItems`; the real account may or may
  not surface any.
- **`expectedRevision` rebase** — refuse-on-conflict is deliberate; upstream's
  dirty-draft rebase is a noted non-goal for this PR.

## Suites

`npx vitest run test/unit` → 259 pass · `npm run test:host` → 33 pass
(at the commit carrying this note).
