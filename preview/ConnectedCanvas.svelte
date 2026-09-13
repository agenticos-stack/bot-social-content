<script>
  import {onDestroy} from 'svelte';
  import {LOCAL_RPC_MAX_BYTES} from '../scripts/local-rpc-contract.mjs';
  import {canvasGrantPersistToAgent, parseGadgetGrantDoorMessage} from '../src/grant-request.js';
  import {SOCIAL_LOCALIZATION_DEFINITION} from '../definition.ts';
  let {onDraftRequested = () => {}, onMutation = () => {}, revision = 0} = $props();
  let frame=$state();
  let frameGeneration=$state(0);
  let port=$state.raw();
  let controller;
  function connect(){
    port?.close();controller?.abort();
    controller=new AbortController();
    const signal=controller.signal;
    const channel=new MessageChannel();port=channel.port1;
    const current=port;
    let pending=0;
    current.onmessage=async event=>{
      const {id,method,args}=event.data || {};
      if(!Number.isSafeInteger(id)||typeof method!=='string'||!Array.isArray(args)||pending>=32)return;
      pending++;
      try{
        const body=JSON.stringify({method,args});
        if(new TextEncoder().encode(body).byteLength>LOCAL_RPC_MAX_BYTES)throw new Error('Request too large');
        const response=await fetch('/api/dev/rpc',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body,signal});
        const result=await response.json();
        if(!response.ok || !result.ok)throw new Error(result.error?.message || result.error || 'The local call failed.');
        if(!signal.aborted){
          current.postMessage({id,ok:true,value:result.value});
          if(method==='createBatch' && typeof result.value?.id==='string' && result.value?.items?.length)onDraftRequested(result.value.id);
          if(method==='requestGeneration' && result.value?.ok===true)onDraftRequested(args[0]);
          if(method==='submitForReview')onMutation();
        }
      }catch(error){if(!signal.aborted)current.postMessage({id,ok:false,error:error.message});}
      finally{pending--;}
    };
    // Opaque sandbox origin requires '*'; only this frame receives the port.
    frame.contentWindow.postMessage({type:'bot-dev-port'},'*',[channel.port2]);
  }
  /*
   * `gadget:grant-door` is a REQUEST, the same as in Studio: the canvas can
   * ask, only the owner can answer, and the answer is given here, in the
   * host's own dialog, never inside the sandbox. Only this frame is heard, and
   * only for a door the gadget declared. Conversation-only is the default;
   * the assistant-wide choice has to be ticked.
   */
  let dialog=$state();
  let grantRequest=$state(null);
  let grantStatus=$state('confirm');
  let grantError=$state('');
  let persistToAssistant=$state(false);
  function receiveGrant(event){
    if(!frame || event.source!==frame.contentWindow || grantStatus==='pending')return;
    const request=parseGadgetGrantDoorMessage(event.data);
    if(!request)return;
    const declared=SOCIAL_LOCALIZATION_DEFINITION.requirements.find(row=>row.requirementKey===request.requirementKey);
    if(!declared)return;
    grantRequest={requirementKey:declared.requirementKey,label:declared.label};
    persistToAssistant=false;grantStatus='confirm';grantError='';
    if(!dialog.open)dialog.showModal();
  }
  function cancelGrant(){
    if(grantStatus==='pending')return;
    grantRequest=null;grantStatus='confirm';grantError='';persistToAssistant=false;
    dialog?.close();
  }
  async function confirmGrant(){
    if(!grantRequest || grantStatus==='pending')return;
    grantStatus='pending';grantError='';
    try{
      const response=await fetch('/api/dev/grant',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},
        body:JSON.stringify({requirementKey:grantRequest.requirementKey,persistToAgent:canvasGrantPersistToAgent(persistToAssistant)})});
      const result=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(result?.error?.message || 'That permission was not granted.');
      grantRequest=null;grantStatus='confirm';persistToAssistant=false;
      dialog?.close();
      // The host swapped the isolate onto the new doors; reload the canvas so
      // it reads them rather than the setup state it drew before the grant.
      frameGeneration++;
    }catch(error){
      // The refusal stays on screen until the owner cancels or tries again.
      grantStatus='failed';
      grantError=error instanceof Error?error.message:'That permission was not granted.';
    }
  }
  onDestroy(()=>{port?.close();controller?.abort();});
  $effect(()=>{revision;port?.postMessage({event:{type:'drafts_changed'}});});
</script>
<!--
  The SAME sandbox the platform uses, deliberately.

  Studio mounts a gadget canvas with `allow-scripts allow-popups
  allow-popups-to-escape-sandbox` (GadgetSandboxFrame.svelte,
  ConversationGadgetFrame.svelte). This harness had only `allow-scripts`, so
  "View original ↗" — a `target="_blank"` link to the post's permalink —
  failed here and only here, with "Blocked opening … in a sandboxed frame
  whose 'allow-popups' permission is not set". A development rig stricter than
  the host it stands in for reports faults the product does not have, which
  costs more than the strictness buys. Match the platform; if the platform
  tightens, tighten with it.
-->
<svelte:window onmessage={receiveGrant} />
{#key frameGeneration}
<iframe
  bind:this={frame}
  src="/dev-canvas"
  sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
  title="Social Content — local source"
  onload={connect}
></iframe>
{/key}
<dialog bind:this={dialog} class="grant" aria-labelledby="grant-title" oncancel={event=>{event.preventDefault();cancelGrant();}}>
  {#if grantRequest}
    <h2 id="grant-title">Grant {grantRequest.label.toLowerCase()}?</h2>
    <p>The canvas is asking to use {grantRequest.label.toLowerCase()}. Confirming grants the permission for this development conversation only. Cancelling makes no grant.</p>
    <label class="persist"><input type="checkbox" bind:checked={persistToAssistant} disabled={grantStatus==='pending'} /> Also allow this assistant in future conversations</label>
    {#if grantError}<p role="alert">{grantError}</p>{/if}
    <div class="actions">
      <button type="button" onclick={cancelGrant} disabled={grantStatus==='pending'}>Cancel</button>
      <button type="button" class="primary" onclick={confirmGrant} disabled={grantStatus==='pending'}>{grantStatus==='pending' ? 'Granting…' : grantStatus==='failed' ? 'Try again' : 'Grant'}</button>
    </div>
  {/if}
</dialog>
<style>
  iframe{display:block;width:100%;height:100%;min-height:0;border:0;background:var(--color-panel)}
  .grant{width:min(calc(100% - 32px),400px);padding:24px;border:1px solid var(--color-line-strong);border-radius:var(--bot-radius-card,14px);background:var(--color-panel);color:var(--color-ink)}
  .grant::backdrop{background:rgb(0 0 0 / .35)}
  h2{font-family:var(--font-brand);font-size:18px;line-height:1.3;margin:0 0 8px}
  p{font-size:13px;line-height:1.6;color:var(--color-ink-soft);margin:8px 0}
  .persist{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.5;margin:16px 0}
  .persist input{margin-top:3px}
  [role=alert]{color:var(--color-ink);border-inline-start:3px solid var(--color-act-hover);padding-inline-start:12px}
  .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
  button{font:inherit;font-size:13px;min-height:36px;padding:6px 14px;border:1px solid var(--color-line-strong);border-radius:7px;background:var(--color-panel);color:var(--color-ink);cursor:pointer}
  .primary{background:var(--color-ink);color:var(--color-panel)}
  button:disabled{opacity:.5;cursor:wait}
  @media(pointer:coarse){button{min-height:44px}}
</style>
