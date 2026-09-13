import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createSocialRuntime} from '../scripts/local-runtime.mjs';
import {createConnectedApi} from '../scripts/connected-api.mjs';
import {SOCIAL_DOOR_METHODS} from '../scripts/local-rpc-contract.mjs';

test('connected host: empty setup, fetch, select, save poster and carry now/schedule to the publisher', {skip:!process.env.BOT_SDK_SOURCE}, async()=>{
  // Real gadget, transport and SQLite. Only provider effects are fixtures.
  const {encodeBytes}=await import(pathToFileURL(resolve(process.env.BOT_SDK_SOURCE,'packages/testkit/src/rpc-bytes.js')));
  // The manifest owns the module list — a gadget source the test forgets to
  // load fails inside the isolate as "No such module", not at the file read.
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  const files=Object.fromEntries(await Promise.all(manifest.files.filter(name=>name.endsWith('.js')&&name!=='client.js').map(async name=>[name,await readFile(new URL('../src/'+name,import.meta.url),'utf8')])));
  const origin='http://social.localhost:18000';
  const submitted=[];
  const uploads=[];
  const doors={spec:{...SOCIAL_DOOR_METHODS,TEST_DESTINATION:['describe']},async call(key,method,args){
    if(key==='TEST_DESTINATION' && method==='describe')return {provider:'instagram',role:'destination',resourceLabel:'Test destination',resolvedId:'crb_test_destination'};
    if(key==='schedule' && method==='list')return [];
    if(key==='workspace' && method==='notify')return {ok:true};
    if(key==='metered_fetch' && method==='socialPostsForAccount')return {ok:true,posts:[1,2].map(i=>({pk:String(i),taken_at:1789000000,caption:{text:'Morning light'},url:'https://www.instagram.com/p/test'+i+'/'})),credits:1,miss:false,nextCursor:null};
    if(key==='social' && method==='uploadMedia'){
      uploads.push({bytes:Buffer.from(args[0].dataBase64,'base64'),mimeType:args[0].mimeType,filename:args[0].filename});
      return {assetId:'test-asset',url:'https://example.com/test-poster.jpg'};
    }
    if(key==='social' && method==='createDraft'){
      submitted.push(args[0]);return {postId:'test-post-'+submitted.length,versionId:'test-version-'+submitted.length,contentHash:'test-hash'};
    }
    if(key==='social' && method==='submitForReview')return {refused:true,code:'submission_required',authority:'send'};
    // The door keys targets by the resource binding id it published to, not
    // the env name the workspace filed under — the readback must map it.
    if(key==='social' && method==='readStatus')return {state:'review_requested',targets:[{destinationBinding:'crb_test_destination',label:'Test destination',outcome:'scheduled',detail:'scheduled'}]};
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
    // The owner-connected destination registers at setup — with the door's
    // describe(), and its resolvedId, stored on the row for later readback.
    const grants=await call('refreshGrants');
    assert.equal(grants.summary.destinations[0]?.binding,'TEST_DESTINATION');
    assert.equal((await call('addOpenSource',['https://www.instagram.com/test_reference/'])).ok,true);
    const scan=await call('refresh');assert.equal(scan.new,2);assert.equal(scan.failedSafe,0);
    const items=(await call('listItems',[{filter:'all'}])).items;
    for(const item of items)await call('setSelection',[item.id,true]);
    const batch=await call('createBatch',[{itemIds:items.map(item=>item.id),destinationBindings:[]}]);
    assert.equal((await call('getBatch',[batch.id])).generation,'requested');
    const png=Uint8Array.from({length:100000},(_,i)=>i%251);
    png.set([137,80,78,71,13,10,26,10]);
    new DataView(png.buffer).setUint32(16,1080);new DataView(png.buffer).setUint32(20,1350);
    // A real JPEG: canvas.toBlob output captured from the connected run —
    // decodable bytes, not a synthetic header, since the fixture is what the
    // publisher's container must accept.
    const jpeg=new Uint8Array(readFileSync(new URL('./fixtures/poster-1080x1350.jpg',import.meta.url)));
    const posters=[{bytes:png,mimeType:'image/png',extension:'png'},{bytes:jpeg,mimeType:'image/jpeg',extension:'jpg'}];
    const intents=[{publishMode:'publish_now'},{publishMode:'schedule',publishLocalTime:'2099-08-01T10:00',timezone:'Asia/Hong_Kong'}];
    for(const [index,item] of batch.items.entries()){
      const saved=await call('saveRevision',[{batchItemId:item.id,expectedRevision:0,caption:'晨光為每天帶來嶄新的開始。',acceptedVisualMode:'text_poster',posterLayout:{template:'1080x1350',headline:'晨光與日常',background:{kind:'solid',value:'#123123'},textColor:'#ffffff',align:'left'},originalMediaRefs:[],publicationIntent:{publishMode:'save_draft'}}]);
      assert.equal(saved.ok,true,JSON.stringify(saved));
      let poster=await call('savePoster',[{batchItemId:item.id,expectedRevision:saved.revision,template:'1080x1350',png:posters[index].bytes}]);
      assert.equal(poster.ok,true,JSON.stringify(poster));
      if(index===0){
        // A PNG draft on an Instagram destination refuses at submit — the
        // provider's container would otherwise hold it at media_not_ready —
        // and the recovery is a fresh JPEG render saved over it.
        const refused=await call('submitForReview',[{batchItemId:item.id,expectedRevision:poster.revision,destinationBindings:['TEST_DESTINATION'],intent:intents[index]}]);
        assert.equal(refused.ok,false,JSON.stringify(refused));
        assert.equal(refused.code,'poster_format_stale');
        posters[0]={bytes:jpeg,mimeType:'image/jpeg',extension:'jpg'};
        poster=await call('savePoster',[{batchItemId:item.id,expectedRevision:poster.revision,template:'1080x1350',png:jpeg}]);
        assert.equal(poster.ok,true,JSON.stringify(poster));
      }
      const filed=await call('submitForReview',[{batchItemId:item.id,expectedRevision:poster.revision,destinationBindings:['TEST_DESTINATION'],intent:intents[index]}]);
      assert.equal(filed.state,'review_requested',JSON.stringify(filed));
      assert.equal(filed.submitted.length,1);
      const publish=await call('readPublishState',[item.id]);
      assert.equal(publish.targets[0]?.destinationBinding,'TEST_DESTINATION');
      assert.equal(publish.targets[0]?.outcome,'scheduled');
      // The stored bytes ship verbatim; the mime the door heard is the one
      // the bytes actually carry — JPEG is what an Instagram container takes.
      assert.deepEqual(uploads[index].bytes,Buffer.from(posters[index].bytes));
      assert.equal(uploads[index].mimeType,posters[index].mimeType);
      assert.equal(uploads[index].filename?.endsWith('.'+posters[index].extension),true);
      assert.equal(submitted[index].schedule.publishMode,intents[index].publishMode);
      // The env name is the local handle; createDraft is addressed by the
      // connector resource binding id the door's describe() resolved.
      assert.deepEqual(submitted[index].targets,[{destinationBinding:'crb_test_destination'}]);
      // GUD-005: the provider holds media filed with no alt text — the filed
      // asset carries the poster's rendered copy plus its real metadata.
      const filedMedia=submitted[index].media?.[0];
      assert.equal(filedMedia?.altText,'Poster: 晨光與日常');
      assert.equal(filedMedia?.mimeType,posters[index].mimeType);
      assert.equal(filedMedia?.byteSize,posters[index].bytes.byteLength);
      assert.deepEqual([filedMedia?.width,filedMedia?.height],[1080,1350]);
      if(index===1)assert.equal(submitted[index].schedule.timezone,'Asia/Hong_Kong');
    }
    assert.equal(submitted.length,2);
  }finally{await runtime.dispose();}
});
