import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('preview SIGTERM releases state lock and fresh process reads saved draft', {skip:!process.env.BOT_SDK_SOURCE,timeout:20000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'social-preview-lifecycle-'));
  const stateDirectory=join(root,'state');
  const reservation=createServer().listen(0,'127.0.0.1');
  await once(reservation,'listening');
  const port=reservation.address().port;
  await new Promise(r=>reservation.close(r));
  const origin=`http://127.0.0.1:${port}`;
  let child, exited;
  async function start(){
    child=spawn(process.execPath,['--import','tsx','scripts/preview.mjs'],{
      cwd:fileURLToPath(new URL('../',import.meta.url)),
      env:{...process.env,SOCIAL_CONTENT_PREVIEW_MODE:'local-runtime',SOCIAL_CONTENT_PREVIEW_PORT:String(port),SOCIAL_CONTENT_PREVIEW_STATE_DIRECTORY:stateDirectory},
      stdio:['ignore','pipe','pipe']
    });
    exited=once(child,'exit');
    let output='', errors='';
    child.stderr.on('data',chunk=>errors+=chunk);
    let timer;
    try {await Promise.race([
      new Promise(resolve=>child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('local-runtime preview:'))resolve();})),
      exited.then(()=>{throw Error('Preview startup failed: '+errors);}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Preview startup timed out')),7000);})
    ]);} finally {clearTimeout(timer);}
    const source=await(await fetch(origin+'/fixture.js')).text();
    const token=source.match(/'x-bot-local-session':"([a-f0-9]+)"/)[1];
    return async(method,args=[])=>{
      const response=await fetch(origin+'/local-rpc',{method:'POST',headers:{origin,'content-type':'application/json','x-bot-local-session':token},body:JSON.stringify({method,args})});
      assert.equal(response.status,200);
      return (await response.json()).value;
    };
  }
  async function stop(){
    if(!child)return;
    child.kill('SIGTERM');
    const timer=setTimeout(()=>child?.kill('SIGKILL'),5000);
    try {const [code]=await exited;assert.equal(code,0,'Preview must exit gracefully');}
    finally {clearTimeout(timer);child=undefined;}
  }
  try {
    let call=await start();
    const batch=await call('createBatch',[{itemIds:['fixture-0'],destinationBindings:['LOCAL_DRAFT']}]);
    const caption='重新啟動後，這份本機草稿仍然完整保留。';
    assert.equal((await call('saveRevision',[{batchItemId:batch.items[0].id,expectedRevision:0,caption}])).ok,true);
    await stop();
    await assert.rejects(access(stateDirectory+'.lock'));
    call=await start();
    const reopened=await call('getBatch',[batch.id]);
    assert.equal(reopened.items[0].caption,caption);
    assert.equal(reopened.items[0].revision,1);
  } finally {try {await stop();}finally {await rm(root,{recursive:true,force:true});}}
});
