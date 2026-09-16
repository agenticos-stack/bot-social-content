import { describe, expect, it } from "vitest";

import {
  createInboxState,
  renderInbox,
  setInboxSourceItems,
  setInboxSummaries
} from "../../src/src/client/inbox.js";
import { findAll, hasClass, installMinimalDom } from "./_helpers/minimal-dom";

// Blocker 3: the card chip and title read the same display stage as the
// drawer header and footer. A stopped turn reads stopped on the card too,
// and an auto-approved owner request never reads 等待批核.
const mark = (dispatch: unknown) =>
  JSON.stringify({ id: "gen_1", base: 0, scope: { caption: true, image: true }, needs: { caption: true, image: true }, dispatch });

function cardText(locale: string, dispatch: unknown) {
  const { document } = installMinimalDom();
  document.documentElement.lang = locale;
  let state = createInboxState();
  state = setInboxSourceItems(state, []);
  state = setInboxSummaries(state, {
    batches: [
      {
        id: "batch_1",
        items: [
          {
            batchItemId: "bi_1",
            itemId: "source_1",
            state: "drafting",
            revision: 0,
            sourceLabel: "Instagram · main",
            provider: "instagram",
            sourceBinding: "IG_MAIN",
            sourceText: "Reference caption",
            caption: null,
            generation: mark(dispatch)
          }
        ]
      }
    ],
    nextCursor: null,
    totals: { batches: 1, items: 1, drafts: 1, review: 0, scheduled: 0, attention: 0 }
  });
  renderInbox(document.body as never, state, {
    locale,
    handlers: { onSelectItem() {}, onInspectBatch() {}, onInboxFilter() {}, onLoadMoreBatches() {} },
    sources: []
  } as never);
  const chips = findAll(document.body as never, (element) => hasClass(element, "sl-chip-attention") || hasClass(element, "sl-chip-queued") || hasClass(element, "sl-chip-submitted"));
  return { text: String((document.body as { textContent?: unknown }).textContent ?? ""), chips: chips.map((chip) => String(chip.textContent ?? "")) };
}

describe("the card chip and title read the display stage", () => {
  for (const locale of ["en", "zh-HK"] as const) {
    it(`[${locale}] never waits for an approval that already ran`, () => {
      const { text, chips } = cardText(locale, { filed: true, actionId: "act_1", source: "host", approved: true });
      expect(text).not.toContain("Awaiting approval");
      expect(text).not.toContain("等待批核");
      expect(chips.join(" ")).toMatch(locale === "en" ? /Approved/ : /已批核/);
    });

    it(`[${locale}] reads a stopped turn as stopped`, () => {
      const { text, chips } = cardText(locale, {
        filed: true,
        actionId: "act_1",
        source: "host",
        outcome: { status: "stopped", code: "credits_exhausted" }
      });
      expect(text).not.toContain("Awaiting approval");
      expect(text).not.toContain("等待批核");
      expect(text).not.toContain("credits_exhausted");
      expect(chips.join(" ")).toMatch(locale === "en" ? /Stopped/ : /已停止/);
    });

    it(`[${locale}] reads declined and failed turns as ended, not waiting`, () => {
      const declined = cardText(locale, { filed: true, actionId: "act_1", source: "host", outcome: { status: "refused" } });
      expect(declined.text).not.toContain("Awaiting approval");
      expect(declined.text).not.toContain("等待批核");
      const failed = cardText(locale, {
        filed: true,
        actionId: "act_1",
        source: "host",
        outcome: { status: "execution_failed", code: "turn_crashed" }
      });
      expect(failed.text).not.toContain("turn_crashed");
      expect(failed.chips.join(" ")).toMatch(locale === "en" ? /Could not complete/ : /未能完成/);
    });
  }

  it("still waits for a member's genuinely unapproved request", () => {
    const { text } = cardText("en", { filed: true, actionId: "act_1", source: "host" });
    expect(text).toContain("Awaiting approval");
  });
});
