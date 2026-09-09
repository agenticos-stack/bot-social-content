// Social Localization client — the Localize / Review / Publish / Result
// steps (TASK-203), plus the first-run setup screen this gadget owns
// (TASK-302). Pure state/selectors are exported separately from the render
// functions so tests/social-localization-client.test.ts can assert step
// transitions and validation gating without a DOM.

import { detectProtectedLiterals, posterPngConstraints, validateLocalization, validatePosterLayout } from "../../model.js";
import { computePosterLayout, drawPoster, renderPosterPng } from "./poster.js";
import { el, replace } from "./dom.js";
import { t } from "./i18n.js";
import { isEditableItem } from "./inbox.js";

export const STEPS = Object.freeze(["select", "localize", "review", "publish", "result"]);

const POSTER_TEMPLATES = Object.freeze(["1080x1350", "1080x1080"]);
const DEFAULT_BACKGROUND = "#1c1c1e";
const DEFAULT_TEXT_COLOR = "#ffffff";

// ---------------------------------------------------------------------------
// Pure wizard state
// ---------------------------------------------------------------------------

export function createWizardState() {
  return {
    step: "select",
    batch: null, // { id, items: [{ id, sourceItem, destinationBindings, revision, caption, posterLayout, confirmedClaims, approval }] }
    activeItemId: null,
    mobilePane: "source",
    drafts: {}, // batchItemId -> { caption, template, headline, subline, background, textColor, align, confirmedClaims: string[] }
    acknowledged: {}, // last server-confirmed draft per item; browser edits never replace this
    savingByItem: {},
    conflicts: {},
    publishByItem: {}, // batchItemId -> per-destination outcomes from readPublishState()
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
    acceptedVisualMode: item.refinementBrief?.visualTreatment ?? "keep_original"
  };
}

