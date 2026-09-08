export function connectedCanvasBridge(origin){return `
globalThis.RpcTarget=class {};
let next=0;
const calls=new Map();
const ready=new Promise(resolve=>{
  function receive(event){
    if(event.source!==parent || event.origin!==${JSON.stringify(origin)} || event.data?.type!=='bot-dev-port' || event.ports.length!==1)return;
    removeEventListener('message',receive);
    const port=event.ports[0];
    port.onmessage=event=>{const result=event.data;const call=calls.get(result?.id);if(!call)return;calls.delete(result.id);clearTimeout(call.timer);result.ok?call.resolve(result.value):call.reject(new Error(result.error));};
    resolve(port);
  }
  addEventListener('message',receive);
});
globalThis.gadget=new Proxy({}, {get(_,method){
  if(method==='then')return undefined;
  if(method==='subscribe')return async()=>({supported:false,reason:'Reload to read local changes.'});
  return async(...args)=>{
    const port=await ready;
    if(calls.size>=32)throw new Error('Too many pending local calls');
    const id=++next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{calls.delete(id);reject(new Error('Local call timed out'));},20000);
      calls.set(id,{resolve,reject,timer});port.postMessage({id,method,args});
    });
  };
}});`}
