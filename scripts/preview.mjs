// Fixture-only renderer of the built artifact. No API, credentials or live doors.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readBlueprintArchive } from "@agenticos-dev/bot-archive-tools";
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const port = Number(process.env.SOCIAL_CONTENT_PREVIEW_PORT || 17920);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose an explicit unprivileged preview port.");
const bytes = await readFile(new URL("../dist/social-content.gadget", import.meta.url));
const archive = await readBlueprintArchive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const fixture = await readFile(new URL("../test/preview-fixture.js", import.meta.url), "utf8");
const canvasCss = await readFile(new URL('../preview/canvas.css', import.meta.url), 'utf8');
const overlay = process.env.BOT_SDK_SOURCE;
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
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const nonce = randomBytes(16).toString("base64");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src data:; img-src blob: data:; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${url.pathname === '/canvas' ? "'self'" : "'none'"}`);
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (url.pathname === '/workspace.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); return; }
  if (url.pathname === "/client.js" || url.pathname === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(url.pathname === "/client.js" ? archive.files["client.js"] : fixture);
    return;
  }
  if (!["/", "/canvas"].includes(url.pathname)) { response.writeHead(404).end(); return; }
  const locale = url.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "en";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === '/') {
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social Content — local workspace</title><style>${brandCss}
${tokensCss}</style></head><body><div id="preview-root"></div><script nonce="${nonce}" type="module" src="/workspace.js"></script></body></html>`);
    return;
  }
  response.end(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social Content canvas — fixture preview</title><style>${brandCss}
${tokensCss}\n${canvasCss}</style></head><body><main id="gadget-root"></main><script nonce="${nonce}" src="/fixture.js"></script><script nonce="${nonce}" src="/client.js"></script></body></html>`);
});
server.listen(port, "127.0.0.1", () => console.log(`Fixture preview: http://127.0.0.1:${port}/ (add ?locale=zh-HK or ?setup=1)`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
