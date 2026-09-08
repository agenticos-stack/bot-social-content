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
    savePoster: (input) => gadget.savePoster(input),
    confirmRights: (input) => gadget.confirmRights(input),
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
export async function loadMediaAsBlobUrl(rpc, itemId, mediaId, rendition) {
  const parts = [];
  let mime = "application/octet-stream";
  let expectedChunks = 1;
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
    const bytes = page.bytes instanceof Uint8Array ? page.bytes : new Uint8Array(page.bytes || []);
    parts.push(bytes);
    chunk += 1;
  } while (chunk < expectedChunks);
  const blob = new Blob(parts, { type: mime });
  return { url: URL.createObjectURL(blob), mime };
}
