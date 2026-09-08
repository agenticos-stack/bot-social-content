<script>
  import { onMount } from 'svelte';

  let { agent, onBack } = $props();
  let messages = $state([]);
  let asks = $state([]);
  let draft = $state('');
  let busy = $state(false);
  let error = $state('');

  function textOf(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('');
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return textOf(value.content);
    for (const key of ['text', 'content', 'message', 'body']) {
      if (typeof value[key] === 'string') return value[key];
    }
    return '';
  }

  function addAssistant(result) {
    const rows = Array.isArray(result?.messages) ? result.messages : [];
    const text = rows.map(textOf).filter(Boolean).at(-1);
    if (text) messages = [...messages, { role: 'assistant', text }];
  }

  async function request(input) {
    const response = await fetch('/api/dev/agent', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || 'The local agent request failed.');
    return payload?.data;
  }

  async function refreshAsks() {
    try { asks = (await request({ operation: 'pending' }))?.asks ?? []; }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Could not read pending approvals.'; }
  }

  async function send(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    draft = '';
    messages = [...messages, { role: 'user', text }];
    busy = true; error = '';
    try {
      const result = await request({ operation: 'run', message: text });
      addAssistant(result?.result);
      asks = (await request({ operation: 'pending' }))?.asks ?? [];
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The local agent request failed.';
    } finally { busy = false; }
  }

  async function answer(actionId, approve) {
    busy = true; error = '';
    try {
      await request({ operation: 'answer', actionId, approve });
      asks = (await request({ operation: 'pending' }))?.asks ?? [];
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not submit that decision.'; }
    finally { busy = false; }
  }

  onMount(() => { void refreshAsks(); });
</script>

<section class="chat" aria-label="Local agent conversation">
  <header class="chat-head">
    <div>
      <span class="eyebrow">LOCAL AGENT</span>
      <h1>Social Content</h1>
    </div>
    <button class="back" type="button" onclick={onBack}>Account</button>
  </header>
  <div class="connection"><span class="dot"></span><span>Connected to local API</span><code>{agent?.workspaceId ?? 'conversation'}</code></div>
  <div class="messages" aria-live="polite">
    {#if messages.length === 0}
      <div class="empty"><strong>Work with the source</strong><p>Ask the agent to inspect a batch, refine a caption, or explain the current local state.</p></div>
    {/if}
    {#each messages as message, index (index)}
      <div class:mine={message.role === 'user'} class="message"><span>{message.text}</span></div>
    {/each}
    {#if busy}<div class="typing" aria-label="Agent is working"><i></i><i></i><i></i></div>{/if}
  </div>
  {#if asks.length}
    <aside class="approvals" aria-label="Pending approvals">
      <div class="approval-title"><span>Approval needed</span><small>{asks.length}</small></div>
      {#each asks as ask (ask.id)}
        <div class="approval"><p>{ask.subject || ask.toolName || 'The agent requested an action.'}</p><div><button type="button" onclick={() => answer(ask.id, false)} disabled={busy}>Reject</button><button class="approve" type="button" onclick={() => answer(ask.id, true)} disabled={busy}>Approve</button></div></div>
      {/each}
    </aside>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <form class="composer" onsubmit={send}>
    <input aria-label="Message" placeholder="Ask about this source…" bind:value={draft} disabled={busy} />
    <button type="submit" aria-label="Send message" disabled={busy || !draft.trim()}>↑</button>
  </form>
</section>

<style>
  .chat{height:100%;min-height:0;display:grid;grid-template-rows:auto auto 1fr auto auto;overflow:hidden;background:var(--color-panel);color:var(--color-ink)}
  .chat-head{display:flex;align-items:center;gap:12px;padding:16px 18px 13px;border-bottom:1px solid var(--color-line)}
  .chat-head h1{font:600 15px/1.2 var(--font-brand);margin:2px 0 0;letter-spacing:-.01em}.eyebrow{font-size:9px;letter-spacing:.12em;color:var(--color-ink-soft)}
  .back{margin-left:auto;border:0;background:transparent;color:var(--color-ink-soft);font-size:11px;padding:5px 7px;border-radius:6px;cursor:pointer}.back:hover{background:var(--color-paper)}
  .connection{display:flex;align-items:center;gap:6px;padding:8px 18px;border-bottom:1px solid var(--color-line);font-size:10px;color:var(--color-ink-soft)}.connection code{margin-left:auto;max-width:92px;overflow:hidden;text-overflow:ellipsis;color:var(--color-ink-faint);font:10px ui-monospace,monospace}.dot{width:6px;height:6px;border-radius:50%;background:#3c9b69;box-shadow:0 0 0 3px color-mix(in srgb,#3c9b69 14%,transparent)}
  .messages{overflow:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px}.empty{margin:auto 6px;color:var(--color-ink-soft);font-size:12px;line-height:1.55}.empty strong{color:var(--color-ink);font-size:13px}.empty p{margin:4px 0 0}.message{max-width:88%;padding:9px 11px;border-radius:11px 11px 11px 4px;background:var(--color-paper);font-size:12px;line-height:1.55;white-space:pre-wrap}.message.mine{align-self:flex-end;border-radius:11px 11px 4px 11px;background:var(--color-ink);color:var(--color-panel)}
  .typing{display:flex;gap:3px;padding:8px 10px}.typing i{width:4px;height:4px;border-radius:50%;background:var(--color-ink-soft);animation:pulse 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes pulse{50%{opacity:.25}}
  .approvals{margin:0 12px 10px;padding:10px;border:1px solid color-mix(in srgb,#b58a38 45%,var(--color-line));border-radius:9px;background:color-mix(in srgb,#b58a38 7%,var(--color-panel))}.approval-title{display:flex;justify-content:space-between;font-size:10px;font-weight:600}.approval-title small{font-weight:500;color:var(--color-ink-soft)}.approval{padding-top:7px}.approval p{font-size:11px;line-height:1.45;margin:0 0 7px}.approval div{display:flex;gap:6px}.approval button{min-height:28px;padding:4px 9px;border:1px solid var(--color-line-strong);border-radius:6px;background:var(--color-panel);font-size:10px;cursor:pointer}.approval .approve{background:var(--color-ink);color:var(--color-panel);border-color:var(--color-ink)}
  .error{margin:0 14px 9px;padding:7px 9px;border-left:2px solid #b94b4b;color:#934040;font-size:10px;line-height:1.4}.composer{display:flex;gap:7px;padding:11px 12px;border-top:1px solid var(--color-line);background:var(--color-panel)}.composer input{min-width:0;flex:1;height:34px;padding:0 10px;border:1px solid var(--color-line-strong);border-radius:8px;background:var(--color-paper);color:var(--color-ink);font:12px var(--font-body)}.composer button{width:34px;height:34px;border:0;border-radius:8px;background:var(--color-ink);color:var(--color-panel);font-size:18px;line-height:1;cursor:pointer}.composer button:disabled{opacity:.35;cursor:default}
</style>
