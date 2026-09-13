// Social Localization client — the Localize / Publish / Result steps
// (TASK-203), plus the first-run setup screen this gadget owns (TASK-302).
// Pure state/selectors are exported separately from the render functions so
// tests/social-localization-client.test.ts can assert step transitions and
// validation gating without a DOM.
//
// Publish used to be preceded by a separate Review step that repeated what
// the batch drawer already showed and rendered the poster as a text span
// instead of the image that actually ships. That step is gone: Publish's own
// cards now carry the poster, caption, destinations, timing and submit
// together, so there is one screen with the real preview on it, not a
// summary screen followed by the screen with the controls.

import { detectProtectedLiterals, validateRevisionDraft } from "../../model.js";
import { el, replace } from "./dom.js";
import { t } from "./i18n.js";
import { isEditableItem } from "./inbox.js";
import { computePosterLayout, drawPoster } from "./poster.js";

export const STEPS = Object.freeze(["select", "publish"]);

const POSTER_TEMPLATES = Object.freeze(["1080x1350", "1080x1080"]);
const DEFAULT_BACKGROUND = "#1c1c1e";
const DEFAULT_TEXT_COLOR = "#ffffff";

// ---------------------------------------------------------------------------
// Pure wizard state
// ---------------------------------------------------------------------------

export function createWizardState() {
  return {
    step: "select",
    batch: null, // { id, items: [{ id, sourceItem, destinationBindings, publications, revision, caption, posterLayout, confirmedClaims, approval }] }
    activeItemId: null,
    mobilePane: "source",
    drafts: {}, // batchItemId -> { caption, template, headline, subline, background, textColor, align, confirmedClaims: string[] }
    acknowledged: {}, // last server-confirmed draft per item; browser edits never replace this
    savingByItem: {},
    conflicts: {},
    publishByItem: {}, // batchItemId -> readPublishState(): { publications, targets }
    // TASK-016: the send decision per item — which destinations this submit
    // files against, and the timing for all of them. Seeded from the item's
    // recorded bindings; the owner picks on the Publish step.
    publishChoices: {}, // batchItemId -> { bindings: string[], intent: { publishMode, ... } }
    publishErrors: {}, // batchItemId -> { code, message } from the last submit refusal
    submittingByItem: {},
    error: null // the message of the most recent refusal (see isRefusal/refusalMessage below), cleared on the next attempt
  };
}

/**
 * `server.js`'s refusal envelope for an EXPECTED condition — `{ ok: false,
 * code, message }`, or `{ ok: false, issues: [...] }` for the two methods
 * (`saveRevision`, `savePoster`) that already had a validation-issues shape.
 * A refusal is a normal return value now, never a rejected promise (see
 * `server.js`'s file header — a throw from a facet method breaks the
 * Durable Object's output gate), so the client checks `ok` explicitly
 * instead of relying on a caught exception.
 */
export function isRefusal(result) {
  return Boolean(result) && typeof result === "object" && result.ok === false;
}

/** The human-readable text for a refusal, whichever of the two shapes above it used. */
export function refusalMessage(result) {
  if (!isRefusal(result)) return null;
  if (typeof result.message === "string" && result.message) return result.message;
  if (Array.isArray(result.issues) && result.issues.length) return result.issues.map((issue) => issue.message).join(" ");
  return null;
}

/** Sets (or clears, with `null`) the wizard's inline error banner — a refusal's message, or a genuinely thrown error's. */
export function setWizardError(state, message) {
  return { ...state, error: message || null };
}

function draftFor(item) {
  const layout = item.posterLayout || {};
  return {
    caption: item.caption ?? item.sourceItem?.text ?? "",
    template: POSTER_TEMPLATES.includes(layout.template) ? layout.template : POSTER_TEMPLATES[0],
    headline: layout.headline || "",
    subline: layout.subline || "",
    background: layout.background?.value || DEFAULT_BACKGROUND,
    textColor: layout.textColor || DEFAULT_TEXT_COLOR,
    align: layout.align || "left",
    confirmedClaims: Array.isArray(item.confirmedClaims) ? item.confirmedClaims.slice() : [],
    publicationIntent: item.publicationIntent ?? { publishMode: "save_draft", latePolicy: "hold" },
    refinementBrief: item.refinementBrief,
    acceptedVisualMode: item.refinementBrief?.visualTreatment ?? "keep_original",
    ledger: item.ledger ?? { spans: [], media: [] }
  };
}

/** Continue (step 1 -> 2): a batch with no items never advances — REQ-006/REQ-013 leave nothing to localize. */
export function setBatch(state, batch) {
  if (!batch || !Array.isArray(batch.items) || !batch.items.length) return state;
  const drafts = {};
  const publishChoices = {};
  for (const item of batch.items) {
    drafts[item.id] = draftFor(item);
    // The submit picker's default is what the item is already pointed at:
    // bound publications and the legacy column arrive as destinationBindings.
    publishChoices[item.id] = {
      bindings: Array.isArray(item.destinationBindings) ? item.destinationBindings.slice() : [],
      intent: item.publicationIntent ?? { publishMode: "save_draft", latePolicy: "hold" }
    };
  }
  return { ...state, step: "publish", batch, activeItemId: batch.items[0].id, drafts, publishChoices, acknowledged: Object.fromEntries(batch.items.map((item) => [item.id, drafts[item.id]])), savingByItem: {}, conflicts: {}, publishByItem: {}, publishErrors: {}, submittingByItem: {} };
}

export function recordDraftConflict(state, id, savedItem) {
  return { ...state, conflicts: { ...state.conflicts, [id]: savedItem ?? null } };
}

