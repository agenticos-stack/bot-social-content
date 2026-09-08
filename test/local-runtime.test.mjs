import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSocialRuntime, browserBridge } from '../scripts/local-runtime.mjs';
import { runInNewContext } from 'node:vm';

test('real Social Content SQLite selection and capability refusal', {skip: !process.env.BOT_SDK_SOURCE}, async () => {
  const names = ['server.js','storage.js','model.js','config.js','doors.js'];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL('../src/'+name, import.meta.url), 'utf8')])));
  const origin = 'http://localhost:17921';
  const session = await createSocialRuntime({files, sdkSource: process.env.BOT_SDK_SOURCE, origins:[origin]});
  const call = async (method, args = []) => session.handle(new Request(origin+'/local-rpc', {
    method:'POST', headers:{origin,'content-type':'application/json','x-bot-local-session':session.token},body:JSON.stringify({method,args})
  }));
  try {
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
    runInNewContext(browserBridge(session.token), browser);
    const filtered = await browser.gadget.listItems({filter:'all',query:'no matching source'});
    assert.equal(filtered.items.length, 0);
    assert.equal(messages.at(-1).value.records[0].id, 'fixture-0');
    assert.equal(messages.at(-1).target, origin);
    assert.equal((await browser.gadget.subscribe()).supported, false);
    const batch = await browser.gadget.createBatch({itemIds:['fixture-0'],destinationBindings:['LOCAL_DRAFT']});
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0].rightsStatus, 'pending');
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
    assert.equal(reopened.items[0].rightsStatus, 'pending');
    const duplicate = await browser.gadget.createBatch({itemIds:['fixture-0'],destinationBindings:['LOCAL_DRAFT']});
    assert.equal(duplicate.code, 'duplicate_active');
    assert.equal((await browser.gadget.listBatchSummaries()).batches.length, 1);
    const rights = await browser.gadget.confirmRights({batchItemId,status:'confirmed',by:'local-developer'});
    assert.equal(rights.rightsStatus, 'confirmed');
    await assert.rejects(browser.gadget.submitForReview(), /method_not_admitted/);
    for (const method of ['submitForReview','seedLocal','setConfig','refresh']) assert.equal((await call(method)).status,403);
  } finally { await session.dispose(); }
});
