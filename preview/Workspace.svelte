<script>
  import { onDestroy, tick } from 'svelte';
  import BrandMark from './BrandMark.svelte';
  import ConnectedSession from './ConnectedSession.svelte';
  import Shell from '@agenticos-dev/bot-shell/GadgetSplitView.svelte';
  import { createFixtureChatAdapter } from '@agenticos-dev/bot-sdk';
  import {
    parseGadgetAgentIntentMessage,
    parseGadgetTopupMessage,
    gadgetHostFeaturesMessage,
    gadgetTopupResultMessage
  } from '../src/agent-intent.js';
  const localRuntime = document.getElementById('preview-root')?.dataset.mode === 'local-runtime';
  const connected = ['connected', 'connected-prod'].includes(document.getElementById('preview-root')?.dataset.mode);
  const remote = document.getElementById('preview-root')?.dataset.mode === 'connected-prod';
  let input = $state('');
  let messages = $state([]);
  let selected = $state([]);
  let scenario = $state('sources');
  let mobilePane = $state('canvas');
  let chatOpen = $state(true);
  let frame = $state();
  let transcript = $state();
  let busy = $state(false);
  let error = $state('');
  // The regenerate hand-off the canvas posted: intent context, the answers so
  // far, and which scripted stage the conversation is on. A top-up ask waits
  // for its own one-tap answer.
  let regen = $state(null);      // { intent, stage: 'ask'|'approve', notes: [] }
  let topupAsk = $state(null);   // { requestId, post }
  const initial = new URL(location.href).searchParams;
  let locale = $state(initial.get('locale') === 'zh-HK' ? 'zh-HK' : 'en');
  let nextLocale = $state(initial.get('locale') === 'zh-HK' ? 'zh-HK' : 'en');
  function applyLocale() {
    if (!['en', 'zh-HK'].includes(nextLocale) || nextLocale === locale) return;
    locale = nextLocale;
    selected = [];
    const url = new URL(location.href);
    url.searchParams.set('locale', locale);
    history.replaceState(null, '', url);
  }
  let frameUrl = $derived(`/canvas?locale=${locale}${scenario === 'draft' ? '&draft=1' : scenario === 'setup' ? '&setup=1' : ''}`);
  const adapter = createFixtureChatAdapter({
    context: { workspaceId: 'fixture-social-workspace', conversationId: 'fixture-social-chat' },
    handlers: { send: (request) => ({ ok: true, value: request.selected?.length
      ? `I have ${request.selected.length} selected source post(s) in context. This is a scripted response, not a live model. ${localRuntime ? 'Your source selection is stored in local SQLite. Content generation and publishing are unavailable.' : 'Open the Saved draft sample to test editing and revision recovery.'}`
      : 'Choose a source card on the canvas, inspect it, then select it to share context here. This is a scripted SDK response, not a live model. Your message has not been sent to any external service.' }) }
  });
  onDestroy(() => adapter.close());
  /*
   * The host's half of the canvas ↔ conversation contract. On every canvas
   * load it announces what it can carry — the agent intent and the top-up
   * ask — so the drawer's ⋯ row and 增值 button are enabled only against a
   * host that actually answers them.
   */
  function announceFeatures() {
    frame?.contentWindow?.postMessage(gadgetHostFeaturesMessage(['agent-intent', 'topup']), location.origin);
  }
  // The scripted regenerate conversation, in the canvas's own language. The
  // copy lives in the host: the intent carries context and suggested replies,
  // never strings the conversation then parrots back.
  const regenCopy = {
    en: {
      cardTitle: (title) => `Regenerate image — ${title || 'this post'}`,
      cardMeta: (ratio, refs) => `Image · ${ratio} · ${refs === 'source' ? "from the post's own picture" : 'no reference'}`,
      ask: 'What should change about this image?',
      plan: (notes, ratio) => `Got it — I'll regenerate this image for "${notes}", keeping ${ratio}.`,
      approval: 'This runs a real image generation. Approve to file it?',
      approve: 'Approve',
      approveAll: 'Always approve',
      deny: 'Deny',
      filed: 'Filed — the image generates as a durable job and waits in the post for you to use.',
      filedFixture: 'Filed — this fixture runs nothing, but the durable request is what the agent submits for real.',
      fileFailed: 'The request was refused and nothing was filed.',
      denied: 'Denied — nothing was filed.',
      topupAsk: 'A generation is paused — this workspace is out of credits. Top up?',
      topupDone: 'Topped up — the paused run resumes on its own.',
      topupCancelled: 'Top-up cancelled — the run stays paused.',
      topup: 'Top up',
      cancel: 'Cancel',
      backToPost: '← Back to the post'
    },
    'zh-HK': {
      cardTitle: (title) => `重新生成圖片 — ${title || '此帖文'}`,
      cardMeta: (ratio, refs) => `圖片 · ${ratio} · ${refs === 'source' ? '以原帖圖片為基礎' : '不參考原圖'}`,
      ask: '這張圖片要改甚麼?',
      plan: (notes, ratio) => `明白 — 我會以「${notes}」重新生成這張圖片，保持 ${ratio}。`,
      approval: '這會真正生成圖片。批准提交嗎？',
      approve: '批准',
      approveAll: '一律批准',
      deny: '拒絕',
      filed: '已提交 — 圖片會以持久工作生成，完成後放在帖文等你採用。',
      filedFixture: '已提交 — 此示範不會真正執行，但這正是代理會提交的持久請求。',
      fileFailed: '請求被拒絕，沒有提交。',
      denied: '已拒絕 — 沒有提交任何請求。',
      topupAsk: '有生成因餘額不足而暫停。要增值嗎？',
      topupDone: '已增值 — 暫停的生成會自動繼續。',
      topupCancelled: '已取消增值 — 生成仍然暫停。',
      topup: '增值',
      cancel: '取消',
      backToPost: '← 返回帖文'
    }
  };
  const copy = $derived(regenCopy[locale] ?? regenCopy.en);
  function pushMessage(role, text) { messages = [...messages, { role, text }]; }
  function startRegen(intent) {
    chatOpen = true; mobilePane = 'chat';
    regen = { intent, stage: 'ask', notes: [] };
    messages = [...messages, { role: 'intent', intent }, { role: 'assistant', text: copy.ask }];
    tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }));
  }
  // One answer — chip or typed — becomes the run instruction's content. The
  // plan line then restates it exactly as the request would file it.
  function answerRegen(note) {
    if (!regen || regen.stage !== 'ask') return;
    const notes = [...regen.notes, note];
    regen = { ...regen, notes, stage: 'approve' };
    messages = [...messages, { role: 'user', text: note }, { role: 'assistant', text: copy.plan(notes.join(' · '), regen.intent.image.aspectRatio) }];
    tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }));
  }
  /*
   * The approval gate, scripted: approving files the durable request for real
   * in local-runtime mode (the same requestGeneration the agent would call),
   * or narrates it in fixture mode where no runtime exists to run it.
   */
  async function decideRegen(choice) {
    const flow = regen;
    if (!flow || flow.stage !== 'approve') return;
    if (choice === 'deny') { regen = null; pushMessage('assistant', copy.denied); return; }
    regen = { ...flow, stage: 'filing' };
    const result = await fileGeneration(flow);
    regen = null;
    pushMessage('assistant', result.ok === false ? `${copy.fileFailed} ${result.message ?? ''}`.trim() : localRuntime ? copy.filed : copy.filedFixture);
    await tick(); transcript?.scrollTo({ top: transcript.scrollHeight });
  }
  async function fileGeneration(flow) {
    if (!localRuntime) return { ok: true };
    try {
      const res = await fetch('/dev-local-rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'requestGeneration', args: [flow.intent.post.batchId, [flow.intent.post.batchItemId], {
          needs: { image: true, caption: false },
          image: { references: flow.intent.image.references, aspectRatio: flow.intent.image.aspectRatio },
          instructions: { image: flow.notes.join('; ') }
        }] })
      });
      // The bridge envelope is {ok, value}; an error rides as {error} with a
      // non-200 — either is a refusal the conversation must not call filed.
      const envelope = await res.json().catch(() => null);
      if (!res.ok || !envelope || envelope.error) {
        return { ok: false, message: envelope?.error ?? `filing failed (${res.status})` };
      }
      const value = envelope.value ?? envelope;
      return value && typeof value === 'object' ? value : { ok: res.ok };
    } catch (error) { return { ok: false, message: String(error?.message ?? error) }; }
  }
  // The scripted top-up card: the funding surface stays the host's, the
  // canvas only hears the correlated answer.
  function answerTopup(choice) {
    const ask = topupAsk;
    if (!ask) return;
    topupAsk = null;
    const outcome = choice === 'topup' ? 'topped_up' : 'cancelled';
    frame?.contentWindow?.postMessage(gadgetTopupResultMessage({ requestId: ask.requestId, outcome }), location.origin);
    pushMessage('assistant', choice === 'topup' ? copy.topupDone : copy.topupCancelled);
    tick().then(() => transcript?.scrollTo({ top: transcript.scrollHeight }));
  }
  function receive(event) {
    if (event.source !== frame?.contentWindow || event.origin !== location.origin) return;
    const intent = parseGadgetAgentIntentMessage(event.data);
    if (intent) { startRegen(intent); return; }
    const topup = parseGadgetTopupMessage(event.data);
    if (topup) { topupAsk = topup; pushMessage('assistant', copy.topupAsk); return; }
    if (event.data?.type !== 'social-preview-selection') return;
    const records = event.data.records;
    if (!Array.isArray(records) || records.length > 20 || records.some(r => !r || typeof r.id !== 'string' || !/^fixture-[0-2]$/.test(r.id) || typeof r.label !== 'string' || r.label.length > 200)) return;
    selected = records.map(r => ({ type: 'source-post', id: r.id, label: r.label }));
  }
  function changeScenario(value) { scenario = value; selected = []; }
  async function send(event) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const text = input.trim(); input = ''; error = '';
    // Mid-conversation, free text is the correction the chips abbreviate.
    if (regen?.stage === 'ask') { answerRegen(text); return; }
    busy = true;
    messages = [...messages, { role: 'user', text }];
    try {
      const result = await adapter.send({ text, selected: selected.map(({type,id}) => ({type,id})) });
      if (result.ok) messages = [...messages, { role: 'assistant', text: result.value }];
      else error = result.message;
    } catch { error = 'The fixture response could not be completed. Try again.'; }
    finally { busy = false; await tick(); transcript?.scrollTo({ top: transcript.scrollHeight }); }
  }