export function resolveDraftConflict(state, id, keepEdits) {
  const saved = state.conflicts?.[id];
  if (state.submitting || state.savingByItem[id] || !isEditableItem(saved) || saved.id !== id || !state.batch) return state;
  const acknowledged = draftFor(saved);
  const conflicts = { ...state.conflicts };
  delete conflicts[id];
  return {
    ...state, conflicts, error: null,
    batch: { ...state.batch, items: state.batch.items.map((item) => item.id === id ? saved : item) },
    acknowledged: { ...state.acknowledged, [id]: acknowledged },
    drafts: { ...state.drafts, [id]: keepEdits ? state.drafts[id] : acknowledged }
  };
}

/** Explicit resume alias: callers use this after reading an existing batch. */
export function resumeBatch(state, batch) {
  return setBatch(state, { ...batch, items: (batch?.items ?? []).filter(isEditableItem) });
}

export function goToStep(state, step) {
  return STEPS.includes(step) ? { ...state, step } : state;
}

export function setActiveItem(state, batchItemId) {
  return state.batch?.items.some((item) => item.id === batchItemId) ? { ...state, activeItemId: batchItemId } : state;
}

export function setMobilePane(state, pane) {
  return ["source", "draft", "preview"].includes(pane) ? { ...state, mobilePane: pane } : state;
}

export function updateDraft(state, batchItemId, patch) {
  if (state.submitting) return state;
  const current = state.drafts[batchItemId];
  if (!current) return state;
  return { ...state, drafts: { ...state.drafts, [batchItemId]: { ...current, ...patch,
    ...(patch.publicationIntent ? { publicationIntent: { ...current.publicationIntent, ...patch.publicationIntent } } : {})
  } } };
}

export function draftIsDirty(state, batchItemId) {
  const draft = state.drafts[batchItemId];
  const acknowledged = state.acknowledged?.[batchItemId];
  return Boolean(draft && acknowledged && JSON.stringify(draft) !== JSON.stringify(acknowledged));
}

export function dirtyItemIds(state) {
  return Object.keys(state.drafts).filter((id) => draftIsDirty(state, id));
}

export function discardDraft(state, batchItemId) {
  const acknowledged = state.acknowledged?.[batchItemId];
  return acknowledged ? { ...state, drafts: { ...state.drafts, [batchItemId]: { ...acknowledged } } } : state;
}

export function toggleConfirmedClaim(state, batchItemId, claimValue) {
  const current = state.drafts[batchItemId];
  if (!current) return state;
  const has = current.confirmedClaims.includes(claimValue);
  const confirmedClaims = has ? current.confirmedClaims.filter((value) => value !== claimValue) : current.confirmedClaims.concat(claimValue);
  return updateDraft(state, batchItemId, { confirmedClaims });
}

export function setSaving(state, batchItemId, saving) {
  return { ...state, savingByItem: { ...state.savingByItem, [batchItemId]: saving } };
}

/** Applies a successful saveRevision() result: bumps the item's revision (PAT-004 compare-and-set) and the caption/poster it now holds. */
export function applySavedRevision(state, batchItemId, result, submittedDraft = state.drafts[batchItemId]) {
  if (!state.batch) return state;
  const items = state.batch.items.map((item) =>
    item.id === batchItemId
      ? { ...item, revision: result.revision ?? item.revision, caption: submittedDraft?.caption ?? item.caption }
      : item
  );
  const acknowledged = submittedDraft ? { ...submittedDraft } : state.acknowledged?.[batchItemId];
  return { ...state, batch: { ...state.batch, items }, acknowledged: { ...state.acknowledged, [batchItemId]: acknowledged } };
}

export function applySavedPoster(state, batchItemId, result, submittedDraft = state.drafts[batchItemId]) {
  if (!result?.ok || !state.batch) return state;
  const items = state.batch.items.map((item) => item.id === batchItemId ? { ...item, revision: result.revision ?? item.revision } : item);
  const currentAcknowledged = state.acknowledged?.[batchItemId] ?? {};
  // savePoster persists PNG bytes and the template only. Layout text/colour
  // fields are not acknowledged here; they remain dirty until saveRevision.
  const acknowledged = submittedDraft
    ? { ...currentAcknowledged, template: submittedDraft.template }
    : currentAcknowledged;
  return { ...state, batch: { ...state.batch, items }, acknowledged: { ...state.acknowledged, [batchItemId]: acknowledged } };
}

export function applyPublishState(state, batchItemId, publishState) {
  return { ...state, publishByItem: { ...state.publishByItem, [batchItemId]: publishState } };
}

// --- Publish step: the send decision (TASK-016) -----------------------------

/** Toggle one destination in an item's submit set. */
export function togglePublishBinding(state, batchItemId, binding) {
  const current = state.publishChoices?.[batchItemId] ?? { bindings: [], intent: { publishMode: "save_draft", latePolicy: "hold" } };
  const has = current.bindings.includes(binding);
  return {
    ...state,
    publishChoices: {
      ...state.publishChoices,
      [batchItemId]: { ...current, bindings: has ? current.bindings.filter((entry) => entry !== binding) : current.bindings.concat(binding) }
    }
  };
}

/** Merge a timing patch into an item's submit intent (publishMode / schedule fields). */
export function setPublishIntent(state, batchItemId, patch) {
  const current = state.publishChoices?.[batchItemId] ?? { bindings: [], intent: { publishMode: "save_draft", latePolicy: "hold" } };
  return {
    ...state,
    publishChoices: { ...state.publishChoices, [batchItemId]: { ...current, intent: { ...current.intent, ...patch, latePolicy: "hold" } } }
  };
}

export function setPublishError(state, batchItemId, error) {
  return { ...state, publishErrors: { ...state.publishErrors, [batchItemId]: error || null } };
}

