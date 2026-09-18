import { describe, expect, it } from "vitest";
import {
  gadgetAgentIntentMessage,
  gadgetHostFeaturesMessage,
  gadgetTopupMessage,
  gadgetTopupResultMessage,
  newAgentIntentRequestId,
  newTopupRequestId,
  parseGadgetAgentIntentMessage,
  parseGadgetHostFeaturesMessage,
  parseGadgetTopupMessage,
  parseGadgetTopupResultMessage
} from "../../src/agent-intent.js";

const post = { batchId: "batch_1", batchItemId: "bi_1", title: "週末特輯" };
const image = {
  mediaId: "gm_1",
  aspectRatio: "4:5",
  references: "source",
  thumbnail: "data:image/jpeg;base64,AAAAAAAAAAA="
};

describe("gadget:host-features — what the canvas may assume", () => {
  it("round-trips the announced set and drops unknown or malformed keys", () => {
    const message = gadgetHostFeaturesMessage(["agent-intent", "topup"]);
    expect(parseGadgetHostFeaturesMessage(message)).toEqual({ features: new Set(["agent-intent", "topup"]) });
    // An unknown key is not a feature — the canvas must not guess it.
    const mixed = parseGadgetHostFeaturesMessage({ type: "gadget:host-features", features: ["agent-intent", "Bad Key", 42] });
    expect(mixed?.features).toEqual(new Set(["agent-intent"]));
    expect(parseGadgetHostFeaturesMessage({ type: "gadget:host-features" })).toBeNull();
    expect(parseGadgetHostFeaturesMessage({ type: "gadget:topup", features: [] })).toBeNull();
    expect(parseGadgetHostFeaturesMessage(null)).toBeNull();
  });
});

describe("gadget:agent-intent — the ⋯ hand-off", () => {
  it("round-trips the image's full context: post, media, ratio, reference, thumbnail, replies", () => {
    const message = gadgetAgentIntentMessage({
      intent: "image.regenerate",
      post,
      image,
      suggestedReplies: ["Too dark", "太暗了"],
      locale: "zh-HK",
      requestId: "ai_1"
    });
    expect(parseGadgetAgentIntentMessage(message)).toEqual({
      requestId: "ai_1",
      intent: "image.regenerate",
      post,
      image,
      suggestedReplies: ["Too dark", "太暗了"],
      locale: "zh-HK"
    });
  });

  it("refuses an intent that cannot name the image — a half-context is worse than none", () => {
    expect(() => gadgetAgentIntentMessage({ intent: "image.regenerate", post: { batchId: "batch_1" }, image })).toThrow();
    expect(() => gadgetAgentIntentMessage({ intent: "image.regenerate", post, image: { aspectRatio: "wide" } })).toThrow();
    expect(() => gadgetAgentIntentMessage({ intent: "summarise", post, image })).toThrow();
    expect(parseGadgetAgentIntentMessage({ type: "gadget:agent-intent", intent: "image.regenerate", post, image: { aspectRatio: "4:5", references: "maybe" } })).toBeNull();
    expect(parseGadgetAgentIntentMessage({ type: "gadget:topup", intent: "image.regenerate", post, image })).toBeNull();
  });

  it("keeps only data-URL thumbnails and bounds the suggested replies", () => {
    // A blob: URL dies at the sandbox boundary (opaque blob store) — the
    // parser drops it so the card renders without a broken image.
    const blobbed = gadgetAgentIntentMessage({ intent: "image.regenerate", post, image: { ...image, thumbnail: "blob:gm_1" } });
    expect(blobbed.image.thumbnail).toBeNull();
    const crowded = gadgetAgentIntentMessage({
      intent: "image.regenerate", post, image,
      suggestedReplies: ["a", "b", "c", "d", "e", "f", "g", "h", "  ", "x".repeat(300)]
    });
    expect(crowded.suggestedReplies).toHaveLength(6);
    expect(crowded.suggestedReplies.every((reply) => reply.length <= 160)).toBe(true);
  });
});

describe("gadget:topup — the correlated funding ask", () => {
  it("requires the post and a request id, and mints fresh unguessable ones", () => {
    const a = newTopupRequestId();
    expect(a).not.toBe(newTopupRequestId());
    expect(a).not.toBe(newAgentIntentRequestId());
    const message = gadgetTopupMessage({ post, requestId: "tu_1" });
    expect(parseGadgetTopupMessage(message)).toEqual({ requestId: "tu_1", post });
    expect(parseGadgetTopupMessage({ type: "gadget:topup", post })).toBeNull();
    expect(() => gadgetTopupMessage({ post: { batchId: "batch_1" } })).toThrow();
  });

  it("round-trips every outcome and refuses a foreign one", () => {
    for (const outcome of ["topped_up", "cancelled", "unsupported"] as const) {
      const message = gadgetTopupResultMessage({ requestId: "tu_1", outcome });
      expect(parseGadgetTopupResultMessage(message)).toEqual({ requestId: "tu_1", outcome, message: null });
    }
    expect(() => gadgetTopupResultMessage({ requestId: "tu_1", outcome: "paid" })).toThrow();
    expect(parseGadgetTopupResultMessage({ type: "gadget:topup-result", requestId: "tu_1", outcome: "paid" })).toBeNull();
    // A result without the request it answers is dropped — never applied.
    expect(parseGadgetTopupResultMessage({ type: "gadget:topup-result", outcome: "topped_up" })).toBeNull();
  });
});
