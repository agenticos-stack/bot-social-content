# Image brief — local runtime preview

Verified on 2026-09-17 on branch `devin/image-brief-gadget` (`6c85f68`),
against the built archive's real server in the fixture local runtime
(`SOCIAL_CONTENT_PREVIEW_MODE=local-runtime`, port 17925, reached through
`http://social.localhost:18000/`). Synthetic SQLite seed only; no platform
login, no provider, no charge possible.

This preview preceded any PR, per the kickoff's local-first gate.

## Seed

- `fixture-0`, `fixture-1` carry one https image each with `thumb` and
  `preview` bytes in `media_cache` (valid 480×600 PNGs, ~2.2 KB each), so
  the Reference stage renders and `sourceImageReferences` resolves.
- `fixture-2` carries no media, which makes the missing-reference warning
  and the `reference_unavailable` refusal reachable.

## Exercised

- Batch of two (fixture-0 with media, fixture-2 without). The auto-created
  ask stamped `imageBrief { aspectRatio: "4:5" }` on both, adding
  `references: [{ id: "fixture-0-img", url: "https://media.localhost/…" }]`
  only where media exists — the lenient initial path.
- Drawer on the media item: "Generation settings — From the post's image ·
  4:5 priced as an edit" disclosure; source toggle checked; ratio segment
  (4:5 / 1:1 / 9:16); "Adjust for this run" one-off; "Also save as this
  post's instruction"; "In effect" layer line with a See Instructions link.
- Arrow keys rove the Image source segment (Generate → Upload → Use
  reference, both directions).
- Toggle off flips the summary to "Without the post's image · … priced as
  a new image".
- Generate with 1:1 + source reference + a transient one-off → replace
  confirm → committed mark on `bi_…` (fixture-0):
  `imageBrief { aspectRatio: "1:1", references: [fixture-0-img] }`,
  `runInstructions { image: "Centre the bottle, add soft shadow" }`,
  `instructionSources { image: "run" }`, `needs { image: true }`.
  The sibling (fixture-2) moved onto the same request keeping its own
  `4:5`, no-reference brief and its outstanding `needs`.
- The one-off buffer cleared after the request (consumed, not reusable).
- Generate on the no-media item with the source toggle on →
  `reference_unavailable`: announced "The post's image could not be used
  as a reference — nothing was requested or charged…". No mark written,
  no request drafted, nothing charged. Warning line visible before the
  click: "This post has no usable image to start from…".
- Instructions tab: four-layer stack (內置預設 / 所有帖文的預設 marked
  In effect / 此帖文 / 這次生成) and the pending request snapshot naming
  the stamped text, its layer, `比例 1:1 · 以原帖圖片為基礎`.
- Reference tab renders the seeded source image from `media_cache` bytes
  (blob URL; no provider URL reaches the document).
- `?locale=zh-HK`: the whole block localized — 生成設定 / 以原帖圖片為基礎 /
  比例 / 跟隨原帖（4:5）/ 正方形（1:1）/ 限時動態（9:16）/ 為這次生成補充指示 /
  在「指示」查看, layer names and snapshot lines included.

## Evidence files

`/tmp/image-brief-evidence/` on the preview host:

- `01-drawer-collapsed.png` — collapsed disclosure under the source segment
- `02-brief-expanded.png` — expanded settings, media item, defaults
- `03-instructions-layers.png` — four-layer stack, English
- `04-reference-tab.png` — seeded source image on the Reference stage
- `05-brief-media-item.png` — brief block on the media item
- `06-after-request.png` — drawer after the request was sent
- `07-no-media-warning.png` — missing-reference warning line
- `08-refusal-announced.png` — `reference_unavailable` announced
- `09-without-reference.png` — "new image" pricing with the toggle off
- `10-zh-hk-brief.png` — expanded settings, zh-HK
- `11-zh-hk-layers.png` — layer stack and pending snapshot, zh-HK

## Known fixture limits

- `checkGenerationStatus`/`resumeGeneration` are not admitted in the
  fixture runtime (they answer `method_not_admitted`, tolerated by the
  client) — the platform-status read is a connected-mode concern.
- The fixture host never executes requests, so `requested` is the
  terminal state here; provider-side `image.edit` execution is covered by
  the API batch's own tests.
