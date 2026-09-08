# Local development bridge: lease renewal and reconnect — 2026-09-08

## Context

The API's local gadget development bridge
(`workers/api/src/v2/development-gadget-registration.ts`, merged as
`400d82914`) issues a fresh `dev:<uuid>` registration with a hard 30-minute
lease. Replacement, socket break (`onRpcBroken`), unsubscribe and expiry all
revoke it server-side; a call after that fails with "Development registration
ended. Reconnect and submit a new action." Pending approvals recorded against
an old gadget id are refused by the API on purpose — it never silently rebinds
them to a replacement registration.

The host (`scripts/connected-agent.mjs`, `scripts/development-session.mjs`)
previously registered once at first use and cached that runtime for the whole
process lifetime, with no renewal and no reconnect path. After 30 minutes, or
after any socket drop, every agent operation failed until someone restarted
the preview process — while `start()` kept reporting `agentConnected: true`
from a stale snapshot.

## What changed

- **Lease renewal.** `createConnectedAgent` re-registers over the same socket
  (`stub.registerDevelopmentGadget`) a few minutes before `expiresAt`
  (`RENEW_WINDOW_MS`, 5 minutes), and never while a turn is in flight — a
  local `turnInFlight` guard mirrors the server's own
  "Stop the current turn before replacing development source." refusal, and a
  renewal due mid-turn is retried immediately after the turn ends.
- **Reconnect.** A broken socket or RPC session (`onRpcBroken`, socket
  `close`/`error`) marks the agent disconnected immediately and disposes the
  stale stub/socket. The next agent operation rebuilds the session lazily
  (fresh ticket → new socket → subscribe → register), authenticated with the
  *current* request's cookie rather than the one captured at `start()` —
  `development-session.mjs` now threads `identity.cookie`, re-derived by
  `acquire()` on every call, into `runtime.agent.handle(input, cookie)`.
  Reconnect attempts back off (1s, 2s, 4s, 8s, capped at 15s) and give up
  after 5 attempts with an explicit "restart this development host" error
  rather than retrying forever.
- **Truthful status.** `info` is a live getter, not a snapshot: `start()` and
  every agent operation response now report the actual `connected` /
  `gadgetId` / `expiresAt` state. A registration the API silently ended is
  translated into "Local registration was replaced; submit the action again."
  instead of a raw RPC error, and the call that hit it is never retried
  automatically — only the connection is torn down so the *next* operation
  reconnects and the caller decides whether to resubmit.
- **Security boundary unchanged.** The browser still never receives the API
  cookie or the socket ticket; `LocalHost.call`'s digest and method allowlist
  checks are untouched.

Five new focused tests in `test/connected-agent.test.mjs` cover: renewal
before expiry over the same socket, no renewal while a turn is running (with
a retry immediately after), reconnect after a break with truthful status in
between, giving up after the reconnect attempt cap, and translating a
replaced-registration error without an inline retry. Two new tests in
`test/development-session.test.mjs` cover fresh-cookie threading into agent
calls and live (not snapshotted) status reporting. `package.json`'s `test`
script previously ran only `build.test.mjs` and `preview.test.mjs` —
`connected-api.test.mjs`, `connected-agent.test.mjs` and
`development-session.test.mjs` existed but were never wired in, so they never
ran in CI or locally via `pnpm test`. All five are self-contained (no
`BOT_SDK_SOURCE` dependency) and are now part of the script; the two
`BOT_SDK_SOURCE`-gated files (`local-runtime.test.mjs`,
`local-preview-lifecycle.test.mjs`) remain run separately, as documented in
`README.md`.

`pnpm test` (20 passing), `pnpm build` and `pnpm validate` all pass.

## Archive hash correction

An earlier handoff cited a 65-character archive hash for this package. SHA-256
digests are 64 hex characters (256 bits); a 65-character value cannot be a
SHA-256 digest and was a transcription error, not a second valid encoding.

The archive built from this branch's source (`pnpm build`), independently
cross-checked with `sha256sum`:

- Artifact: `dist/social-content.gadget`
- Size: 97,628 bytes
- SHA-256: `e81822e7318291c8d6815c633d916836b6e2a49bc26eb8480b39316bff3f6f3a`

This size/hash differ from `evidence/baseline.md` and `evidence/public-release.md`
because this branch's source includes the lease-renewal/reconnect change above;
they are not a re-verification of the unchanged baseline artifact. No archive
was uploaded or published as part of this work.
