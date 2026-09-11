// Social Localization client — the one file that calls the gadget's server.
//
// Every RPC this UI makes goes through here, so a contract change on the
// server side (`format-blueprints/social-localization/server.js`, owned by a
// sibling task) touches this one file rather than every view module that
// happens to need a post. Each export is a thin pass-through to
// `globalThis.gadget.<method>` — nothing here decides anything; that is
// `steps.js` and `collection.js`'s job on the data this returns.

/** Wraps the sandbox's `globalThis.gadget` stub. `gadget` is the capnweb RpcStub the host handshake produced — see gadget-sandbox-html.ts. */
export function createRpc(gadget) {
  if (!gadget) throw new Error("createRpc requires the sandboxed gadget stub.");
  return {
    summary: () => gadget.summary(),
    setConfig: (config) => gadget.setConfig(config),
    saveSetup: (config) => gadget.saveSetup(config),
    setMonitoring: (enabled) => gadget.setMonitoring(enabled),
    refreshGrants: () => gadget.refreshGrants(),
    addOpenSource: (link) => gadget.addOpenSource(link),
    removeOpenSource: (binding) => gadget.removeOpenSource(binding),
    refresh: () => gadget.refresh(),
    listItems: (params) => gadget.listItems(params),
    getItem: (id) => gadget.getItem(id),
    markSeen: (ids) => gadget.markSeen(ids),
    setSelection: (id, selected) => gadget.setSelection(id, selected),
    clearSelection: () => gadget.clearSelection(),
    getMedia: (itemId, mediaId, options) => gadget.getMedia(itemId, mediaId, options),
    createBatch: (input) => gadget.createBatch(input),
    getBatch: (batchId) => gadget.getBatch(batchId),
    listBatches: () => gadget.listBatches(),
    listBatchSummaries: (params) => gadget.listBatchSummaries(params),
    saveRevision: (input) => gadget.saveRevision(input),
    saveRevisions: (input) => gadget.saveRevisions(input),
    savePoster: (input) => gadget.savePoster(input),
    submitForReview: (input) => gadget.submitForReview(input),
    readPublishState: (batchItemId) => gadget.readPublishState(batchItemId),
    subscribe: (target, client) => gadget.subscribe(target, client),
    exportAs: (format) => gadget.exportAs(format)
  };
}

/**
 * Assembles a chunked `getMedia()` response into a Blob URL.
 *
 * SEC-004 / CON-004 bound media to chunked RPC bytes, never a raw provider
 * URL reaching the sandbox — so a `blob:` URL built from what the door
 * handed over is the only address this document is ever allowed to draw
 * from. The caller owns the returned URL and must `URL.revokeObjectURL` it
 * when the preview closes or the item changes.
 */
/**
 * One chunk's bytes, in whichever shape they survived the trip.
 *
 * `new Uint8Array(value)` on a plain object silently yields an EMPTY array
 * rather than failing, so a Buffer that crossed as `{ type: "Buffer", data:
 * [...] }` produced an empty blob and a broken image — with nothing anywhere
 * saying the bytes had been lost. `server.js`'s `toBytes` has the same problem
 * and the same fix on the other side of the RPC; both are needed, because the
 * bytes cross two boundaries and each one can flatten them.
 */
function chunkBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (!value || typeof value !== "object") return new Uint8Array(0);
  // A Node Buffer that was serialised: `{ type: "Buffer", data: [...] }`.
  if (Array.isArray(value.data)) return new Uint8Array(value.data);
  /*
   * A `Uint8Array` that was serialised.
   *
   * JSON has no typed arrays, so one arrives as a plain object keyed by index
   * — `{"0":137,"1":80,...}` — with no `length` and no `data`. `new
   * Uint8Array(thatObject)` yields an EMPTY array rather than failing, so the
   * blob came out zero bytes and the image was simply broken, with nothing
   * anywhere reporting that the bytes had been dropped.
   *
   * Read by index up to the count of keys rather than by `Object.values`,
   * because key order is not part of the contract.
   */
  const length = Object.keys(value).length;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const byte = value[index];
    if (typeof byte !== "number") return new Uint8Array(0);
    bytes[index] = byte;
  }
  return bytes;
}

export async function loadMediaAsBlobUrl(rpc, itemId, mediaId, rendition) {
  const parts = [];
  let mime = "application/octet-stream";
  let expectedChunks = 1;
  let expectedTotal = null;
  let chunk = 0;
  do {
    const page = await rpc.getMedia(itemId, mediaId, { rendition, chunk });
    if (!page) break;
    // `getMedia` answers an expired/missing source with a value —
    // `{ ok: false, code, message }` — not a rejected promise (server.js's
    // header note: a throw from a facet method breaks the Durable Object's
    // output gate). Re-thrown here, at the browser boundary, so the
    // existing `.catch()` callers keep working unchanged.
    if (page.ok === false) throw new Error(page.message || "This media is not available.");
    if (page.mime) mime = page.mime;
    if (typeof page.chunks === "number" && page.chunks > 0) expectedChunks = page.chunks;
    if (typeof page.total === "number" && expectedTotal === null) expectedTotal = page.total;
    const bytes = chunkBytes(page.bytes);
    parts.push(bytes);
    chunk += 1;
  } while (chunk < expectedChunks);
  /*
   * COUNT WHAT ARRIVED against what the server said it was sending.
   *
   * Every way these bytes can be lost loses them quietly: a shape `chunkBytes`
   * cannot read yields an empty array, a dropped chunk simply is not there,
   * and `new Blob()` accepts all of it without complaint. The caller then gets
   * a perfectly valid `blob:` URL for a broken picture, which renders as
   * nothing at all — indistinguishable from a post that has no media. Both of
   * this file's byte-shape bugs reached a screen that way before anything
   * reported them.
   *
   * `total` is the server's own count of the bytes for this rendition, so a
   * mismatch is a transport fault, not a missing source, and it says so.
   */
  const assembled = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (expectedTotal !== null && assembled !== expectedTotal) {
    throw new Error(`This media arrived as ${assembled} of ${expectedTotal} bytes.`);
  }
  const blob = new Blob(parts, { type: mime });
  // `total` travels with the URL because the drawer states the size of the
  // frame an owner is looking at, and this is the only place that knows it.
  return { url: URL.createObjectURL(blob), mime, total: assembled };
}
