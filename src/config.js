// Social Localization blueprint — pure config normalization and validation.
//
// No I/O, like model.js (PAT-002): `server.js` calls these, and they are
// unit-tested in plain node without a facet. Kept separate from model.js
// because these shapes are about the INSTANCE (cadence, doors, policy), not
// about a provider's post.

const MIN_INTERVAL_MINUTES = 1; // REQ-012: minimum interval 60 s.
const MAX_BINDINGS = 20; // REQ-002: 1 to 20 sources, 1 to 20 destinations.
const MAX_LABEL_CHARS = 100;
const MAX_TERM_LIST = 100;
const MAX_TERM_CHARS = 200;
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const NOTIFICATION_MODES = ["immediate", "daily", "off"];
const DEFAULT_REFINEMENT_BRIEF = Object.freeze({
  version: 1,
  targetLanguage: "zh-HK",
  register: "written",
  tone: "",
  allowedChanges: [],
  protectedTerms: [],
  protectedFacts: [],
  protectedClaims: [],
  callToAction: null,
  visualTreatment: "keep_original"
});

/**
 * What this gadget may spend on metered fetching, per rolling 30 days.
 *
 * IT SHIPS NON-NULL, and that is the whole design. The platform's per-action
 * spend cap was removed in September 2026 after a census found no organisation
 * had ever set one — it defaulted to nothing, so it never decided anything,
 * and deleting it cost nothing. A budget defaulting to null would repeat that
 * exactly.
 *
 * 40,000 credits is about HKD 40. Ten public sources on the default daily
 * cadence is roughly 9,000 credits a month at the measured price, so the
 * default auto-allows ordinary use with about four times the headroom, and
 * trips on ten sources switched to hourly (~215,000). That is the cap doing
 * real work: it separates what an owner meant from what they probably did not.
 *
 * ZERO IS NOT EMPTY. `0` means "spend nothing" and is honoured as a refusal;
 * an ABSENT value means "unset" and takes this default. Collapsing the two
 * would silently disable a gadget an owner thought they had left alone.
 */
const DEFAULT_FETCH_BUDGET_CREDITS = 40_000;
/** `toConfigPayload`'s named cadences, each mapped to the schedule door's `create(hook, cadence)` shape. */
const NAMED_CADENCES = {
  hourly: { kind: "interval", everyMinutes: 60 },
  daily: { kind: "daily", at: "09:00" },
  weekly: { kind: "weekly", weekday: 1, at: "09:00" }
};

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function boundedString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** One `{binding, label, provider, pageId?}` source or destination row. Throws on a genuinely unusable row. */
export function normalizeBindingRow(input) {
  const row = record(input);
  const binding = boundedString(row?.binding, 200);
  const label = boundedString(row?.label, MAX_LABEL_CHARS);
  const provider = boundedString(row?.provider, 40);
  if (!binding || !label || !provider) {
    throw new Error("Each source or destination needs a binding, a label and a provider.");
  }
  const pageId = boundedString(row?.pageId, 200);
  return { binding, label, provider, ...(pageId ? { pageId } : {}) };
}

/** `sources` or `destinations`: 1 to 20 rows (REQ-002), each valid, bindings unique. */
export function normalizeBindingList(input, kind) {
  const list = Array.isArray(input) ? input : [];
  if (list.length < 1 || list.length > MAX_BINDINGS) {
    throw new Error(`An instance needs 1 to ${MAX_BINDINGS} ${kind}.`);
  }
  const normalized = list.map(normalizeBindingRow);
  const seen = new Set();
  for (const row of normalized) {
    if (seen.has(row.binding)) throw new Error(`Duplicate ${kind} binding: ${row.binding}.`);
    seen.add(row.binding);
  }
  return normalized;
}

/**
 * The schedule door's own cadence shape (gatekeeper-kinds.ts
 * `schedule.create`): `{kind:"interval",everyMinutes} | {kind:"daily",at,
 * timezone} | {kind:"weekly",weekday,at,timezone}`.
 *
 * ALSO ACCEPTS THE CLIENT'S NAMED CADENCE. `toConfigPayload` sends `cadence`
 * as a bare string — `"hourly"` / `"daily"` / `"weekly"` — carrying no `at`
 * or `timezone` of its own (`createSetupDraft`'s draft has no time-of-day
 * field). `timeZone` is filled in by `normalizeConfig` from the sibling
 * field; a default `at: "09:00"` and, for weekly, `weekday: 1` (Monday)
 * stand in for what the setup screen does not yet collect.
 */
