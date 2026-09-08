import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { buildPackage } from "../scripts/build.mjs";

test("served preview includes the required mount before loading the real client", { timeout: 10000 }, async () => {
  await buildPackage();
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, SOCIAL_CONTENT_PREVIEW_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let timer;
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => { throw new Error("Preview exited before listening"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Preview startup timed out")), 5000); })
    ]);
    const shell = await fetch(`http://127.0.0.1:${port}/`);
    const shellHtml = await shell.text();
    assert.match(shellHtml, /id="preview-root"/);
    assert.match(shellHtml, /--color-panel: #ffffff/);
    assert.match(shellHtml, /:root\[data-theme='dark'\]/);
    const response = await fetch(`http://127.0.0.1:${port}/canvas?locale=zh-HK`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /--color-panel: #ffffff/);
    assert.match(html, /:root\[data-theme='dark'\]/);
    assert.match(html, /<main id="gadget-root"><\/main>/);
    assert.ok(html.indexOf('id="gadget-root"') < html.indexOf('src="/client.js"'));
    assert.match(html, /lang="zh-HK"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/definition.ts`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status, 405);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    await exited;
  }
});

async function fixture(search = "") {
  const context = { URL, location: { href: `http://127.0.0.1:17920/${search}` } };
  runInNewContext(await readFile(new URL("preview-fixture.js", import.meta.url), "utf8"), context);
  return context.gadget;
}

test("preview fixture supports selection/filtering and explicitly refuses publishing", async () => {
  const gadget = await fixture();
  assert.equal((await gadget.summary()).configured, true);
  assert.equal((await gadget.listItems({ filter: "new" })).items.length, 3);
  await gadget.setSelection("fixture-0", true);
  assert.equal((await gadget.listItems({ filter: "all", query: "brighter" })).items[0].selected, true);
  await gadget.markSeen(["fixture-0"]);
  assert.equal((await gadget.listItems({ filter: "new" })).items.length, 2);
  await assert.rejects(gadget.submitForReview({}), /No live action was performed/);
  await assert.rejects(gadget.setConfig({}), /No live action was performed/);
});

test("setup preview and separate sessions do not persist state", async () => {
  assert.equal((await (await fixture("?setup=1")).summary()).configured, false);
  const first = await fixture();
  await first.setSelection("fixture-0", true);
  const second = await fixture();
  assert.equal((await second.listItems({ filter: "all" })).items[0].selected, false);
});

test("draft fixture simulates a conflict and only saves against its latest revision", async () => {
  const gadget = await fixture("?draft=1&conflict=1");
  assert.equal((await gadget.listBatchSummaries()).batches.length, 1);
  const conflict = await gadget.saveRevision({ batchItemId: "fixture-draft", expectedRevision: 1, caption: "local" });
  assert.equal(conflict.issues[0].code, "revision_conflict");
  const batch = await gadget.getBatch("fixture-batch");
  assert.equal(batch.items[1].revision, 2);
  assert.notEqual(batch.items[1].caption, "local");
  assert.equal((await gadget.saveRevision({ batchItemId: "fixture-draft", expectedRevision: 2, caption: "local" })).revision, 3);
  assert.equal((await gadget.getBatch("fixture-batch")).items[1].caption, "local");
  await assert.rejects(gadget.submitForReview({}), /No live action was performed/);
});
