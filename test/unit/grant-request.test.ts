import { describe, expect, it } from "vitest";
import {
  canvasGrantPersistToAgent,
  gadgetGrantResultMessage,
  GRANT_OUTCOMES,
  newGrantRequestId,
  parseGadgetActivateDoorMessage,
  parseGadgetGrantDoorMessage,
  parseGadgetGrantResultMessage
} from "../../src/grant-request.js";

describe("gadget door request contract", () => {
  it("parses a grant request, keeping a well-formed request id and dropping a malformed one", () => {
    expect(parseGadgetGrantDoorMessage({ type: "gadget:grant-door", requirementKey: "metered_fetch", requestId: "abc_123" }))
      .toEqual({ requirementKey: "metered_fetch", requestId: "abc_123" });
    expect(parseGadgetGrantDoorMessage({ type: "gadget:grant-door", requirementKey: "metered_fetch" }))
      .toEqual({ requirementKey: "metered_fetch", requestId: null });
    expect(parseGadgetGrantDoorMessage({ type: "gadget:grant-door", requirementKey: "metered_fetch", requestId: "<script>" }))
      .toEqual({ requirementKey: "metered_fetch", requestId: null });
    expect(parseGadgetGrantDoorMessage({ type: "gadget:grant-door", requirementKey: "Not A Key" })).toBeNull();
  });

  it("requires an id on an activation request", () => {
    expect(parseGadgetActivateDoorMessage({ type: "gadget:activate-door", requirementKey: "metered_fetch", requestId: "r1" }))
      .toEqual({ requirementKey: "metered_fetch", requestId: "r1" });
    expect(parseGadgetActivateDoorMessage({ type: "gadget:activate-door", requirementKey: "metered_fetch" })).toBeNull();
    expect(parseGadgetActivateDoorMessage({ type: "gadget:grant-door", requirementKey: "metered_fetch", requestId: "r1" })).toBeNull();
  });

  it("round-trips every result outcome and refuses an unknown one", () => {
    for (const outcome of GRANT_OUTCOMES) {
      const message = gadgetGrantResultMessage({ requestId: "r1", requirementKey: "metered_fetch", outcome, message: "why" });
      expect(parseGadgetGrantResultMessage(message)).toEqual({ requestId: "r1", requirementKey: "metered_fetch", outcome, message: "why" });
    }
    expect(() => gadgetGrantResultMessage({ requestId: "r1", requirementKey: "metered_fetch", outcome: "granted" })).toThrow();
    expect(parseGadgetGrantResultMessage({ type: "gadget:grant-result", requirementKey: "metered_fetch", outcome: "granted" })).toBeNull();
  });

  it("mints distinct well-formed ids and keeps assistant-wide consent opt-in", () => {
    const a = newGrantRequestId();
    const b = newGrantRequestId();
    expect(a).not.toBe(b);
    expect(parseGadgetActivateDoorMessage({ type: "gadget:activate-door", requirementKey: "social", requestId: a })).not.toBeNull();
    expect(canvasGrantPersistToAgent(undefined)).toBe(false);
    expect(canvasGrantPersistToAgent(true)).toBe(true);
  });
});
