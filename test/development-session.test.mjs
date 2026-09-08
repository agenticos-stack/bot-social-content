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