export function setSubmitting(state, batchItemId, submitting) {
  return { ...state, submittingByItem: { ...state.submittingByItem, [batchItemId]: submitting } };
}

/** The destinations this submit would file — the picker's answer, never the batch's fixed property. */
export function publishBindings(state, batchItemId) {
  return state.publishChoices?.[batchItemId]?.bindings ?? [];
}

/**
 * Localize -> Review. Drafting needs no destination and needs no send —
 * only that nothing is mid-save or unsaved, so the review the owner reads
 * is the draft that is actually stored.
 */
export function reviewEnabled(state) {
  if (!state.batch?.items.length || state.submitting) return false;
  if (Object.keys(state.conflicts ?? {}).length) return false;
  if (dirtyItemIds(state).length) return false;
  if (Object.values(state.savingByItem).some(Boolean)) return false;
  return true;
}

/**
 * Whether ONE item can be filed for review right now — the Publish step's
 * per-item submit (TASK-016). Everything `submitEnabled` asked of the batch,
 * asked of the item, plus the one thing that only exists at this step: at
 * least one destination chosen.
 */
export function submitItemEnabled(state, batchItemId, policy) {
  const item = state.batch?.items.find((entry) => entry.id === batchItemId);
  if (!item || state.submitting || state.submittingByItem?.[batchItemId]) return false;
  if (state.conflicts && Object.hasOwn(state.conflicts, batchItemId)) return false;
  if (state.savingByItem[batchItemId] || draftIsDirty(state, batchItemId)) return false;
  if (!publishBindings(state, batchItemId).length) return false;
  const issues = computeIssues(item, state.drafts[batchItemId], policy).issues;
  return !hasBlockingIssues(issues);
}

// ---------------------------------------------------------------------------
// Pure validation/gating selectors
// ---------------------------------------------------------------------------

/** Runs the same validator saveRevision() selects from the brief (localization vs grounded). */
export function computeIssues(item, draft, policy) {
  return validateRevisionDraft({
    source: { text: item.sourceItem?.text ?? "", id: item.sourceItem?.id ?? "" },
    draft: draft?.caption ?? "",
    brief: draft?.refinementBrief,
    ledger: draft?.ledger,
    policy: { ...policy, confirmedClaims: draft?.confirmedClaims ?? [] },
    limits: item.limits || {}
  });
}

export function hasBlockingIssues(issues) {
  return Array.isArray(issues) && issues.some((issue) => issue.severity === "block");
}

export function submitEnabled(state, policy) {
  if (!state.batch?.items.length || state.submitting || Object.keys(state.conflicts ?? {}).length || dirtyItemIds(state).length || Object.values(state.savingByItem).some(Boolean)) return false;
  return state.batch.items.every((item) => {
    const draft = state.drafts[item.id];
    const issues = computeIssues(item, draft, policy).issues;
    return !hasBlockingIssues(issues);
  });
}

/** Mockup's "Approval expired because this version changed" — REQ-011: any content change invalidates a prior approval. */
export function isApprovalExpired(approval) {
  if (!approval || approval.approvedRevision == null || approval.currentRevision == null) return false;
  return approval.approvedRevision !== approval.currentRevision;
}

// ---------------------------------------------------------------------------
// First-run setup (TASK-302) — pure config assembly
// ---------------------------------------------------------------------------

export function createSetupDraft() {
  return {
    cadence: "daily",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Hong_Kong",
    notificationPolicy: "immediate",
    quietHoursStart: "",
    quietHoursEnd: "",
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: [],
    contentPrompt: "",
    posterPrompt: "",
    refinementBrief: { version: 1, targetLanguage: "zh-HK", register: "written", tone: "", allowedChanges: [], visualTreatment: "keep_original" }
  };
}

/**
 * The stored config, back in the shape the setup form edits.
 *
 * The inverse of `toConfigPayload`, and it exists because setup was a ONE-WAY
 * DOOR: `runSetup` ran only while `!summary.configured`, so cadence, timezone
 * and every protected term were set once at first run and could
 * never be changed again from any surface. Door grants and schedules were
 * always editable from the workspace page; this was the half with no way back.
 *
 * Fields the config does not carry fall back to a fresh draft's default rather
 * than to empty, so a config written before a field existed opens on that
 * field's default instead of on a blank the owner did not choose.
 */
export function draftFromConfig(config) {
  const base = createSetupDraft();
  if (!config || typeof config !== "object") return base;
  const list = (value) => (Array.isArray(value) ? value.slice() : null);
  const text = (value) => (typeof value === "string" && value.trim() ? value : null);
  return {
    ...base,
    baseConfig: config,
    cadence: config.cadence ?? base.cadence,
    timezone: text(config.timeZone) ?? text(config.timezone) ?? base.timezone,
    notificationPolicy: text(config.notifications?.mode) ?? text(config.notificationPolicy) ?? base.notificationPolicy,
    // `quietHours` is one nullable object on the wire and two fields in the
    // form; a null there means "no quiet hours", which is two empty strings.
    quietHoursStart: text(config.notifications?.quietHours?.start) ?? text(config.quietHours?.start) ?? "",
    quietHoursEnd: text(config.notifications?.quietHours?.end) ?? text(config.quietHours?.end) ?? "",
    protectedTerms: list(config.protectedTerms) ?? base.protectedTerms,
    protectedHashtags: list(config.protectedHashtags) ?? base.protectedHashtags,
    disclaimers: list(config.disclaimers) ?? base.disclaimers,
    claimsRequiringConfirmation: list(config.claimsRequiringConfirmation) ?? base.claimsRequiringConfirmation,
    contentPrompt: typeof config.contentPrompt === "string" ? config.contentPrompt : base.contentPrompt,
    posterPrompt: typeof config.posterPrompt === "string" ? config.posterPrompt : base.posterPrompt,
    refinementBrief: config.refinementBrief ?? base.refinementBrief
  };
}

