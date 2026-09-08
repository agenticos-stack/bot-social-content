# Social Content

Watches authorized social accounts on a cadence, keeps the posts it finds in
its own storage, lets an owner pick which ones to work on, and hands the
approved written Traditional Chinese (zh-HK) version to the existing Social
Hub publisher through a door. Instagram Business/Creator accounts and
Facebook Pages are the first sources.

This gadget carries no product-specific code, table, or route on the host
platform. Everything it does — reading sources, storing what it finds,
drafting captions, laying out posters, tracking review state — is code and
data inside this archive. The platform lends it capabilities through the
doors below and never learns this blueprint's name.

## Files

Flat, per the runtime's contract: no bundler, no subdirectories, relative
imports between these files resolved by the runtime itself.

| File | What it is |
| --- | --- |
| `client.js` | The sandboxed UI — collection, preview drawer, localization editor, poster editor, review state. Bundled from `src/client/*` (not shipped; see the client PR). |
| `server.js` | The facet class: storage schema and migrations, the scan hook, and every method the client and the agent call. |
| `storage.js` | The SQLite adapter `server.js` uses for all persistence — the one place table names and columns are named. |
| `config.js` | Instance configuration: cadence, timezone, rights policy, notification policy, protected-literal lists. |
| `doors.js` | Every door call in one place — a contract change on a door touches this file, not every method that happens to use it. |
| `model.js` | Pure functions with no I/O: per-provider normalization, content hashing, localization validation, poster layout validation. Unit-testable outside the runtime. |
| `agent.md` | Working instructions for the agent that drafts and edits captions here. |
| `README.md` | This file. |

## Storage

All inside this gadget's own Durable Object SQLite (`ctx.storage.sql`), never
read or mirrored by the host:

- `config` — instance settings (cadence, timezone, rights policy, protected
  terms, disclaimers, hashtags requiring confirmation).
- `sources` / `destinations` — the connector bindings this instance was
  granted, by role.
- `items` — normalized source posts (`SourceItem`), one row per
  `(sourceBinding, providerItemId)`, with first-seen/last-seen timestamps and
  a content hash for change detection.
- `seen` — which items an owner has already looked at, for the New/All filter.
- `media_cache` — bounded cached preview bytes for source media.
- `scan_runs` — idempotency record for each scan, keyed on the schedule
  door's stable `runId`.
- `batches` / `batch_items` — the set an owner continued with, and each
  item's working state (rights, draft, review, publish).
- `revisions` — immutable caption/poster/claims revisions, one row per
  `saveRevision` call, compare-and-set against the batch item's current
  revision.
- `posters` — rendered poster PNG bytes for a revision.
- `origin_links` — the immutable origin reference (source provider, binding
  label, provider item id, permalink, content hash, published/retrieved
  times) carried through to the Social Hub door on submission.

A blueprint upgrade migrates this schema in place (`schema_version` plus
forward-only migrations run on facet start); it does not depend on any
host-side migration.

## Doors this gadget needs

Granted by the owner during setup, never assumed:

- **Connector, source role** (1 to 20 bindings) — read access to the
  authorized accounts this instance watches (Instagram Business/Creator,
  Facebook Pages).
- **Connector, destination role** (1 to 20 bindings) — the channels a
  localized post can be published to.
- **Social** — the Social Hub door: creates a draft with its origin
  reference, and (from the owner's own action in the UI) submits a version
  for review.
- **Schedule** — arms the recurring scan hook and reports its status.
- **Workspace** — sends the conversation a notification when a scan finds new
  posts.

Every door call goes through `doors.js`. A door that has not been granted is
reported (`{ outcome: "unknown", message: "... is not granted ..." }`), never
silently skipped where the caller needs to know.

## Export

`exportAs("json")` — items, batches and revisions, without media bytes,
bounded to the platform's export cap. `exportAs("html")` — a rendered batch
summary and approved captions. Raw storage never leaves by any other route.
