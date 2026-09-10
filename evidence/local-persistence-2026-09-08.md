# Persistent local preview — 2026-09-08

Supersedes the temporary-storage limitation in the earlier local-runtime evidence.

## Implementation

- SDK testkit/local-session accepts explicit host-owned `stateDirectory`.
  Temporary test databases remain the default when omitted.
- Persistent directories require an ownership marker and exclusive sibling lock.
  Unowned directories, symlinks, second writers and resets while running are refused.
- Preview uses ignored `.bot-local/social-content`; an explicit absolute state
  override supports isolated tests/parallel previews.
- Social seed is transactional and skips an already configured database.
- Reset renames state to a unique backup, never recursively deletes user state.
- Tokens rotate on restart; old browser tokens are refused.
- Pinned Miniflare signal hooks exit immediately by default. The preview removes
  only the known hooks newly installed by its runtime and owns awaited shutdown.
  Other pre-existing listeners are preserved. Upgrade this integration with its
  lifecycle test, not by assuming hook internals are stable.

## Verified

- SDK local-state/local-session: 2 tests passed, including fresh runtime with
  changed source, persisted SQL data, locked-writer refusal, reset and reopening
  the backup to prove its old data remains recoverable.
- Social local-runtime: 1 extended test passed. Draft caption, revision, rights
  and item count survive disposal/recreation without reseeding duplicates.
- Social local-preview-lifecycle: 1 test passed. Two actual HTTP preview processes
  use one isolated state directory; SIGTERM exits 0, releases the lock, and the
  next process reads the same draft/revision.
- Svelte autofixer: no issues; optional existing bind:this suggestions only.
- Running preview: saved a Chinese draft, stopped/restarted, then read revision 1
  and exact caption. Mac Chrome shows that saved draft through the gateway and
  the corrected “Drafts survive server restarts” tooltip.

## Review state

`social.localhost:18000` now routes to persistent preview on loopback 17922.
The prior temporary preview on 17921 remains running for recovery; its old sample
drafts were not migrated or deleted. The new persistent preview has a separate
restart-verification draft. No platform data or credentials were touched.

Agent chat is still scripted; providers, schedules and publication stay disabled.
