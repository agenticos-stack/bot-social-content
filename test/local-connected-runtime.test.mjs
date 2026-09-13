import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createSocialRuntime} from '../scripts/local-runtime.mjs';
import {createConnectedApi} from '../scripts/connected-api.mjs';
import {SOCIAL_DOOR_METHODS} from '../scripts/local-rpc-contract.mjs';

test('connected host: empty setup, fetch, select, save poster and carry now/schedule to the publisher', {skip:!process.env.BOT_SDK_SOURCE}, async()=>{
  // Real gadget, transport and SQLite. Only provider effects are fixtures.
  const {encodeBytes}=await import(pathToFileURL(resolve(process.env.BOT_SDK_SOURCE,'packages/testkit/src/rpc-bytes.js')));
  const files=Object.fromEntries(await Promise.all(['server.js','storage.js','model.js','config.js','doors.js'].map(async name=>[name,await readFile(new URL('../src/'+name,import.meta.url),'utf8')])));
  const origin='http://social.localhost:18000';
  const submitted=[];
  const uploads=[];
  const doors={spec:{...SOCIAL_DOOR_METHODS,TEST_DESTINATION:['describe']},async call(key,method,args){
    if(key==='TEST_DESTINATION' && method==='describe')return {provider:'instagram',role:'destination',resourceLabel:'Test destination'};
    if(key==='schedule' && method==='list')return [];
    if(key==='workspace' && method==='notify')return {ok:true};
    if(key==='metered_fetch' && method==='socialPostsForAccount')return {ok:true,posts:[1,2].map(i=>({pk:String(i),taken_at:1789000000,caption:{text:'Morning light'},url:'https://www.instagram.com/p/test'+i+'/'})),credits:1,miss:false,nextCursor:null};
    if(key==='social' && method==='uploadMedia'){
      uploads.push(Buffer.from(args[0].dataBase64,'base64'));
      return {assetId:'test-asset',url:'https://example.com/test-poster.png'};
    }
    if(key==='social' && method==='createDraft'){
      submitted.push(args[0]);return {postId:'test-post-'+submitted.length,versionId:'test-version-'+submitted.length,contentHash:'test-hash'};
    }
    if(key==='social' && method==='submitForReview')return {refused:true,code:'submission_required',authority:'send'};
    if(key==='social' && method==='readStatus')return {state:'review_requested',targets:[]};
    throw new Error('Unexpected fixture door '+key+'.'+method);
  }};
  const runtime=await createSocialRuntime({files,sdkSource:process.env.BOT_SDK_SOURCE,origins:[origin],doors,seedFixtures:false});
  const bff=createConnectedApi({apiOrigin:'http://127.0.0.1:8789',frontendOrigin:origin,development:{call:request=>runtime.handle(new Request(origin+'/local-rpc',{method:'POST',headers:{origin,'content-type':'application/json','x-bot-local-session':runtime.token},body:request.body,duplex:'half'}))}});
  const call=async(method,args=[])=>{
    const response=await bff(new Request(origin+'/api/dev/rpc',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({method,args:encodeBytes(args)})}));
    assert.equal(response.status,200);
    const value=await response.json();assert.equal(value.ok,true,JSON.stringify(value));
    return value.value;
  };
  try{
    const empty=await call('summary');
    assert.equal(empty.configured,false);assert.equal(empty.counts.total,0);assert.deepEqual(empty.destinations,[]);
    assert.equal((await call('saveSetup',[{cadence:'daily',fetchBudgetCredits:1000}])).configured,true);
    assert.equal((await call('addOpenSource',['https://www.instagram.com/test_reference/'])).ok,true);
    const scan=await call('refresh');assert.equal(scan.new,2);assert.equal(scan.failedSafe,0);
    const items=(await call('listItems',[{filter:'all'}])).items;
    for(const item of items)await call('setSelection',[item.id,true]);
    const batch=await call('createBatch',[{itemIds:items.map(item=>item.id),destinationBindings:[]}]);
    assert.equal((await call('getBatch',[batch.id])).generation,'requested');
    const png=Uint8Array.from({length:100000},(_,i)=>i%251);
    png.set([137,80,78,71,13,10,26,10]);
    new DataView(png.buffer).setUint32(16,1080);new DataView(png.buffer).setUint32(20,1350);
    const intents=[{publishMode:'publish_now'},{publishMode:'schedule',publishLocalTime:'2099-08-01T10:00',timezone:'Asia/Hong_Kong'}];
    for(const [index,item] of batch.items.entries()){
      const saved=await call('saveRevision',[{batchItemId:item.id,expectedRevision:0,caption:'晨光為每天帶來嶄新的開始。',acceptedVisualMode:'text_poster',posterLayout:{template:'1080x1350',headline:'晨光與日常',background:{kind:'solid',value:'#123123'},textColor:'#ffffff',align:'left'},originalMediaRefs:[],publicationIntent:{publishMode:'save_draft'}}]);
      assert.equal(saved.ok,true,JSON.stringify(saved));
      const poster=await call('savePoster',[{batchItemId:item.id,expectedRevision:saved.revision,template:'1080x1350',png}]);
      assert.equal(poster.ok,true,JSON.stringify(poster));
      const filed=await call('submitForReview',[{batchItemId:item.id,expectedRevision:poster.revision,destinationBindings:['TEST_DESTINATION'],intent:intents[index]}]);
      assert.equal(filed.state,'review_requested',JSON.stringify(filed));
      assert.equal(filed.submitted.length,1);
      assert.deepEqual(uploads[index],Buffer.from(png));
      assert.equal(submitted[index].schedule.publishMode,intents[index].publishMode);
      if(index===1)assert.equal(submitted[index].schedule.timezone,'Asia/Hong_Kong');
    }
    assert.equal(submitted.length,2);
  }finally{await runtime.dispose();}
});
