// Local renderer of the built artifact. No platform credentials or live doors.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
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
let archive;
if (connectedModes.has(mode)) {
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  const files={};
  for(const name of manifest.files){
    if(!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name) || Object.hasOwn(files,name))throw new Error('Invalid source file.');
    files[name]=name==='client.js'?await buildClient():await readFile(new URL('../src/'+name,import.meta.url),'utf8');
  }
  archive={files};
} else {
  const bytes = await readFile(new URL("../dist/social-content.gadget", import.meta.url));
  archive = await readBlueprintArchive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const fixture = await readFile(new URL("../test/preview-fixture.js", import.meta.url), "utf8");
const canvasCss = await readFile(new URL('../preview/canvas.css', import.meta.url), 'utf8');
const overlay = process.env.BOT_SDK_SOURCE;
if (!['fixture', 'local-runtime', 'connected', 'connected-prod'].includes(mode)) throw new Error('Unknown preview mode');
const frontendOrigin = process.env.SOCIAL_CONTENT_FRONTEND_ORIGIN;
const apiOrigin=process.env.SOCIAL_CONTENT_API_ORIGIN;
const remote = mode === 'connected-prod';
// A developer key mints the session here; a token and workspace id pasted from
// a browser remain supported for a one-off. Exactly one of the two, because a
// key silently overriding a pasted pair would connect to a workspace the
// operator did not name.
const developerKey = remote ? readDeveloperKey(process.env.SOCIAL_CONTENT_DEV_KEY) : null;
let devToken = remote ? (process.env.SOCIAL_CONTENT_DEV_TOKEN || '').trim() : '';
let devWorkspaceId = remote ? (process.env.SOCIAL_CONTENT_DEV_WORKSPACE_ID || '').trim() : '';
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
    const stateDirectory=fileURLToPath(new URL(key,root));
    const prior=new Map(signals.map(signal=>[signal,new Set(process.listeners(signal))]));
    let local;
    try {
      local=await createSocialRuntime({files:archive.files,sdkSource:overlay,origins:[frontendOrigin],stateDirectory});
      const agent=await createConnectedAgent({apiOrigin,frontendOrigin,cookie:identity.cookie,devToken:identity.devToken,workspaceId:devWorkspaceId,stateDirectory,title:SOCIAL_LOCALIZATION_DEFINITION.title,sourceHash:connectedSourceHash,methods:socialMethodNames(),callLocal:async(method,args)=>{
        const result=await local.handle(new Request('http://127.0.0.1/local-rpc',{method:'POST',headers:{origin:frontendOrigin,'content-type':'application/json','x-bot-local-session':local.token},body:JSON.stringify({method,args}),duplex:'half'}));
        const payload=await result.json();
        if(!result.ok||!payload.ok)throw new Error(payload.error?.message||'The local source call failed.');
        return payload.value;
      }});
      return {...local,agent,dispose:async()=>{agent.close();await local.dispose();}};
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
