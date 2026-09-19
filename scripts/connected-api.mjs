import { assertLocalApiOrigin, assertLocalFrontendOrigin, assertRemoteApiOrigin } from '@agenticos-dev/bot-devkit/origins';
import { LOCAL_RPC_MAX_BYTES } from './local-rpc-contract.mjs';
import { doorFailureResponse } from '@agenticos-dev/bot-devkit/doors';

const localRoutes = new Map([
  ['/api/auth/get-session', ['GET']],
  ['/api/auth/dev-sign-in', ['POST']],
  ['/api/auth/sign-out', ['POST']],
  ['/api/agenticos/v1/studio/shell', ['GET']],
  ['/api/dev/session', ['POST']],
  ['/api/dev/rpc', ['POST']],
  ['/api/dev/agent', ['POST']],
  ['/api/dev/grant', ['POST']],
  ['/api/dev/activate', ['POST']],
  ['/api/dev/events', ['GET']],
  ['/api/dev/connections', ['POST']],
  ['/api/agenticos/v2/workspaces', ['GET']]
]);
const remoteRoutes = new Map([
  ['/api/dev/session', ['POST']],
  ['/api/dev/rpc', ['POST']],
  ['/api/dev/agent', ['POST']],
  ['/api/dev/grant', ['POST']],
  ['/api/dev/activate', ['POST']],
  ['/api/dev/events', ['GET']],
  ['/api/dev/connections', ['POST']]
]);
const tokenKeys = new Set(['token','access_token','accessToken']);
export function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!tokenKeys.has(key)).map(([key,value])=>[key,redactCredentials(value)]));
}

/** Local BFF only. Authentication remains the API's existing Better Auth flow
 *  on loopback, or a host-held gadget-dev token against production/staging.
 *  The browser never receives that token. */
