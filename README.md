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
Conversation/Canvas control keeps the canvas mounted. Desktop chat width uses a
keyboard-accessible range input. These preview additions are not archived into
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
