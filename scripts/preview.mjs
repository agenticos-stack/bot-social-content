// Local renderer of the built artifact. No platform credentials or live doors.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { readBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createSocialRuntime, browserBridge } from './local-runtime.mjs';
import { prepareLocalState } from './local-state.mjs';
import { createConnectedApi } from './connected-api.mjs';
import { SOCIAL_LOCALIZATION_DEFINITION } from '../definition.ts';
import { createDevelopmentSessions } from './development-session.mjs';
import { createConnectedAgent, socialMethodNames, sourceDigest } from './connected-agent.mjs';
import { buildClient } from './client.mjs';
import { connectedCanvasBridge } from './connected-canvas.mjs';
import { assertGadgetDevWorkspaceId, assertRemoteApiOrigin } from './platform-origin.mjs';
import { describeExpiry, mintGadgetDevSession, readDeveloperKey } from './gadget-dev-mint.mjs';

const port = Number(process.env.SOCIAL_CONTENT_PREVIEW_PORT || 17920);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose an explicit unprivileged preview port.");
const mode = process.env.SOCIAL_CONTENT_PREVIEW_MODE || 'fixture';
const connectedModes = new Set(['connected', 'connected-prod']);
/**
 * Read the gadget's source as the platform will see it.
 *
 * Extracted so a reload rebuilds by exactly the same rule as the first build.
 * A watcher that assembles the archive a second, slightly different way is a
 * watcher that serves code the first path would have rejected.
 */
/**
 * Watch the files `readSourceFiles` reads, and nothing else.
 *
 * `recursive` is used for `src/` because a gadget's sources sit directly in
 * it; a watcher that misses a rename would serve stale code and blame the
 * developer's editor. Failures to watch are reported rather than thrown — a
 * preview that runs without hot reload is far better than one that will not
 * start because a directory is missing.
 */
