import { describe, expect, it } from "vitest";

import { generationDisplayStage } from "../../src/model.js";

// Blocker 3: one stage function drives the card chip, card title, drawer
// header and drawer footer. It reads the dispatch receipt, the recorded
// platform outcome and the mark's outstanding needs — never the platform
// action log, which the card cannot reach.
const mark = (dispatch: unknown, needs: unknown = { caption: true, image: true }) =>
  JSON.stringify({ id: "gen_1", base: 0, scope: { caption: true, image: true }, needs, dispatch });

describe("one display stage for card, header and footer", () => {
  it("reads nothing pending as null", () => {
    expect(generationDisplayStage(null)).toBeNull();
    expect(generationDisplayStage(undefined)).toBeNull();
    // A lingered mark with no outstanding needs is completed, not pending.
    expect(generationDisplayStage(mark({ filed: true, actionId: "act_1" }, { caption: false, image: false }))).toBeNull();
  });

  it("reads an unfiled mark as start-unconfirmed", () => {
    expect(generationDisplayStage(mark(undefined))).toBe("start_unconfirmed");
  });

  it("reads filing refusals as their own stages", () => {
    expect(generationDisplayStage(mark({ filed: false, reason: "insufficient_credits" }))).toBe("insufficient_credits");
    expect(generationDisplayStage(mark({ filed: false, reason: "credit_check_unavailable" }))).toBe(
      "credit_check_unavailable"
    );
    expect(generationDisplayStage(mark({ filed: false, reason: "no v2 conversation" }))).toBe("start_failed");
  });

  it("reads a filed request with no outcome as awaiting approval — unless the receipt says approved", () => {
    expect(generationDisplayStage(mark({ filed: true, actionId: "act_1" }))).toBe("awaiting_approval");
    // An auto-approved owner request never reads 等待批核, even before any
    // status read: the room stamps the approval on the receipt at filing.
    expect(generationDisplayStage(mark({ filed: true, actionId: "act_1", approved: true }))).toBe(
      "approved_not_started"
    );
  });

  it("reads a recorded final outcome the same on every surface", () => {
    expect(generationDisplayStage(mark({ filed: true, actionId: "act_1", outcome: { status: "stopped" } }))).toBe(
      "stopped"
    );
    expect(generationDisplayStage(mark({ filed: true, actionId: "act_1", outcome: { status: "refused" } }))).toBe(
      "declined"
    );
    expect(
      generationDisplayStage(mark({ filed: true, actionId: "act_1", outcome: { status: "execution_failed" } }))
    ).toBe("execution_failed");
  });

  it("lets a final outcome win over the approval receipt", () => {
    expect(
      generationDisplayStage(mark({ filed: true, actionId: "act_1", approved: true, outcome: { status: "stopped" } }))
    ).toBe("stopped");
  });

  it("ignores a non-final outcome status", () => {
    expect(generationDisplayStage(mark({ filed: true, actionId: "act_1", outcome: { status: "running" } }))).toBe(
      "awaiting_approval"
    );
  });
});