export function createConnectedApi({apiOrigin, frontendOrigin, development, fetcher = fetch, platform = 'local'}) {
  if (platform === 'remote') {
    assertRemoteApiOrigin(apiOrigin);
    assertLocalFrontendOrigin(frontendOrigin, ['social.localhost']);
  } else {
    assertLocalApiOrigin(apiOrigin);
    assertLocalFrontendOrigin(frontendOrigin, ['social.localhost']);
  }
  const routes = platform === 'remote' ? remoteRoutes : localRoutes;
  const unavailable = platform === 'remote' ? 'The production API is unavailable.' : 'The local API is unavailable.';
  return async function handle(request) {
    const url = new URL(request.url);
    const fail = (status,error)=>Response.json({error:{message:error}},{status,headers:{'cache-control':'no-store'}});
    const refused = (status,message,code)=>Response.json({error:{message,code,certainty:'refused'}},{status,headers:{'cache-control':'no-store'}});
    if (!routes.get(url.pathname)?.includes(request.method)) return fail(404,'Route unavailable in connected preview.');
    if (url.origin !== frontendOrigin || request.headers.get('sec-fetch-site') === 'cross-site') return fail(403,'Origin refused.');
    if (request.method !== 'GET' && request.headers.get('origin') !== frontendOrigin) return fail(403,'Origin refused.');
    /*
     * Host-observed changes for the connected canvas, as Server-Sent Events.
     * The same authenticated session acquisition as every other development
     * route: signed in, owning the running session, never starting one. Each
     * event names only its type; the canvas re-reads through the gadget API.
     */
    if (url.pathname === '/api/dev/events') {
      if (!development || typeof development.events !== 'function') return fail(503,'Live updates are not configured.');
      let unsubscribe=()=>{};
      let heartbeat;
      const encoder=new TextEncoder();
      let push;
      try {
        unsubscribe=await development.events(request,(event)=>push?.(event));
      } catch (error) {
        return fail(409,error instanceof Error?error.message:'Live updates are unavailable.');
      }
      const stream=new ReadableStream({
        start(controller){
          push=(event)=>{try{controller.enqueue(encoder.encode(`data: ${JSON.stringify({type:event?.type})}\n\n`));}catch{}};
          controller.enqueue(encoder.encode(': connected\n\n'));
          heartbeat=setInterval(()=>{try{controller.enqueue(encoder.encode(': keep-alive\n\n'));}catch{}},25000);
          heartbeat.unref?.();
          request.signal?.addEventListener?.('abort',()=>{clearInterval(heartbeat);unsubscribe();try{controller.close();}catch{}},{once:true});
        },
        cancel(){clearInterval(heartbeat);push=undefined;unsubscribe();}
      });
      return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'}});
    }
    const headers = new Headers({accept:'application/json'});
    for (const key of ['cookie','origin','content-type']) {
      const value=request.headers.get(key);if(value)headers.set(key,value);
    }
    let body;
    if (request.method !== 'GET') {
      if (!headers.get('content-type')?.startsWith('application/json')) return fail(415,'JSON required.');
      const reader=request.body?.getReader();const chunks=[];let size=0;
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>(url.pathname === '/api/dev/rpc' ? LOCAL_RPC_MAX_BYTES : 16384)){await reader.cancel();return fail(413,'Request too large.');}chunks.push(value);
      }}finally{reader.releaseLock();}
      body=Buffer.concat(chunks);
    }
    const starting = url.pathname === '/api/dev/session';
    const agent = url.pathname === '/api/dev/agent';
    const grant = url.pathname === '/api/dev/grant';
    const activate = url.pathname === '/api/dev/activate';
    const connections = url.pathname === '/api/dev/connections';
    if (starting || url.pathname === '/api/dev/rpc' || agent || grant || activate || connections) {
      if (!development) return fail(503,'Local source runtime is not configured.');
      if(connections){
        // Either "what could I connect" or one choice of account for one
        // declared family. Anything else in the body is refused.
        let input;
        try { input=JSON.parse(body.toString()); } catch { return fail(400,'Invalid JSON.'); }
        const keys=input && typeof input==='object' && !Array.isArray(input) ? Object.keys(input).sort().join(',') : '';
        const list=keys==='operation' && input.operation==='list';
        const choose=keys==='operation,requirementKey,resolvedId' && input.operation==='grant' && typeof input.requirementKey==='string' && typeof input.resolvedId==='string';
        if(!list && !choose)return fail(400,'List connections, or name a family and an account.');
        try{return Response.json({data:await development.connections(request,input)},{headers:{'cache-control':'no-store'}});}
        catch(error){return fail(409,error instanceof Error?error.message:'Connections are unavailable.');}
      }
      if(grant){
        // The owner's answer from the host dialog, nothing more: which door,
        // and whether it also applies to the assistant. Anything else in the
        // body is refused rather than forwarded.
        let input;
        try { input=JSON.parse(body.toString()); } catch { return refused(400,'Invalid JSON.','invalid_request'); }
        const keys=input && typeof input==='object' && !Array.isArray(input) ? Object.keys(input).sort().join(',') : '';
        if(keys!=='persistToAgent,requirementKey' || typeof input.requirementKey!=='string' || typeof input.persistToAgent!=='boolean')return refused(400,'A door and a scope are required.','invalid_request');
        // Only a classified refusal is a 409. Anything else may have saved
        // consent before the answer was lost: 502, certainty unknown.
        try{return Response.json({data:await development.grant(request,input)},{headers:{'cache-control':'no-store'}});}
        catch(error){return doorFailureResponse(error,'That door could not be granted.');}
      }
      if(activate){
        // Start a door this conversation already holds. The body names the
        // door and nothing else; the development runtime refuses any key the
        // platform does not list as granted, so this can never grant.
        let input;
        try { input=JSON.parse(body.toString()); } catch { return refused(400,'Invalid JSON.','invalid_request'); }
        const keys=input && typeof input==='object' && !Array.isArray(input) ? Object.keys(input).sort().join(',') : '';
        if(keys!=='requirementKey' || typeof input.requirementKey!=='string')return refused(400,'A door is required.','invalid_request');
        if(typeof development.activate!=='function')return refused(501,'This host cannot activate a door.','unsupported');
        try{return Response.json({data:await development.activate(request,input)},{headers:{'cache-control':'no-store'}});}
        catch(error){return doorFailureResponse(error,'That door could not be activated.');}
      }
      if(agent){
        let input;
        try { input=JSON.parse(body.toString()); } catch { return fail(400,'Invalid JSON.'); }
        try{return Response.json({data:await development.agent(request,input)},{headers:{'cache-control':'no-store'}});}
        catch(error){return fail(409,error instanceof Error?error.message:'The local agent session is unavailable.');}
      }
      if(!starting)try{return await development.call(new Request(request.url,{method:'POST',headers:request.headers,body}));}
      catch {return fail(403,'Local development session is unavailable for this account.');}
      let input;
      try { input=JSON.parse(body.toString()); } catch { return fail(400,'Invalid JSON.'); }
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) return fail(400,'Session identity is assigned by the local host.');
      try{return Response.json({data:await development.start(request)},{headers:{'cache-control':'no-store'}});}
      catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start local runtime. Check your local session and the development server.';
        console.error('development.start failed:', error);
        return fail(409, message);
      }
    }
    if (platform === 'remote') return fail(404,'Route unavailable in connected preview.');
    const path=url.pathname.startsWith('/api/agenticos/')?url.pathname.slice('/api/agenticos'.length):url.pathname;
    try {
      const upstream=await fetcher(apiOrigin+path+url.search,{method:request.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(15000)});
      const safeHeaders = new Headers({'content-type':'application/json','cache-control':'no-store'});
      for(const cookie of upstream.headers.getSetCookie())safeHeaders.append('set-cookie',cookie);
      if(upstream.status===204)return new Response(null,{status:204,headers:safeHeaders});
      // Never forward bearer response headers, credential JSON fields or redirects.
      const payload=redactCredentials(await upstream.json());
      return Response.json(payload,{status:upstream.status,headers:safeHeaders});
    } catch { return fail(502,unavailable); }
  };
}
