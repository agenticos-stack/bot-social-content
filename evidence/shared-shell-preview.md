# Shared shell local preview — 2026-09-08

Preview-only implementation; production archive hash remains
c71f078f83ae8668baf55cbced010bf3364b56cbd06166f72339c0b580bdf9fb.

- Shared SDK shell source: https://github.com/agenticos-stack/agenticos-bot-sdk/pull/9
- pnpm patch mirrors that shell component/declaration diff exactly. New SDK
  layout props are not yet released on npm. Standard pnpm install applies the
  patch; BOT_SDK_SOURCE is optional, not required for independent development.
- Six focused app tests passed both with source override and patched dependency.
- SDK SSR test passed for default right layout, left ordering and collapsed slot.
- Svelte autofixer: no issues; app bind:this references are needed for checked
  iframe message source and transcript scroll after a fixture response.
- Mac Chrome 152 reviewed actual localhost preview at desktop and 390px.
- Desktop measured chat left x=0/width=360; canvas right x=360.
- Selecting a canvas source produced one context reference; fixture chat received
  it and returned its explicit non-model response.
- At 390px document scrollWidth=390. Conversation/Canvas switching preserved
  the selected checkbox in the same iframe.
- Draft review scenario rendered the sample saved revision and Inspect action.
- Width slider is a native labelled range. Unknown fixture RPCs still refuse.
- Browser restored to desktop/source library. Preview kept running for review.

No claim of live AI, DO persistence, Studio integration, scheduled publication
or full accessibility acceptance. Existing canvas source cards/drawers remain
the packaged implementation; decorative artwork is labelled synthetic in the
preview stylesheet. Fixture scenario changes deliberately reset canvas state.
