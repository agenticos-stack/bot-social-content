// Social Localization client — the one file that calls the gadget's server.
//
// Every RPC this UI makes goes through here, so a contract change on the
// server side (`format-blueprints/social-localization/server.js`, owned by a
// sibling task) touches this one file rather than every view module that
// happens to need a post. The method list below is this bot's contract; the
// pass-throughs and the chunked-blob mechanics come from
// @agenticos-dev/bot-shell — nothing here decides anything; that is
// `steps.js` and `collection.js`'s job on the data this returns.

import { createRpc as createShellRpc, assembleChunkedBlobUrl } from "@agenticos-dev/bot-shell/client/rpc.js";

/** Wraps the sandbox's `globalThis.gadget` stub. `gadget` is the capnweb RpcStub the host handshake produced — see gadget-sandbox-html.ts. */
export function createRpc(gadget) {
  return createShellRpc(gadget, [
    "summary",
    "setConfig",
    "saveSetup",
    "setMonitoring",
    "refreshGrants",
    "addOpenSource",
    "removeOpenSource",
    "refresh",
    "listItems",
    "getItem",
    "markSeen",
    "setSelection",
    "clearSelection",
    "getMedia",
    // Accepted AI-generated image bytes — the gadget's own store, chunked
    // exactly like getMedia so `loadGeneratedImageAsBlobUrl` assembles them.
    "getGeneratedImage",
    // A JPEG copy of an accepted PNG is a NEW derived asset — accepted bytes
    // are never re-delivered. Accepting it is a separate saveRevision.
    "saveDerivedGeneratedImage",
    "createBatch",
    "getBatch",
    // `itemIds` scopes a re-draft to the named posts; omitted means the
    // legacy batch-wide request (still used by createBatch's first run).
    // `options.needs` ({ image, caption }) asks for one part and keeps the other.
    "requestGeneration",
    // Read-only re-read for uncertain or stale progress. The room answers it
    // with the platform's canonical action state, so the canvas can show what
    // actually happened to a request rather than what it last recorded.
    // Creates nothing, notifies nobody, charges nothing.
    "checkGenerationStatus",
    // Deliver a request that was saved but never submitted. It keeps the
    // existing request identity, scope and instruction snapshot; the host files
    // it through the same governed path, so a second press converges on the one
    // approval instead of creating another.
    "resumeGeneration",
    // Per-post image/caption instructions; null resets a part to the saved default.
    "saveInstructionOverrides",
    "listBatches",
    "listBatchSummaries",
    "saveRevision",
    "saveRevisions",
    // Owner upload: unattributed registration (no generationRequest) then bytes.
    "saveGeneratedImage",
    "deliverGeneratedImage",
    "savePoster",
    "submitForReview",
    "readPublishState",
    "subscribe",
    "exportAs"
  ]);
}

/**
 * Assembles a chunked `getMedia()` response into a Blob URL.
 *
 * SEC-004 / CON-004 bound media to chunked RPC bytes, never a raw provider
 * URL reaching the sandbox — so a `blob:` URL built from what the door
 * handed over is the only address this document is ever allowed to draw
 * from. The caller owns the returned URL and must `URL.revokeObjectURL` it
 * when the preview closes or the item changes.
 *
 * `getMedia` answers an expired/missing source with a value —
 * `{ ok: false, code, message }` — not a rejected promise (server.js's
 * header note: a throw from a facet method breaks the Durable Object's
 * output gate). The shared assembler re-throws it here, at the browser
 * boundary, with `code` attached so a stage chooses its recovery action
 * from `code`, never by reading the message.
 */
export function loadMediaAsBlobUrl(rpc, itemId, mediaId, rendition) {
  return assembleChunkedBlobUrl(
    (chunk) => rpc.getMedia(itemId, mediaId, { rendition, chunk }),
    "This media is not available."
  );
}

/**
 * The generated-image counterpart of `loadMediaAsBlobUrl` — same chunked
 * envelope (`getGeneratedImage` mirrors `getMedia`'s shape), same byte-count
 * check, same caller-owned `blob:` URL contract.
 */
export function loadGeneratedImageAsBlobUrl(rpc, id) {
  return assembleChunkedBlobUrl(
    (chunk) => rpc.getGeneratedImage(id, { chunk }),
    "This image is not available."
  );
}
