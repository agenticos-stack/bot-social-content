# Social Content AI agent

Public source: `agenticos-stack/bot-social-content`. Licensed under Apache-2.0.
This is a standalone app repository; `private: true` prevents accidental npm
publication and does not restrict this repository's open-source license.

Author the agent here, then build a portable `.gadget` archive. Building does
not need Worker source, a running API, credentials, or publication authority.

From this repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
pnpm validate
```

The package has no workspace dependencies. Its archive codec and bounded gadget
definition validator are the released `@agenticos-dev/bot-*` packages declared
in `package.json`, so these commands run without API, Studio, modules, or a
monorepo lockfile.

## Local fixture preview

### Authenticated local-source development

This mode reads the working source directly. It does **not** require building,
uploading, publishing or installing a `.gadget` archive:

```sh
BOT_SDK_SOURCE=/path/to/agenticos-bot-sdk \
SOCIAL_CONTENT_PREVIEW_MODE=connected \
SOCIAL_CONTENT_PREVIEW_PORT=17923 \
SOCIAL_CONTENT_API_ORIGIN=http://127.0.0.1:8789 \
SOCIAL_CONTENT_FRONTEND_ORIGIN=http://social.localhost:18000 \
pnpm preview
```

Use an isolated local API with the existing development authentication enabled
and this exact frontend origin configured. Sign in, then **Start development
session**. Reopening resumes the same local runtime and a dedicated API
conversation for the agent. The conversation is not a marketplace install and
no platform gadget record or archive upload is created. Restart the preview
after source changes; automatic hot reload is not implemented for this mode.

The canvas runs in an opaque sandbox and talks through a MessageChannel to the
authenticated host. The host rechecks user and active organization on every
runtime call; cookies and host runtime credentials never enter the canvas.
Storage lives under ignored `.bot-local/connected/`, keyed by app, organization
and user. Existing offline drafts are not copied or changed. One account/org
owns a running host; restart it before switching identities.

Connected: local API authentication, a ticketed capnweb agent session, the
working source canvas/SQLite, governed draft methods and the existing approval
surface. The host keeps the API cookie and ticket out of the sandbox and
validates the source digest before every agent call. The approval round trip has
been verified locally. Skills/MCP, provider calls, scheduling and publishing
remain intentionally unavailable until their normal API-governed doors are
configured. Packaging remains a release step.

### Production platform (gadget-dev token)

Local iteration against the production (or staging) agent loop uses a scoped
gadget-dev token, never a copied session cookie. Any signed-in organization may
start one; there is no allowlist.

Sign in once with the SDK CLI, then let it mint the session and start this
host — nothing is pasted and no credential reaches this repository:

```sh
bot-dev login
bot-dev dev --gadget social_localization -- pnpm preview
```

`bot-dev` keeps the sign-in credential in `~/.config/agenticos/` and passes the
host only an eight-hour session token, through `AGENTICOS_GADGET_DEV_TOKEN`,
`AGENTICOS_GADGET_DEV_WORKSPACE_ID` and `AGENTICOS_API_ORIGIN`. Archive the
`[gadget-dev]` conversation to end the session early.

For CI, or a box where nobody can read an emailed code, a personal access token
carrying the `gadget_dev.session` scope still works, and the host mints its own
session at boot:

```sh
BOT_SDK_SOURCE=/path/to/agenticos-bot-sdk \
SOCIAL_CONTENT_PREVIEW_MODE=connected-prod \
SOCIAL_CONTENT_PREVIEW_PORT=17923 \
SOCIAL_CONTENT_API_ORIGIN=https://api.agenticos.hk \
SOCIAL_CONTENT_DEV_KEY=ag_mcp_… \
SOCIAL_CONTENT_FRONTEND_ORIGIN=http://social.localhost:18000 \
pnpm preview
```

The host prints the workspace id and the expiry, never the key or the token it
mints. Archive that room to revoke the session; revoke the key in Studio to end
every future one.

For a one-off against a session somebody else started, paste it instead —
`SOCIAL_CONTENT_DEV_TOKEN` with `SOCIAL_CONTENT_DEV_WORKSPACE_ID=chat_…`. Set
one or the other; setting both is refused, because a key silently overriding a
pasted pair would connect to a workspace you did not name.

`SOCIAL_CONTENT_API_ORIGIN` must be exactly `https://api.agenticos.hk` or
`https://staging-api.agenticos.hk`. The host mints socket tickets at
`POST /v2/gadget-dev/rpc-ticket` with the bearer token and opens `wss://`.
The browser on `social.localhost` never receives the token, cookie, or
ticket; auth/sign-in routes are not proxied. The canvas is still local
SQLite. Publishing doors are not granted on the API side. Restart the host
to switch tokens or workspaces.