/** Shapes the setup draft into the setConfig() payload — locale is fixed en -> zh-HK per REQ-007. */
export function toConfigPayload(draft) {
  return {
    ...draft.baseConfig,
    cadence: typeof draft.cadence === "object" && draft.cadence.kind !== "interval" ? { ...draft.cadence, timezone: draft.timezone } : draft.cadence,
    timeZone: draft.timezone,
    timezone: draft.timezone,
    sourceLocale: "en",
    targetLocale: "zh-HK",
    notificationPolicy: draft.notificationPolicy,
    notifications: { mode: draft.notificationPolicy, ...(draft.quietHoursStart && draft.quietHoursEnd ? { quietHours: { start: draft.quietHoursStart, end: draft.quietHoursEnd } } : {}) },
    quietHours: draft.quietHoursStart && draft.quietHoursEnd ? { start: draft.quietHoursStart, end: draft.quietHoursEnd } : null,
    protectedTerms: draft.protectedTerms,
    protectedHashtags: draft.protectedHashtags,
    disclaimers: draft.disclaimers,
    claimsRequiringConfirmation: draft.claimsRequiringConfirmation,
    contentPrompt: draft.contentPrompt,
    posterPrompt: draft.posterPrompt,
    refinementBrief: draft.refinementBrief
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `state.error` (a refusal's or a genuine throw's message), rendered the same place `renderSetup`'s error banner is — or nothing when there isn't one. */
function renderWizardError(state) {
  return state.error ? el("p", { class: "sl-wizard-error", role: "alert" }, state.error) : null;
}

/**
 * Candidate protected terms/hashtags read off the owner's own watched posts.
 *
 * Heuristic, deliberately: a hashtag is already a deliberate token, and a
 * capitalized Latin run that repeats across posts is usually a brand or
 * product name — exactly the words this list exists to keep verbatim. zh-HK
 * copy has no case, so CJK text contributes hashtags only. Suggestions are a
 * click away from the list; nothing is added silently.
 */
export function suggestProtectedTerms(items) {
  const texts = (Array.isArray(items) ? items : []).map((item) => item?.text).filter((v) => typeof v === "string");
  const hashtags = new Map();
  const terms = new Map();
  for (const text of texts) {
    for (const match of text.matchAll(/#[\p{L}\p{N}_]+/gu)) {
      const tag = match[0].slice(1);
      hashtags.set(tag, (hashtags.get(tag) ?? 0) + 1);
    }
    for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9&]*(?:[ \t]+[A-Z][A-Za-z0-9&]*){0,3}\b/g)) {
      const term = match[0].trim();
      if (term.length < 3 || COMMON_CAPITALIZED.has(term)) continue;
      terms.set(term, (terms.get(term) ?? 0) + 1);
    }
  }
  const pick = (map) => [...map.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([value]) => value).slice(0, 10);
  return { terms: pick(terms), hashtags: pick(hashtags) };
}

// Ordinary English sentence-openers a capitalized-token pass would otherwise
// call a product name. Only repeated tokens are ever suggested; this list
// keeps the obvious ones out.
const COMMON_CAPITALIZED = new Set(["The", "This", "That", "A", "An", "And", "For", "With", "Our", "Your", "New", "Now", "Get", "Shop", "Sale", "Today", "We", "You", "I"]);

/**
 * Public accounts this workspace watches, added by pasting a link.
 *
 * string the owner types and the gadget stores verbatim; a public account is a
 * link the SERVER resolves into a platform and an account key, and it can be
 * refused — a bare handle, a platform we cannot watch, a URL that names
 * `/explore` rather than an account. So this field is asynchronous, has its
 * own busy and error state, and shows what was resolved rather than what was
 * typed. Reusing the tag list would have meant storing the raw string and
 * discovering it was wrong at 09:00 tomorrow, from a scan that failed.
 *
 * Each row also carries what the last scan cost and which provider served it,
 * because these accounts are the ones that spend money and "why is this
 * expensive" is otherwise unanswerable from the screen.
 */
function renderOpenSources(locale, state, handlers) {
  const input = el("input", {
    type: "text",
    // Its OWN class, not `sl-field-input`. That class marks the tag inputs —
    // type a value, press Enter, it is stored verbatim — and this field is a
    // different thing: the server resolves it and may refuse. Sharing the
    // class also made this input the first `sl-field-input` on the form, which
    // silently redirected an existing test's protected-term typing into here.
    class: "sl-open-source-input",
    placeholder: t(locale, "openSourcePlaceholder"),
    disabled: state.openBusy,
    onkeydown: (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const value = event.currentTarget.value;
      event.currentTarget.value = "";
      handlers.onAddOpenSource(value);
    }
  });

  const fetchGranted = state.fetchGranted !== false;
  const rows = fetchGranted
    ? (state.openSources || []).map((source) =>
        el("div", { class: "sl-open-source" }, [
          el("span", { class: "sl-open-source-name" }, source.displayName || source.binding),
          source.lastServedBy
            ? el(
                "span",
                { class: "sl-open-source-meta" },
                t(locale, "openSourceServedBy", {
                  provider: source.lastServedBy,
                  credits: String(source.lastCostCredits ?? 0)
                })
              )
            : null,
          el(
            "button",
            {
              type: "button",
              class: "sl-open-source-remove",
              disabled: state.openBusy,
              "aria-label": t(locale, "openSourceRemove", { value: source.displayName || source.binding }),
              onclick: () => handlers.onRemoveOpenSource(source.binding)
            },
            "×"
          )
        ])
      )
    : [];

  return el("div", { class: "sl-open-source-field" }, [
    fetchGranted
      ? null
      : el("div", { class: "sl-fetch-permission", role: "status" }, [
          el("p", { class: "sl-field-note" }, t(locale, "fetchNeedsPermission")),
          el(
            "button",
            { type: "button", class: "sl-secondary", onclick: () => handlers.onGrantFetch?.() },
            t(locale, "fetchGrant")
          ),
          el("p", { class: "sl-field-note" }, t(locale, "fetchGrantNext"))
        ]),
    rows.length ? el("div", { class: "sl-open-source-list" }, rows) : null,
    input,
    // The refusal the server gave, in the owner's own words, beside the field
    // that caused it — not a toast that has gone by the time they look up.
    state.openError ? el("p", { class: "sl-setup-error", role: "alert" }, state.openError) : null,
    el("p", { class: "sl-field-note" }, t(locale, "openSourceHint"))
  ]);
}