function watchSource(onChange) {
  const watchers = [];
  for (const target of [new URL('../src/', import.meta.url), new URL('../definition.ts', import.meta.url)]) {
    try {
      watchers.push(watch(fileURLToPath(target), { recursive: target.href.endsWith('/') }, onChange));
    } catch (error) {
      console.warn(`not watching ${target.pathname}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return watchers;
}

async function readSourceFiles() {
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  const files={};
  for(const name of manifest.files){
    if(!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name) || Object.hasOwn(files,name))throw new Error('Invalid source file.');
    files[name]=name==='client.js'?await buildClient():await readFile(new URL('../src/'+name,import.meta.url),'utf8');
  }
  return files;
}

let archive;
if (connectedModes.has(mode)) {
  archive={files:await readSourceFiles()};
} else {
  const bytes = await readFile(new URL("../dist/social-content.gadget", import.meta.url));
  archive = await readBlueprintArchive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const fixture = await readFile(new URL("../test/preview-fixture.js", import.meta.url), "utf8");
const canvasCss = await readFile(new URL('../preview/canvas.css', import.meta.url), 'utf8');
const overlay = process.env.BOT_SDK_SOURCE;
if (!['fixture', 'local-runtime', 'connected', 'connected-prod'].includes(mode)) throw new Error('Unknown preview mode');
const frontendOrigin = process.env.SOCIAL_CONTENT_FRONTEND_ORIGIN;
const apiOrigin=process.env.SOCIAL_CONTENT_API_ORIGIN || process.env.AGENTICOS_API_ORIGIN;
const remote = mode === 'connected-prod';
// A developer key mints the session here; a token and workspace id pasted from
// a browser remain supported for a one-off. Exactly one of the two, because a
// key silently overriding a pasted pair would connect to a workspace the
// operator did not name.
// `bot-dev dev` mints the session and passes it in the child environment under
// generic names, because a host consumes a session it did not mint and naming
// the variables after this gadget would make every gadget invent its own
// spelling of the same three facts. The SOCIAL_CONTENT_* names remain for a
// host started by hand.
const developerKey = remote ? readDeveloperKey(process.env.SOCIAL_CONTENT_DEV_KEY) : null;
let devToken = remote
  ? (process.env.AGENTICOS_GADGET_DEV_TOKEN || process.env.SOCIAL_CONTENT_DEV_TOKEN || '').trim()
  : '';
let devWorkspaceId = remote
  ? (process.env.AGENTICOS_GADGET_DEV_WORKSPACE_ID || process.env.SOCIAL_CONTENT_DEV_WORKSPACE_ID || '').trim()
  : '';
if (remote) {
  assertRemoteApiOrigin(apiOrigin);
  if (developerKey) {
    if (devToken || devWorkspaceId) throw new Error('Set SOCIAL_CONTENT_DEV_KEY or SOCIAL_CONTENT_DEV_TOKEN/SOCIAL_CONTENT_DEV_WORKSPACE_ID, not both.');
    const minted = await mintGadgetDevSession({
      apiOrigin,
      developerKey,
      gadgetKey: SOCIAL_LOCALIZATION_DEFINITION.key,
      title: SOCIAL_LOCALIZATION_DEFINITION.title
    });
    devToken = minted.devToken;
    devWorkspaceId = minted.workspaceId;
    // The workspace id is a room the operator can open and archive; the token
    // is a credential and is never printed.
    console.log(`gadget-dev session ${devWorkspaceId} on ${apiOrigin}, valid until ${describeExpiry(minted.expiresAtMs)}`);
  } else if (!devToken) {
    throw new Error('Set SOCIAL_CONTENT_DEV_KEY to a personal access token with the gadget_dev.session scope, or SOCIAL_CONTENT_DEV_TOKEN to a token already minted.');
  }
  assertGadgetDevWorkspaceId(devWorkspaceId);
}
/**
 * Which methods this gadget calls on each door.
 *
 * Read off `src/doors.js` rather than invented: these are exactly the calls
 * the gadget makes, so a door appears in `env` with the surface the source
 * actually uses. The platform decides whether any of them may proceed — this
 * only names them, the way DOOR_SPEC does for an installed gadget.
 */
function doorMethodsByEnvKey() {
  return {
    social: ["createDraft", "submitForReview", "readStatus"],
    schedule: ["create", "list", "cancel"],
    workspace: ["notify"],
    metered_fetch: ["socialPostsForAccount"]
  };
}

const connectedSourceHash = connectedModes.has(mode) ? sourceDigest(archive.files) : null;
const development=connectedModes.has(mode)?createDevelopmentSessions({appKey:SOCIAL_LOCALIZATION_DEFINITION.key,origin:frontendOrigin,
  async authenticate(request){
    if (remote) return {userId:'gadget-dev',orgId:devWorkspaceId,devToken};
    const headers={cookie:request.headers.get('cookie') || '',accept:'application/json'};
    const get=async path=>{const result=await fetch(apiOrigin+path,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});if(!result.ok)throw new Error('Local authentication failed');return result.json();};
    const session=await get('/api/auth/get-session');
    if(!session?.user?.id)return null;
    const shell=await get('/v1/studio/shell');
    return {userId:session.user.id,orgId:shell.data?.activeOrg?.id,cookie:headers.cookie};
  },
  async createRuntime(key, identity){
    const root=new URL('../.bot-local/connected/',import.meta.url);
    await mkdir(root,{recursive:true,mode:0o700});
    /*
     * The agent and the isolate get SIBLING directories, never the same one.
     *
     * The testkit claims its state directory by creating it and writing a
     * `.bot-state` marker, and refuses a directory that already exists without
     * one — that is what stops it adopting a directory it does not own. But
     * the agent is started first (deliberately: the door spec shapes `env` at
     * load), and `createConnectedAgent` does `mkdir(stateDirectory, {
     * recursive: true })` to store its session file. Sharing one path meant
     * the agent always created it first, unmarked, so every connected run
     * failed with "Refusing an unowned or symlinked local state directory" —
     * reported, like every other startup failure here, as a generic 409.
     *
     * A child directory does not help either: `recursive: true` creates the
     * parent on the way down. They have to be siblings.
     */
    const sessionRoot=fileURLToPath(new URL(key,root));
    await mkdir(sessionRoot,{recursive:true,mode:0o700});
    const agentStateDirectory=resolve(sessionRoot,'agent');
    const stateDirectory=resolve(sessionRoot,'runtime');
    const prior=new Map(signals.map(signal=>[signal,new Set(process.listeners(signal))]));
    let local;
    // The agent comes FIRST, and the isolate second, because the door spec
    // shapes `env` at load time and only the platform knows which doors this
    // conversation was actually granted. `callLocal` therefore waits on the
    // isolate rather than capturing it: registration happens immediately, but
    // the platform cannot call the gadget until the runtime it calls exists.
    // Both are reassigned by a reload: the gate is replaced before the old
    // isolate is disposed, so a call that arrives mid-swap queues on the NEW
    // promise instead of reaching a runtime that is going away.
    let readyLocal;
    let localReady = new Promise((resolve) => { readyLocal = resolve; });
    try {
      const agent=await createConnectedAgent({apiOrigin,frontendOrigin,cookie:identity.cookie,devToken:identity.devToken,workspaceId:devWorkspaceId,stateDirectory:agentStateDirectory,title:SOCIAL_LOCALIZATION_DEFINITION.title,sourceHash:connectedSourceHash,methods:socialMethodNames(),requirements:SOCIAL_LOCALIZATION_DEFINITION.requirements,callLocal:async(method,args)=>{
        await localReady;
        const result=await local.handle(new Request('http://127.0.0.1/local-rpc',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json','x-bot-local-session':local.token},body:JSON.stringify({method,args}),duplex:'half'}));
        const payload=await result.json();
        if(!result.ok||!payload.ok)throw new Error(payload.error?.message||'The local source call failed.');
        return payload.value;
      }});
      // Only granted doors appear, so an ungranted one is absent from `env` —
      // the same absence an installed gadget sees, which is what lets the
      // gadget read a missing door as configuration rather than failure.
      const doors = await agent.doors(doorMethodsByEnvKey()).catch(() => null);
      // `doors` is null when the owner has granted none, and the testkit rejects a
      // null where it accepts an absence — so a workspace with no doors could not
      // start its runtime at all, and the preview reported that as a generic 409.
      // Absence is the documented, supported state; pass it as one.
      const startRuntime=(files)=>createSocialRuntime({files,sdkSource:overlay,origins:[frontendOrigin],stateDirectory,doors:doors ?? undefined});
      local=await startRuntime(archive.files);
      readyLocal();

      /**
       * Hot reload: new source becomes the live source without a restart.
       *
       * Three things make this cheap rather than delicate, and each is a
       * property something else already guarantees:
       *
       *  - `registerDevelopmentGadget` is built to be called again. It revokes
       *    the previous binding and mints a fresh `dev:<uuid>` so stale action
       *    arguments cannot resolve to the replacement, which is exactly a
       *    reload's semantics. `agent.reload` uses it, so the socket, the
       *    conversation and the granted doors all survive.
       *  - The isolate's state lives in `stateDirectory`, and the testkit's
       *    `dispose()` releases its lock while leaving the `.bot-state` marker
       *    and the SQLite file in place. So the runtime is swapped and the
       *    gadget's data persists — a reload is not a reset.
       *  - `doors` is resolved once and reused, because a grant is the owner's
       *    and does not change when a file does. Re-asking would make every
       *    save a round trip for an answer nobody changed.
       *
       * What it must NOT do is let a call reach a disposed runtime. `callLocal`
       * awaits `localReady`, so each reload replaces that gate with a fresh
       * unresolved promise BEFORE disposing, and resolves it after the new
       * isolate exists. In-flight callers queue rather than fault.
       */
      let reloading=Promise.resolve();
      let lastHash=connectedSourceHash;
      const reload=async()=>{
        let files;
        try { files=await readSourceFiles(); }
        catch (error) { console.error(`reload skipped, source did not build: ${error instanceof Error?error.message:error}`); return; }
        const nextHash=sourceDigest(files);
        // An editor that saves a file it did not change should cost nothing.
        if(nextHash===lastHash) return;
        const gate=new Promise((resolve)=>{ readyLocal=resolve; });
        const previous=local;
        const previousReady=localReady;
        localReady=gate;
        try {
          await previousReady;            // let in-flight calls finish on the old isolate
          await previous.dispose();       // releases the state lock; data stays
          local=await startRuntime(files);
          await agent.reload({sourceHash:nextHash,methods:socialMethodNames(),requirements:SOCIAL_LOCALIZATION_DEFINITION.requirements});
          lastHash=nextHash;
          archive={files};
          console.log(`reloaded ${nextHash.slice(0,12)} — ${Object.keys(files).length} files`);
        } catch (error) {
          console.error(`reload failed: ${error instanceof Error?error.message:error}`);
        } finally { readyLocal(); }
      };
      // Serialised and debounced: two saves in quick succession are one
      // reload, and two reloads never overlap on one state directory.
      let pending;
      const scheduleReload=()=>{
        clearTimeout(pending);
        pending=setTimeout(()=>{ reloading=reloading.then(reload,reload); },150);
      };
      const watchers=watchSource(scheduleReload);
      if (doors) console.log(`doors reachable from local source: ${Object.keys(doors.spec).join(', ')}`);
      // `local` is read through a getter: a reload replaces the binding, and a
      // holder of this object must reach the CURRENT isolate, not the one that
      // existed when it was handed over.
      return {
        get token(){ return local.token; },
        handle:(request)=>local.handle(request),
        agent,
        dispose:async()=>{
          for (const watcher of watchers) watcher.close();
          agent.close();
          await local.dispose();
        }
      };
    }
    catch (error) { await local?.dispose().catch(() => undefined); throw error; }
    finally{for(const signal of signals)for(const listener of process.listeners(signal))if(!prior.get(signal).has(listener)&&['onSignalInt','onSignalTerm'].includes(listener.name))process.removeListener(signal,listener);}
  }
}):null;
const connected = connectedModes.has(mode) ? createConnectedApi({apiOrigin, frontendOrigin, development, platform: remote ? 'remote' : 'local'}) : null;
const tokensCss = await readFile(overlay ? resolve(overlay, 'packages/shell/tokens.css') : fileURLToPath(import.meta.resolve('@agenticos-dev/bot-shell/tokens.css')), 'utf8');
// Same pinned families as Studio. Embedded locally; no third-party font requests.
const fontFaces = await Promise.all([
  ['geist', 'Geist Variable', '100 900'],
  ['plus-jakarta-sans', 'Plus Jakarta Sans Variable', '200 800']
].map(async ([name, family, weight]) => {
  const bytes = await readFile(fileURLToPath(import.meta.resolve(`@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`)));
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')}`;
}));
const brandCss = fontFaces.join('\n') + `\n@font-face{font-family:"CJK Sans Fallback";src:local("PingFang HK"),local("PingFang TC"),local("Noto Sans CJK HK"),local("Noto Sans HK"),local("Microsoft JhengHei"),local("Hiragino Sans CNS");size-adjust:100%}`;
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../preview/main.js', import.meta.url))], bundle: true,
  write: false, format: 'esm', platform: 'browser', conditions: ['browser', 'svelte'],
  alias: overlay ? { '@agenticos-dev/bot-shell/GadgetSplitView.svelte': resolve(overlay, 'packages/shell/GadgetSplitView.svelte') } : {},
  plugins: [{ name: 'svelte', setup(builder) { builder.onLoad({ filter: /\.svelte$/ }, async ({path}) => ({
    contents: compile(await readFile(path, 'utf8'), { filename: path, generate: 'client', css: 'injected' }).js.code,
    loader: 'js', resolveDir: fileURLToPath(new URL('../preview/', import.meta.url))
  })); } }]
});
const signals = ['SIGINT', 'SIGTERM'];
const priorSignalListeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
const runtime = mode === 'local-runtime' ? await createSocialRuntime({ files: archive.files, sdkSource: overlay,
  stateDirectory: await prepareLocalState(),
  origins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`, 'http://social.localhost:18000'] }) : null;
// Pinned Miniflare 4.20260702.0 installs immediate process.exit signal hooks.
// This foreground HTTP host owns graceful shutdown instead. Remove only the
// known hooks installed by this runtime, never pre-existing process listeners.
if (runtime) for (const signal of signals) for (const listener of process.listeners(signal)) {
  if (!priorSignalListeners.get(signal).has(listener) && ['onSignalInt', 'onSignalTerm'].includes(listener.name))
    process.removeListener(signal, listener);
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const nonce = randomBytes(16).toString("base64");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  if(connected && url.pathname==='/dev-canvas' && request.method==='GET'){
    response.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:; img-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`);
    response.setHeader('Content-Type','text/html; charset=utf-8');
    const script=(connectedCanvasBridge(frontendOrigin)+'\n'+archive.files['client.js']).replaceAll('</script','<\\/script');
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${brandCss}\n${tokensCss}\n${canvasCss}</style></head><body><main id="gadget-root"></main><script nonce="${nonce}">${script}</script></body></html>`);return;
  }
  if (connected && url.pathname.startsWith('/api/')) {
    try {
      if (request.headers.host !== new URL(frontendOrigin).host) { response.writeHead(403).end(); return; }
      const result = await connected(new Request(new URL(request.url, frontendOrigin), {
        method: request.method, headers: request.headers,
        ...(!['GET','HEAD'].includes(request.method) ? {body: Readable.toWeb(request), duplex: 'half'} : {})
      }));
      response.statusCode = result.status;
      for (const [key,value] of result.headers) if (key !== 'set-cookie') response.setHeader(key,value);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('Set-Cookie', cookies);
      response.end(await result.text());
    } catch { response.writeHead(502).end(); }
    return;
  }
  if (connected && ['/canvas','/client.js','/fixture.js','/local-rpc'].includes(url.pathname)) { response.writeHead(404).end(); return; }
  if (runtime && url.pathname === '/local-rpc') {
    try {
      const result = await runtime.handle(new Request('http://127.0.0.1/local-rpc', {
        method: request.method, headers: request.headers,
        ...(!['GET','HEAD'].includes(request.method) ? {body: Readable.toWeb(request), duplex: 'half'} : {})
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch { response.writeHead(500, {'Content-Type':'application/json'}).end('{"error":"local_transport_failed"}'); }
    return;
  }
  response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:; img-src blob: data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${url.pathname === '/canvas' ? "'self'" : "'none'"}`);
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (url.pathname === '/workspace.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
  if (url.pathname === "/client.js" || url.pathname === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(url.pathname === "/client.js" ? archive.files["client.js"] : runtime ? browserBridge(runtime.token) : fixture);
    return;
  }
  if (!["/", "/canvas"].includes(url.pathname)) { response.writeHead(404).end(); return; }
  const locale = url.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "en";
  if (runtime || connected) response.setHeader('Content-Security-Policy', response.getHeader('Content-Security-Policy').replace("connect-src 'none'", "connect-src 'self'"));
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === '/') {
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social Content — local workspace</title><style>${brandCss}
${tokensCss}</style></head><body><div id="preview-root" data-mode="${mode}"></div><script nonce="${nonce}" type="module" src="/workspace.js"></script></body></html>`);
    return;
  }
  response.end(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social Content canvas — ${mode} preview</title><style>${brandCss}
${tokensCss}\n${canvasCss}</style></head><body><main id="gadget-root"></main><script nonce="${nonce}" src="/fixture.js"></script><script nonce="${nonce}" src="/client.js"></script></body></html>`);
});
server.listen(port, "127.0.0.1", () => console.log(`${mode} preview: http://127.0.0.1:${port}/ (${remote ? 'gadget-dev token against production API; ticketed agent + local SQLite' : connected ? 'local API authentication; ticketed agent + local SQLite' : runtime ? 'SQLite persists in .bot-local/social-content' : 'in-memory fixture'})`));
server.on('error', async error => { console.error(error.message); await runtime?.dispose(); process.exitCode = 1; });
let stopping = false;
for (const signal of signals) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    try { await runtime?.dispose(); await development?.dispose(); process.exit(0); }
    catch (error) { console.error('Shutdown failed; local state lock retained.', error.message); process.exit(1); }
  });
});