</script>

<svelte:window onmessage={receive} />
<header class="topbar">
  <div class="identity"><BrandMark /><span class="brand-name">Agentic<span class="brand-os">OS</span></span><span class="slash">/</span><strong>Social Content</strong><span class="edition" title={localRuntime ? 'Local SQLite with sample data. Drafts survive server restarts. No live AI or publishing.' : 'Synthetic data and scripted chat. No live AI or publishing.'}>DEV PREVIEW</span></div>
  <div class="dev-controls">
    {#if connected}<span class="runtime-mode">{remote ? 'Production platform' : 'Local API'}</span>{:else}
    {#if localRuntime}<span class="runtime-mode" title="Reads and selection use SQLite. Setup, providers, scheduling and publishing are unavailable.">Local SQLite</span>{:else}
    <label for="fixture-scenario">Scenario</label>
    <select id="fixture-scenario" value={scenario} onchange={event => changeScenario(event.currentTarget.value)} title="Switching scenarios resets canvas edits.">
      <option value="sources">Source library</option><option value="draft">Saved draft</option><option value="setup">First-time setup</option>
    </select>
    {/if}
    <button class="chat-toggle" aria-expanded={chatOpen} onclick={() => { chatOpen = !chatOpen; mobilePane = chatOpen ? "chat" : "canvas"; }}>{chatOpen ? "Hide conversation" : "Show conversation"}</button>
    <label for="canvas-language">Canvas language</label>
    <select id="canvas-language" bind:value={nextLocale} title={localRuntime ? 'Reloads the canvas in this language. Saved selection and chat are preserved.' : 'Changing language resets canvas edits. Chat is preserved.'}>
      <option value="en">English</option>
      <option value="zh-HK">繁體中文（香港）</option>
    </select>
    <button class="apply-language" disabled={nextLocale === locale} onclick={applyLocale}>Apply</button>
    {/if}
  </div>
</header>
{#if connected}
  <ConnectedSession />
{:else}
<nav class="mobile-switch" aria-label="Workspace panel">
  <button aria-pressed={mobilePane === 'chat'} onclick={() => { chatOpen = true; mobilePane = 'chat'; }}>Conversation</button>
  <button aria-pressed={mobilePane === 'canvas'} onclick={() => mobilePane = 'canvas'}>Canvas</button>
</nav>

<main style="--bot-chat-width:392px">
  {#snippet chat()}
    <div class="conversation-heading"><strong>Social Content</strong><span>Conversation</span></div>
    <div class="transcript" bind:this={transcript} role="log" aria-label="Fixture conversation" aria-live="polite">
      <div class="assistant-intro"><span class="avatar" aria-hidden="true"><BrandMark /></span><div><strong>Social Content <small>Fixture assistant</small></strong><p>Start with the canvas. Inspect a source, select what matters, and bring it into the conversation.</p><p class="muted">You stay in control of the draft—and when it goes out.</p></div></div>
      {#if messages.length === 0}<div class="suggestions"><span class="eyebrow">TRY A STARTING POINT</span>{#each ['Help me shape a Hong Kong caption', 'Review the selected source', 'Explain the review and schedule flow'] as prompt (prompt)}<button onclick={() => input = prompt}>{prompt}<span aria-hidden="true">↗</span></button>{/each}</div>{/if}
      {#if regen}<button class="chat-back" onclick={() => { mobilePane = 'canvas'; }}>{copy.backToPost}</button>{/if}
      {#each messages as message, index (index)}
        {#if message.role === 'intent'}
          <div class="intent-card" role="note">
            {#if message.intent.image.thumbnail}<img class="intent-thumb" src={message.intent.image.thumbnail} alt="" />{/if}
            <div class="intent-meta"><strong>{copy.cardTitle(message.intent.post.title)}</strong><span>{copy.cardMeta(message.intent.image.aspectRatio, message.intent.image.references)}</span></div>
          </div>
        {:else}
          <article class:user-message={message.role === 'user'} class="message"><small>{message.role === 'user' ? 'You' : 'Fixture assistant'}</small><p>{message.text}</p></article>
        {/if}
      {/each}
      {#if regen?.stage === 'ask' && regen.intent.suggestedReplies.length}
        <div class="regen-chips" role="group">{#each regen.intent.suggestedReplies as suggestion (suggestion)}<button type="button" class="regen-chip" onclick={() => answerRegen(suggestion)}>{suggestion}</button>{/each}</div>
      {/if}
      {#if regen?.stage === 'approve'}
        <div class="approval-card" role="note">
          <p>{copy.approval}</p>
          <div class="approval-actions">
            <button type="button" class="approval-primary" onclick={() => decideRegen('approve')}>{copy.approve}</button>
            <button type="button" onclick={() => decideRegen('approve_all')}>{copy.approveAll}</button>
            <button type="button" onclick={() => decideRegen('deny')}>{copy.deny}</button>
          </div>
        </div>
      {/if}
      {#if topupAsk}
        <div class="approval-card" role="note">
          <div class="approval-actions">
            <button type="button" class="approval-primary" onclick={() => answerTopup('topup')}>{copy.topup}</button>
            <button type="button" onclick={() => answerTopup('cancel')}>{copy.cancel}</button>
          </div>
        </div>
      {/if}
    </div>
    <div class="composer-wrap">
      {#if selected.length}<div class="context"><span class="context-dot" aria-hidden="true"></span><span>{selected.length} source{selected.length === 1 ? '' : 's'} in context</span><span class="context-name">{selected[0].label}</span></div>{/if}
      <form onsubmit={send}><label class="sr-only" for="message">Message the fixture assistant</label><textarea id="message" bind:value={input} rows="3" maxlength="4000" placeholder="What would you like to create?" onkeydown={e => { if(e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e); }}></textarea><div class="composer-footer"><span>Fixture mode <span aria-hidden="true">·</span> no live AI</span><button class="send" disabled={!input.trim() || busy} aria-label="Send fixture message">↑</button></div></form>
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
  {/snippet}
  {#snippet canvas()}
    <!-- Platform branding belongs to this development harness, never the packaged canvas. -->
    <iframe bind:this={frame} src={frameUrl} onload={announceFeatures} title={localRuntime ? 'Social Content canvas — local SQLite sample' : 'Social Content canvas — synthetic fixture'}></iframe>
  {/snippet}
  <Shell {chat} {canvas} {chatOpen} chatSide="left" {mobilePane} canvasScroll="clip" chatLabel="Creative conversation" canvasLabel="Social Content canvas" />
</main>
{/if}

<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;background:var(--color-paper);color:var(--color-ink);font-family:var(--font-sans);font-size:14px} :global(button),:global(textarea),:global(input){font:inherit} :global(button){cursor:pointer} :global(button:disabled){cursor:not-allowed} :global(:focus-visible){outline:2px solid var(--color-act-hover);outline-offset:3px} :global(.chat){background:var(--color-panel)!important} :global(.canvas){background:var(--color-panel)} :global(.canvas.canvas-clip > *){flex:none!important} :global(.canvas.canvas-clip > iframe){flex:1!important}
  .topbar{height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid var(--color-panel-subtle);background:var(--color-panel)}.identity{display:flex;align-items:center;gap:16px}.brand-name{font-weight:700;letter-spacing:-.3px}.slash{color:var(--color-ink-faint)}.identity strong{font-weight:500}.edition{font-size:9px;letter-spacing:1.6px;color:var(--color-ink-faint);border:1px solid var(--color-panel-subtle);border-radius:4px;padding:5px 7px}main{height:calc(100dvh - 98px);min-height:420px}.eyebrow{font-size:9px;letter-spacing:1.8px;font-weight:650;color:var(--color-ink-faint)}.transcript{flex:1;overflow:auto;padding:25px 24px;min-height:0}.assistant-intro{display:flex;gap:12px}.avatar{background:var(--color-panel-subtle);border:1px solid var(--color-line-strong);min-width:29px;height:29px;border-radius:9px;display:grid;place-items:center;font:700 19px var(--font-brand)}.assistant-intro strong{font-size:11px}.assistant-intro small{display:block;font-weight:400;color:var(--color-ink-faint);font-size:9px;margin-top:4px}.assistant-intro p,.message p{font-size:12px;line-height:1.8;margin:12px 0;white-space:pre-wrap}.muted{color:var(--color-ink-faint)}.suggestions{margin:28px 0 0 41px}.suggestions .eyebrow{font-size:8px}.suggestions button{display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--color-panel-subtle);padding:13px 0;font-size:11px;line-height:1.5;color:var(--color-ink-soft)}.suggestions button:hover{color:var(--color-act-hover)}.suggestions button span{color:var(--color-act-hover)}.message{padding:8px 0}.message small{font-size:10px;color:var(--color-ink-faint)}.user-message{border-radius:12px;background:var(--color-panel-subtle);margin:14px 0;padding:12px 14px}.user-message p{margin:5px 0}.composer-wrap{padding:12px 20px 16px}.composer-wrap form{border:1px solid var(--color-line-strong);border-radius:14px;background:var(--color-panel);padding:12px;box-shadow:0 4px 18px transparent}textarea{resize:none;border:0;width:100%;background:transparent;font-size:12px;line-height:1.6;color:var(--color-ink);padding:3px;min-height:58px}textarea:focus{outline:0}.composer-wrap form:focus-within{outline:2px solid var(--color-act-hover);outline-offset:2px}.composer-footer{display:flex;align-items:center;justify-content:space-between;color:var(--color-ink-faint);font-size:9px}.send{width:30px;height:30px;border-radius:9px;background:var(--color-ink);color:var(--color-panel);border:0;font-size:20px}.send:disabled{background:var(--color-panel-subtle);color:var(--color-ink-faint)}.context{display:flex;gap:6px;align-items:center;font-size:10px;margin:0 0 9px;color:var(--color-ink-soft)}.context-dot{width:6px;height:6px;background:var(--color-ink-faint);border-radius:50%}.context-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:110px;color:var(--color-ink-faint)}iframe{width:100%;border:0;min-height:0;display:block;background:var(--color-panel)}.mobile-switch{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  @media(max-width:1050px){.transcript{padding:20px}}
  @media(max-width:760px){.topbar{height:58px;padding:0 16px}.identity{gap:10px}.brand-name,.edition,.slash{display:none}.identity strong{font-size:13px}.mobile-switch{display:flex;padding:6px 16px;gap:8px;background:var(--color-panel);border-bottom:1px solid var(--color-panel-subtle)}.mobile-switch button{flex:1;border:0;border-radius:7px;padding:9px;color:var(--color-ink-faint);background:var(--color-paper)}.mobile-switch button[aria-pressed=true]{background:var(--color-ink);color:var(--color-panel)}main{height:calc(100dvh - 145px)}.suggestions{margin-top:18px}}

  /* Compact development chrome; installed bots render only the canvas document. */
  .topbar{height:48px;padding:0 20px}

  
  main{height:calc(100dvh - 76px)}
  
  
  
  .assistant-intro p,.message p,textarea{font-size:14px;line-height:1.7}
  .assistant-intro strong,.suggestions button{font-size:13px}
  .assistant-intro small,.composer-footer,.eyebrow{font-size:11px}
  .muted{color:var(--color-ink-soft)}
  
  
  
  
  @media(max-width:760px){
    
    main{height:calc(100dvh - 135px)}
    textarea{font-size:16px}
    
  }
.brand-name{font-family:var(--font-brand);font-weight:620;letter-spacing:-.02em}.brand-os{color:var(--color-act-hover)}
  .dev-controls{display:flex;align-items:center;gap:8px;font-size:12px}
  .dev-controls select,.apply-language{font:inherit;min-height:36px;border:1px solid var(--color-line-strong);border-radius:9px;background:var(--color-panel);color:var(--color-ink);padding:6px 10px}
  .apply-language:disabled{opacity:.5}
  
  @media(max-width:760px){
    .topbar{height:auto;min-height:92px;flex-wrap:wrap;gap:6px;padding:8px 16px}
    .dev-controls{width:100%;justify-content:space-between}
    .dev-controls select{font-size:16px;min-width:0;max-width:190px}
    .dev-controls select,.apply-language{min-height:44px}
    main{height:calc(100dvh - 195px)}
    
  }
:global(#preview-root){height:100dvh;display:flex;flex-direction:column;overflow:hidden} main{flex:1;min-height:0;height:auto} .topbar,.mobile-switch{flex-shrink:0}

.conversation-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--color-line);font-size:13px}.conversation-heading span{font-size:12px;color:var(--color-ink-soft)}

/* The regenerate hand-off, host side: the intent card shows the image being
   discussed (never asked which), chips are the one-tap answers, the approval
   card is the scripted governance gate, and the back link is the narrow
   pane's way out. */
.intent-card{display:flex;gap:12px;align-items:center;margin:16px 0 4px;padding:11px 12px;border:1px solid var(--color-line-strong);border-radius:12px;background:var(--color-panel)}
.intent-thumb{width:44px;height:44px;object-fit:cover;border-radius:9px;flex:none}
.intent-meta{display:flex;flex-direction:column;gap:3px;min-width:0}
.intent-meta strong{font-size:12.5px;font-weight:600}
.intent-meta span{font-size:11px;color:var(--color-ink-soft)}
.regen-chips{display:flex;flex-wrap:wrap;gap:7px;margin:6px 0 4px 41px}
.regen-chip{min-height:30px;padding:0 11px;border:1px solid var(--color-line-strong);border-radius:999px;background:transparent;font-size:11.5px;color:var(--color-ink-soft)}
.regen-chip:hover{color:var(--color-act-hover);border-color:var(--color-act-hover)}
.approval-card{margin:10px 0 4px 41px;padding:12px;border:1px solid var(--color-line-strong);border-radius:12px;background:var(--color-panel)}
.approval-card p{margin:0 0 10px;font-size:12px;line-height:1.5}
.approval-actions{display:flex;gap:8px;flex-wrap:wrap}
.approval-actions button{min-height:32px;padding:0 12px;border:1px solid var(--color-line-strong);border-radius:9px;background:var(--color-panel);font-size:11.5px;color:var(--color-ink)}
.approval-actions .approval-primary{background:var(--color-ink);border-color:var(--color-ink);color:var(--color-panel)}
.chat-back{display:none;margin:12px 0 0;background:transparent;border:0;font-size:12px;color:var(--color-act-hover);text-align:left;padding:0}
@media(max-width:760px){.chat-back{display:block}}

.chat-toggle{font:inherit;min-height:36px;border:1px solid var(--color-line-strong);border-radius:9px;padding:6px 10px;background:var(--color-panel);color:var(--color-ink)} .dev-controls{flex-wrap:wrap}.topbar{height:auto;min-height:48px;gap:12px;padding-top:8px;padding-bottom:8px;flex-wrap:wrap}@media(max-width:760px){.dev-controls{justify-content:flex-start}.dev-controls label{font-size:11px}.chat-toggle{min-height:44px}}
</style>
