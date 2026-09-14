import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocialRuntime, browserBridge } from '../scripts/local-runtime.mjs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('real Social Content SQLite selection and capability refusal', {skip: !process.env.BOT_SDK_SOURCE}, async () => {
  // The manifest owns the module list — a gadget source the test forgets to
  // load fails inside the isolate as "No such module", not at the file read.
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const names = manifest.files.filter(name => name.endsWith('.js') && name !== 'client.js');
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL('../src/'+name, import.meta.url), 'utf8')])));
  const origin = 'http://localhost:17921';
  const root = await mkdtemp(join(tmpdir(),'social-persistence-test-'));
  const options = {files, sdkSource: process.env.BOT_SDK_SOURCE, origins:[origin],stateDirectory:join(root,'state')};
  let session;
  const call = async (method, args = []) => session.handle(new Request(origin+'/local-rpc', {
    method:'POST', headers:{origin,'content-type':'application/json','x-bot-local-session':session.token},body:JSON.stringify({method,args})
  }));
  try {
    session = await createSocialRuntime(options);
    assert.equal((await (await call('summary')).json()).value.configured, true);
    assert.equal((await call('setSelection',['fixture-0',true])).status, 200);
    const rows = (await (await call('listItems',[{filter:'all'}])).json()).value.items;
    assert.equal(rows.length, 3);
    assert.equal(rows.find(row => row.id === 'fixture-0').selected, true);
    const messages = [];
    const browser = {location:{origin}, parent:{postMessage:(value,target)=>messages.push({value,target})},
      fetch: async (url, options) => {
        assert.equal(url, '/local-rpc');
        assert.equal(options.credentials, 'omit');
        return session.handle(new Request(origin+url, {...options,headers:{...options.headers,origin}}));
      }};
    const { DECODE_BYTES_SOURCE } = await import(pathToFileURL(resolve(process.env.BOT_SDK_SOURCE, 'packages/testkit/src/rpc-bytes.js')));
    runInNewContext(browserBridge(session.token, DECODE_BYTES_SOURCE), browser);
    const filtered = await browser.gadget.listItems({filter:'all',query:'no matching source'});
    assert.equal(filtered.items.length, 0);
    assert.equal(messages.at(-1).value.records[0].id, 'fixture-0');
    assert.equal(messages.at(-1).target, origin);
    assert.equal((await browser.gadget.subscribe()).supported, false);
    const batch = await browser.gadget.createBatch({itemIds:['fixture-0'],destinationBindings:['LOCAL_DRAFT']});
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0].state, 'drafting');
    const batchItemId = batch.items[0].id;
    const caption = '每天從美好的早晨開始，探索生活中的精彩時刻。';
    const saved = await browser.gadget.saveRevision({batchItemId,expectedRevision:0,caption});
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.revision, 1);
    const stale = await browser.gadget.saveRevision({batchItemId,expectedRevision:0,caption:'這是過期的修改，不應覆蓋已儲存的文案。'});
    assert.equal(stale.ok, false);
    assert.ok(stale.issues.some(issue => issue.code === 'revision_conflict'));
    const reopened = await browser.gadget.getBatch(batch.id);
    assert.equal(reopened.items[0].caption, caption);
    assert.equal(reopened.items[0].revision, 1);
    const duplicate = await browser.gadget.createBatch({itemIds:['fixture-0'],destinationBindings:['LOCAL_DRAFT']});
    assert.equal(duplicate.code, 'duplicate_active');
    assert.equal((await browser.gadget.listBatchSummaries()).batches.length, 1);
    // submitForReview is admitted so it can refuse by value: with no doors a
    // submission cannot reach a publisher — it answers a refusal, and the item
    // stays in drafting.
    const submit = await browser.gadget.submitForReview({batchItemId, expectedRevision:1, destinationBindings:['LOCAL_DRAFT']});
    assert.equal(submit.ok, false);
    assert.equal(typeof submit.code, 'string');
    for (const method of ['seedLocal','setConfig','refresh']) assert.equal((await call(method)).status,403);
    const previousToken = session.token;
    await session.dispose();
    session = await createSocialRuntime(options);
    // The session token lives beside the SQLite it guards: a restart keeps it,
    // so the browser session the developer was holding stays valid.
    assert.equal(session.token, previousToken);
    const persisted = (await (await call('getBatch',[batch.id])).json()).value;
    assert.equal(persisted.items[0].caption,caption);
    assert.equal(persisted.items[0].revision,1);
    assert.equal((await (await call('listItems',[{filter:'all'}])).json()).value.items.length,3);
    const stillValid = await browser.gadget.summary();
    assert.equal(typeof stillValid.counts.total, 'number');
  } finally { await session?.dispose(); await rm(root,{recursive:true,force:true}); }
});

test('browser bridge carries image bytes to generated and derived image saves', {skip: !process.env.BOT_SDK_SOURCE}, async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const names = manifest.files.filter(name => name.endsWith('.js') && name !== 'client.js');
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL('../src/'+name, import.meta.url), 'utf8')])));
  const origin = 'http://localhost:17921';
  const root = await mkdtemp(join(tmpdir(),'social-bytes-test-'));
  let session;
  try {
    session = await createSocialRuntime({files, sdkSource: process.env.BOT_SDK_SOURCE, origins:[origin], stateDirectory:join(root,'state')});
    const sent = [];
    const browser = {location:{origin}, btoa, parent:{postMessage(){}},
      fetch: async (url, options) => { sent.push(options.body.length); return session.handle(new Request(origin+url, {...options,headers:{...options.headers,origin}})); }};
    const { DECODE_BYTES_SOURCE } = await import(pathToFileURL(resolve(process.env.BOT_SDK_SOURCE, 'packages/testkit/src/rpc-bytes.js')));
    runInNewContext(browserBridge(session.token, DECODE_BYTES_SOURCE), browser);
    const gadget = browser.gadget;
    const created = await gadget.createBatch({itemIds:['fixture-0'], destinationBindings:['LOCAL_DRAFT']});
    const batchId = created.batch?.id ?? created.id ?? created.batchId;
    const item = (await gadget.getBatch(batchId)).items[0];
    const png = new Uint8Array(40 * 1024); png.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    const jpeg = new Uint8Array(20 * 1024); jpeg.set([0xff,0xd8,0xff,0xe0]);
    const registered = await gadget.saveGeneratedImage({batchItemId:item.id, attachmentId:'synthetic', mimeType:'image/png'});
    const delivered = await gadget.deliverGeneratedImage({id:registered.id, bytes:png});
    assert.equal(delivered.ok, true);
    assert.equal(delivered.byteLength, png.byteLength);
    const derived = await gadget.saveDerivedGeneratedImage({sourceMediaId:registered.id, bytes:jpeg, mimeType:'image/jpeg'});
    assert.equal(derived.ok, true, JSON.stringify(derived));
    assert.notEqual(derived.id, registered.id);
    // Base64 is ~1.33x the bytes; an index-keyed object would be several times
    // that, and over the local session's 64 KB request cap.
    assert.ok(Math.max(...sent) < png.byteLength * 1.5, `largest request ${Math.max(...sent)} bytes`);
  } finally {
    await session?.dispose();
    await rm(root, {recursive:true, force:true});
  }
});