/**
 * The setup form, on first run and on every visit after it.
 *
 * `editing` is the difference between the two: the same fields, but the
 * heading, the primary label and the presence of a Cancel control all say
 * whether this is the first configuration or a change to a live one. Before
 * this the form had only the first mode, because it could only be reached
 * once.
 */
export function renderSetup(root, draft, ctx) {
  const { locale, saving, error, handlers, editing = false, summary = {}, dirty = true } = ctx;
  const note = (key) => el("p", { class: "sl-field-note" }, t(locale, key));
  const field = (key, control) => {
    const id = "sl-" + key;
    const input = control.querySelector?.("input, textarea, select") || control;
    input.setAttribute("id", id);
    input.setAttribute("name", key);
    return el("div", { class: "sl-field" }, [el("label", { for: id }, t(locale, key)), control]);
  };
  const section = (key, children) => el("fieldset", { class: "sl-setup-section" }, [
    el("legend", null, t(locale, key)), ...children
  ]);
  const select = (value, options, onChange) => el("select", { onchange: e => onChange(e.currentTarget.value) },
    options.map(([id, label]) => el("option", { value: id, selected: id === value }, t(locale, label))));
  const accounts = (key, rows) => el("div", { class: "sl-field" }, [
    el("strong", null, t(locale, key)),
    rows?.length ? el("ul", null, rows.map(row => el("li", null, row.label || row.displayName || row.provider)))
      : note("setupNoConnections")
  ]);
  const customCadence = typeof draft.cadence === "object";
  const monitoring = summary.config?.monitoringEnabled;
  const sourceSection = section("setupSourcesSection", [
    note("setupSourcesNote"),
    accounts("setupConnectedSources", (summary.sources || []).filter(row => row.origin !== "open")),
    accounts("setupDestinations", summary.destinations),
    /*
     * A connector granted after first setup reaches storage only if someone
     * re-derives it — `deriveBindingsFromGrants` runs on first setup and the
     * legacy `setConfig` path alone, and this form's payload has never
     * carried a binding list. `refreshGrants` is the additive re-check; the
     * result is said beside the button, not only in a toast.
     */
    el("div", { class: "sl-setup-actions" }, [
      el("button", { type: "button", class: "sl-secondary", disabled: ctx.grantsBusy, onclick: () => handlers.onRefreshGrants() }, t(locale, "setupCheckConnections")),
      ctx.grantsNote ? el("p", { role: "status", class: "sl-field-note" }, ctx.grantsNote) : null
    ]),
    field("openSourceLabel", renderOpenSources(locale, ctx, handlers)),
    note("openSourceDesc")
  ]);
  /*
   * The prompts are the whole form. The protection lists still enforce at
   * saveRevision — they are config carried through `baseConfig`, not fields
   * the owner edits here.
   */
  const rulesSection = section("setupRulesSection", [
    note("setupRulesNote"),
    field("setupContentPrompt", el("textarea", { rows: 4, value: draft.contentPrompt, placeholder: t(locale, "setupContentPromptHint"), onchange: e => handlers.onChange({ contentPrompt: e.currentTarget.value }) })),
    field("setupPosterPrompt", el("textarea", { rows: 4, value: draft.posterPrompt, placeholder: t(locale, "setupPosterPromptHint"), onchange: e => handlers.onChange({ posterPrompt: e.currentTarget.value }) }))
  ]);
  const monitoringSection = section("setupMonitoringSection", [
    note("setupMonitoringNote"),
    el("p", { role: "status" }, t(locale, monitoring === false || !summary.configured ? "setupMonitoringPaused" : monitoring === true ? "setupMonitoringActive" : "setupMonitoringLegacy")),
    field("setupCadence", select(customCadence ? "custom" : draft.cadence, [
      ...(customCadence ? [["custom", "setupCustomCadence"]] : []),
      ["hourly", "setupCadenceHourly"], ["daily", "setupCadenceDaily"], ["weekly", "setupCadenceWeekly"]
    ], cadence => { if (cadence !== "custom") handlers.onChange({ cadence }); })),
    field("setupTimezone", el("input", { type: "text", value: draft.timezone, onchange: e => handlers.onChange({ timezone: e.currentTarget.value }) })),
    field("setupNotifications", select(draft.notificationPolicy, [
      ["immediate", "setupNotifyImmediate"], ["daily", "setupNotifyDaily"], ["off", "setupNotifyOff"]
    ], notificationPolicy => handlers.onChange({ notificationPolicy }))),
    field("setupQuietStart", el("input", { type: "time", value: draft.quietHoursStart, onchange: e => handlers.onChange({ quietHoursStart: e.currentTarget.value }) })),
    field("setupQuietEnd", el("input", { type: "time", value: draft.quietHoursEnd, onchange: e => handlers.onChange({ quietHoursEnd: e.currentTarget.value }) })),
    dirty || !summary.configured ? note("setupSaveFirst") : null,
    el("div", { class: "sl-setup-actions" }, [
      el("button", { type: "button", class: "sl-secondary", "data-monitor-enable": "true", disabled: saving || dirty || !summary.configured, onclick: () => handlers.onMonitoring(true) }, t(locale, "setupEnable")),
      el("button", { type: "button", class: "sl-secondary", disabled: saving || !summary.configured || monitoring === false, onclick: () => handlers.onMonitoring(false) }, t(locale, "setupPause"))
    ])
  ]);
  // The host sandbox forbids form submission. Native type=button actions
  // retain Enter/Space keyboard activation without changing sandbox policy.
  const form = el("form", { class: "sl-setup-form", onsubmit: e => e.preventDefault() }, [
    el("fieldset", { disabled: saving || ctx.openBusy, class: "sl-setup-fields" }, [
      sourceSection, rulesSection,
      section("setupPublicationSection", [note("setupPublicationNote")]),
      monitoringSection,
      error ? el("p", { class: "sl-setup-error", role: "alert" }, error) : null,
      ctx.notice ? el("p", { role: "status", class: "sl-setup-notice" }, ctx.notice) : null,
      el("div", { class: "sl-setup-actions" }, [
        editing ? el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onCancel() }, t(locale, "settingsCancel")) : null,
        el("button", { type: "button", class: "sl-primary", disabled: saving, onclick: () => handlers.onSubmit() }, t(locale, saving ? "setupSaving" : "saveChanges"))
      ])
    ])
  ]);
  replace(root, [el("div", { class: "sl-titleline" }, [
    el("h1", null, t(locale, editing ? "settingsTitle" : "setupTitle")), note("setupFlow")
  ]), form]);
}

