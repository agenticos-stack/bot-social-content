// TASK-202: node unit tests for the pure config helpers `server.js` calls.
// No I/O, like model.js's own tests (PAT-002).
import { describe, expect, it } from "vitest";
import {
  isWithinQuietHours,
  normalizeBindingList,
  normalizeBindingRow,
  normalizeCadence,
  normalizeConfig,
  scheduleStateFrom,
  wallClockHHMM
} from "../../src/config.js";

describe("normalizeBindingRow", () => {
  it("trims and bounds a valid row", () => {
    expect(normalizeBindingRow({ binding: " IG_MAIN ", label: " Main IG ", provider: "instagram" })).toEqual({
      binding: "IG_MAIN",
      label: "Main IG",
      provider: "instagram"
    });
  });

  it("keeps pageId only when present", () => {
    expect(normalizeBindingRow({ binding: "FB_MAIN", label: "Main FB", provider: "facebook", pageId: "123" }).pageId).toBe(
      "123"
    );
    expect(normalizeBindingRow({ binding: "FB_MAIN", label: "Main FB", provider: "facebook" })).not.toHaveProperty(
      "pageId"
    );
  });

  it("throws on a missing binding, label or provider", () => {
    expect(() => normalizeBindingRow({ binding: "", label: "x", provider: "instagram" })).toThrow();
    expect(() => normalizeBindingRow({ binding: "x", label: "", provider: "instagram" })).toThrow();
    expect(() => normalizeBindingRow({ binding: "x", label: "y", provider: "" })).toThrow();
  });
});

describe("normalizeBindingList", () => {
  it("REQ-002: refuses zero rows and more than 20", () => {
    expect(() => normalizeBindingList([], "sources")).toThrow(/1 to 20/);
    const twentyOne = Array.from({ length: 21 }, (_, index) => ({
      binding: `B${index}`,
      label: `Label ${index}`,
      provider: "instagram"
    }));
    expect(() => normalizeBindingList(twentyOne, "sources")).toThrow(/1 to 20/);
  });

  it("accepts 1 to 20 rows", () => {
    const one = normalizeBindingList([{ binding: "B1", label: "L1", provider: "instagram" }], "sources");
    expect(one).toHaveLength(1);
  });

  it("refuses a duplicate binding", () => {
    const rows = [
      { binding: "B1", label: "L1", provider: "instagram" },
      { binding: "B1", label: "L2", provider: "instagram" }
    ];
    expect(() => normalizeBindingList(rows, "sources")).toThrow(/Duplicate/);
  });
});

describe("normalizeCadence", () => {
  it("accepts the client's named cadence strings, filling in a default time and the sibling timezone", () => {
    expect(normalizeCadence("hourly")).toEqual({ kind: "interval", everyMinutes: 60 });
    expect(normalizeCadence("daily", "Asia/Hong_Kong")).toEqual({ kind: "daily", at: "09:00", timezone: "Asia/Hong_Kong" });
    expect(normalizeCadence("weekly", "Asia/Hong_Kong")).toEqual({
      kind: "weekly",
      weekday: 1,
      at: "09:00",
      timezone: "Asia/Hong_Kong"
    });
  });

  it("REQ-012: an interval below the 1-minute floor is refused", () => {
    expect(() => normalizeCadence({ kind: "interval", everyMinutes: 0.5 })).toThrow(/at least/);
  });

  it("accepts a valid interval, rounding to whole minutes", () => {
    expect(normalizeCadence({ kind: "interval", everyMinutes: 60.4 })).toEqual({ kind: "interval", everyMinutes: 60 });
  });

  it("accepts a valid daily cadence", () => {
    expect(normalizeCadence({ kind: "daily", at: "09:30", timezone: "Asia/Hong_Kong" })).toEqual({
      kind: "daily",
      at: "09:30",
      timezone: "Asia/Hong_Kong"
    });
  });

  it("refuses a daily cadence with a malformed time", () => {
    expect(() => normalizeCadence({ kind: "daily", at: "9:30", timezone: "UTC" })).toThrow(/HH:MM/);
  });

  it("accepts a valid weekly cadence", () => {
    expect(normalizeCadence({ kind: "weekly", weekday: 1, at: "08:00", timezone: "UTC" })).toEqual({
      kind: "weekly",
      weekday: 1,
      at: "08:00",
      timezone: "UTC"
    });
  });

  it("refuses an unknown cadence kind", () => {
    expect(() => normalizeCadence({ kind: "monthly" })).toThrow(/interval.*daily.*weekly/);
  });
});

