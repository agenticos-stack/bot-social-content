import {createHash} from 'node:crypto';

/** Host-owned local runtime registry. No marketplace, API conversation or model loop. */
export function createDevelopmentSessions({appKey, authenticate, createRuntime, origin}) {
  let owner;
  let pending;
  let closed=false;
  async function acquire(request, start) {
    if(closed)throw new Error('Development host is closed.');
    const identity=await authenticate(request);
    if(closed)throw new Error('Development host is closed.');
    if(!identity?.userId || !identity?.orgId)throw new Error('Sign in to a local organization first.');
    const key=createHash('sha256').update(JSON.stringify([appKey,identity.orgId,identity.userId])).digest('hex');
    if(owner && owner!==key)throw new Error('Restart this development host to switch account or organization.');
    if(!pending && !start)throw new Error('Start the development session first.');
    if(!pending){
      owner=key;
      pending=Promise.resolve().then(()=>createRuntime(key)).catch(error=>{pending=undefined;owner=undefined;throw error;});
    }
    return {runtime:await pending,key};
  }
  return {
    async start(request){
      const {key}=await acquire(request,true);
      return {mode:'local-source',sessionId:key,storage:'local-do-sqlite',agentConnected:false};
    },
    async call(request){
      const {runtime}=await acquire(request,false);
      // Host-only credential for the existing local testkit. Never the API cookie.
      return runtime.handle(new Request(origin+'/local-rpc',{method:'POST',headers:{origin,'content-type':'application/json','x-bot-local-session':runtime.token},body:request.body,duplex:'half'}));
    },
    async dispose(){closed=true;if(pending)await (await pending).dispose();}
  };
}
