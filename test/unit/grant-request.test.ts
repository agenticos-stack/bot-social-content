import { describe, expect, it } from "vitest";
import {
  canvasGrantPersistToAgent,
  consentAllowsFetch,
  parseGadgetGrantDoorMessage
} from "../../src/grant-request.js";

describe("gadget:grant-door is a request, not consent", () => {
  it("accepts a well-formed requirement key", () => {
    expect(parseGadgetGrantDoorMessage({ type: "gadget:grant-door", requirementKey: "metered_fetch" })).toEqual({
      requirementKey: "metered_fetch"
    });
  });

  it("rejects a claimed gesture, persist flag, or other sender-owned consent", () => {
    const parsed = parseGadgetGrantDoorMessage({
      type: "gadget:grant-door",
      requirementKey: "metered_fetch",
      userGesture: true,
      persistToAgent: true
    });
    expect(parsed).toEqual({ requirementKey: "metered_fetch" });
    expect(canvasGrantPersistToAgent(true)).toBe(true);
  });

  it("ignores anything that is not this message", () => {
    expect(parseGadgetGrantDoorMessage({ type: "gadget:console", requirementKey: "metered_fetch" })).toBeNull();
    expect(parseGadgetGrantDoorMessage({ type: "gadget:grant-door", requirementKey: "METERED FETCH" })).toBeNull();
  });
});

describe("canvas persist scope", () => {
  it("is conversation-only unless the owner ticks the explained choice", () => {
    expect(canvasGrantPersistToAgent(undefined)).toBe(false);
    expect(canvasGrantPersistToAgent(false)).toBe(false);
    expect(canvasGrantPersistToAgent(true)).toBe(true);
  });
});

describe("effective fetch consent", () => {
  it("prefers the platform consent projection over a surviving binding stub", () => {
    expect(
      consentAllowsFetch({
        metered_fetch: { socialPostsForAccount: async () => ({}) },
        __consent: { metered_fetch: false }
      })
    ).toBe(false);
    expect(
      consentAllowsFetch({
        metered_fetch: { socialPostsForAccount: async () => ({}) },
        __consent: { metered_fetch: true }
      })
    ).toBe(true);
  });

  it("falls back to stub presence only when no consent projection was minted", () => {
    expect(consentAllowsFetch({ metered_fetch: {} })).toBe(true);
    expect(consentAllowsFetch({})).toBe(false);
  });
});
