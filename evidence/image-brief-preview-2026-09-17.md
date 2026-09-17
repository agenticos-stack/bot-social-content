# Image brief — local runtime preview

Verified on 2026-09-17 on branch `devin/image-brief-gadget`, correction pass
B (carousel refusal, gadget-side cap removal, History/Instructions/Post/
Reference/drawer corrections), against the built archive's real server in
the fixture local runtime (`SOCIAL_CONTENT_PREVIEW_MODE=local-runtime`,
port 17925, reached through `http://social.localhost:18000/`). Synthetic
SQLite seed only; no platform login, no provider, no charge possible.

This preview preceded any PR, per the kickoff's local-first gate.

## Seed

- `fixture-0` carries one `image` (480×600 PNG, `thumb` + `preview` bytes
  in `media_cache`), so the Reference stage renders and
  `sourceImageReferences` resolves.
- `fixture-1` carries two `carousel_child` images — the shape that used to
  refuse; it now resolves both frames as references.
- `fixture-2` carries no media, which makes the missing-reference warning
  and the `reference_unavailable` refusal reachable.

## Exercised (correction pass)

- Batch of two (fixture-1 carousel, fixture-2 no-media). The armed ask
  stamped `imageBrief` per item at `4:5`, references only where media
  exists.
- Post tab on the carousel item: joined Image source segment (Generate /
  Upload / Use reference — roving arrow keys retained), "Rewrite caption"
  is a quiet inline action in the caption row, the pending-image
  placeholder wraps inside its thumbnail, and the publish radios sit on
  the first screen at desktop width.
- "Generation settings — From the post's image · 4:5 · priced as an edit"
  disclosure: source toggle, Shape segment (Match the post 4:5 / Square
  1:1 / Story 9:16), "Adjust for this run", "In effect" layer line.
- Generate on the carousel item at 9:16 with source references → replace
  confirm (centered dialog, not drawer-docked) → committed mark
  `bi_4e56cf…` (fixture-1): `imageBrief { aspectRatio: "9:16",
  references: [{id: fixture-1-img-a, …}, {id: fixture-1-img-b, …}] }`,
  `needs { image: true }`. Both `carousel_child` frames resolved — no
  refusal, no gadget-side cap. The no-media sibling moved onto the same
  request `gen_94802b3f…` keeping its own `4:5` no-reference brief and
  outstanding needs.
- Generate on the no-media item with the source toggle on →
  `reference_unavailable`: announced "The post's image could not be used
  as a reference — nothing was requested or charged. Upload an image, or
  generate without the post's image." Mark unchanged — no request
  stamped, nothing charged. The warning line "This post has no usable
  image to start from — the request will be refused without spending
  credits." is visible inside the disclosure before the click.
- Reference tab on the carousel item is inspection-only: "Reference only —
  not published", frame carousel "1 of 2" with per-frame tabs, original
  caption — and no adoption control; adoption lives only in the Post
  tab's source segment.
- Instructions tab: four-layer stack (Built-in default / Default for
  every post — In effect / This post / This run), one image editor with
  "Saved default" + "Reset to default", the caption editor inside a
  collapsed disclosure, and exactly one snapshot — "Instructions on the
  pending request" — carrying the brief line "Shape 9:16 · From the
  post's image". No accepted or last-completed snapshots here.
- History tab: one chronological feed ("Generation request — Image ·
  waiting · Shape 9:16 · From the post's image"), no Export row, no
  "No provider receipt yet" filler.
- Drawer geometry measured in the iframe viewport (888×524): 535px wide,
  12px insets, height `100dvh−24px`, 14px radius, 1px border, elevation
  shadow, backdrop `rgba(24,24,27,0.22)` + `blur(2px)`. The
  confirm/replace dialog stays centered (`sl-preview-dialog` without
  `sl-drawer`). At 390×500 the drawer uses the narrow variant: 7px
  margins, `100vw−14px` wide, `100dvh−14px` high, 12px radius. The
  doubled-class selectors outrank the SDK's `dialog.bot-drawer` rules in
  the real shell.
- `?locale=zh-HK`: the drawer fully localized — 生成設定 / 以原帖圖片為基礎
  · 4:5 以編輯計價, 圖片來源 segment 生成 / 上載 / 採用來源, publish
  radios, statuses.

## Evidence files

`/tmp/image-brief-evidence-b/` on the preview host (names match contents):

- `01-reference-tab-carousel.png` — carousel Reference tab, frame 1 of 2
  rendered, no adoption control
- `02-instructions-stack.png` — layer stack + one image editor (English)
- `03-history-feed.png` — single chronological event, no export row
- `04-drawer-narrow.png` — 390px viewport, 7px-margin floating drawer
- `05-post-tab-no-media-warning.png` — no-media item, disclosure expanded,
  warning line under the source toggle
- `06-skel-label-fixed.png` — pending placeholder wrapped cleanly in the
  thumbnail; publish radios on the first screen
- `07-post-tab-carousel-brief.png` — carousel item, brief expanded, ratio
  segment + source toggle
- `08-zhhk-post-tab.png` — zh-HK drawer, localized brief disclosure

## Known fixture limits

- `checkGenerationStatus`/`resumeGeneration` are not admitted in the
  fixture runtime (they answer `method_not_admitted`, tolerated by the
  client) — the platform-status read is a connected-mode concern.
- The fixture host never executes requests, so `requested` is the
  terminal state here; provider-side `image.edit` execution is covered by
  the API batch's own tests.