export function normalizeCadence(input, fallbackTimeZone) {
  const named = typeof input === "string" && Object.hasOwn(NAMED_CADENCES, input) ? { ...NAMED_CADENCES[input] } : null;
  const cadence = named ?? record(input);
  if (!cadence) throw new Error('A cadence is required: "hourly", "daily", "weekly", or an explicit { kind, ... }.');

  if (cadence.kind === "interval") {
    const everyMinutes = Number(cadence.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES) {
      throw new Error(`An interval cadence must be at least ${MIN_INTERVAL_MINUTES} minute(s).`);
    }
    return { kind: "interval", everyMinutes: Math.round(everyMinutes) };
  }

  if (cadence.kind === "daily") {
    const at = boundedString(cadence.at, 5);
    const timezone = boundedString(cadence.timezone, 100) || boundedString(fallbackTimeZone, 100);
    if (!TIME_PATTERN.test(at)) throw new Error('A daily cadence needs "at" as HH:MM.');
    if (!timezone) throw new Error("A daily cadence needs a timezone.");
    return { kind: "daily", at, timezone };
  }

  if (cadence.kind === "weekly") {
    const weekday = Number(cadence.weekday);
    const at = boundedString(cadence.at, 5);
    const timezone = boundedString(cadence.timezone, 100) || boundedString(fallbackTimeZone, 100);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error(`A weekly cadence needs a weekday 0-6 (${WEEKDAY_NAMES.join(", ")}).`);
    }
    if (!TIME_PATTERN.test(at)) throw new Error('A weekly cadence needs "at" as HH:MM.');
    if (!timezone) throw new Error("A weekly cadence needs a timezone.");
    return { kind: "weekly", weekday, at, timezone };
  }

  throw new Error('A cadence must be "interval", "daily" or "weekly".');
}

function normalizeTermList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => typeof entry === "string" || record(entry))
    .slice(0, MAX_TERM_LIST)
    .map((entry) => {
      if (typeof entry === "string") return entry.trim().slice(0, MAX_TERM_CHARS);
      const value = record(entry);
      return { value: boundedString(value?.value, MAX_TERM_CHARS), allowSubstring: value?.allowSubstring === true };
    })
    .filter((entry) => (typeof entry === "string" ? entry.length > 0 : entry.value.length > 0));
}

/**
 * Accepts either `{ notifications: { mode, quietHours } }` (structured) or
 * the client's flat `notificationPolicy` + top-level `quietHours: {start,
 * end} | null` (`toConfigPayload`). Both land in the same stored shape.
 */
function normalizeNotifications(config) {
  const structured = record(config.notifications);
  const mode = NOTIFICATION_MODES.includes(structured?.mode)
    ? structured.mode
    : NOTIFICATION_MODES.includes(config.notificationPolicy)
      ? config.notificationPolicy
      : "immediate";
  const quietHours = record(structured?.quietHours) ?? record(config.quietHours);
  if (!quietHours) return { mode };
  const start = boundedString(quietHours.start, 5);
  const end = boundedString(quietHours.end, 5);
  if (!TIME_PATTERN.test(start) || !TIME_PATTERN.test(end)) return { mode };
  return { mode, quietHours: { start, end } };
}

function normalizeRefinementBrief(value) {
  const brief = record(value);
  if (!brief) return DEFAULT_REFINEMENT_BRIEF;
  return {
    ...DEFAULT_REFINEMENT_BRIEF,
    targetLanguage: boundedString(brief.targetLanguage, 40) || DEFAULT_REFINEMENT_BRIEF.targetLanguage,
    register: boundedString(brief.register, 80) || DEFAULT_REFINEMENT_BRIEF.register,
    tone: boundedString(brief.tone, 120),
    allowedChanges: normalizeTermList(brief.allowedChanges),
    protectedTerms: normalizeTermList(brief.protectedTerms),
    protectedFacts: normalizeTermList(brief.protectedFacts),
    protectedClaims: normalizeTermList(brief.protectedClaims),
    callToAction: boundedString(brief.callToAction, 300) || null,
    visualTreatment: ["keep_original", "text_poster", "ai_refinement"].includes(brief.visualTreatment)
      ? brief.visualTreatment
      : DEFAULT_REFINEMENT_BRIEF.visualTreatment
  };
}

/**
 * The full config `setConfig` persists. `sources` and `destinations` are
 * normalized separately (`normalizeBindingList`) since they are stored in
 * their own tables, not inside this JSON blob — and the client's own
 * `toConfigPayload` does not send them at all; `server.js` derives them from
 * the granted connector bindings when they are absent.
 *
 * TWO ACCEPTED SHAPES. The structured one (`timeZone`, `locale: {from,to}`,
 * `notifications: {mode,quietHours}`, `cadence` as `{kind,...}`) is what
 * `summary()` returns and what a future richer setup screen or a test can
 * send directly. The client's actual `toConfigPayload` output
 * (`src/client/steps.js`, `cc/social-localization-client` PR #1483) is
 * flatter — `timezone` (lowercase), `sourceLocale`/`targetLocale`,
 * `notificationPolicy`, top-level `quietHours`, `cadence` as a bare
 * `"hourly"`/`"daily"`/`"weekly"` string — and is accepted the same way, so
 * `setConfig` needs no adapter at the call site.
 */
