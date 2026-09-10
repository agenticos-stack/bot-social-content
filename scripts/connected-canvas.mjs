/*
 * `decodeBytes` is the testkit's own decoder, handed in rather than imported.
 *
 * The host encodes binary values into an envelope on the way out (see the
 * testkit's rpc-bytes.js: an index-keyed Uint8Array costs ~9 characters per
 * byte and arrives as an object with one own property per byte for
 * structuredClone to walk, twice). Encoder and decoder must be the same
 * version, and BOT_SDK_SOURCE overlays the testkit with a checkout — so
 * importing the published package here would pair a source encoder with an
 * installed decoder. preview.mjs resolves both from the same place.
 */
export function connectedCanvasBridge(origin, decodeBytes){return `
${decodeBytes}
globalThis.RpcTarget=class {};
let next=0;
const calls=new Map();
const ready=new Promise(resolve=>{
  function receive(event){
    if(event.source!==parent || event.origin!==${JSON.stringify(origin)} || event.data?.type!=='bot-dev-port' || event.ports.length!==1)return;
    removeEventListener('message',receive);
    const port=event.ports[0];
    port.onmessage=event=>{const result=event.data;const call=calls.get(result?.id);if(!call)return;calls.delete(result.id);clearTimeout(call.timer);result.ok?call.resolve(__botDecodeBytes(result.value)):call.reject(new Error(result.error));};
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
      const timer=setTimeout(()=>{calls.delete(id);reject(new Error('The local host did not answer '+method+' within 30 seconds.'));},30000);
      calls.set(id,{resolve,reject,timer});port.postMessage({id,method,args});
    });
  };
}});`}