/**
 * The timing half of the send decision, per item on the Publish step
 * (TASK-016). Writes `publishChoices[itemId].intent` — the submission's own
 * argument — not the draft, so choosing a time never dirties the caption.
 */
function renderTimingPicker(itemId, intent, locale, handlers, disabled) {
  const change = (patch, redraw = true) => handlers.onPublishIntent(itemId, patch, redraw);
  // Subordinate to .sl-pc-field-label's section register (below it, not a
  // second shout): small, muted, sentence case. Its own class -- the
  // shared .sl-field is the setup form's own label+input wiring and does
  // not style a bare text child the way this needs.
  const field = (key, control) => el("label", { class: "sl-pc-subfield" }, [
    el("span", { class: "sl-pc-subfield-label" }, t(locale, key)),
    control
  ]);
  return el("div", { class: "sl-pc-field" }, [
    el("span", { class: "sl-pc-field-label" }, t(locale, "publicationTiming")),
    el("div", { class: "sl-timing", role: "radiogroup", "aria-label": t(locale, "publicationTiming") },
      [["save_draft", "publicationDraft"], ["publish_now", "publicationNow"], ["schedule", "publicationSchedule"]].map(([mode, key]) =>
        el("label", { class: `sl-seg${intent.publishMode === mode ? " sl-seg-on" : ""}` }, [
          el("input", { type: "radio", name: `publicationMode-${itemId}`, checked: intent.publishMode === mode, disabled,
            onchange: () => change({ publishMode: mode, publishLocalTime: null, timezone: mode === "schedule" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null, utcOffsetMinutes: null }) }),
          t(locale, key)
        ]))),
    // UTC offset removed: no owner fills that in correctly, and the
    // mode-change handler above already keeps utcOffsetMinutes null --
    // the door's contract (and its own ambiguous-time resolution) is
    // unchanged. The hint lives here, not below the whole control: it is
    // about a chosen time specifically, not about "Keep as draft".
    ...(intent.publishMode === "schedule" ? [
      field("publicationLocalTime", el("input", { type: "datetime-local", value: intent.publishLocalTime || "", oninput: e => change({ publishLocalTime: e.currentTarget.value }, false) })),
      field("publicationTimezone", el("input", { type: "text", value: intent.timezone || "", oninput: e => change({ timezone: e.currentTarget.value }, false) })),
      el("p", { class: "sl-field-note" }, t(locale, "publicationHint"))
    ] : [])
  ]);
}


/**
 * The poster as it will actually publish — drawn locally with the same
 * layout math the batch drawer and `savePoster` both use (poster.js), never
 * a text stand-in. A gadget canvas is an opaque origin: an `<img>` can only
 * show bytes it already holds (`blob:`/`data:`), and a plain `<canvas>`
 * sidesteps that fetch entirely by drawing the same pixels the drawer draws.
 * Returns `null` when the item has no poster layout yet, so the caller can
 * fall back to an identifying line instead of an empty box.
 */
function posterCanvas(locale, item) {
  const layout = item.posterLayout;
  if (!layout?.template) return null;
  const canvas = el("canvas", { class: "sl-pc-canvas", "aria-label": t(locale, "posterTitle") });
  const computed = computePosterLayout({ template: layout.template, headline: layout.headline, subline: layout.subline, align: layout.align });
  canvas.width = computed.width;
  canvas.height = computed.height;
  const ctx2d = canvas.getContext("2d");
  if (ctx2d) drawPoster(ctx2d, computed, { headline: layout.headline, subline: layout.subline, background: { value: layout.background?.value }, textColor: layout.textColor });
  return canvas;
}

/**
 * A publication's state as the batch drawer's own summary line says it --
 * `<destination> · <state>` -- never the raw mechanism name (defect 4: a
 * `bound` row leaked verbatim there). Distinct from `stateBadge`'s
 * one-word pill labels below: "Chosen" reads fine on a small badge but
 * vague as the tail of a sentence, so `bound` gets its own fuller phrase
 * here.
 */
