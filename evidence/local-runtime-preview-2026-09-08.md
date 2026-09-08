# Login-free local runtime preview

Verified on 2026-09-08 using SDK source branch `codex/chat-left-shell`
(`6d1714f`, unpublished testkit local-session export).

## Scope

The built archive's server runs in workerd with Durable Object SQLite. A
development-only subclass seeds three synthetic sources without granting
providers or arming a schedule. The archive server itself is unchanged.
Browser RPC uses a per-process token, an exact loopback origin, a fixed local
identity and an explicit method allowlist. No platform login is involved.

## Evidence

- `BOT_SDK_SOURCE=... node --test test/local-runtime.test.mjs`: 1 passed;
  real-app storage, selection, bridge filtering/context, subscription refusal
  and unadmitted setup/provider/publishing calls covered.
- `pnpm exec tsx --test --test-concurrency=1 test/preview.test.mjs`: 4 passed.
- Svelte autofixer: no issues; optional bind:this attachment suggestions only.
- Mac Chrome 152, existing Social Content tab through the SSH gateway:
  `http://social.localhost:18000/?locale=zh-HK`.
- Local SQLite label visible; fixture scenario dropdown absent.
- Selected a source using its checkbox; full reload retained its selection and
  chat context. Changed canvas language to English; both remained intact.
- Filter returning zero rows did not clear the selected source from chat.
- Request without local token returned HTTP 403. Publishing call refused.
- Collapsing and reopening chat retained the same iframe DOM instance.
- Source drawer height matched the canvas: 904px. At 390×844, document width
  and scroll width were both 390px; drawer footer remained visible. Emulation
  cleared after inspection.

## Not claimed

This is not live agent execution, provider access, scheduling, publishing or
end-to-end draft editing. These calls remain unadmitted. Subscription reports
unsupported; there is no realtime push stream. Chat is scripted. SQLite lasts
for the running preview process, not across server stops. Public SDK packaging
of this testkit and a generic live host adapter remain separate work.

## Review rig

Gateway Social upstream is loopback port 17921, with the SDK source override
and `SOCIAL_CONTENT_PREVIEW_MODE=local-runtime`. Other gateway mappings are
unchanged. The runtime process is retained for user review. Fixture mode is
still the default `pnpm preview` command and can be started on a free port.
