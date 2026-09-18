import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectedApi} from '../scripts/connected-api.mjs';
import { refuse } from '@agenticos-dev/bot-devkit/doors';
const frontendOrigin='http://social.localhost:18000';
test('poster requests pass the connected BFF without increasing the agent-message budget',async()=>{
  const body=JSON.stringify({method:'savePoster',args:[{png:{$bot_bytes_b64:'a'.repeat(150000)}}]});
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{call:async request=>{
    assert.equal(await request.text(),body);
    return Response.json({ok:true,value:{revision:2}});
  }}});
  const request=path=>new Request(frontendOrigin+path,{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body});
  assert.equal((await handle(request('/api/dev/rpc'))).status,200);
  assert.equal((await handle(request('/api/dev/agent'))).status,413);
});
test('development launch never creates an installed gadget or API conversation',async()=>{
  let calls=0;
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{start:async()=>{calls++;return {mode:'local-source'};}},fetcher:()=>assert.fail('must not call marketplace or conversation API')});
  const request=body=>new Request(frontendOrigin+'/api/dev/session',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await handle(request({orgId:'other'}))).status,400);
  assert.equal(calls,0);
  assert.equal((await handle(request({}))).status,200);
  assert.equal(calls,1);
});
test('connected BFF delegates only the host-owned agent operation',async()=>{
  let input;
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{agent:async(_request,value)=>{input=value;return {result:{turnId:'t_local'}};}}});
  const response=await handle(new Request(frontendOrigin+'/api/dev/agent',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:'{"operation":"pending"}'}));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{data:{result:{turnId:'t_local'}}});
  assert.deepEqual(input,{operation:'pending'});
});
test('connected BFF preserves cookies but never bearer credentials',async()=>{
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,fetcher:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:8789/api/auth/dev-sign-in');
    assert.equal(options.headers.get('authorization'),null);
    assert.equal(options.headers.get('cookie'),'session=example');
    return Response.json({user:{id:'user'},session:{token:'secret'}},{headers:{'set-cookie':'session=new; HttpOnly','set-auth-token':'secret'}});
  }});
  const result=await handle(new Request(frontendOrigin+'/api/auth/dev-sign-in',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json',authorization:'Bearer secret',cookie:'session=example'},body:'{}'}));
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{user:{id:'user'},session:{}});
  assert.equal(result.headers.get('set-auth-token'),null);
  assert.match(result.headers.get('set-cookie'),/HttpOnly/);
});
test('connected BFF rejects foreign origins, unknown routes and oversized requests',async()=>{
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,fetcher:()=>assert.fail('must not reach upstream')});
  assert.equal((await handle(new Request(frontendOrigin+'/api/auth/dev-sign-in',{method:'POST',headers:{origin:'http://evil.localhost'}}))).status,403);
  assert.equal((await handle(new Request(frontendOrigin+'/api/agenticos/v1/gadgets',{method:'POST'}))).status,404);
  assert.equal((await handle(new Request(frontendOrigin+'/api/auth/dev-sign-in',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:'x'.repeat(16385)}))).status,413);
  assert.throws(()=>createConnectedApi({apiOrigin:'https://staging-api.agenticos.hk',frontendOrigin}));
});
test('remote platform BFF admits production API origins and never proxies cookies or auth routes',async()=>{
  assert.throws(()=>createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,platform:'remote'}));
  const handle=createConnectedApi({apiOrigin:'https://staging-api.agenticos.hk',frontendOrigin,platform:'remote',development:{start:async()=>({mode:'local-source'})},fetcher:()=>assert.fail('must not proxy to production')});
  assert.equal((await handle(new Request(frontendOrigin+'/api/auth/get-session'))).status,404);
  assert.equal((await handle(new Request(frontendOrigin+'/api/auth/dev-sign-in',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:'{}'}))).status,404);
  assert.equal((await handle(new Request(frontendOrigin+'/api/dev/session',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:'{}'}))).status,200);
});
test('connected BFF forwards only the owner answer to a door grant',async()=>{
  const inputs=[];
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{grant:async(_request,value)=>{inputs.push(value);return {requirementKey:'metered_fetch',persistedToAgent:false};}},fetcher:()=>assert.fail('grant must go through the development host')});
  const request=body=>new Request(frontendOrigin+'/api/dev/grant',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await handle(request({requirementKey:'metered_fetch'}))).status,400);
  assert.equal((await handle(request({requirementKey:'metered_fetch',persistToAgent:'no'}))).status,400);
  assert.equal((await handle(request({requirementKey:'metered_fetch',persistToAgent:false,resolvedId:'x'}))).status,400);
  assert.equal(inputs.length,0);
  const response=await handle(request({requirementKey:'metered_fetch',persistToAgent:false}));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{data:{requirementKey:'metered_fetch',persistedToAgent:false}});
  assert.deepEqual(inputs,[{requirementKey:'metered_fetch',persistToAgent:false}]);
  const refused=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{grant:async()=>{throw refuse('That door is not one this gadget declared.','not_declared');}}});
  const failed=await refused(request({requirementKey:'email',persistToAgent:false}));
  assert.equal(failed.status,409);
  assert.deepEqual((await failed.json()).error,{message:'That door is not one this gadget declared.',code:'not_declared',certainty:'refused'});
  // An unclassified throw may follow a saved grant: never a 409 refusal.
  const lost=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{grant:async()=>{throw new Error('The upstream response was lost.');}}});
  const unknown=await lost(request({requirementKey:'metered_fetch',persistToAgent:false}));
  assert.equal(unknown.status,502);
  assert.deepEqual((await unknown.json()).error,{message:'The upstream response was lost.',certainty:'unknown'});
});
test('connected BFF admits only a connection listing or one account choice',async()=>{
  const inputs=[];
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{connections:async(_request,value)=>{inputs.push(value);return value.operation==='list'?{families:[]}:{granted:{requirementKey:'destination:IG_FAVCRM'}};}},fetcher:()=>assert.fail('connections go through the development host')});
  const request=body=>new Request(frontendOrigin+'/api/dev/connections',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
  for(const bad of [{},{operation:'revoke'},{operation:'list',requirementKey:'destination'},{operation:'grant',requirementKey:'destination'},{operation:'grant',requirementKey:'destination',resolvedId:7},{operation:'grant',requirementKey:'destination',resolvedId:'crb_1',resolvedLabel:'x'}])
    assert.equal((await handle(request(bad))).status,400);
  assert.equal(inputs.length,0);
  assert.deepEqual(await (await handle(request({operation:'list'}))).json(),{data:{families:[]}});
  assert.equal((await handle(request({operation:'grant',requirementKey:'destination',resolvedId:'crb_1'}))).status,200);
  assert.deepEqual(inputs,[{operation:'list'},{operation:'grant',requirementKey:'destination',resolvedId:'crb_1'}]);
});
