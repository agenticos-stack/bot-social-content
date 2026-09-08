<script>
  import { onDestroy, tick } from 'svelte';
  import BrandMark from './BrandMark.svelte';
  import Shell from '@agenticos-dev/bot-shell/GadgetSplitView.svelte';
  import { createFixtureChatAdapter } from '@agenticos-dev/bot-sdk';
  let input = $state('');
  let messages = $state([]);
  let selected = $state([]);
  let scenario = $state('sources');
  let mobilePane = $state('canvas');
  let chatOpen = $state(true);
  let frame;
  let transcript;
  let busy = $state(false);
  let error = $state('');
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
      ? `I have ${request.selected.length} selected source post(s) in context. In a live session, the agent would use those references to refine your draft. This fixture does not generate content or publish. Open the Draft review sample to test editing and revision recovery.`
      : 'Choose a source card on the canvas, inspect it, then select it to share context here. This is a scripted SDK response, not a live model. Your message has not been sent to any external service.' }) }
  });
  onDestroy(() => adapter.close());
  function receive(event) {
    if (event.source !== frame?.contentWindow || event.origin !== location.origin || event.data?.type !== 'social-preview-selection') return;
    const records = event.data.records;
    if (!Array.isArray(records) || records.length > 20 || records.some(r => !r || typeof r.id !== 'string' || !/^fixture-[0-2]$/.test(r.id) || typeof r.label !== 'string' || r.label.length > 200)) return;
    selected = records.map(r => ({ type: 'source-post', id: r.id, label: r.label }));
  }
  function changeScenario(value) { scenario = value; selected = []; }
  async function send(event) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const text = input.trim(); input = ''; busy = true; error = '';
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
  <div class="identity"><BrandMark /><span class="brand-name">Agentic<span class="brand-os">OS</span></span><span class="slash">/</span><strong>Social Content</strong><span class="edition" title="Synthetic data and scripted chat. No live AI or publishing.">DEV PREVIEW</span></div>
  <div class="dev-controls">
    <label for="canvas-language">Canvas language</label>
    <select id="canvas-language" bind:value={nextLocale} title="Changing language resets canvas edits. Chat is preserved.">
      <option value="en">English</option>
      <option value="zh-HK">繁體中文（香港）</option>
    </select>
    <button class="apply-language" disabled={nextLocale === locale} onclick={applyLocale}>Apply</button>
  </div>
</header>
<nav class="mobile-switch" aria-label="Workspace panel">
  <button aria-pressed={mobilePane === 'chat'} onclick={() => { chatOpen = true; mobilePane = 'chat'; }}>Conversation</button>
  <button aria-pressed={mobilePane === 'canvas'} onclick={() => mobilePane = 'canvas'}>Canvas</button>
