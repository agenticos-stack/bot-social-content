<script>
  import { onMount } from 'svelte';
  import ConnectedCanvas from './ConnectedCanvas.svelte';
  import ConnectedChat from './ConnectedChat.svelte';
  import Shell from '@agenticos-dev/bot-shell/GadgetSplitView.svelte';
  let email = $state('');
  let user = $state(null);
  let busy = $state(true);
  let error = $state('');
  let orgName = $state('');
  let development = $state(null);
  let draftRequests = $state([]);
  let canvasRevision = $state(0);
  let asksRevision = $state(0);
  function queueDraft(batchId){
    if(typeof batchId==='string' && !draftRequests.includes(batchId))draftRequests=[...draftRequests,batchId];
  }
  const remote = document.getElementById('preview-root')?.dataset.mode === 'connected-prod';
  async function request(path, body) {
    const response = await fetch(path, {method:body === undefined ? 'GET' : 'POST',credentials:'include',
      headers:body === undefined ? {} : {'content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
    const value = await response.json();
    if(!response.ok)throw new Error(value.error?.message || value.message || 'The local API request failed.');
    return value;
  }
  async function load() {
    user = (await request('/api/auth/get-session'))?.user ?? null;
    if(!user){orgName='';development=null;return;}
    const shell = await request('/api/agenticos/v1/studio/shell');
    orgName=shell.data?.activeOrg?.name || '';
  }
  async function perform(operation) {
    if (busy) return;
    busy=true;error='';
    try{await operation();}catch(cause){error=cause instanceof Error?cause.message:'Connection failed.';}finally{busy=false;}
  }
  onMount(()=>{busy=false;if(!remote)void perform(load);});
  function start(){void perform(async()=>{
    const result=await request('/api/dev/session',{});
    if(result.data?.mode!=='local-source')throw new Error('The local runtime did not start.');
    development=result.data;
  });}
  function signIn(event){event.preventDefault();void perform(async()=>{await request('/api/auth/dev-sign-in',{email});await load();});}
  function signOut(){void perform(async()=>{await request('/api/auth/sign-out',{});user=null;orgName='';development=null;});}
</script>

{#if development}
  <div class="runtime-shell">
    {#snippet chat()}<ConnectedChat agent={development.agent} {draftRequests} {asksRevision} onDraftHandled={()=>draftRequests=draftRequests.slice(1)} onChange={()=>canvasRevision++} onBack={()=>development=null} />{/snippet}
    {#snippet canvas()}<ConnectedCanvas revision={canvasRevision} onDraftRequested={queueDraft} onMutation={()=>asksRevision++} />{/snippet}
    <Shell {chat} {canvas} chatSide="left" chatOpen={true} mobilePane="canvas" canvasScroll="clip" chatLabel="Development connection" canvasLabel="Local canvas" />
  </div>
{:else}
<main class="connected">
  <section aria-labelledby="connection-title">
    <h1 id="connection-title">{remote ? 'Production platform' : user ? 'Signed in' : 'Sign in'}</h1>
    {#if remote}
      <p class="hint">Local source connected to your production workspace. Provider calls use the connections you grant. Review the content and timing before submitting a post.</p>
      <button class="primary" type="button" onclick={start} disabled={busy}>{busy ? 'Working…' : 'Start development session'}</button>
      <p class="hint">Opens your local source with persistent SQLite against the production agent session. No upload or marketplace installation.</p>
    {:else if user}
      <p class="account">{user.email}<span>{orgName ? `Organization · ${orgName}` : 'Local account'}</span></p>
      <p class="hint">Local API connected.</p>
        <button class="primary" type="button" onclick={start} disabled={busy}>{busy ? 'Working…' : 'Start development session'}</button>
        <p class="hint">Opens your local source with persistent SQLite. No upload or marketplace installation.</p>
      <div class="actions"><button type="button" onclick={()=>perform(load)} disabled={busy}>Refresh</button><button type="button" onclick={signOut} disabled={busy}>Sign out</button></div>
    {:else}
      <p>Use your local AgenticOS account.</p>
      <form onsubmit={signIn}>
        <label for="dev-email">Work email</label>
        <input id="dev-email" name="email" type="email" autocomplete="username" bind:value={email} required disabled={busy} />
        <button class="primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Sign in locally'}</button>
      </form>
      <p class="hint">Local development only. No email is sent.</p>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
</main>
{/if}

<style>
  .runtime-shell{flex:1;min-height:0;--bot-chat-width:320px}
  .connected{flex:1;overflow:auto;display:grid;place-items:start center;padding:clamp(32px,8vh,96px) 24px;background:var(--color-paper)}
  section{width:min(100%,380px);padding:24px;border:1px solid var(--color-line-strong);border-radius:var(--bot-radius-card,14px);background:var(--color-panel)}
  h1{font-family:var(--font-brand);font-size:20px;line-height:1.3;margin:0 0 12px}p{font-size:13px;line-height:1.6;color:var(--color-ink-soft);margin:8px 0}.account{color:var(--color-ink);overflow-wrap:anywhere}.account span{display:block;font-size:12px;color:var(--color-ink-soft);margin-top:4px}
  form{display:grid;gap:8px;margin-top:20px}label{display:block;font-size:12px}input{box-sizing:border-box;width:100%;font:inherit;font-size:14px;min-height:36px;padding:7px 10px;border:1px solid var(--color-line-strong);border-radius:7px;background:var(--color-panel);color:var(--color-ink)}
  button{font:inherit;font-size:12px;min-height:32px;padding:6px 12px;border:1px solid var(--color-line-strong);border-radius:7px;background:var(--color-panel);color:var(--color-ink);cursor:pointer}.primary{justify-self:start;margin-top:4px;background:var(--color-ink);color:var(--color-panel)}button:disabled{opacity:.5;cursor:wait}.hint{font-size:12px;margin-top:16px}.actions{display:flex;gap:8px;margin-top:16px}[role=alert]{color:var(--color-ink);border-inline-start:3px solid var(--color-act-hover);padding-inline-start:12px}
  @media(pointer:coarse){input{font-size:16px;min-height:44px}button{min-height:44px}}
</style>
