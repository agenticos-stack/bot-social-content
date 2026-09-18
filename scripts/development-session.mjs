import {createHash} from 'node:crypto';
import {refuse} from '@agenticos-dev/bot-devkit/doors';

/** Host-owned local runtime registry. No marketplace, API conversation or model loop. */
export function createDevelopmentSessions({appKey, authenticate, createRuntime, origin}) {
  let owner;
  let pending;
  let closed=false;
  async function acquire(request, start) {
    if(closed)throw refuse('Development host is closed.','no_session');
    const identity=await authenticate(request);
    if(closed)throw refuse('Development host is closed.','no_session');
    if(!identity?.userId || !identity?.orgId)throw refuse('Sign in to a local organization first.','not_signed_in');
    const key=createHash('sha256').update(JSON.stringify([appKey,identity.orgId,identity.userId])).digest('hex');
    if(owner && owner!==key)throw refuse('Restart this development host to switch account or organization.','wrong_account');
    if(!pending && !start)throw refuse('Start the development session first.','no_session');
    if(!pending){
      owner=key;
      pending=Promise.resolve().then(()=>createRuntime(key, identity, request)).catch(error=>{pending=undefined;owner=undefined;throw error;});
    }
    return {runtime:await pending,key,identity};
  }
  return {
    async start(request){
      const {key}=await acquire(request,true);
      const {runtime}=await acquire(request,false);
      return {mode:'local-source',sessionId:key,storage:'local-do-sqlite',agentConnected:Boolean(runtime.agent?.info?.connected),agent:runtime.agent?.info ?? null};
    },
    async call(request){
      const {runtime}=await acquire(request,false);
      // Host-only credential for the existing local testkit. Never the API cookie.
      return runtime.handle(new Request(origin+'/local-rpc',{method:'POST',headers:{origin,'content-type':'application/json','x-bot-local-session':runtime.token},body:request.body,duplex:'half'}));
    },
    async agent(request, input){
      const {runtime,identity}=await acquire(request,false);
      if(typeof runtime.agent?.handle !== 'function')throw new Error('The local agent session is unavailable.');
      // Credential captured at `start()` can be stale minutes later (rotated
      // session cookie, or a gadget-dev token the operator replaced). `acquire`
      // re-authenticates on every call, so hand the agent the current
      // cookie or token rather than the one from `start()`.
      return runtime.agent.handle(input, identity.devToken ?? identity.cookie);
    },
    async connections(request, input){
      const {runtime}=await acquire(request,false);
      if(typeof runtime.connections !== 'function')throw new Error('Connections are unavailable in this development session.');
      return runtime.connections(input);
    },
    async grant(request, input){
      const {runtime,identity}=await acquire(request,false);
      if(typeof runtime.grant !== 'function')throw refuse('Granting doors is unavailable in this development session.','unsupported');
      return runtime.grant(input, identity.devToken ?? identity.cookie);
    },
    /*
     * Start a door this conversation already holds. The same authenticated
     * acquisition as every other operation: the caller must be signed in, own
     * the running session (same org and user), and the session must exist —
     * this never starts one. The runtime verifies the grant with the platform
     * and grants nothing; its answer (runtime ready or refresh_failed) is
     * returned as it is.
     */
    async activate(request, input){
      const {runtime}=await acquire(request,false);
      if(typeof runtime.activate !== 'function')throw refuse('Activating doors is unavailable in this development session.','unsupported');
      return runtime.activate(input);
    },
    /** Subscribe the authenticated owner of the running session to host-observed changes. */
    async events(request, listener){
      const {runtime}=await acquire(request,false);
      if(typeof runtime.events !== 'function')throw new Error('Live updates are unavailable in this development session.');
      return runtime.events(listener);
    },
    async dispose(){closed=true;if(pending)await (await pending).dispose();}
  };
}