After building, run `pnpm preview` and open
`http://127.0.0.1:17920/`. Add `?locale=zh-HK` for Chinese UI or `?setup=1` for
setup. Choose a free port with `SOCIAL_CONTENT_PREVIEW_PORT`; an occupied port
fails instead of replacing its owner. Stop the foreground process with Ctrl-C.

This serves the **built archive's client**, not a reimplemented mockup. Source
cards, filtering and selection use synthetic in-memory fixture data. Mutating
publication/configuration calls explicitly fail; no API or live doors exist.
The server binds loopback only, serves three fixed routes, and denies network
connections through CSP. It is a component-review aid, not the Studio sandbox,
authentication, backend persistence or real publishing acceptance test.

### Shared SDK workspace

The root preview now mounts the SDK shell with conversation left and canvas
right. A local in-memory `createFixtureChatAdapter` supplies explicitly scripted
responses; it does not call a model. Source selection is passed from the canvas
to chat through a source-window/origin-checked, bounded fixture message. Unknown
fixture RPCs remain denied. The `Source library`, `Draft review`, and `Setup`
controls load distinct synthetic scenarios and reset the canvas state. The mobile
Conversation/Canvas control keeps the canvas mounted. Desktop chat is collapsible.
These preview additions are not archived into
the production app or connected to Studio.

Use pnpm 12.2.1 (Node 24 recommended). `pnpm-lock.yaml` is canonical; npm's old
lockfile is removed. The narrow `patches/bot-shell-0.1.0.patch` applies the SDK's
pending left-chat/mobile-pane props to its published Apache-2.0 shell. It is the
same change under review in the SDK source, not a separate chat engine. Remove
the patch when adopting the SDK release containing those props.

To test a local SDK source checkout instead of the pinned patched dependency:

```sh
BOT_SDK_SOURCE=/path/to/agenticos-bot-sdk pnpm preview
```

The override must point to the SDK branch implementing `chatSide`/`mobilePane`.
Normal pnpm installation needs no sibling checkout. The four minimum-release-age
exceptions name only the exact owner-published 0.1.0 SDK dependencies; no global
age-policy disable or dependency build-script approval is used.

### Experimental login-free SQLite runtime

Use the SDK branch containing `packages/testkit/src/local-session.js`, with its
dependencies installed. No platform login, session cookie or API token is needed:

```sh
BOT_SDK_SOURCE=/path/to/agenticos-bot-sdk \
SOCIAL_CONTENT_PREVIEW_MODE=local-runtime \
SOCIAL_CONTENT_PREVIEW_PORT=17921 pnpm preview
```

This runs the built archive's server in local workerd/DO SQLite, with a
development-only seed wrapper and three synthetic source records. Reads and
selection changes, draft creation and revision saves use SQLite in the ignored
`.bot-local/social-content` directory. State survives browser reloads and server
restarts. A lock refuses concurrent processes using the same database. There are no granted providers, armed schedules, external
publishing, setup writes or live subscriptions. Unsupported calls fail explicitly.
Chat remains explicitly scripted. Runtime mode hides fixture scenario controls;
language changes reload the canvas without clearing saved selections. The
`Local SQLite` label distinguishes this mode. This remains an experimental
storage/draft-editing preview, not a complete workflow acceptance environment.

To test: select a source, continue, enter written Chinese copy and a poster
headline, then choose **Save changes**. Reload and open **Content → Inspect →
Continue editing** to recover the saved draft. Existing rights checks, duplicate
prevention and revision-conflict handling are unchanged. The seeded destination
is explicitly labelled **Local draft only (not connected)**; it grants nothing.

