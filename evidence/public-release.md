# Public snapshot verification — 2026-09-08

Owner approved public visibility and Apache-2.0. Only the standalone app source
snapshot is published, without private monorepo or local extraction history.

After replacing one customer-specific comment with a generic binding example:

- Clean lockfile installation with lifecycle scripts disabled passed.
- Six focused build/fixture tests passed, including repeat-build byte equality.
- Build and archive validation passed.
- Artifact size: 94,841 bytes.
- SHA256: c71f078f83ae8668baf55cbced010bf3364b56cbd06166f72339c0b580bdf9fb.

The extraction baseline in baseline.md remains historical evidence; the public
artifact differs only in the packaged comment. No runtime logic was changed.
Bounded credential-signature scanning is not a comprehensive security audit.
No production installation, marketplace listing, ownership cutover, or provider
publication was performed. Fixture testing does not prove those integrations.
