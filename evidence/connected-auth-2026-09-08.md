# Connected local authentication

## Local-source correction

The initial install-dependent launcher was removed. Connected mode now reads
source files and builds the client in memory; it does not read an archive or
use the marketplace/install resolver. It creates only the dedicated local
development conversation required by the authenticated agent session.

Verified on the Mac: authenticated start opens the real source canvas backed
by local DO SQLite. Selecting a source succeeds. The opaque iframe refuses
document.cookie access. Anonymous runtime calls are refused. Four focused host
tests and four existing fixture tests pass. Svelte analysis reports no issues
(an optional attachment suggestion remains for iframe binding).

Data is isolated under `.bot-local/connected/` by an app/org/user hash. Existing
offline state is untouched. The connected host also persists a dedicated API
conversation id beside that runtime state; the conversation is not a
marketplace installation.

The older notes below describe the superseded auth-only checkpoint.

The Social Content development host now accepts `SOCIAL_CONTENT_PREVIEW_MODE=connected` with explicit `SOCIAL_CONTENT_API_ORIGIN` (loopback HTTP only) and `SOCIAL_CONTENT_FRONTEND_ORIGIN`.

Verified on the Mac at http://social.localhost:18000 using preview port 17923 and an isolated API on 8789:

- Existing local user session recognized inside Social Content, with no Studio redirect; authenticated state survived reload.
- This was session recognition, not a fresh sign-in/OTP verification test.
- Two focused proxy tests pass: cookie forwarding, bearer credential stripping, exact-origin checks, route restrictions, oversized request rejection and remote API refusal.
- New session component passes Svelte autofixer. Workspace has no issues; optional bind:this attachment suggestions remain.
- The host creates/resumes one dedicated development conversation in the
  isolated API response; no installed gadget row is created.

Verified after the follow-up bridge: the host creates/resumes a dedicated
conversation, mints a ticketed capnweb session, registers the working source
with a digest, and routes an agent turn back into the same local SQLite runtime.
The sandbox still receives no cookie or ticket. Provider doors, skills/MCP,
scheduling, publishing, source hot reload and production authentication remain
out of scope for this local rig. Connected mode deliberately does not serve
fixture canvas routes. Offline SQLite state remains separate and unchanged.

Gateway currently routes Social Content to 17923. The prior persistent offline preview on 17922 remains available for recovery; Studio's existing API rig is untouched.