</nav>
    <div class="canvas-tools"><nav aria-label="Fixture scenario">{#each [['sources','Source library'],['draft','Draft review'],['setup','Setup']] as [value,label] (value)}<button aria-pressed={scenario === value} onclick={() => changeScenario(value)}>{label}</button>{/each}</nav><button class="chat-toggle" aria-expanded={chatOpen} onclick={() => { chatOpen = !chatOpen; mobilePane = chatOpen ? "chat" : "canvas"; }}>{chatOpen ? "Hide conversation" : "Show conversation"}</button></div>

<main style="--bot-chat-width:392px">
  {#snippet chat()}
    <div class="conversation-heading"><strong>Social Content</strong><span>Conversation</span></div>
    <div class="transcript" bind:this={transcript} role="log" aria-label="Fixture conversation" aria-live="polite">
      <div class="assistant-intro"><span class="avatar" aria-hidden="true"><BrandMark /></span><div><strong>Social Content <small>Fixture assistant</small></strong><p>Start with the canvas. Inspect a source, select what matters, and bring it into the conversation.</p><p class="muted">You stay in control of the draft—and when it goes out.</p></div></div>
      {#if messages.length === 0}<div class="suggestions"><span class="eyebrow">TRY A STARTING POINT</span>{#each ['Help me shape a Hong Kong caption', 'Review the selected source', 'Explain the review and schedule flow'] as prompt (prompt)}<button onclick={() => input = prompt}>{prompt}<span aria-hidden="true">↗</span></button>{/each}</div>{/if}
      {#each messages as message, index (index)}<article class:user-message={message.role === 'user'} class="message"><small>{message.role === 'user' ? 'You' : 'Fixture assistant'}</small><p>{message.text}</p></article>{/each}
    </div>
    <div class="composer-wrap">
      {#if selected.length}<div class="context"><span class="context-dot" aria-hidden="true"></span><span>{selected.length} source{selected.length === 1 ? '' : 's'} in context</span><span class="context-name">{selected[0].label}</span></div>{/if}
      <form onsubmit={send}><label class="sr-only" for="message">Message the fixture assistant</label><textarea id="message" bind:value={input} rows="3" maxlength="4000" placeholder="What would you like to create?" onkeydown={e => { if(e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e); }}></textarea><div class="composer-footer"><span>Fixture mode <span aria-hidden="true">·</span> no live AI</span><button class="send" disabled={!input.trim() || busy} aria-label="Send fixture message">↑</button></div></form>
      {#if error}<p role="alert">{error}</p>{/if}
    </div>
  {/snippet}
  {#snippet canvas()}
    <!-- Platform branding belongs to this development harness, never the packaged canvas. -->
    <iframe bind:this={frame} src={frameUrl} title="Social Content canvas — synthetic fixture" onload={() => selected = []}></iframe>
  {/snippet}
  <Shell {chat} {canvas} {chatOpen} chatSide="left" {mobilePane} canvasScroll="clip" chatLabel="Creative conversation" canvasLabel="Social Content canvas" />
</main>

<style>
  :global(*){box-sizing:border-box} :global(body){margin:0;background:var(--color-paper);color:var(--color-ink);font-family:var(--font-sans);font-size:14px} :global(button),:global(textarea),:global(input){font:inherit} :global(button){cursor:pointer} :global(button:disabled){cursor:not-allowed} :global(:focus-visible){outline:2px solid var(--color-act-hover);outline-offset:3px} :global(.chat){background:var(--color-panel)!important} :global(.canvas){background:var(--color-panel)} :global(.canvas.canvas-clip > *){flex:none!important} :global(.canvas.canvas-clip > iframe){flex:1!important}
  .topbar{height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid var(--color-panel-subtle);background:var(--color-panel)}.identity{display:flex;align-items:center;gap:16px}.brand-name{font-weight:700;letter-spacing:-.3px}.slash{color:var(--color-ink-faint)}.identity strong{font-weight:500}.edition{font-size:9px;letter-spacing:1.6px;color:var(--color-ink-faint);border:1px solid var(--color-panel-subtle);border-radius:4px;padding:5px 7px}main{height:calc(100dvh - 98px);min-height:420px}.eyebrow{font-size:9px;letter-spacing:1.8px;font-weight:650;color:var(--color-ink-faint)}.transcript{flex:1;overflow:auto;padding:25px 24px;min-height:0}.assistant-intro{display:flex;gap:12px}.avatar{background:var(--color-panel-subtle);border:1px solid var(--color-line-strong);min-width:29px;height:29px;border-radius:9px;display:grid;place-items:center;font:700 19px var(--font-brand)}.assistant-intro strong{font-size:11px}.assistant-intro small{display:block;font-weight:400;color:var(--color-ink-faint);font-size:9px;margin-top:4px}.assistant-intro p,.message p{font-size:12px;line-height:1.8;margin:12px 0;white-space:pre-wrap}.muted{color:var(--color-ink-faint)}.suggestions{margin:28px 0 0 41px}.suggestions .eyebrow{font-size:8px}.suggestions button{display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--color-panel-subtle);padding:13px 0;font-size:11px;line-height:1.5;color:var(--color-ink-soft)}.suggestions button:hover{color:var(--color-act-hover)}.suggestions button span{color:var(--color-act-hover)}.message{padding:8px 0}.message small{font-size:10px;color:var(--color-ink-faint)}.user-message{border-radius:12px;background:var(--color-panel-subtle);margin:14px 0;padding:12px 14px}.user-message p{margin:5px 0}.composer-wrap{padding:12px 20px 16px}.composer-wrap form{border:1px solid var(--color-line-strong);border-radius:14px;background:var(--color-panel);padding:12px;box-shadow:0 4px 18px transparent}textarea{resize:none;border:0;width:100%;background:transparent;font-size:12px;line-height:1.6;color:var(--color-ink);padding:3px;min-height:58px}textarea:focus{outline:0}.composer-wrap form:focus-within{outline:2px solid var(--color-act-hover);outline-offset:2px}.composer-footer{display:flex;align-items:center;justify-content:space-between;color:var(--color-ink-faint);font-size:9px}.send{width:30px;height:30px;border-radius:9px;background:var(--color-ink);color:var(--color-panel);border:0;font-size:20px}.send:disabled{background:var(--color-panel-subtle);color:var(--color-ink-faint)}.context{display:flex;gap:6px;align-items:center;font-size:10px;margin:0 0 9px;color:var(--color-ink-soft)}.context-dot{width:6px;height:6px;background:var(--color-ink-faint);border-radius:50%}.context-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:110px;color:var(--color-ink-faint)}.canvas-tools{display:flex;justify-content:space-between;align-items:center;padding:0 32px;border-bottom:1px solid var(--color-panel-subtle);gap:12px}.canvas-tools nav{display:flex;gap:22px}.canvas-tools button{background:none;border:0;border-bottom:2px solid transparent;color:var(--color-ink-faint);font-size:11px;padding:12px 0}.canvas-tools button[aria-pressed=true]{color:var(--color-ink);border-color:var(--color-act-hover);font-weight:600}iframe{width:100%;border:0;min-height:0;display:block;background:var(--color-panel)}.mobile-switch{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  @media(max-width:1050px){.canvas-tools{padding:0 20px}.transcript{padding:20px}}
  @media(max-width:760px){.topbar{height:58px;padding:0 16px}.identity{gap:10px}.brand-name,.edition,.slash{display:none}.identity strong{font-size:13px}.mobile-switch{display:flex;padding:6px 16px;gap:8px;background:var(--color-panel);border-bottom:1px solid var(--color-panel-subtle)}.mobile-switch button{flex:1;border:0;border-radius:7px;padding:9px;color:var(--color-ink-faint);background:var(--color-paper)}.mobile-switch button[aria-pressed=true]{background:var(--color-ink);color:var(--color-panel)}main{height:calc(100dvh - 145px)}.canvas-tools nav{gap:18px}.suggestions{margin-top:18px}}

  /* Compact development chrome; installed bots render only the canvas document. */
  .topbar{height:48px;padding:0 20px}

  
  main{height:calc(100dvh - 76px)}
  
  
  
  .assistant-intro p,.message p,textarea{font-size:14px;line-height:1.7}
  .assistant-intro strong,.suggestions button{font-size:13px}
  .assistant-intro small,.composer-footer,.eyebrow{font-size:11px}
  .muted{color:var(--color-ink-soft)}
  .canvas-tools{padding:0 24px;min-height:48px}
  .canvas-tools button{font-size:13px;min-height:44px}
  .canvas-tools button[aria-pressed=true]{border-color:var(--color-ink)}
  
  @media(max-width:760px){
    
    main{height:calc(100dvh - 135px)}
    textarea{font-size:16px}
    .canvas-tools{padding:0 16px}
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
:global(#preview-root){height:100dvh;display:flex;flex-direction:column;overflow:hidden} main{flex:1;min-height:0;height:auto}.topbar,.mobile-switch,.canvas-tools{flex-shrink:0}
.conversation-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--color-line);font-size:13px}.conversation-heading span{font-size:12px;color:var(--color-ink-soft)}.canvas-tools .chat-toggle{border:1px solid var(--color-line-strong);border-radius:9px;padding:6px 12px;min-height:36px;color:var(--color-ink)}
.canvas-tools{flex-wrap:wrap;padding-top:6px;padding-bottom:6px}
</style>
