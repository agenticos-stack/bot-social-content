<script>
  import { untrack } from 'svelte';

  let { agent, onBack, onCanvas = () => {}, draftRequests = [], asksRevision = 0, agentIntent = null, onIntentConsumed = () => {}, onDraftHandled = () => {}, onChange = () => {} } = $props();
  const remote = document.getElementById('preview-root')?.dataset.mode === 'connected-prod';
  const workspaceId = $derived(typeof agent?.workspaceId === 'string' ? agent.workspaceId : '');
  // A full conversation id is 41 characters of mostly-constant prefix and
  // random hex. Only the first group tells two sessions apart, so that is what
  // the row shows; the whole id stays in the title for copying out of it.
  const shortId = $derived(workspaceId.replace(/^chat_/, '').split('-')[0] || 'conversation');
  let messages = $state([]);
  let asks = $state([]);
  let draft = $state('');
  let busy = $state(false);
  let error = $state('');
  let failedDraft = $state(null);
  // Set when a reload/renewal replaced the gadget registration: every ask
  // captured against the old id is dead server-side, so the honest UI is a
  // retained notice (receipt of what happened) plus a fresh request — never
  // a silent redirect of the old approval onto replacement code.
  let replacedFrom = $state(null);

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
    const data = payload?.data;
    if (data?.agent?.replacedFrom) replacedFrom = data.agent.replacedFrom;
    return data;
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
      onChange();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The local agent request failed.';
    } finally { busy = false; }
  }

  async function answer(actionId, approve) {
    busy = true; error = '';
    try {
      await request({ operation: 'answer', actionId, approve });
      asks = (await request({ operation: 'pending' }))?.asks ?? [];
      onChange();
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not submit that decision.'; }
    finally { busy = false; }
  }

  $effect(()=>{asksRevision;untrack(()=>{void refreshAsks();});});
  /*
   * The ⋯ row's hand-off: the intent card IS the owner's ask — it lands in
   * the transcript, then a seeded turn carries the image's context (and the
   * agent.md rule, attached server-side) so the agent asks what should
   * change about THIS image rather than which one. The suggested replies it
   * carried stay beside the composer until the intent is consumed.
   */
  let activeIntent = $state(null);
  $effect(()=>{
    if(!agentIntent)return;
    const intent=agentIntent;
    untrack(()=>{onIntentConsumed();void startIntent(intent);});
  });
  async function startIntent(intent){
    activeIntent=intent;
    busy=true;error='';
    messages=[...messages,{role:'intent',intent}];
    try{
      const result=await request({operation:'regen-intent',intent});
      addAssistant(result?.result);
      asks=(await request({operation:'pending'}))?.asks ?? [];
      onChange();
    }catch(cause){error=cause instanceof Error?cause.message:'The regenerate conversation could not start.';}
    finally{busy=false;}
  }
  async function suggestReply(text){
    if(busy||!activeIntent)return;
    messages=[...messages,{role:'user',text}];
    busy=true;error='';
    try{
      const result=await request({operation:'run',message:text});
      addAssistant(result?.result);
      asks=(await request({operation:'pending'}))?.asks ?? [];
      onChange();
    }catch(cause){error=cause instanceof Error?cause.message:'The local agent request failed.';}
    finally{busy=false;}
  }
  $effect(()=>{
    if(!busy && draftRequests.length){
      const batchId=draftRequests[0];
      untrack(()=>{onDraftHandled();void generate(batchId);});
    }
  });
  async function generate(batchId){
    busy=true;error='';failedDraft=null;
    messages=[...messages,{role:'user',text:'Generate an image and a caption for each selected reference, using the saved instructions.'}];
    try{
      const result=await request({operation:'draft',batchId});
      addAssistant(result?.result);
      asks=(await request({operation:'pending'}))?.asks ?? [];
      onChange();
    }catch(cause){failedDraft=batchId;error=cause instanceof Error?cause.message:'Generation failed.';}
    finally{busy=false;}
  }
</script>

<section class="chat" aria-label="Local agent conversation">
  <header class="chat-head">
    <div>
      <span class="eyebrow">LOCAL AGENT</span>
      <h1>Social Content</h1>
    </div>
    <button class="back" type="button" onclick={onBack}>Account</button>
  </header>
  <div class="connection">
    <span class="dot"></span>
    <span class="connection-label">Connected to {remote ? 'production' : 'local'} API</span>
    <code title={workspaceId || 'No conversation id'}>{shortId}</code>
  </div>
  <div class="messages" aria-live="polite">
    {#if messages.length === 0}
      <div class="empty"><strong>Work with the source</strong><p>Ask the agent to inspect a batch, refine a caption, or explain the current local state.</p></div>
    {/if}
    {#each messages as message, index (index)}
      {#if message.role === 'intent'}
        <div class="intent-card" role="note">
          {#if message.intent.image.thumbnail}<img class="intent-thumb" src={message.intent.image.thumbnail} alt="" />{/if}
          <div class="intent-meta">
            <strong>Regenerate image — {message.intent.post.title || 'this post'}</strong>
            <span>Image · {message.intent.image.aspectRatio} · {message.intent.image.references === 'source' ? "from the post's own picture" : 'no reference'}</span>
          </div>
        </div>
      {:else}
        <div class:mine={message.role === 'user'} class="message"><span>{message.text}</span></div>
      {/if}
    {/each}
    {#if busy}<div class="typing" aria-label="Agent is working"><i></i><i></i><i></i></div>{/if}
    {#if activeIntent}
      <button class="canvas-back" type="button" onclick={onCanvas}>← Canvas</button>
    {/if}
  </div>
  {#if replacedFrom}
    <aside class="approvals" aria-label="Registration replaced">
      <div class="approval-title"><span>Gadget reloaded</span></div>
      <div class="approval"><p>The local source was re-registered — approvals requested before the reload are no longer actionable. Ask the agent again to re-issue them; earlier receipts are retained in the conversation.</p></div>
    </aside>
  {/if}
  {#if asks.length}
    <aside class="approvals" aria-label="Pending approvals">
      <div class="approval-title"><span>Approval needed</span><small>{asks.length}</small></div>
      {#each asks as ask (ask.id)}
        <div class="approval"><p>{ask.subject || ask.toolName || 'The agent requested an action.'}</p><div><button type="button" onclick={() => answer(ask.id, false)} disabled={busy}>Reject</button><button class="approve" type="button" onclick={() => answer(ask.id, true)} disabled={busy}>Approve</button></div></div>
      {/each}
    </aside>
  {/if}
  {#if activeIntent?.suggestedReplies?.length}
    <div class="intent-chips" role="group">
      {#each activeIntent.suggestedReplies as suggestion (suggestion)}
        <button type="button" disabled={busy} onclick={()=>suggestReply(suggestion)}>{suggestion}</button>
      {/each}
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}{#if failedDraft}<button type="button" disabled={busy} onclick={()=>generate(failedDraft)}>Retry generation</button>{/if}</p>{/if}
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
  .connection{display:flex;align-items:center;gap:7px;padding:9px 18px;border-bottom:1px solid var(--color-line);font-size:10px;color:var(--color-ink-soft)}
  .connection-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* An id is one token: it truncates rather than wrapping, whatever the pane width. */
  .connection code{flex:none;margin-left:auto;max-width:12ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 6px;border-radius:5px;background:var(--color-paper);color:var(--color-ink-soft);font:10px/1.5 ui-monospace,monospace}
  .dot{flex:none;width:6px;height:6px;border-radius:50%;background:#3c9b69;box-shadow:0 0 0 3px color-mix(in srgb,#3c9b69 14%,transparent)}
  .messages{overflow:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px}.empty{margin:auto 6px;color:var(--color-ink-soft);font-size:12px;line-height:1.55}.empty strong{color:var(--color-ink);font-size:13px}.empty p{margin:4px 0 0}.message{max-width:88%;padding:9px 11px;border-radius:11px 11px 11px 4px;background:var(--color-paper);font-size:12px;line-height:1.55;white-space:pre-wrap}.message.mine{align-self:flex-end;border-radius:11px 11px 4px 11px;background:var(--color-ink);color:var(--color-panel)}
  .typing{display:flex;gap:3px;padding:8px 10px}.typing i{width:4px;height:4px;border-radius:50%;background:var(--color-ink-soft);animation:pulse 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes pulse{50%{opacity:.25}}
  .approvals{margin:0 12px 10px;padding:10px;border:1px solid color-mix(in srgb,#b58a38 45%,var(--color-line));border-radius:9px;background:color-mix(in srgb,#b58a38 7%,var(--color-panel))}.approval-title{display:flex;justify-content:space-between;font-size:10px;font-weight:600}.approval-title small{font-weight:500;color:var(--color-ink-soft)}.approval{padding-top:7px}.approval p{font-size:11px;line-height:1.45;margin:0 0 7px}.approval div{display:flex;gap:6px}.approval button{min-height:28px;padding:4px 9px;border:1px solid var(--color-line-strong);border-radius:6px;background:var(--color-panel);font-size:10px;cursor:pointer}.approval .approve{background:var(--color-ink);color:var(--color-panel);border-color:var(--color-ink)}
  .error{margin:0 14px 9px;padding:7px 9px;border-left:2px solid #b94b4b;color:#934040;font-size:10px;line-height:1.4}.composer{display:flex;gap:7px;padding:11px 12px;border-top:1px solid var(--color-line);background:var(--color-panel)}.composer input{min-width:0;flex:1;height:34px;padding:0 10px;border:1px solid var(--color-line-strong);border-radius:8px;background:var(--color-paper);color:var(--color-ink);font:12px var(--font-body)}.composer button{flex:none;width:34px;height:34px;border:0;border-radius:8px;background:var(--color-ink);color:var(--color-panel);font-size:18px;line-height:1;cursor:pointer}.composer button:hover:not(:disabled){background:var(--color-act-hover)}
  /* Matches the fixture composer: nothing to send is inert, not a dimmed dark button. */
  .composer button:disabled{background:var(--color-panel-subtle);color:var(--color-ink-faint);cursor:default}
  /* The intent card shows the image being discussed — the conversation never
     asks which one. Chips are the one-tap answers the canvas suggested. */
  .intent-card{display:flex;gap:10px;align-items:center;padding:9px 11px;border:1px solid var(--color-line-strong);border-radius:11px;background:var(--color-paper)}
  .intent-thumb{width:40px;height:40px;object-fit:cover;border-radius:8px;flex:none}
  .intent-meta{display:flex;flex-direction:column;gap:2px;min-width:0}
  .intent-meta strong{font-size:11.5px;font-weight:600}
  .intent-meta span{font-size:10px;color:var(--color-ink-soft)}
  .intent-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px}
  .intent-chips button{min-height:28px;padding:3px 10px;border:1px solid var(--color-line-strong);border-radius:999px;background:var(--color-panel);font-size:10.5px;color:var(--color-ink-soft);cursor:pointer}
  .intent-chips button:hover:not(:disabled){color:var(--color-act-hover);border-color:var(--color-act-hover)}
  .canvas-back{display:none;align-self:flex-start;margin:6px 0 0;background:transparent;border:0;font-size:11px;color:var(--color-act-hover);cursor:pointer}
  @media(max-width:760px){.canvas-back{display:block}}
</style>
