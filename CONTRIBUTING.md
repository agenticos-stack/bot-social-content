# Working on Social Content

This repository is the single source of truth for the Social Content gadget:
`definition.ts`, `src/` (server, storage, model, config, doors, and the client
under `src/src/client/`), and the build that produces `social-content.gadget`.
The API monorepo vendors the built archive with recorded provenance; it does
not hold the source any more.

## What the gadget does

`scan sources → inbox → select → createBatch → saveRevision → savePoster →
confirmRights → submitForReview → readPublishState → exportAs`

Watch authorized social accounts, keep normalized posts, localize approved
picks into written Traditional Chinese (zh-HK), and hand the exact approved
version to the Social Hub publisher through a door.

## The three ways to run it, and what each can actually do

| mode | data | doors | use it for |
| --- | --- | --- | --- |
| `fixture` | synthetic | none | components, layout, copy |
| `local-runtime` | seeded local SQLite | none | storage, model, client logic |
| `connected-prod` | real org, real model | **granted doors** | the whole loop |

Only the third can scan a real account or submit for publication, because
those go through doors and a door is a platform object. The first two are
faster and cost nothing — use them for anything that does not need one.

```sh
# fixture / local
pnpm preview

# connected: real production agent loop, local source
bot-dev login                       # once, ever
bot-dev dev --gadget social_localization --org <sandbox-org> -- pnpm preview
```

`bot-dev` comes from `@agenticos-dev/bot-devkit`. It mints an eight-hour
session, starts this host with it, and prints which doors are reachable.
`BOT_SDK_SOURCE` must point at an `agenticos-bot-sdk` checkout.

## Before a connected run

1. **Use a sandbox org, not a customer's.** Turns debit real credits
   (`V2_TURN_BILLING` is on in production) and a scan spends real money
   through the metered `fetch` door.
2. **Grant the doors on that conversation.** `social`, `schedule`,
   `workspace` and — for open accounts — `fetch`. An ungranted door is
   ABSENT from `env`, not refused, and the gadget reads that absence as
   configuration rather than failure.
3. **Archiving the `[gadget-dev]` conversation revokes everything**: the
   session, the doors and the socket, in one act.

## What is true about governance, so you do not design around a myth

- A gadget can NEVER send, spend, operate or deploy directly. Those refuse
  with `submission_required`, installed or not. Publishing is
  `submitForReview` → the owner approves → the platform composes the effect
  from the pinned revision. That is not a development restriction.
- `read` and `generate` proceed, scoped and audited. Scanning is a read.
- Every door call is recorded, including from a development session.

## Where to start

The four review items recorded in the API's 2026-09-07 evidence note —
mixed-state batch resume, unsaved-submission protection, conflict recovery,
incomplete localized labels — are **closed**. Every one has a passing test in
`test/unit/`. Do not re-do them; read the tests first if you think otherwise.

What has genuinely never happened is a **real run**: this gadget has never
scanned a real account, never submitted, never published. Start there. Expect
the first run to surface small, specific defects — a refusal message that
reads wrong, a field missing from a submission, a door signature that does not
match what the source expects. Those are cheap to fix with a failing real case
and expensive to guess at.

## Traps that have already cost someone a day

- **Two test runners.** `test/*.test.mjs` is `node --test` (host behaviour);
  `test/unit/**` is vitest (gadget internals, ported from the API). `npm test`
  runs both. Consolidating them is real work nobody has done.
- **`src/client.js` is generated and gitignored.** The client source is
  `src/src/client/*.js`; `build.mjs` bundles it on every build. A committed
  bundle silently drifts — one used to, and a test asserted against it.
- **zh-HK means written Chinese.** `嘅 咗 唔 呢個 睇 喺` belong in speech, not
  in a product. `test/unit/model.test.ts` and the i18n tests enforce this.
- **The archive is vendored into the API.** After changing anything that ships,
  rebuild and re-sync there, or the platform keeps serving the old gadget.
- **Do not add a second post, schedule, approval or analytics lifecycle.** The
  Social Hub door owns those; the definition's `actions: []` is deliberate.

## Checks before a PR

```sh
pnpm build          # archive builds, prints size and sha256
npm test            # host suite + unit suite
```

PRs go to `staging`.