/** Continue (step 1 -> 2): a batch with no items never advances — REQ-006/REQ-013 leave nothing to localize. */
export function setBatch(state, batch) {
  if (!batch || !Array.isArray(batch.items) || !batch.items.length) return state;
  const drafts = {};
  for (const item of batch.items) drafts[item.id] = draftFor(item);
  return { ...state, step: "localize", batch, activeItemId: batch.items[0].id, drafts, acknowledged: Object.fromEntries(batch.items.map((item) => [item.id, drafts[item.id]])), savingByItem: {}, conflicts: {}, publishByItem: {} };
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

// ---------------------------------------------------------------------------
// Pure validation/gating selectors
// ---------------------------------------------------------------------------

/** Runs model.js's validateLocalization for one item against its current draft — the same rule the server enforces on saveRevision(). */
export function computeIssues(item, draft, policy) {
  return validateLocalization({
    source: { text: item.sourceItem?.text ?? "" },
    draft: draft?.caption ?? "",
    policy: { ...policy, confirmedClaims: draft?.confirmedClaims ?? [] },
    limits: item.limits || {}
  });
}

export function hasBlockingIssues(issues) {
  return Array.isArray(issues) && issues.some((issue) => issue.severity === "block");
}

/** REQ-019: an item MUST NOT submit while source rights are pending or denied. */
export function rightsBlockSubmit(rightsStatus) {
  return rightsStatus === "pending" || rightsStatus === "denied";
}

export function submitEnabled(state, policy) {
  if (!state.batch?.items.length || state.submitting || Object.keys(state.conflicts ?? {}).length || dirtyItemIds(state).length || Object.values(state.savingByItem).some(Boolean)) return false;
  return state.batch.items.every((item) => {
    const draft = state.drafts[item.id];
    const issues = computeIssues(item, draft, policy).issues;
    return !hasBlockingIssues(issues) && !rightsBlockSubmit(item.rightsStatus);
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
    rightsPolicy: "require_confirmation",
    notificationPolicy: "immediate",
    quietHoursStart: "",
    quietHoursEnd: "",
    protectedTerms: [],
    protectedHashtags: [],
    disclaimers: [],
    claimsRequiringConfirmation: [],
    refinementBrief: { version: 1, targetLanguage: "zh-HK", register: "written", tone: "", allowedChanges: [], visualTreatment: "keep_original" }
  };
}

/**
 * The stored config, back in the shape the setup form edits.
 *
 * The inverse of `toConfigPayload`, and it exists because setup was a ONE-WAY
 * DOOR: `runSetup` ran only while `!summary.configured`, so cadence, timezone,
 * rights policy and every protected term were set once at first run and could
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
    rightsPolicy: text(config.rightsPolicy) ?? base.rightsPolicy,
    notificationPolicy: text(config.notifications?.mode) ?? text(config.notificationPolicy) ?? base.notificationPolicy,
    // `quietHours` is one nullable object on the wire and two fields in the
    // form; a null there means "no quiet hours", which is two empty strings.
    quietHoursStart: text(config.notifications?.quietHours?.start) ?? text(config.quietHours?.start) ?? "",
    quietHoursEnd: text(config.notifications?.quietHours?.end) ?? text(config.quietHours?.end) ?? "",
    protectedTerms: list(config.protectedTerms) ?? base.protectedTerms,
    protectedHashtags: list(config.protectedHashtags) ?? base.protectedHashtags,
    disclaimers: list(config.disclaimers) ?? base.disclaimers,
    claimsRequiringConfirmation: list(config.claimsRequiringConfirmation) ?? base.claimsRequiringConfirmation,
    refinementBrief: config.refinementBrief ?? base.refinementBrief
  };
}

export function addListEntry(draft, field, value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || !Array.isArray(draft[field]) || draft[field].includes(trimmed)) return draft;
  return { ...draft, [field]: draft[field].concat(trimmed) };
}

export function removeListEntry(draft, field, value) {
  if (!Array.isArray(draft[field])) return draft;
  return { ...draft, [field]: draft[field].filter((entry) => entry !== value) };
}

/** Shapes the setup draft into the setConfig() payload — locale is fixed en -> zh-HK per REQ-007. */
export function toConfigPayload(draft) {
  return {
    ...draft.baseConfig,
    cadence: typeof draft.cadence === "object" && draft.cadence.kind !== "interval" ? { ...draft.cadence, timezone: draft.timezone } : draft.cadence,
    timeZone: draft.timezone,
    timezone: draft.timezone,
    rightsPolicy: draft.rightsPolicy,
    sourceLocale: "en",
    targetLocale: "zh-HK",
    notificationPolicy: draft.notificationPolicy,
    notifications: { mode: draft.notificationPolicy, ...(draft.quietHoursStart && draft.quietHoursEnd ? { quietHours: { start: draft.quietHoursStart, end: draft.quietHoursEnd } } : {}) },
    quietHours: draft.quietHoursStart && draft.quietHoursEnd ? { start: draft.quietHoursStart, end: draft.quietHoursEnd } : null,
    protectedTerms: draft.protectedTerms,
    protectedHashtags: draft.protectedHashtags,
    disclaimers: draft.disclaimers,
    claimsRequiringConfirmation: draft.claimsRequiringConfirmation,
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

function renderTagList(locale, field, values, onAdd, onRemove) {
  const input = el("input", {
    type: "text",
    class: "sl-field-input",
    placeholder: t(locale, "setupAddPlaceholder"),
    onkeydown: (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      onAdd(event.currentTarget.value);
      event.currentTarget.value = "";
    }
  });
  const chips = values.map((value) =>
    el("span", { class: "sl-tag" }, [
      typeof value === "string" ? value : value.value,
      el("button", { type: "button", "aria-label": t(locale, "setupRemove", { value: typeof value === "string" ? value : value.value }), onclick: () => onRemove(value) }, "×")
    ])
  );
  return el("div", { class: "sl-tag-field" }, [el("div", { class: "sl-tag-list" }, chips), input]);
}

/**
 * Public accounts this workspace watches, added by pasting a link.
 *
 * A DIFFERENT SHAPE FROM `renderTagList`, deliberately. A protected term is a
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

  const rows = (state.openSources || []).map((source) =>
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
  );

  return el("div", { class: "sl-open-source-field" }, [
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
  const tags = (key, fieldName) => field(key, renderTagList(locale, fieldName, draft[fieldName],
    value => handlers.onAdd(fieldName, value), value => handlers.onRemove(fieldName, value)));
  const accounts = (key, rows) => el("div", { class: "sl-field" }, [
    el("strong", null, t(locale, key)),
    rows?.length ? el("ul", null, rows.map(row => el("li", null, row.label || row.displayName || row.provider)))
      : note("setupNoConnections")
  ]);
  const brief = draft.refinementBrief || {};
  const updateBrief = patch => handlers.onChange({ refinementBrief: patch });
  const customCadence = typeof draft.cadence === "object";
  const monitoring = summary.config?.monitoringEnabled;
  const sourceSection = section("setupSourcesSection", [
    note("setupSourcesNote"),
    accounts("setupConnectedSources", (summary.sources || []).filter(row => row.origin !== "open")),
    accounts("setupDestinations", summary.destinations),
    field("openSourceLabel", renderOpenSources(locale, ctx, handlers)),
    note("openSourceDesc")
  ]);
  const rulesSection = section("setupRulesSection", [
    note("setupRulesNote"),
    field("setupTone", el("input", { type: "text", maxlength: 120, value: brief.tone || "", onchange: e => updateBrief({ tone: e.currentTarget.value }) })),
    field("setupAllowedChanges", el("textarea", { value: (brief.allowedChanges || []).map(v => typeof v === "string" ? v : v.value).join("\n"), onchange: e => updateBrief({ allowedChanges: e.currentTarget.value.split("\n").filter(Boolean) }) })),
    field("setupVisual", select(brief.visualTreatment || "keep_original", [
      ["keep_original", "setupVisualOriginal"], ["text_poster", "setupVisualPoster"],
      ...(brief.visualTreatment === "ai_refinement" ? [["ai_refinement", "setupVisualExisting"]] : [])
    ], value => updateBrief({ visualTreatment: value }))),
    note("setupVisualNote"),
    field("setupRightsPolicy", select(draft.rightsPolicy, [
      ["require_confirmation", "setupRightsRequireConfirmation"], ["trust_connected", "setupRightsTrustConnected"]
    ], rightsPolicy => handlers.onChange({ rightsPolicy }))),
    note("openSourceRightsNote"),
    field("setupLocale", el("p", null, t(locale, "setupLocaleFixed"))),
    tags("setupProtectedTerms", "protectedTerms"), tags("setupHashtags", "protectedHashtags"),
    tags("setupDisclaimers", "disclaimers"), tags("setupClaims", "claimsRequiringConfirmation")
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
        el("button", { type: "button", class: "sl-primary", disabled: saving, onclick: () => handlers.onSubmit() }, t(locale, saving ? "setupSaving" : "saveChanges")),
        summary.configured ? el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onCancel() }, t(locale, "setupDone")) : null
      ])
    ])
  ]);
  replace(root, [el("div", { class: "sl-titleline" }, [
    el("h1", null, t(locale, editing ? "settingsTitle" : "setupTitle")), note("setupFlow")
  ]), form]);
}

function renderHighlightedSource(text, policy) {
  const spans = detectProtectedLiterals(text, policy);
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, span.start)));
    fragment.appendChild(el("mark", { class: "sl-lit" }, text.slice(span.start, span.end)));
    cursor = span.end;
  }
  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
  return fragment;
}

function renderIssueList(locale, issues, onMark) {
  if (!issues.length) return null;
  return el(
    "ul",
    { class: "sl-issue-list" },
    issues.map((issue) =>
      el("li", { class: `sl-issue sl-issue-${issue.severity}` }, [
        el("span", { class: "sl-issue-badge" }, t(locale, `issueSeverity${issue.severity[0].toUpperCase()}${issue.severity.slice(1)}`)),
        el("p", null, issue.message),
        issue.severity === "confirm" && issue.span
          ? el("button", { type: "button", class: "sl-mark-btn", onclick: () => onMark(issue.span.value) }, t(locale, "markReviewed"))
          : null
      ])
    )
  );
}

function renderPosterEditor(root, item, draft, ctx) {
  const { locale, handlers } = ctx;
  const canvas = el("canvas", { class: "sl-poster-canvas", "aria-label": "Poster preview" });
  const templateButtons = posterTemplatesList().map((template) =>
    el(
      "button",
      {
        type: "button",
        class: "sl-tpl-btn",
        "aria-pressed": String(draft.template === template),
        onclick: () => handlers.onPosterChange({ template })
      },
      t(locale, template === "1080x1350" ? "tplPortrait" : "tplSquare")
    )
  );

  function redraw() {
    const { width, height } = posterPngConstraints(draft.template);
    canvas.width = width;
    canvas.height = height;
    const layout = computePosterLayout({ template: draft.template, headline: draft.headline, subline: draft.subline, align: draft.align });
    const ctx2d = canvas.getContext("2d");
    if (ctx2d) drawPoster(ctx2d, layout, { headline: draft.headline, subline: draft.subline, background: { value: draft.background }, textColor: draft.textColor });
  }
  redraw();

  const layoutCheck = validatePosterLayout({
    template: draft.template,
    headline: draft.headline,
    subline: draft.subline,
    background: { kind: "solid", value: draft.background },
    textColor: draft.textColor,
    align: draft.align
  });

  const editor = el("div", { class: "sl-poster-editor" }, [
    el("h3", null, t(locale, "posterTitle")),
    el("p", { class: "sl-field-note" }, t(locale, "posterHint")),
    el("div", { class: "sl-poster-grid" }, [
      el("div", { class: "sl-template-pick" }, templateButtons),
      el("div", { class: "sl-field-group" }, [
        el("div", { class: "sl-field" }, [
          el("label", null, t(locale, "posterHeadline")),
          el("input", {
            type: "text",
            value: draft.headline,
            onchange: (event) => {
              handlers.onPosterChange({ headline: event.currentTarget.value });
            }
          })
        ]),
        el("div", { class: "sl-field" }, [
          el("label", null, t(locale, "posterSubline")),
          el("input", { type: "text", value: draft.subline, onchange: (event) => handlers.onPosterChange({ subline: event.currentTarget.value }) })
        ]),
        el("div", { class: "sl-field" }, [
          el("label", null, t(locale, "posterBackground")),
          el("input", { type: "color", value: draft.background, onchange: (event) => handlers.onPosterChange({ background: event.currentTarget.value }) })
        ]),
        el("p", { class: "sl-field-note" }, t(locale, "posterNote")),
        el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onSavePoster(item.id) }, t(locale, "posterSave"))
      ]),
      el("div", { class: "sl-poster-preview" }, [canvas])
    ]),
    layoutCheck.ok ? null : el("p", { class: "sl-field-note sl-issue-block" }, layoutCheck.issues.map((issue) => issue.message).join(" "))
  ]);

  root.appendChild(editor);
  handlers.onPosterRedrawReady?.(redraw);
}

function posterTemplatesList() {
  return POSTER_TEMPLATES;
}

function renderPublicationControls(item, draft, locale, handlers) {
  const intent = draft.publicationIntent;
  const change = (patch, redraw = true) => handlers.onDraftChange(item.id, { publicationIntent: { ...patch, latePolicy: "hold" } }, redraw);
  const field = (key, control) => el("label", { class: "sl-field" }, [t(locale, key), control]);
  return el("fieldset", { class: "sl-setup-section" }, [
    el("legend", null, t(locale, "publicationTiming")),
    ...[["save_draft", "publicationDraft"], ["publish_now", "publicationNow"], ["schedule", "publicationSchedule"]].map(([mode, key]) =>
      el("label", { class: "sl-radio" }, [el("input", { type: "radio", name: "publicationMode", checked: intent.publishMode === mode,
        onchange: () => change({ publishMode: mode, publishLocalTime: null, timezone: mode === "schedule" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null, utcOffsetMinutes: null }) }), t(locale, key)])),
    ...(intent.publishMode === "schedule" ? [
      field("publicationLocalTime", el("input", { type: "datetime-local", value: intent.publishLocalTime || "", oninput: e => change({ publishLocalTime: e.currentTarget.value }, false) })),
      field("publicationTimezone", el("input", { type: "text", value: intent.timezone || "", oninput: e => change({ timezone: e.currentTarget.value }, false) })),
      field("publicationOffset", el("input", { type: "number", min: -840, max: 840, value: intent.utcOffsetMinutes ?? "", oninput: e => change({ utcOffsetMinutes: e.currentTarget.value === "" ? null : Number(e.currentTarget.value) }, false) }))
    ] : []),
    el("p", { class: "sl-field-note" }, t(locale, "publicationHint")),
    field("setupVisual", el("select", { onchange: e => handlers.onDraftChange(item.id, { acceptedVisualMode: e.currentTarget.value }) },
      [["keep_original", "setupVisualOriginal"], ["text_poster", "setupVisualPoster"], ...(draft.acceptedVisualMode === "ai_refinement" ? [["ai_refinement", "setupVisualExisting"]] : [])].map(([value, key]) => el("option", { value, selected: draft.acceptedVisualMode === value }, t(locale, key))))),
    el("p", { class: "sl-field-note" }, t(locale, "setupVisualNote"))
  ]);
}

export function renderLocalize(root, state, ctx) {
  const { locale, policy, handlers } = ctx;
  const batch = state.batch;
  if (!batch) return replace(root, []);

  const tabs = el(
    "div",
    { class: "sl-item-tabs", role: "tablist" },
    batch.items.map((item) =>
      el(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": String(item.id === state.activeItemId),
          onclick: () => handlers.onSelectItem(item.id)
        },
        item.sourceItem?.text ? item.sourceItem.text.split("\n")[0].slice(0, 40) : item.id
      )
    )
  );

  const activeItem = batch.items.find((item) => item.id === state.activeItemId) || batch.items[0];
  const draft = state.drafts[activeItem.id];
  const issueResult = computeIssues(activeItem, draft, policy);

  const paneTabs = el("div", { class: "sl-mobile-panes", role: "tablist" }, [
    ["source", t(locale, "paneSource")], ["draft", t(locale, "paneDraft")], ["preview", t(locale, "panePreview")]
  ].map(([pane, label]) => el("button", { type: "button", role: "tab", "aria-selected": String(state.mobilePane === pane), onclick: () => handlers.onMobilePane?.(pane) }, label)));
  const dual = el("div", { class: `sl-dual sl-mobile-pane-${state.mobilePane}` }, [
    el("div", { class: "sl-dual-pane" }, [
      el("header", null, [el("strong", null, t(locale, "sourceHeader"))]),
      el("div", { class: "sl-dual-body" }, [
        el("p", { class: "sl-src-text" }, [renderHighlightedSource(activeItem.sourceItem?.text || "", policy)]),
        el("p", { class: "sl-legend" }, t(locale, "legend"))
      ])
    ]),
    el("div", { class: "sl-dual-pane" }, [
      el("header", null, [el("strong", null, t(locale, "zhHeader")), el("span", { class: "sl-revision-badge" }, t(locale, "revisionBadge", { n: activeItem.revision ?? 0 }))]),
      el("div", { class: "sl-dual-body" }, [
        el("textarea", {
          class: "sl-zh-edit",
          "aria-label": t(locale, "zhEditLabel", { title: activeItem.sourceItem?.text?.slice(0, 30) || activeItem.id }),
          value: draft.caption,
          oninput: (event) => handlers.onDraftChange(activeItem.id, { caption: event.currentTarget.value })
        })
      ])
    ])
  ]);

  const issueList = renderIssueList(locale, issueResult.issues, (claimValue) => handlers.onToggleClaim(activeItem.id, claimValue));

  const posterHost = el("div", { class: `sl-mobile-poster-host${state.mobilePane === "preview" ? " sl-mobile-pane-visible" : ""}` }, []);
  renderPosterEditor(posterHost, activeItem, draft, ctx);

  const savingThis = !!state.savingByItem[activeItem.id];
  const submittable = submitEnabled(state, policy);

  const footer = el("footer", { class: "sl-selection" }, [
    el("div", { class: "sl-selection-inner" }, [
      el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onBack() }, t(locale, "back")),
      el(
        "button",
        {
          type: "button",
          class: "sl-secondary",
          disabled: savingThis || Object.hasOwn(state.conflicts ?? {}, activeItem.id),
          onclick: () => handlers.onSave(activeItem.id)
        },
        savingThis ? t(locale, "saving") : t(locale, "saveChanges")
      ),
      el(
        "button",
        {
          type: "button",
          class: "sl-primary",
          style: "margin-left:auto",
          disabled: !submittable,
          title: submittable ? "" : t(locale, "submitBlocked"),
          onclick: () => handlers.onSubmitForReview()
        },
        t(locale, "submitForReview")
      )
    ])
  ]);

  replace(root, [el("fieldset", { disabled: !!state.submitting, style: "border:0;padding:0;margin:0;min-width:0" }, [
    el("div", { class: "sl-titleline" }, [el("h1", null, t(locale, "localizeTitle")), el("p", null, t(locale, "localizeDesc"))]),
    renderWizardError(state),
    Object.hasOwn(state.conflicts ?? {}, activeItem.id) ? el("section", { class: "sl-wizard-error", "aria-label": t(locale, "conflictTitle") }, [
      el("p", { role: "alert" }, t(locale, "conflictTitle")),
      el("p", null, state.conflicts[activeItem.id]?.caption || t(locale, "conflictUnavailable")),
      isEditableItem(state.conflicts[activeItem.id]) ? el("div", null, [
        el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onResolveConflict(activeItem.id, false) }, t(locale, "conflictReload")),
        el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onResolveConflict(activeItem.id, true) }, t(locale, "conflictKeep"))
      ]) : el("p", null, t(locale, "conflictUnavailable"))
    ]) : null,
    tabs,
    paneTabs,
    dual,
    issueList,
    posterHost,
    renderPublicationControls(activeItem, draft, locale, handlers),
    footer
  ])]);
}

export function renderReview(root, state, ctx) {
  const { locale, handlers, summary } = ctx;
  const batch = state.batch;
  if (!batch) return replace(root, []);

  const destinationLabel = (binding) => {
    const destination = (summary?.destinations || []).find((entry) => entry.destinationBinding === binding || entry.binding === binding);
    return destination?.label || binding;
  };

  const cards = batch.items.flatMap((item) => {
    const draft = state.drafts[item.id];
    return (item.destinationBindings || []).map((binding) =>
      el("div", { class: "sl-preview-card" }, [
        el("header", null, [el("strong", null, destinationLabel(binding))]),
        el("div", { class: "sl-pc-media" }, [el("span", null, draft.headline)]),
        el("div", { class: "sl-pc-body" }, [el("p", null, draft.caption), el("span", { class: "sl-bind-label" }, t(locale, "boundTo", { label: destinationLabel(binding) }))])
      ])
    );
  });

  const approval = batch.approval || null;
  const expired = isApprovalExpired(approval);
  const approvalCard = el("div", { class: `sl-approval-card${expired ? " sl-approval-expired" : ""}` }, [
    el("h3", null, t(locale, expired ? "approvalExpiredTitle" : approval ? "approvalReadyTitle" : "approvalPendingTitle")),
    el("p", null, t(locale, expired ? "approvalExpiredBody" : approval ? "approvalReadyBody" : "approvalPendingBody")),
    approval?.contentHash ? el("span", { class: "sl-hash" }, t(locale, "contentHash", { hash: approval.contentHash })) : null
  ]);

  const footer = el("footer", { class: "sl-selection" }, [
    el("div", { class: "sl-selection-inner" }, [
      el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onBack() }, t(locale, "backToLocalize")),
      el("button", { type: "button", class: "sl-secondary", style: "margin-left:auto", onclick: () => handlers.onContinue() }, t(locale, "continueToPublish"))
    ])
  ]);

  replace(root, [
    el("div", { class: "sl-titleline" }, [el("h1", null, t(locale, "reviewTitle")), el("p", null, t(locale, "reviewDesc"))]),
    renderWizardError(state),
    el("div", { class: "sl-review-grid" }, cards),
    approvalCard,
    footer
  ]);
}

function stateBadge(locale, outcome) {
  const key = { scheduled: "stateScheduled", published: "statePublished", failed_safe: "stateFailed", unknown: "stateUnknown" }[outcome] || "stateUnknown";
  return el("span", { class: `sl-state-badge sl-state-${outcome}` }, t(locale, key));
}

export function renderPublish(root, state, ctx) {
  const { locale, handlers } = ctx;
  const batch = state.batch;
  if (!batch) return replace(root, []);

  const rows = batch.items.flatMap((item) => {
    const publishState = state.publishByItem[item.id];
    const targets = publishState?.targets || [];
    return targets.map((target) =>
      el("div", { class: "sl-target-row" }, [
        el("div", { class: "sl-who" }, [el("strong", null, target.label || target.destinationBinding), target.detail ? el("span", null, target.detail) : null]),
        stateBadge(locale, target.outcome),
        target.outcome === "published" && target.receiptUrl
          ? el("a", { class: "sl-receipt", href: target.receiptUrl, target: "_blank", rel: "noopener noreferrer" }, t(locale, "viewReceipt"))
          : target.outcome === "failed_safe"
            ? el("button", { type: "button", class: "sl-cta", onclick: () => handlers.onRetry(item.id, target.destinationBinding) }, t(locale, "retry"))
            : target.outcome === "unknown"
              ? el("button", { type: "button", class: "sl-cta", onclick: () => handlers.onCheckManually(item.id, target.destinationBinding) }, t(locale, "checkManually"))
              : null,
        target.guidance ? el("p", { class: "sl-guidance" }, target.guidance) : target.outcome === "unknown" ? el("p", { class: "sl-guidance" }, t(locale, "unknownGuidance")) : null
      ])
    );
  });

  const footer = el("footer", { class: "sl-selection" }, [
    el("div", { class: "sl-selection-inner" }, [
      el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onBack() }, t(locale, "backToReview")),
      el("button", { type: "button", class: "sl-primary", style: "margin-left:auto", onclick: () => handlers.onViewSummary() }, t(locale, "viewSummary"))
    ])
  ]);

  replace(root, [
    el("div", { class: "sl-titleline" }, [el("h1", null, t(locale, "publishTitle")), el("p", null, t(locale, "publishDesc"))]),
    renderWizardError(state),
    rows.length ? el("div", null, rows) : el("p", null, t(locale, "loading")),
    footer
  ]);
}

export function renderResult(root, state, ctx) {
  const { locale, handlers } = ctx;
  const batch = state.batch;
  if (!batch) return replace(root, []);

  const items = batch.items.map((item) => {
    const publishState = state.publishByItem[item.id];
    const outcomes = (publishState?.targets || []).map((target) => stateBadge(locale, target.outcome));
    return el("div", { class: "sl-result-item" }, [
      el("strong", null, item.sourceItem?.text ? item.sourceItem.text.split("\n")[0].slice(0, 60) : item.id),
      el("div", { class: "sl-outcomes" }, outcomes)
    ]);
  });

  const exportRow = el("div", { class: "sl-export-row" }, [
    el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onExport("json") }, t(locale, "exportJson")),
    el("button", { type: "button", class: "sl-secondary", onclick: () => handlers.onExport("html") }, t(locale, "exportHtml"))
  ]);

  replace(root, [
    el("div", { class: "sl-titleline" }, [el("h1", null, t(locale, "resultTitle"))]),
    el("div", { class: "sl-result-summary" }, items),
    el("p", { class: "sl-result-note" }, t(locale, "resultNote")),
    exportRow,
    el("button", { type: "button", class: "sl-primary", onclick: () => handlers.onStartAnother() }, t(locale, "startAnother"))
  ]);
}

export { renderPosterPng };
