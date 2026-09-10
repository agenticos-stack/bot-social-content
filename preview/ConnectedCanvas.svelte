<script>
  import {onDestroy} from 'svelte';
  let frame=$state();
  let port;
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
        if(body.length>16000)throw new Error('Request too large');
        const response=await fetch('/api/dev/rpc',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body,signal});
        const result=await response.json();
        if(!response.ok || !result.ok)throw new Error('Local call unavailable. Check your session or the supported development methods.');
        if(!signal.aborted)current.postMessage({id,ok:true,value:result.value});
      }catch(error){if(!signal.aborted)current.postMessage({id,ok:false,error:error.message});}
      finally{pending--;}
    };
    // Opaque sandbox origin requires '*'; only this frame receives the port.
    frame.contentWindow.postMessage({type:'bot-dev-port'},'*',[channel.port2]);
  }
  onDestroy(()=>{port?.close();controller?.abort();});
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
<iframe
  bind:this={frame}
  src="/dev-canvas"
  sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
  title="Social Content — local source"
  onload={connect}
></iframe>
<style>iframe{display:block;width:100%;height:100%;min-height:0;border:0;background:var(--color-panel)}</style>