export function publicationStateSummary(locale, state) {
  const key = {
    scheduled: "stateScheduled",
    published: "statePublished",
    failed_safe: "stateFailed",
    failed: "stateFailed",
    unknown: "stateUnknown",
    bound: "drawerPublicationBound",
    review_requested: "stateInReview",
    superseded: "stateSuperseded"
  }[state] || "stateUnknown";
  return t(locale, key);
}

function stateBadge(locale, outcome) {
  const key = {
    scheduled: "stateScheduled",
    published: "statePublished",
    failed_safe: "stateFailed",
    failed: "stateFailed",
    unknown: "stateUnknown",
    bound: "stateBound",
    review_requested: "stateInReview",
    superseded: "stateSuperseded"
  }[outcome] || "stateUnknown";
  return el("span", { class: `sl-state-badge sl-state-${outcome}` }, t(locale, key));
}

/** A publication's displayable state: the door's own outcome when one has been read back, else the row's filing state. */
function publicationOutcome(publication) {
  const target =
    publication.targets?.find((entry) => entry.destinationBinding === publication.destinationBinding) ??
    publication.targets?.[0];
  return { target, outcome: target?.outcome ?? publication.state };
}

export function renderPublish(root, state, ctx) {
  const { locale, handlers, summary, policy } = ctx;
  const batch = state.batch;
  if (!batch) return replace(root, []);

  const destinations = Array.isArray(summary?.destinations) ? summary.destinations : [];
  const destinationLabel = (binding) =>
    destinations.find((entry) => entry.destinationBinding === binding || entry.binding === binding)?.label || binding;

  /*
   * TASK-017/TASK-022: with nowhere configured there is nothing to submit
   * TO — said on this step, where the choice actually lives, with both ways
   * out beside it. Drafting was never blocked on this; only the send is.
   */
  const emptyDestinations = el("div", { class: "sl-empty" }, [
    el("strong", null, t(locale, "batchNoDestinationTitle")),
    el("p", null, t(locale, "publishNoDestinationsBody")),
    el("div", { class: "sl-setup-actions" }, [
      el("button", { type: "button", class: "sl-primary", onclick: () => handlers.onOpenSettings() }, t(locale, "settingsOpen")),
      el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onRefreshGrants() }, t(locale, "setupCheckConnections"))
    ])
  ]);

  /*
   * The batch's own approval fact -- one per batch, not per item -- but it
   * belongs on the card it describes, not a separate screen the owner has
   * to click through before reaching the cards `renderReview` used to be.
   * One quiet note, built fresh for each item's own card.
   */
  const approval = batch.approval || null;
  const expired = isApprovalExpired(approval);
  const approvalLead = t(locale, expired ? "approvalExpiredTitle" : approval ? "approvalReadyTitle" : "approvalPendingTitle");
  const approvalRest = t(locale, expired ? "approvalExpiredBody" : approval ? "approvalReadyBody" : "approvalPendingBody");
  function renderApprovalNote() {
    return el("div", { class: `sl-approval-note${expired ? " sl-approval-expired" : ""}` }, [
      el("span", { class: "sl-approval-mark", "aria-hidden": "true" }, "◆"),
      el("span", null, [
        el("strong", null, approvalLead + (/[.!?]$/.test(approvalLead) ? "" : ".") + " "),
        approvalRest,
        approval?.contentHash ? el("span", { class: "sl-hash" }, " " + t(locale, "contentHash", { hash: approval.contentHash })) : null
      ])
    ]);
  }

  const itemCards = batch.items.map((item) => {
    const draft = state.drafts[item.id] ?? {};
    const publishState = state.publishByItem[item.id];
    const publications = publishState?.publications ?? item.publications ?? [];
    // A pair already filed at the current revision is shown, not re-offered —
    // the checkbox is disabled so ticking it off cannot file a duplicate.
    const filedPairs = new Set(
      publications
        .filter((pub) => pub.version && pub.revision === item.revision && pub.state !== "superseded" && pub.state !== "failed")
        .map((pub) => pub.destinationBinding)
    );
    const choice = state.publishChoices[item.id] ?? {
      bindings: [],
      intent: item.publicationIntent ?? { publishMode: "save_draft", latePolicy: "hold" }
    };
    const submitting = !!state.submittingByItem[item.id];
    const error = state.publishErrors?.[item.id];
    const enabled = submitItemEnabled(state, item.id, policy);
    const poster = posterCanvas(locale, item);
    // The slot keeps the ratio it ships in whether or not a poster exists
    // yet, so the caption beside it does not jump as the owner moves
    // between posts. 1080x1080 is the only square template; every other
    // template (including "no template chosen yet") is the portrait shape
    // most posts actually use.
    const mediaAspect = item.posterLayout?.template === "1080x1080" ? "1 / 1" : "4 / 5";

    const pubRows = publications
      .filter((pub) => pub.state !== "superseded")
      .map((pub) => {
        const { target, outcome } = publicationOutcome(pub);
        return el("div", { class: "sl-target-row" }, [
          el("div", { class: "sl-who" }, [
            el("strong", null, destinationLabel(pub.destinationBinding)),
            // Revision 0 is not a version an owner has -- it means nothing
            // has been saved yet. "Version 0" reads like a debug line; say
            // what it means instead. 1 and up keep "Version {n}".
            el("span", null, pub.revision > 0 ? t(locale, "drawerRevision", { n: pub.revision }) : t(locale, "inboxNoSavedRevision"))
          ]),
          stateBadge(locale, outcome),
          target?.receiptUrl
            ? el("a", { class: "sl-receipt", href: target.receiptUrl, target: "_blank", rel: "noopener noreferrer" }, t(locale, "viewReceipt"))
            : outcome === "failed_safe" || outcome === "failed"
              ? el("button", { type: "button", class: "sl-cta", onclick: () => handlers.onRetry(item.id, pub.destinationBinding) }, t(locale, "retry"))
              : outcome === "unknown" && pub.version
                ? el("button", { type: "button", class: "sl-cta", onclick: () => handlers.onCheckManually(item.id, pub.destinationBinding) }, t(locale, "checkManually"))
                : null,
          target?.guidance
            ? el("p", { class: "sl-guidance" }, target.guidance)
            : outcome === "unknown" && pub.version
              ? el("p", { class: "sl-guidance" }, t(locale, "unknownGuidance"))
              : null
        ]);
      });

    // REQ-016's own rule (post-card.js's providerGlyph) applies here too:
    // the two-case fallback is precedent already established there, not a
    // new provider table -- a trailing tag naming the provider type, never
    // a data source of its own.
    const providerTag = (provider) => provider === "instagram" ? t(locale, "providerInstagram") : provider === "facebook" ? t(locale, "providerFacebook") : null;
    const picker = destinations.length
      ? el("div", { class: "sl-pc-field" }, [
          el("span", { class: "sl-pc-field-label" }, t(locale, "publishPickDestinations")),
          el("div", { class: "sl-dest", role: "group", "aria-label": t(locale, "publishPickDestinations") }, destinations.map((destination) => {
            const binding = destination.destinationBinding ?? destination.binding;
            const filed = filedPairs.has(binding);
            const checked = filed || choice.bindings.includes(binding);
            const tag = filed ? t(locale, "publishAlreadyFiled") : providerTag(destination.provider);
            return el("label", { class: `sl-dest-row${checked ? " sl-dest-row-selected" : ""}` }, [
              el("input", {
                type: "checkbox",
                checked,
                disabled: filed || submitting,
                onchange: () => handlers.onToggleBinding(item.id, binding)
              }),
              destination.label || binding,
              tag ? el("span", { class: "sl-dest-tag" }, tag) : null
            ]);
          }))
        ])
      : null;

    const refusal = error
      ? el("div", { class: "sl-wizard-error", role: "alert" }, [
          el("p", null, error.message),
          // REQ-017's opt-in is the refusal's own button — the owner takes it
          // deliberately, and nothing else retries with `createNewVersion`.
          error.code === "duplicate_active"
            ? el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onSubmitItem(item.id, true) }, t(locale, "duplicateBlockedNewVersion"))
            : null
        ])
      : null;

    // ONE card: the poster as it will ship, the caption beside it, then
    // every control that decides where and when it ships, ending in this
    // item's own submit — no separate screen between looking at the draft
    // and acting on it.
    return el("div", { class: "sl-preview-card" }, [
      el("header", null, [el("strong", null, item.sourceItem?.sourceLabel || item.sourceItem?.provider || t(locale, "paneSource"))]),
      el("div", { class: "sl-pc-grid" }, [
        // The poster on the secondary surface -- the half that shows what
        // exists, not what to decide. Two columns at 760px and up; stacked
        // below it, poster first.
        el("div", { class: "sl-pc-media" }, [
          el("div", { class: "sl-pc-media-slot", style: `aspect-ratio: ${mediaAspect}` }, [
            // Never the id, and never the caption again either: the
            // header above already carries the item's identity, and the
            // body paragraph below already carries the caption. This slot
            // says exactly one thing when there is no poster to show.
            poster || el("span", { class: "sl-pc-media-empty" }, t(locale, "posterPending"))
          ])
        ]),
        el("div", { class: "sl-pc-body" }, [
        // Finished copy, not a second place to change it -- the drawer is
        // where the caption is edited (composer, protected-literal
        // preview); this card is where it is seen as it will ship and
        // decided on. A quiet way back, not another primary.
        el("div", { class: "sl-pc-caption" }, [
          el("p", null, draft.caption || item.caption || ""),
          el("button", { type: "button", class: "sl-cta", onclick: () => handlers.onEditCaption(item.id) }, t(locale, "editCaption"))
        ]),
        pubRows.length ? el("div", { class: "sl-pc-pubs" }, pubRows) : null,
        picker,
        renderTimingPicker(item.id, choice.intent ?? { publishMode: "save_draft" }, locale, handlers, submitting),
        renderApprovalNote(),
        refusal,
        // A hairline, a reassurance on the left, submit on the right --
        // the item's own submit is this card's one primary.
        destinations.length
          ? el("div", { class: "sl-submit-row" }, [
              el("span", { class: "sl-submit-hint" }, t(locale, "submitHint")),
              el(
                "button",
                {
                  type: "button",
                  class: "sl-primary",
                  disabled: !enabled,
                  title: enabled ? "" : t(locale, "submitBlocked"),
                  onclick: () => handlers.onSubmitItem(item.id, false)
                },
                submitting ? t(locale, "saving") : t(locale, "submitForReview")
              )
            ])
          : null
        ])
      ])
    ]);
  });

  // In normal document flow, not the floating .sl-selection dock -- that
  // dock is for a live selection's own transient action (the Sources
  // tray), not persistent navigation tied to no selection at all. Quiet
  // and secondary: the real action on this screen is a card's own submit
  // row, not this pair.
  const footer = el("div", { class: "sl-page-nav" }, [
    el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onBack() }, t(locale, "back"))
  ]);

  replace(root, [
    el("div", { class: "sl-titleline" }, [el("h1", null, t(locale, "publishTitle")), el("p", null, t(locale, "publishDesc"))]),
    renderWizardError(state),
    destinations.length ? el("div", { class: "sl-review-grid" }, itemCards) : emptyDestinations,
    footer
  ]);
}


