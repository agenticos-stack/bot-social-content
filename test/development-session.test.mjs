import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDevelopmentSessions} from '../scripts/development-session.mjs';
test('local sessions resume one runtime, recheck identity and isolate organizations',async()=>{
  let identity={userId:'u1',orgId:'o1'};
  let creates=0,calls=0,disposed=0;
  const session=createDevelopmentSessions({appKey:'test-app',origin:'http://social.localhost:18000',authenticate:async()=>identity,createRuntime:async key=>{
    creates++;assert.match(key,/^[a-f0-9]{64}$/);
    return {token:'host-only',agent:{info:{connected:true,workspaceId:'chat_test'}},handle:async request=>{
      calls++;assert.equal(request.headers.get('cookie'),null);assert.equal(request.headers.get('x-bot-local-session'),'host-only');return Response.json({ok:true});
    },dispose:async()=>{disposed++;}};
  }});
  const request=()=>new Request('http://social.localhost:18000/api/dev/rpc',{method:'POST',body:'{"method":"summary","args":[]}'});
  await assert.rejects(session.call(request()),/Start/);
  const [a,b]=await Promise.all([session.start(request()),session.start(request())]);
  assert.deepEqual(a,b);assert.equal(creates,1);assert.equal(a.agentConnected,true);assert.equal(a.agent.workspaceId,'chat_test');
  await session.call(request());assert.equal(calls,1);
  identity={userId:'u1',orgId:'o2'};
  await assert.rejects(session.call(request()),/switch account/);
  identity=null;
  await assert.rejects(session.call(request()),/Sign in/);
  await session.dispose();assert.equal(disposed,1);
  await assert.rejects(session.start(request()),/closed/);
});

test('agent calls receive the current request cookie, never the one captured at start',async()=>{
  const cookies=[];
  let currentCookie='session=first';
  const session=createDevelopmentSessions({appKey:'test-app',origin:'http://social.localhost:18000',
    authenticate:async request=>({userId:'u1',orgId:'o1',cookie:request.headers.get('cookie')}),
    createRuntime:async()=>({token:'host-only',agent:{
      get info(){return {connected:true,workspaceId:'chat_test',gadgetId:'dev:1',expiresAt:1};},
      handle:async(input,cookie)=>{cookies.push(cookie);return {result:input,agent:{connected:true}};}
    },handle:async()=>Response.json({ok:true}),dispose:async()=>{}})});
  const request=cookie=>new Request('http://social.localhost:18000/api/dev/agent',{method:'POST',headers:{cookie},body:'{"operation":"pending"}'});
  await session.start(request(currentCookie));
  await session.agent(request(currentCookie),{operation:'pending'});
  currentCookie='session=rotated';
  await session.agent(request(currentCookie),{operation:'pending'});
  assert.deepEqual(cookies,['session=first','session=rotated']);
});

test('start() and agent() report the live connection state, not a snapshot from creation',async()=>{
  let connected=true;
  const session=createDevelopmentSessions({appKey:'test-app',origin:'http://social.localhost:18000',
    authenticate:async request=>({userId:'u1',orgId:'o1',cookie:request.headers.get('cookie')}),
    createRuntime:async()=>({token:'host-only',agent:{
      get info(){return {connected,workspaceId:'chat_test',gadgetId:connected?'dev:1':null,expiresAt:connected?1:null};},
      handle:async input=>({result:input,agent:{connected}})
    },handle:async()=>Response.json({ok:true}),dispose:async()=>{}})});
  const request=()=>new Request('http://social.localhost:18000/api/dev/agent',{method:'POST',headers:{cookie:'session=a'},body:'{"operation":"pending"}'});
  const started=await session.start(request());
  assert.equal(started.agentConnected,true);
  connected=false;
  const afterBreak=await session.start(request());
  assert.equal(afterBreak.agentConnected,false);
  assert.equal(afterBreak.agent.gadgetId,null);
});
