import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectedApi} from '../scripts/connected-api.mjs';
const frontendOrigin='http://social.localhost:18000';
test('development launch never creates an installed gadget or API conversation',async()=>{
  let calls=0;
  const handle=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin,development:{start:async()=>{calls++;return {mode:'local-source'};}},fetcher:()=>assert.fail('must not call marketplace or conversation API')});
  const request=body=>new Request(frontendOrigin+'/api/dev/session',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await handle(request({orgId:'other'}))).status,400);
  assert.equal(calls,0);
  assert.equal((await handle(request({}))).status,200);
  assert.equal(calls,1);
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
