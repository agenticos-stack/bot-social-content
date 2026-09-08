// Fixture-only renderer of the built artifact. No API, credentials or live doors.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readBlueprintArchive } from "@agenticos-dev/bot-archive-tools";

const port = Number(process.env.SOCIAL_CONTENT_PREVIEW_PORT || 17920);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose an explicit unprivileged preview port.");
const bytes = await readFile(new URL("../dist/social-content.gadget", import.meta.url));
const archive = await readBlueprintArchive(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const fixture = await readFile(new URL("../test/preview-fixture.js", import.meta.url), "utf8");
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const nonce = randomBytes(16).toString("base64");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (url.pathname === "/client.js" || url.pathname === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(url.pathname === "/client.js" ? archive.files["client.js"] : fixture);
    return;
  }
  if (url.pathname !== "/") { response.writeHead(404).end(); return; }
  const locale = url.searchParams.get("locale") === "zh-HK" ? "zh-HK" : "en";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social Content — fixture preview</title></head><body><aside aria-label="Preview notice">Fixture preview — no live accounts, publishing or saved data.</aside><main id="gadget-root"></main><script nonce="${nonce}" src="/fixture.js"></script><script nonce="${nonce}" src="/client.js"></script></body></html>`);
});
server.listen(port, "127.0.0.1", () => console.log(`Fixture preview: http://127.0.0.1:${port}/ (add ?locale=zh-HK or ?setup=1)`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