For a fresh local workspace, stop the preview, then run:

```sh
BOT_SDK_SOURCE=/path/to/agenticos-bot-sdk node scripts/local-state.mjs --reset
```

Reset archives the database to a unique sibling `.backup-*` directory and prints
its path. It does not delete data and refuses to run while the state is locked.
The next preview start seeds a fresh workspace. Never commit `.bot-local`, and
never point this development host at platform storage.

For isolated parallel previews, set `SOCIAL_CONTENT_PREVIEW_STATE_DIRECTORY`
to an explicit absolute directory under an existing local parent; use a distinct
port as well. Omit it for the standard ignored project-local state.

The foreground host overrides only the pinned Miniflare signal hooks it added,
so shutdown awaits workerd disposal before releasing the lock. Verify this
integration when upgrading Miniflare:

```sh
BOT_SDK_SOURCE=/path/to/agenticos-bot-sdk node --test test/local-preview-lifecycle.test.mjs
```

The local POST bridge requires an exact loopback origin and a per-process token,
admits only named methods, and accepts no caller-supplied workspace identity.
The seed wrapper is not included in the `.gadget` archive.

Run the focused real-runtime check explicitly (it skips without the source path):

```sh
BOT_SDK_SOURCE=/path/to/agenticos-bot-sdk node --test test/local-runtime.test.mjs
```

## Source and output

- `src/`: authored server, storage, configuration, doors, model and agent docs.
- `src/src/client/`: authored client modules. This nesting deliberately retains
  the existing relative imports during relocation; `src/client.js` is generated.
- `definition.ts`: the single definition used by this archive and the host's
  compatibility registry export.
- `manifest.json`: archive members and display metadata.
- `dist/social-content.gadget`: deterministic archive with the full definition.
- `dist/release.json`: artifact size/checksum, validated definition and member
  hashes. It establishes integrity, not publisher identity or review status.

The legacy bundled filename is intentionally unchanged.

## Compatibility and release boundary

The product name is **Social Content**, including zh-HK UI. The definition key
`social_localization`, bundled ID `social.localization`, installation IDs and
workspace associations are unchanged. Existing installed code is not rewritten.

This extraction starts from the clean `origin/staging` source commit recorded
in `PROVENANCE.md`. Its old
`workers/api/format-blueprints/social-localization/*` paths map to `src/*` here;
the standalone archive is rebuilt from source rather than copying an old binary.

The bundled release owner remains active. Do not upload this platform key until
the ownership-cutover and legacy-provenance gates are satisfied. Marketplace
listing, install and upgrade are separate host workflows.

For an eventual release, retain the exact clean source commit and lockfile
SHA-256 alongside `release.json`; after an authorized upload, record the owner,
returned Blueprint version ID and optional listing ID. None is invented by a
local build. Real browser acceptance and production publication are separate
gates, not implied by these package tests.
# Shared visual foundation

Dev-only **Canvas language → Apply** switches between English and zh-HK.
It preserves the chat but reloads the canvas fixture (discarding canvas edits),
and records the choice in the preview URL. Dev controls remain English.
This tests UI language, not the source/draft content language or user preferences.
Production must supply the user's resolved locale on the iframe document; the
bot reads `document.documentElement.lang`. Verify host integration before release:
the inspected Studio sandbox template still hardcodes English.

The local workspace and canvas both consume `@agenticos-dev/bot-shell/tokens.css`.
Use its semantic CSS variables instead of app-specific palettes. Each iframe
must load the stylesheet separately; parent CSS does not cross that boundary.
The host owns font loading and theme selection. This preview defaults to light;
it does not yet synchronize an interactive theme switch across frames.

The temporary pnpm patch includes the unreleased token export and split-shell
changes. A fresh `pnpm install` works without a private Studio checkout or sibling
SDK checkout. Remove the patch when these changes have an official SDK release.
Available shared UI today: design tokens and split shell. Domain cards and forms
remain application-owned; a complete shared component library is future work.