describe("normalizeConfig", () => {
  it("fills in defaults for an empty input", () => {
    const config = normalizeConfig({ cadence: { kind: "interval", everyMinutes: 60 } });
    expect(config.timeZone).toBe("UTC");
    expect(config.rightsPolicy).toBe("require_confirmation");
    expect(config.locale).toEqual({ from: "en", to: "zh-HK" });
    expect(config.notifications).toEqual({ mode: "immediate" });
    expect(config.protectedTerms).toEqual([]);
  });

  it("normalizes protected term lists, both plain strings and {value, allowSubstring}", () => {
    const config = normalizeConfig({
      cadence: { kind: "interval", everyMinutes: 60 },
      protectedTerms: ["Acme", { value: "Acme Pro", allowSubstring: true }]
    });
    expect(config.protectedTerms).toEqual(["Acme", { value: "Acme Pro", allowSubstring: true }]);
  });

  it("keeps a notification mode only from the known set, defaulting otherwise", () => {
    const config = normalizeConfig({ cadence: { kind: "interval", everyMinutes: 60 }, notifications: { mode: "bogus" } });
    expect(config.notifications).toEqual({ mode: "immediate" });
  });

  it("keeps quiet hours only when both times are well-formed", () => {
    const config = normalizeConfig({
      cadence: { kind: "interval", everyMinutes: 60 },
      notifications: { mode: "immediate", quietHours: { start: "22:00", end: "07:00" } }
    });
    expect(config.notifications).toEqual({ mode: "immediate", quietHours: { start: "22:00", end: "07:00" } });
  });

  it("accepts the client's own toConfigPayload shape (src/client/steps.js) with no adapter", () => {
    // Named string cadence, lowercase `timezone`, `sourceLocale`/`targetLocale`,
    // `notificationPolicy`, top-level `quietHours` — cc/social-localization-client PR #1483.
    const config = normalizeConfig({
      cadence: "daily",
      timezone: "Asia/Hong_Kong",
      rightsPolicy: "trust_connected",
      sourceLocale: "en",
      targetLocale: "zh-HK",
      notificationPolicy: "daily",
      quietHours: { start: "22:00", end: "07:00" },
      protectedTerms: [],
      protectedHashtags: [],
      disclaimers: [],
      claimsRequiringConfirmation: []
    });
    expect(config.cadence).toEqual({ kind: "daily", at: "09:00", timezone: "Asia/Hong_Kong" });
    expect(config.timeZone).toBe("Asia/Hong_Kong");
    expect(config.rightsPolicy).toBe("trust_connected");
    expect(config.locale).toEqual({ from: "en", to: "zh-HK" });
    expect(config.notifications).toEqual({ mode: "daily", quietHours: { start: "22:00", end: "07:00" } });
  });

  it("an unrecognised rightsPolicy falls back to the safer require_confirmation default", () => {
    expect(normalizeConfig({ cadence: "hourly", rightsPolicy: "anything_else" }).rightsPolicy).toBe(
      "require_confirmation"
    );
  });
});

describe("isWithinQuietHours", () => {
  it("handles a same-day window", () => {
    expect(isWithinQuietHours({ start: "13:00", end: "17:00" }, "14:00")).toBe(true);
    expect(isWithinQuietHours({ start: "13:00", end: "17:00" }, "18:00")).toBe(false);
  });

  it("handles an overnight window", () => {
    expect(isWithinQuietHours({ start: "22:00", end: "07:00" }, "23:30")).toBe(true);
    expect(isWithinQuietHours({ start: "22:00", end: "07:00" }, "03:00")).toBe(true);
    expect(isWithinQuietHours({ start: "22:00", end: "07:00" }, "12:00")).toBe(false);
  });

  it("is false with no quiet hours configured", () => {
    expect(isWithinQuietHours(undefined, "14:00")).toBe(false);
  });
});

describe("scheduleStateFrom", () => {
  it("unarmed when there is no schedule row", () => {
    expect(scheduleStateFrom(null)).toBe("unarmed");
  });

  // REQ-012: dead is the STORE's terminal state — bounded retries exhausted,
  // never firing again — reported through the schedule door's `status`.
  it("dead when the door reports the schedule as dead", () => {
    expect(scheduleStateFrom({ status: "dead", lastError: "boom" })).toBe("dead");
    expect(scheduleStateFrom({ status: "dead", lastError: null })).toBe("dead");
  });

  // A failed fire is not a dead schedule: the store re-arms and carries on.
  // Calling it dead made a bad afternoon indistinguishable from a schedule
  // that will never run again.
  it("degraded, not dead, when a fire failed but the schedule is still armed", () => {
    expect(scheduleStateFrom({ status: "active", lastError: "boom" })).toBe("degraded");
    expect(scheduleStateFrom({ lastError: "boom" })).toBe("degraded");
  });

  it("passes paused and cancelled through", () => {
    expect(scheduleStateFrom({ status: "paused" })).toBe("paused");
    expect(scheduleStateFrom({ status: "cancelled" })).toBe("cancelled");
  });

  it("active otherwise", () => {
    expect(scheduleStateFrom({ lastError: null })).toBe("active");
    expect(scheduleStateFrom({ status: "active", lastError: null })).toBe("active");
  });
});

describe("wallClockHHMM", () => {
  it("formats an instant in a given IANA timezone as HH:MM", () => {
    // 2026-08-20T09:15:00Z is 17:15 in Asia/Hong_Kong (UTC+8).
    expect(wallClockHHMM("Asia/Hong_Kong", new Date("2026-08-20T09:15:00Z"))).toBe("17:15");
  });

  it("falls back to UTC HH:MM on an unknown timezone rather than throwing", () => {
    expect(wallClockHHMM("Not/A_Zone", new Date("2026-08-20T09:15:00Z"))).toBe("09:15");
  });
});