export function normalizeConfig(input) {
  const config = record(input) ?? {};
  const locale = record(config.locale) ?? {};
  const timeZone = boundedString(config.timeZone, 100) || boundedString(config.timezone, 100) || "UTC";
  return {
    cadence: normalizeCadence(config.cadence, timeZone),
    timeZone,
    fetchBudgetCredits: normalizeFetchBudget(config.fetchBudgetCredits),
    locale: {
      from: boundedString(locale.from, 20) || boundedString(config.sourceLocale, 20) || "en",
      to: boundedString(locale.to, 20) || boundedString(config.targetLocale, 20) || "zh-HK"
    },
    notifications: normalizeNotifications(config),
    protectedTerms: normalizeTermList(config.protectedTerms),
    protectedHashtags: normalizeTermList(config.protectedHashtags),
    disclaimers: normalizeTermList(config.disclaimers),
    claimsRequiringConfirmation: normalizeTermList(config.claimsRequiringConfirmation),
    refinementBrief: normalizeRefinementBrief(config.refinementBrief),
    contentPrompt: boundedString(config.contentPrompt, 4000) || "",
    posterPrompt: boundedString(config.posterPrompt, 4000) || "",
    drafting: normalizeDrafting(config.drafting)
  };
}

/**
 * Whether a scan may ask for what it found to be drafted (TASK-019).
 *
 * OFF UNLESS ASKED, and unrecognised reads as off. An owner who upgrades this
 * gadget has agreed to nothing new, and the failure of the other default is not
 * a wrong setting — it is a scan that starts putting approvable agent turns in
 * front of them, on its own cadence, spending the organization's credits.
 *
 * SEPARATE FROM `notifications`, because REQ-014 says a notification must not be
 * the mechanism by which work is requested. Sharing one setting would make quiet
 * hours and a `daily` digest silently decide whether work is asked for, which is
 * exactly the coupling that requirement forbids.
 */
export function normalizeDrafting(value) {
  return value === "on_new" ? "on_new" : "off";
}

/** Whether quiet hours (owner's timeZone, HH:MM wall-clock) cover an instant. Pure, so it is testable without faking the clock. */
export function isWithinQuietHours(quietHours, hhmm) {
  if (!quietHours || !TIME_PATTERN.test(hhmm)) return false;
  const { start, end } = quietHours;
  if (start === end) return false;
  // Overnight ranges (e.g. 22:00-07:00) wrap past midnight.
  return start < end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

/**
 * A schedule row's own state for `summary().schedule`.
 *
 * REQ-012's terminal state comes from the SCHEDULE DOOR, which reports the
 * store's `status`. It used to be derived here from `lastError`, which says
 * something else entirely: one failed fire sets it, and the store re-arms and
 * carries on. So a schedule that had a bad afternoon showed as dead while a
 * genuinely dead one — bounded retries exhausted, never firing again — showed
 * as dead for the same reason and could not be told apart. Deriving a fact
 * the store already computes is the same mistake as inferring one from a
 * name; read the value.
 *
 * `degraded` is what `lastError` actually means: still armed, last fire
 * failed.
 */
export function scheduleStateFrom(schedule) {
  if (!schedule) return "unarmed";
  if (schedule.status === "dead") return "dead";
  if (schedule.status === "paused" || schedule.status === "cancelled") return schedule.status;
  if (schedule.lastError) return "degraded";
  return "active";
}

/**
 * The owner's LOCAL calendar day (`YYYY-MM-DD`) at an instant, for REQ-014's
 * "one digest per day". Pure, like `wallClockHHMM` beside it: the instant is
 * a parameter, so the daily boundary is testable without faking a clock.
 *
 * A local day, not a rolling 24 hours: "once a day" means something to a
 * person, and it is not "24 hours after whenever the first scan happened".
 */
export function localDay(timeZone, date = new Date()) {
  try {
    // en-CA gives YYYY-MM-DD, which sorts and compares as a string.
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(
      date
    );
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** HH:MM wall-clock time in an IANA timezone, for quiet-hours comparison. Pure: takes the instant as a parameter. */
export function wallClockHHMM(timeZone, date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
    return formatter.format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

/**
 * The metered-fetch budget, in credits.
 *
 * A non-negative integer, or the default when unset. `0` survives — see
 * `DEFAULT_FETCH_BUDGET_CREDITS` for why zero and empty must stay different
 * answers.
 */
function normalizeFetchBudget(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_FETCH_BUDGET_CREDITS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FETCH_BUDGET_CREDITS;
  return Math.floor(parsed);
}
