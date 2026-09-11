// Social Localization blueprint — server.js (TASK-202).
//
// The facet class: storage (REQ-031), the scan hook (REQ-012/013), and the
// batch/revision/publish surface the client and the agent call through
// `readGadget` / `callGadgetMethod` (CON-010). Everything specific to this
// blueprint lives here and in its sibling files — nothing in `workers/api/src`
// names Social Localization (REQ-029).
//
// FILE SHAPE (PAT-002): `model.js` is pure normalization/validation, shared
// unchanged by client and server. `storage.js` is the one seam onto
// `ctx.storage.sql`. `config.js` is pure config validation. `doors.js` is
// every door call. This file wires them together and is the only one that
// touches `this.ctx` or `this.env`.
//
// A NOTE ON MULTI-FILE IMPORTS. `WorkspaceCodeStore.readFiles` (the live-edit
// path) and `readBlueprintArchive` (the packed `.gadget` path) both hand
// `loadGadget` EVERY file of the gadget, not just `client.js` / `server.js` —
// `readBlueprintArchive` even refuses a filename containing "/", so a
// `src/server/server.js` layout could not survive being packed. The shipped
// `dashboard` blueprint's `server.js` already does `import ... from
// "./model.js"` on this exact path. So this file and its siblings are flat,
// not bundled: the runtime resolves `./model.js`, `./storage.js`,
// `./config.js` and `./doors.js` as separate modules, same as `model.js`'s
// own header already assumes ("bundled unchanged into both the sandboxed
// client and the facet server").
//
// REFUSAL VS THROW (output-gate fix, api PR #1496/#1502 CI evidence:
// `workerd/api/actor-state.c++:1187: failed: broken.outputGateBroken`).
// This class runs as a `ctx.facets` target — the same mechanism
// `WorkspaceRoom.gadgetFacet()` uses in production, proven in
// `tests/v2-social-localization-server.workers.test.ts` via
// `test-worker/gadget-facet-harness.ts`'s generic facet host — and every
// method call crosses a real Durable Object RPC boundary to reach it, not a
// plain function call. workerd logs "uncaught exception" for ANY exception
// that unwinds across that boundary, whether or not the caller's own
// `try/catch` (or a test's `rejects.toThrow`) ends up catching the resulting
// rejected promise — a minimal repro (one facet method that throws, called
// twice) proved this: the vitest assertion passed both times, and workerd
// still logged the throw as an uncaught exception each time. Enough of these
// across one test run leaves an actor with a broken output gate, which is
// what turns a suite where every reported test passes into a job that still
// fails: the crash surfaces during runtime teardown, after the JSON reporter
// has already written "success": true for every file.
//
// A `throw` in a facet method is therefore never the right way to answer a
// condition an owner can hit through ordinary use of this gadget — an
// unresolved destination, a stale revision, a
// missing batch item, a rejected poster upload, a provider outage. Those
// answer with a VALUE instead, the same idiom the platform's own doors
// already use for an expected refusal
// (`workers/api/src/domains/gadgets/connector-door.ts`, `social-door.ts`):
// `{ ok: false, code, message }`, or — for `saveRevision` / `savePoster`,
// which already had a validation-issues envelope — `{ ok: false, issues:
// [{ code, severity, message }] }`, so a newly-converted "batch item not
// found" case reads the same way as the validator's own refusals. A
// successful call keeps returning whatever bare value it always returned
// (no `{ ok: true, ... }` wrapper was added) — `ok: false` is the only
// refusal marker, never inferred from a shape change on success.
//
// NOTHING IN A FACET METHOD THROWS ANYMORE, INCLUDING A GENUINE CALLER BUG.
// The first pass here kept two throws for conditions no UI caller could
// produce (`savePoster` with no bytes at all; an unknown status literal on a
// rights call) on the reasoning that a real programming
// error is different from an owner-facing condition. It is not, at this
// boundary: a workerd test exercising exactly those two throws through this
// same facet harness — nothing else — reproduced the identical failure this
// whole fix exists to remove, `Test Files 11 passed / Tests 117 passed`
// alongside two `Unhandled Rejection`s reading "savePoster needs PNG
// bytes..." and the rights-status variant, `exit 1`. Removing just
// those two tests (`it.skip`) made the same suite exit 0. A throw is
// dangerous here because of WHERE it is, not why it happened — so an
// invariant violation now returns `{ ok: false, code: "invalid_argument",
// ... }` (or the matching `issues` shape for `savePoster`) like everything
// else, and a caller that hits one has a real bug to fix, signalled by the
// code rather than by an exception.
import { DurableObject } from "cloudflare:workers";
import {
  boundExport,
  detectProtectedLiterals,
  exportBounds,
  normalizeFacebookPagePosts,
  normalizeInstagramMedia,
  normalizeAssetRefs,
  normalizeProtectedOverrides,
  normalizePublicationIntent,
  normalizeRefinementBrief,
  normalizeLedger,
  applyProtectedOverridesToLedger,
  draftOrigin,

  posterPngConstraints,
  validatePosterLayout,
  validateRevisionDraft,
  normalizeOpenInstagramPosts,
  publicationMedia,
  resolveOpenSource,
  openSourceBinding
} from "./model.js";
import { Storage } from "./storage.js";
import {
  isWithinQuietHours,
  localDay,
  normalizeBindingList,
  normalizeConfig,
  scheduleStateFrom,
  wallClockHHMM
} from "./config.js";
import {
  FIXED_DOOR_KEYS as FIXED_DOOR_KEY_LIST,
  doorGrantStatus,
  fetchMedia,
  isDoorRefusal,
  listFacebookPagePosts,
  listInstagramMedia,
  notify,
  scheduleCancel,
  scheduleCreate,
  scheduleList,
  socialCreateDraft,
  socialReadStatus,
  socialSubmitForReview,
  listOpenAccountPosts,
  mediaUrlFor
} from "./doors.js";

/**
 * The fixed doors every instance of this blueprint may be granted
 * (TASK-205's door requirements). Everything else in `env` is a connector
 * binding — a source or a destination the owner named at grant time
 * (REQ-030, TASK-101's `env.<label slug>`).
 *
 * Sourced from `doors.js`'s own `FIXED_DOOR_KEYS` (Finding D) rather than
 * repeated here: the platform binds a fixed capability door under its own
 * lowercase requirement key (`env.social` / `env.schedule` / `env.workspace`
 * — see `doors.js`'s header note), never an uppercased guess, and this Set
 * only ever needs to agree with that one export.
 */
const FIXED_DOOR_KEYS = new Set(FIXED_DOOR_KEY_LIST);

const SCAN_HOOK_NAME = "scan";
const MAX_ITEMS_PER_SOURCE = 100; // REQ-013
const PAGE_SIZE = 25; // one connector call's `limit` — small enough to isolate a mid-scan failure to a few items
const STALE_RUN_MS = 5 * 60 * 1000; // a "running" scan_runs row older than this is a crash, not a live overlap

/*
 * SEC-004. Matched to the media door's own thumb cap, deliberately.
 *
 * "Thumb" is not a smaller picture here: Instagram's payload carries exactly
 * one `image_versions2.candidate` per photo, so a thumb IS the full-size file
 * and there is nothing smaller to ask the door for. At 256 KiB this cache
 * refused two of the first twelve photos from a real account -- the two
 * largest, which are the two a grid most wants to show.
 *
 * Kept equal to `MEDIA_FETCH_THUMB_MAX_BYTES` in the API's media door. A
 * cache cap below the door's turns bytes that were fetched and paid for into
 * a refusal here; one above it can never be reached. Move both or neither.
 */
const THUMB_MAX_BYTES = 512 * 1024;
const PREVIEW_MAX_BYTES = 1024 * 1024; // SEC-004
const PREVIEW_CHUNK_BYTES = 1024 * 1024; // CON-007: chunk anything above 1 MiB

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The schedule door deliberately returns a human-readable cadence string, not
 * its stored object. Keep the comparison at this boundary in the same shape
 * as that public door contract; the object fallback preserves compatibility
 * with older local harnesses that returned the stored cadence directly.
 */
function cadenceDescription(cadence) {
  if (!cadence || typeof cadence !== "object") return null;
  if (cadence.kind === "interval" && Number.isInteger(cadence.everyMinutes)) {
    return `every ${cadence.everyMinutes} minutes`;
  }
  if (cadence.kind === "daily" && typeof cadence.at === "string" && typeof cadence.timezone === "string") {
    return `daily at ${cadence.at} ${cadence.timezone}`;
  }
  if (
    cadence.kind === "weekly" &&
    Number.isInteger(cadence.weekday) &&
    cadence.weekday >= 0 &&
    cadence.weekday < WEEKDAY_NAMES.length &&
    typeof cadence.at === "string" &&
    typeof cadence.timezone === "string"
  ) {
    return `every ${WEEKDAY_NAMES[cadence.weekday]} at ${cadence.at} ${cadence.timezone}`;
  }
  return null;
}

function cadenceMatches(schedule, cadence) {
  if (typeof schedule?.cadence === "string") return schedule.cadence === cadenceDescription(cadence);
  return JSON.stringify(schedule?.cadence) === JSON.stringify(cadence);
}

/**
 * Provider -> everything that is provider-specific about reading it: the
 * `doors.js` wrapper that calls its connector door read action, and the
 * `model.js` normalizer that turns its response into `SourceItem`s.
 *
 * ONE TABLE, ONE LOOKUP (PAT-003). This used to be a map of list functions
 * plus, a few lines into `scanOneSource`, a second dispatch on the same value
 * — a ternary comparing the provider against Instagram and otherwise
 * choosing the Facebook normalizer. Two lookups on one value is two models of
 * the provider set, and that ternary's fallback branch was Facebook: adding a
 * third provider to the map alone would list it correctly and normalize it as
 * Facebook, with nothing failing. REQ-003 says a new provider must be "a new
 * pinned action behind the connector door and a normalizer case in the
 * gadget's `model.js`" — this is that case, and there is now one place to
 * add it.
 */
/**
 * One dispatch table, two ways in (PAT-003).
 *
 * `list`/`normalize` read an account this organisation HOLDS, through its
 * connector grant. `openList`/`openNormalize` read a PUBLIC account it does
 * not, through the metered fetch door. Same platform, same stored item shape,
 * different authority and a different wire format — which is why the
 * normalizers cannot be shared: the broker relays Instagram's own Polaris
 * shape, not the Graph API's.
 *
 * A platform with no `openList` simply cannot be watched openly; the scan says
 * so rather than falling back to the connector reader, which would try to use
 * a grant that does not exist.
 */
const PROVIDERS = {
  instagram: {
    list: listInstagramMedia,
    normalize: normalizeInstagramMedia,
    openList: listOpenAccountPosts,
    openNormalize: normalizeOpenInstagramPosts
  },
  facebook: { list: listFacebookPagePosts, normalize: normalizeFacebookPagePosts }
};

export class Gadget extends DurableObject {
  static hooks = {
    scan: "Reads each granted source for new posts on the armed cadence and stores what changed."
  };

  static readMethods = [
    "summary",
    "listItems",
    "getItem",
    "getMedia",
    "getBatch",
    "listBatches",
    "listBatchSummaries",
    "readPublishState",
    "scanRuns",
    "exportAs"
  ];

  constructor(ctx, env) {
    super(ctx, env);
    this.storage = new Storage(ctx);
    this.storage.migrate();
    this.subscribers = new Map();
    /*
     * RPC calls may overlap at await points. Chain mutations so each
     * operation observes and commits one authoritative state in strict
     * order — the same serial lane the workspace-docs blueprint carries.
     * A read-then-write split across an `await` (`saveConfiguration`
     * derives bindings behind door calls before writing; `submitForReview`
     * files publications after them) is exactly the shape that corrupts
     * under a 4-way pool, and no `transactionSync` reaches across an await.
     */
    this.mutationQueue = Promise.resolve();
  }

  enqueueMutation(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  // -----------------------------------------------------------------------
  // setup / summary (REQ-032)
  // -----------------------------------------------------------------------

  async summary() {
    const config = this.storage.getConfig();
    const sources = await this.describeRows(this.storage.listSources());
    const destinations = await this.describeRows(this.storage.listDestinations());

    const counts = this.storage.countItems();
    const schedules = await scheduleList(this.env);
    const scanSchedule = schedules.find((schedule) => schedule.hook === SCAN_HOOK_NAME) ?? null;

    return {
      configured: Boolean(config),
      config,
      sources,
      destinations,
      counts,
      schedule: {
        state: scheduleStateFrom(scanSchedule),
        nextRunAt: scanSchedule ? scanSchedule.nextRunAt : null
      },
      // Finding D: whether each fixed capability door is granted, read
      // straight off `this.env` rather than inferred from anything that
      // tried and failed. `false` here is what "not granted" looks like —
      // never a silent `unknown` only a server-side console.warn recorded.
      doors: doorGrantStatus(this.env),
      lastScanAt: this.storage.lastCompletedScanAt(),
      // What first-run (TASK-302) offers the owner to assign as a source or a
      // destination: every granted door this class does not already know the
      // meaning of. Never inferred from a name — REQ-016 — only from
      // `describe()` when the door offers one.
      availableConnectorBindings: this.availableConnectorBindings()
    };
  }

  availableConnectorBindings() {
    return Object.keys(this.env || {}).filter((key) => !FIXED_DOOR_KEYS.has(key));
  }

  /**
   * REQ-016's facts, as the door reported them.
   *
   * READ FROM STORAGE, NOT RE-FETCHED. The description is captured once, when
   * the binding is configured (`describedBindings` below), and kept beside
   * the row — so `summary()` is not one door round-trip per binding on every
   * open, and so a door that has gone quiet does not make the provider's
   * caption limit vanish from a screen that was showing it a minute ago.
   *
   * Every field the door did not report stays null and renders as
   * unavailable, never as zero (GUD-003). This used to keep exactly one
   * field, `glyph`, which the door does not have — it reports `glyphKey` —
   * so the value was always null and every other fact was dropped on the
   * floor, including the caption limit REQ-016 exists for.
   */
  async describeRows(rows) {
    return rows.map((row) => {
      const description = row.describe ?? null;
      const mediaLimits = description?.mediaLimits;
      return {
        binding: row.binding,
        origin: row.origin ?? "binding",
        displayName: row.displayName ?? null,
        lastServedBy: row.lastServedBy ?? null,
        lastCostCredits: row.lastCostCredits ?? null,
        label: row.label,
        provider: row.provider,
        glyphKey: readString(description?.glyphKey),
        providerLabel: readString(description?.providerLabel),
        supportedSourceFormats: readStringArray(description?.supportedSourceFormats),
        supportedDestinationFormats: readStringArray(description?.supportedDestinationFormats),
        captionLimit: readNumber(description?.captionLimit),
        mediaLimits: mediaLimits
          ? { imageBytes: readNumber(mediaLimits.imageBytes), videoBytes: readNumber(mediaLimits.videoBytes) }
          : null,
        nativeScheduling: typeof description?.nativeScheduling === "boolean" ? description.nativeScheduling : null,
        reportedMetrics: readStringArray(description?.reportedMetrics),
        lastCheckedAt: row.lastCheckedAt ?? null,
        lastOutcome: row.lastOutcome ?? null,
        message: row.lastMessage ?? null
      };
    });
  }

  /**
   * `record.sources` / `.destinations` are OPTIONAL: the client's own
   * `toConfigPayload` (`src/client/steps.js`) sends only policy fields —
   * cadence, timezone, locale, notifications, protected-term
   * lists — never a binding list, because door grants (TASK-301's setup
   * screen) already establish which connectors this instance holds before
   * this gadget's own first-run screen runs. When the caller omits them, the
   * granted connector bindings are derived and split by the ROLE each door
   * states for itself (`deriveBindingsFromGrants`). An explicit `sources` /
   * `destinations` array — a future richer setup screen, or a test — is still
   * validated strictly (REQ-002: 1 to 20, unique bindings).
   */
  setConfig(input) {
    // Compatibility: old installed clients coupled Save to starting monitoring.
    return this.enqueueMutation(async () => {
      try { return await this.saveConfiguration(input, true); }
      catch (error) { return { ok: false, message: errorMessage(error) }; }
    });
  }

  saveSetup(input) {
    // The mutation lane serialises this against any monitoring change still
    // in flight — the old `monitoringChanging` flag's job, done by ordering.
    return this.enqueueMutation(async () => {
      try { return await this.saveConfiguration(input, false); }
      catch (error) { return { ok: false, message: errorMessage(error) }; }
    });
  }

  async saveConfiguration(input, legacyActivation) {
    const record = input && typeof input === "object" ? input : {};
    const previous = this.storage.getConfig();
    const config = {
      ...normalizeConfig(record),
      // A caller cannot enable monitoring by smuggling this field into Save.
      monitoringEnabled: previous ? previous.monitoringEnabled !== false : legacyActivation
    };
    const derived = (legacyActivation || !previous) && (record.sources === undefined || record.destinations === undefined)
      ? await this.deriveBindingsFromGrants() : null;
    const sources =
      record.sources !== undefined
        ? await this.describedBindings(normalizeBindingList(record.sources, "sources"))
        : derived?.sources;
    const destinations =
      record.destinations !== undefined
        ? await this.describedBindings(normalizeBindingList(record.destinations, "destinations"))
        : derived?.destinations;

    this.storage.setConfig(config);
    if (sources) this.storage.setSources(sources);
    if (destinations) this.storage.setDestinations(destinations);
    if (legacyActivation) await this.armSchedule(config.cadence, config.timeZone);

    return this.summary();
  }

  setMonitoring(enabled) {
    return this.enqueueMutation(async () => {
      try { return await this.changeMonitoring(enabled); }
      catch (error) { return { ok: false, message: errorMessage(error) }; }
    });
  }

  async changeMonitoring(enabled) {
    const config = this.storage.getConfig();
    if (!config || typeof enabled !== "boolean") {
      return { ok: false, message: "Save setup first, then explicitly enable or pause monitoring." };
    }
    if (!enabled) {
      // Stop execution first, even if cancelling a remote schedule needs approval.
      this.storage.setConfig({ ...config, monitoringEnabled: false });
      try {
        for (const row of await scheduleList(this.env)) {
          if (row.hook !== SCAN_HOOK_NAME || row.status === "cancelled") continue;
          const cancelled = await scheduleCancel(this.env, row.id);
          if (cancelled?.cancelled !== true) {
            return {
              ok: false,
              message: "Monitoring is paused locally. Resolve the existing schedule before cleaning it up."
            };
          }
        }
      } catch (error) {
        return { ok: false, message: `Monitoring is paused locally. Schedule cleanup: ${errorMessage(error)}` };
      }
      return { ok: true, summary: await this.summary() };
    }
    try {
      const schedules = (await scheduleList(this.env)).filter(row => row.hook === SCAN_HOOK_NAME && row.status !== "cancelled");
      if (schedules.length === 1 && schedules[0].status === "active" && cadenceMatches(schedules[0], config.cadence)) {
        this.storage.setConfig({ ...config, monitoringEnabled: true });
        return { ok: true, summary: await this.summary() };
      }
      // Do not create a second live scan schedule when applying a changed cadence.
      this.storage.setConfig({ ...config, monitoringEnabled: false });
      for (const row of schedules) {
        const cancelled = await scheduleCancel(this.env, row.id);
        if (cancelled?.cancelled !== true) return { ok: false, message: "Monitoring is paused. Resolve the existing schedule before applying a new cadence." };
      }
      const schedule = await scheduleCreate(this.env, SCAN_HOOK_NAME, config.cadence);
      if (!schedule?.id) return { ok: false, message: "Monitoring is not enabled. Complete the schedule decision in the workspace, then retry." };
      this.storage.setConfig({ ...config, monitoringEnabled: true });
      return { ok: true, summary: await this.summary() };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  /**
   * The granted connector bindings, split into sources and destinations by
   * the ROLE each door states (REQ-002, REQ-016).
   *
   * THE ROLE COMES FROM THE DOOR, NOT FROM THE NAME. A grant made against a
   * family requirement is stored under `${requirementKey}:<slug>` and the
   * platform strips that prefix before the gadget sees the env name
   * (`gatekeeperEnvKey`), so nothing in `env` says which part a binding
   * plays. `describe()` states it: `role` is the satisfied requirement's own
   * declared role, resolved where the definition and the grant are both in
   * hand. Reversing the env name, or reading a provider name and deciding
   * Instagram must be a source, would be a second copy of the setup screen's
   * decision kept where it cannot see that decision change.
   *
   * A DOOR THAT STATES NO ROLE GETS TODAY'S PERMISSIVE BEHAVIOUR — that
   * binding, and only that binding, is offered as both. `role: null` means
   * the requirement declared none; it does not mean "work it out". Every
   * binding was in both lists before this, which is how one provider's
   * caption limit (`limitsForDestinations`) came to be enforced against
   * another provider's channel and how REQ-017's duplicate pair key came to
   * be computed over the union of every grant.
   */
  async deriveBindingsFromGrants() {
    const sources = [];
    const destinations = [];
    for (const binding of this.availableConnectorBindings()) {
      const describe = await describeConnector(this.env, binding);
      const provider = readString(describe?.provider);
      if (!provider) continue; // scanning needs a known provider; skip rather than guess (REQ-016)
      const row = { binding, label: describeLabel(describe, binding), provider, describe };
      // Stated as two exclusions rather than three cases on purpose: a role
      // this blueprint does not recognise is as good as none — the permissive
      // case — never a silently dropped binding the owner did grant.
      const role = readString(describe?.role);
      if (role !== "destination") sources.push(row);
      if (role !== "source") destinations.push(row);
    }
    return { sources, destinations };
  }

  /**
   * REQ-016 at grant/first-run time: ask each binding's door what it is, once,
   * and keep the answer with the row. A binding the caller named explicitly
   * (a richer setup screen, or a test) gets the same treatment as a derived
   * one — the requirement is about where the facts COME FROM, not about which
   * code path put the binding in the list.
   *
   * A door that answers nothing leaves `describe` null; the row is still
   * stored, because the owner did grant it and its provider was stated.
   */
  async describedBindings(rows) {
    const described = [];
    for (const row of rows) {
      const describe = await describeConnector(this.env, row.binding);
      described.push({ ...row, describe, label: row.label || describeLabel(describe, row.binding) });
    }
    return described;
  }

  /**
   * A connector granted AFTER first setup (TASK-020).
   *
   * `deriveBindingsFromGrants` ran only inside `saveConfiguration`, and there
   * only on the legacy `setConfig` path or while no config existed — and the
   * settings form's payload (`toConfigPayload`) has never carried `sources`
   * or `destinations`. So a door granted later never appeared: the lists
   * `summary()` reports are read from storage, and nothing after first setup
   * ever wrote to them.
   *
   * ADDITIVE, and only additive. A granted-but-unstored binding is inserted;
   * every row already stored keeps its cursor, scan history and describe
   * exactly as they are. It does not touch the config, does not arm or alter
   * a schedule, and does not remove a revoked grant either — a revoked door's
   * row stays so the items it produced still name their source, and
   * `summary().doors` is what reports it gone.
   */
  refreshGrants() {
    return this.enqueueMutation(() => this.refreshGrantsLocked());
  }

  async refreshGrantsLocked() {
    const derived = await this.deriveBindingsFromGrants();
    const knownSources = new Set(this.storage.listSources().map((row) => row.binding));
    const knownDestinations = new Set(this.storage.listDestinations().map((row) => row.binding));
    const addedSources = derived.sources.filter((row) => !knownSources.has(row.binding));
    const addedDestinations = derived.destinations.filter((row) => !knownDestinations.has(row.binding));
    this.ctx.storage.transactionSync(() => {
      for (const source of addedSources) this.storage.addSourceBinding(source);
      for (const destination of addedDestinations) this.storage.addDestinationBinding(destination);
    });
    return {
      ok: true,
      added: {
        sources: addedSources.map((row) => ({ binding: row.binding, label: row.label, provider: row.provider })),
        destinations: addedDestinations.map((row) => ({ binding: row.binding, label: row.label, provider: row.provider }))
      },
      summary: await this.summary()
    };
  }

  async armSchedule(cadence, timeZone) {
    const withZone = cadence.kind === "interval" ? cadence : { ...cadence, timezone: cadence.timezone || timeZone };
    try {
      await scheduleCreate(this.env, SCAN_HOOK_NAME, withZone);
    } catch (error) {
      // `create` is `deploy`-authority (gatekeeper-kinds.ts): the door raises
      // it as a submission rather than completing inline, so a rejection or
      // an absent door must not fail setup outright. `summary().schedule`
      // shows "unarmed" until it is granted/approved.
      console.warn("social-localization: could not arm the scan schedule:", errorMessage(error));
    }
  }

  async cancelSchedule(scheduleId) {
    return scheduleCancel(this.env, scheduleId);
  }

  /**
   * Watch a PUBLIC account, named by a link the owner pasted.
   *
   * NOT a read: it changes what this gadget will fetch, and every fetch after
   * it costs money. Resolution happens here, before anything is stored, so an
   * owner learns "that link does not name an account" while they are looking
   * at the form — rather than at 09:00 tomorrow, from a scan that failed, with
   * no way to tell a typo from an account that went private.
   *
   * Refuses by value like everything else in this facet: a throw over RPC
   * breaks the Durable Object output gate and poisons the actor.
   */
  addOpenSource(link) {
    return this.enqueueMutation(() => this.addOpenSourceLocked(link));
  }

  async addOpenSourceLocked(link) {
    const resolved = resolveOpenSource(link);
    if (!resolved.ok) return resolved;

    const provider = PROVIDERS[resolved.platform];
    if (!provider?.openList) {
      return {
        ok: false,
        code: "unsupported_platform",
        message: `Public accounts cannot be watched on ${resolved.platform} yet.`
      };
    }

    const binding = openSourceBinding(resolved.platform, resolved.accountKey);
    const { added, source } = this.storage.addOpenSource({
      binding,
      platform: resolved.platform,
      accountKey: resolved.accountKey,
      displayName: resolved.displayName
    });
    // `added: false` is not an error — an owner pasting a link they already
    // added should get the source they already have, with its cursor intact,
    // rather than a rescan from the top or a complaint.
    return { ok: true, added, source: { binding: source.binding, displayName: source.displayName } };
  }

  /** Stop watching a public account. Its stored items are left alone. */
  removeOpenSource(binding) {
    return this.enqueueMutation(() => this.removeOpenSourceLocked(binding));
  }

  async removeOpenSourceLocked(binding) {
    const source = this.storage.getSource(binding);
    if (!source || source.origin !== "open") {
      return { ok: false, code: "not_open_source", message: "That is not a public account this workspace watches." };
    }
    this.storage.removeSource(binding);
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // scan (REQ-012, REQ-013, hook)
  // -----------------------------------------------------------------------

  /**
   * The scan ledger and what it adds up to.
   *
   * `summary()` answers "when did a scan last complete". Nobody could ask
   * "have they been completing", and that is the number the release criteria
   * are stated in.
   *
   * THE RATE IS OVER SOURCE SCANS, NOT RUNS, and the first version of this
   * method got that wrong in a way that made the threshold incapable of
   * failing. `status` describes the RUN: `finishScanRun` writes `failed` only
   * when handed an `error`, and the normal path never hands it one, so a run
   * in which every source failed was recorded `completed`. A rate built from
   * `status` therefore read 1.0 through a total provider outage. The unit the
   * criterion means is the source scan — each source, in each run, either
   * confirmed, failed safe, or came back unclassified.
   *
   * "Excluding provider outages" is then subtraction from the DENOMINATOR: a
   * source whose provider call threw is removed rather than scored, because
   * counting it as success would carry a broken scan over the line and
   * counting it as failure would hold a release for something nobody here can
   * fix. `unclassified` stays in the denominator on purpose — an outcome
   * nothing could classify is our problem, and the canary holds it at zero
   * separately.
   *
   * A READ, and declared as one: it reports what happened and changes
   * nothing, so an agent may call it without stopping to ask.
   *
   * `successRate` is null, never 1, when nothing eligible was attempted, and
   * runs written before schema 4 are skipped rather than assumed clean —
   * "nothing has happened yet" and "everything worked" must not clear the same
   * threshold.
   */
  async scanRuns({ since = null, limit = 200 } = {}) {
    const runs = this.storage.listScanRuns({ since, limit });

    let confirmed = 0;
    let providerFailures = 0;
    let unclassified = 0;
    let counted = 0;
    for (const run of runs) {
      // A run from before schema 4 has no per-source counts. It is left out of
      // the rate entirely rather than assumed clean — the whole defect being
      // fixed here was a threshold that could only read as success.
      if (run.source_count === null || run.source_count === undefined) continue;
      counted += 1;
      const failedSafe = run.failed_safe_count ?? 0;
      const unknown = run.unknown_count ?? 0;
      providerFailures += failedSafe;
      unclassified += unknown;
      confirmed += Math.max(0, run.source_count - failedSafe - unknown);
    }

    // "excluding provider outages": a source whose provider call threw is
    // removed from the denominator, not scored either way. What remains is the
    // work this gadget was actually responsible for.
    const eligible = confirmed + unclassified;

    return {
      since,
      runs: runs.map((run) => ({
        runId: run.run_id,
        status: run.status,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        sourceCount: run.source_count ?? null,
        newCount: run.new_count,
        changedCount: run.changed_count,
        failedSafeCount: run.failed_safe_count,
        unknownCount: run.unknown_count ?? null,
        error: run.error
      })),
      totals: {
        runs: runs.length,
        runsCounted: counted,
        completed: runs.filter((run) => run.status === "completed").length,
        failed: runs.filter((run) => run.status === "failed").length,
        running: runs.filter((run) => run.status === "running").length,
        // The three numbers the release threshold is stated in. `status` is
        // about the RUN; these are about the SOURCE SCANS inside it, which is
        // the unit "scan success >= 99 % excluding provider outages" means.
        sourceScans: confirmed + providerFailures + unclassified,
        confirmed,
        providerFailures,
        unclassified,
        // Null, never 1, when nothing eligible was attempted: "nothing has
        // happened yet" and "everything worked" must not clear one threshold.
        successRate: eligible > 0 ? confirmed / eligible : null
      }
    };
  }

  /**
   * The owner's "check now". Same code path as the hook (`runScan`), a fresh
   * `runId` each time so a manual refresh is never mistaken for a retry of
   * the last one.
   */
  refresh() {
    return this.enqueueMutation(() => this.runScan(`manual:${crypto.randomUUID()}`));
  }

  /**
   * The scheduled hook. REQ-012: "each firing carries a `runId` that is
   * stable across retries and the gadget keys its idempotency on it".
   *
   * `schedule-room-invoker.ts` posts one argument, the firing descriptor
   * `{ runId, scheduleId, hook, firedFor }`, where `runId` is the fence's own
   * run key (`runKeyFor(scheduleId, fireAt)` — the schedule and the instant
   * it was due). A retried alarm for the same occurrence carries the same
   * string, so `runScan`'s `scan_runs` primary key turns the second firing
   * into "this run already happened" rather than a second scan.
   *
   * This used to mint `hook:${crypto.randomUUID()}` because the invoker sent
   * no arguments at all: a different id on every call, which recognises
   * nothing, so the guard could never fire and a retried alarm scanned twice.
   *
   * A firing with no `runId` still runs. That is a hook called by hand, or by
   * a host that has not been updated, and refusing it would be worse than
   * running it — the item-level idempotency underneath (REQ-013's
   * `UNIQUE(source_binding, provider_item_id)` upsert) still holds either way.
   */
  scan(firing) {
    return this.enqueueMutation(() => {
      if (this.storage.getConfig()?.monitoringEnabled === false) {
        return { skipped: true, reason: "Monitoring is paused." };
      }
      const runId = typeof firing?.runId === "string" && firing.runId ? firing.runId : `hook:${crypto.randomUUID()}`;
      return this.runScan(runId, firingInstant(firing));
    });
  }

  async runScan(runId, at = new Date()) {
    const empty = { new: 0, changed: 0, unchanged: 0, failedSafe: 0, unknown: 0, perSource: [] };

    const active = this.storage.activeRun();
    if (active) {
      if (Date.now() - Date.parse(active.started_at) <= STALE_RUN_MS) {
        return { ...empty, skipped: true, reason: "A scan is already running." };
      }
      // Stale: the previous run's isolate died mid-scan. Close it out so it
      // does not block every scan after it, then proceed with this one.
      this.storage.finishScanRun(active.run_id, { error: "Superseded: the previous run never finished." });
    }
    if (!this.storage.startScanRun(runId)) {
      return { ...empty, skipped: true, reason: "This run already happened." };
    }

    const config = this.storage.getConfig();
    const sources = this.storage.listSources();
    const perSource = [];
    let newCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedSafeCount = 0;
    let unknownCount = 0;

    for (const source of sources) {
      const result = await this.scanOneSource(source);
      perSource.push(result);
      newCount += result.new;
      changedCount += result.changed;
      unchangedCount += result.unchanged;
      if (result.outcome === "failed_safe") failedSafeCount += 1;
      if (result.outcome === "unknown") unknownCount += 1;
    }

    this.storage.finishScanRun(runId, {
      newCount,
      changedCount,
      failedSafeCount,
      sourceCount: sources.length,
      unknownCount
    });

    // Called on EVERY scan, not only one that found something: a `daily`
    // digest is due on the first scan after the local day rolls over, and
    // that scan may well find nothing itself (REQ-014).
    await this.notifyNewItems(
      newCount,
      perSource.filter((result) => result.new > 0).map((result) => result.binding),
      config,
      at
    );
    await this.broadcast({ type: "scan", runId, new: newCount, changed: changedCount, perSource });

    /**
     * ASKING FOR THE WORK, SEPARATELY FROM ANNOUNCING IT (REQ-014, TASK-019).
     *
     * Deliberately not inside `notifyNewItems` and not gated by anything it
     * reads. A notification must not be the mechanism by which work is
     * requested, and the practical shape of that rule is this: `mode: "off"`,
     * quiet hours and a spent `daily` digest all decide whether somebody is
     * INTERRUPTED, and none of them may decide whether the work gets asked for.
     * An owner who silenced notices did not thereby cancel the drafting they
     * turned on.
     *
     * Returned rather than sent. There is nothing here for the gadget to call
     * (SEC-003) — and, verified 2026-09-10, nothing on the platform that reads
     * it either: `schedule-room-invoker.ts` keeps only `error`/`detail` from
     * the hook's response and `schedule-delivery.ts` reduces the outcome to
     * `{ok}`/`{ok:false}`. The request is still emitted — the shape is the
     * contract agenticos-stack/agenticos#1861 is asked to honor — but until
     * that lands, `drafting: "on_new"` has never produced a revision through
     * this path. Generation today is the Content-tab ask (see the client's
     * ask card) or the owner speaking to the agent directly.
     */
    const workRequest = this.workRequestFor(perSource, config);

    return {
      new: newCount,
      changed: changedCount,
      unchanged: unchangedCount,
      failedSafe: failedSafeCount,
      unknown: unknownCount,
      perSource,
      ...(workRequest ? { workRequest } : {})
    };
  }

  /**
   * What a scan asks for, or nothing at all (TASK-019).
   *
   * OFF BY DEFAULT and unrecognised reads as off (`normalizeDrafting`). A scan
   * that started requesting agent turns because an owner upgraded would spend
   * the organization's credits on a cadence nobody armed for that purpose.
   *
   * ONE REQUEST PER SCAN, batching every source's findings into one brief. The
   * unit an owner answers is the scan, not the post: twelve found references are
   * one decision about one afternoon's work, and one card per item would make
   * approving the obvious case worse than doing it by hand. The platform holds
   * its own ceiling as well, so this is the agreed shape rather than the only
   * thing standing between an owner and a queue.
   *
   * THE BATCH IS OPENED HERE because a draft has nowhere to go without one:
   * `saveRevision` takes a `batchItemId`. A destination is deliberately NOT
   * passed (TASK-004): drafting is `generate` and needs no `send` target —
   * where a scan-drafted post goes is the owner's decision at submit, and a
   * workspace with no destination granted still gets its drafts.
   *
   * Never throws: a scan's stored findings must survive a failure to ask about
   * them, and the ask is the cheap half.
   */
  workRequestFor(perSource, config) {
    if (config?.drafting !== "on_new") return null;

    const itemIds = perSource.flatMap((result) => result.newIds ?? []);
    if (!itemIds.length) return null;

    try {
      const opened = this.openBatch({ itemIds });
      // By value, never a throw (PAT-007). A refusal here — these items
      // already have an active localization — is not a scan failure and is
      // not something to ask an owner about.
      if (!opened || opened.ok === false || !opened.items?.length) return null;

      return {
        batchId: opened.id,
        // The accounts the posts came from, in the owner's own words for them.
        // The platform bounds this before it reaches an approval card.
        sourceLabel: [
          ...new Set(perSource.filter((result) => (result.newIds ?? []).length > 0).map((result) => result.label))
        ]
          .filter(Boolean)
          .join(", "),
        /**
         * The SOURCE item ids, not the batch item ids, and taken from what was
         * actually opened rather than from what was asked for.
         *
         * Source ids because they are the observation identity the ledger stands
         * on (`source:<id>`), which is what an audit trail links by (REQ-008).
         * The agent reaches the batch items it must write through by reading
         * `getBatch(batchId)`, so nothing here needs to carry them.
         */
        itemIds: opened.items.map((item) => item.sourceItem?.id).filter(Boolean),
        // The one method a finished draft is returned through. `agent.md`
        // carries the contract; this names it so the brief does not have to
        // repeat it.
        intake: "saveRevision"
      };
    } catch {
      return null;
    }
  }

  /** One source, cursor-paginated, at most `MAX_ITEMS_PER_SOURCE` items, isolated so one source's failure never stops another's. */
  async scanOneSource(source) {
    const provider = PROVIDERS[source.provider];
    if (!provider) {
      const message = `Unknown provider "${source.provider}".`;
      this.storage.recordSourceOutcome(source.binding, { outcome: "unknown", message, cursor: source.cursor });
      return { binding: source.binding, outcome: "unknown", new: 0, changed: 0, unchanged: 0, message };
    }

    /**
     * Which reader, decided by the source's ORIGIN and nothing else.
     *
     * Not by whether a binding "looks like" an open key, and not by trying the
     * connector first and falling back — a fallback would reach for a grant
     * that does not exist and report its absence as a provider failure.
     * `origin` is stored on the row precisely so this is a lookup.
     */
    const isOpen = source.origin === "open";

    /**
     * THE BUDGET, checked before the first metered call and not after it.
     *
     * Refuses BY VALUE and leaves the schedule armed: a budget that stops the
     * work silently, or that disarms the cadence, is the silent-schedule
     * failure this feature's parent plan already records twice. The owner sees
     * the reason on the source row and can raise the number, and the next
     * firing resumes without further approval — they already agreed at setup
     * that this was the number.
     *
     * Only open sources are metered; a connector source costs nothing and is
     * never held up by this.
     */
    if (isOpen) {
      const budget = this.storage.getConfig()?.fetchBudgetCredits;
      if (typeof budget === "number") {
        const spent = this.storage.fetchSpendCredits();
        if (spent >= budget) {
          const message = `Fetch budget spent: ${spent} of ${budget} credits in the last 30 days.`;
          this.storage.recordSourceOutcome(source.binding, {
            outcome: "failed_safe",
            message,
            cursor: source.cursor
          });
          return { binding: source.binding, outcome: "failed_safe", new: 0, changed: 0, unchanged: 0, message };
        }
      }
    }
    const list = isOpen ? provider.openList : provider.list;
    const normalize = isOpen ? provider.openNormalize : provider.normalize;
    if (!list || !normalize) {
      const message = isOpen
        ? `Public accounts cannot be watched on ${source.provider} yet.`
        : `Unknown provider "${source.provider}".`;
      this.storage.recordSourceOutcome(source.binding, { outcome: "unknown", message, cursor: source.cursor });
      return { binding: source.binding, outcome: "unknown", new: 0, changed: 0, unchanged: 0, message };
    }

    let cursor = source.cursor ?? null;
    /*
     * Every cursor this run has already asked with.
     *
     * A pager that does not advance is not a pager. `treg.instagram.user.posts`
     * RETURNS a `next_cursor` but does not accept one — sending it back yields
     * the identical page, verified against the live endpoint — so the loop
     * refetched page one until `MAX_ITEMS_PER_SOURCE` stopped it: roughly
     * eight billed provider calls to read twelve posts, on every scan.
     *
     * Detecting the repeat rather than special-casing this endpoint keeps it
     * true for the next provider whose cursor loops, and costs one Set.
     */
    const askedWith = new Set([cursor]);
    let fetched = 0;
    let newCount = 0;
    const newIds = [];
    let changedCount = 0;
    let unchangedCount = 0;
    let outcome = "confirmed";
    let message = null;

    try {
      while (fetched < MAX_ITEMS_PER_SOURCE) {
        // An open reader takes the SOURCE (it needs the platform and account
        // key); a connector reader takes the binding, which is its grant.
        const response = isOpen
          ? await list(this.env, source, { after: cursor })
          : await list(this.env, source.binding, { limit: PAGE_SIZE, after: cursor });
        if (isOpen && (response.servedBy || typeof response.credits === "number")) {
          // Recorded even on a refusal: "which provider answered, and what did
          // it cost" is the first question when a source degrades, and it
          // cannot be reconstructed later.
          this.storage.recordSourceCost(source.binding, {
            servedBy: response.servedBy,
            credits: response.credits
          });
        }
        // Any outcome that is not `confirmed` ends this source's scan and is
        // recorded as itself — including `no_answer`, the broker's "nobody
        // could serve this account". That is NOT "nothing new", and counting
        // it as a clean read is how a scan reports success while fetching
        // nothing.
        if (response.outcome !== "confirmed") {
          outcome = response.outcome;
          message = response.message ?? null;
          break;
        }

        const normalized = await normalize(response.page, {
          binding: source.binding,
          label: source.label,
          pageId: source.pageId
        });
        for (const item of normalized.items) {
          if (fetched >= MAX_ITEMS_PER_SOURCE) break;
          const result = this.storage.upsertItem(item);
          fetched += 1;
          // The ids as well as the count, because a work request has to name
          // what it found (TASK-019) and a number cannot be drafted from.
          if (result.isNew) {
            newCount += 1;
            newIds.push(item.id);
          } else if (result.changed) changedCount += 1;
          else unchangedCount += 1;
        }

        // The cursor advances only after this page's items are persisted, so
        // a crash here resumes from this page rather than skipping past it.
        cursor = normalized.nextCursor;
        this.storage.recordSourceOutcome(source.binding, { outcome: "confirmed", cursor });
        if (!cursor || normalized.items.length === 0) break;
        // A cursor we have already used cannot take us anywhere new, so this
        // page is the last one — not an error, and the items just read are
        // kept. Reaching here is the provider saying "no more", clumsily.
        if (askedWith.has(cursor)) break;
        askedWith.add(cursor);
      }
    } catch (error) {
      outcome = "failed_safe";
      message = errorMessage(error);
    }

    this.storage.recordSourceOutcome(source.binding, { outcome, message, cursor });
    return {
      binding: source.binding,
      // The owner's own words for the account, carried so a work request can name
      // where the posts came from without re-reading the sources table.
      label: source.label,
      outcome,
      new: newCount,
      newIds,
      changed: changedCount,
      unchanged: unchangedCount,
      message
    };
  }

  /**
   * REQ-014's three policies, and quiet hours on all of them.
   *
   * `daily` used to be `off` wearing a different name: this method returned
   * early unless the mode was `immediate`, so an owner who chose "once a day"
   * got nothing, ever, and nothing said so.
   *
   * WHAT EACH ONE MEANS NOW.
   *
   *   `off`       — nothing is accumulated and nothing is sent.
   *   `immediate` — one notice per scan that found something.
   *   `daily`     — one summary on the first scan after the owner's LOCAL day
   *                 rolls over, covering everything since the last notice.
   *
   * QUIET HOURS DEFER, THEY DO NOT DISCARD. On both sending policies a notice
   * due inside quiet hours stays in the accumulator and goes out with the
   * next one — the owner asked not to be interrupted, not to not be told.
   * The old code dropped an immediate notice on the floor: the items were
   * found, the conversation never heard, and nothing recorded that.
   *
   * `at` is the instant this scan is FOR — the firing's `firedFor` for a
   * scheduled run, now for a manual refresh — so the day boundary and the
   * quiet-hours window are evaluated against the occurrence rather than
   * against whenever the isolate happened to get to it.
   */
  async notifyNewItems(newCount, newBindings, config, at = new Date()) {
    const notifications = config?.notifications ?? { mode: "immediate" };
    if (notifications.mode === "off") return;

    const timeZone = config?.timeZone;
    const today = localDay(timeZone, at);

    if (newCount > 0) {
      this.storage.accumulateNotice({ newCount, bindings: newBindings, day: today });
    }

    const pending = this.storage.notifyState();
    if (pending.pendingNew <= 0) return;

    // Held, not dropped. The next scan outside the window sends it.
    if (notifications.quietHours && isWithinQuietHours(notifications.quietHours, wallClockHHMM(timeZone, at))) {
      return;
    }

    // One summary per local day: nothing more until the day rolls over again.
    if (notifications.mode === "daily" && pending.lastNoticeDay === today) return;

    const accountCount = pending.pendingBindings.length || 1;
    const postWord = pending.pendingNew === 1 ? "post" : "posts";
    const accountWord = accountCount === 1 ? "account" : "accounts";
    // `href` is intentionally omitted: the gadget has no reliable way to
    // learn its own conversation id (the shipped Doc gadget never references
    // one either), and TASK-104's own description says `workspace.notify`
    // "calls the v2 notifyConversation path for the gadget's conversation" —
    // the host already has both ids from the door binding and builds
    // `/chat/:id?w=<gadgetId>` (REQ-014) there.
    await notify(this.env, {
      title: `${pending.pendingNew} new ${postWord}`,
      body: `${pending.pendingNew} new ${postWord} from ${accountCount} ${accountWord}.`
    });
    this.storage.clearNotice({ day: today, at: at.toISOString() });
  }

  // -----------------------------------------------------------------------
  // collection (REQ-005, REQ-006)
  // -----------------------------------------------------------------------

  async listItems(input = {}) {
    const options = input && typeof input === "object" ? input : {};
    return this.storage.listItems(options);
  }

  async getItem(id) {
    const item = this.storage.getItem(String(id));
    if (!item) return null;
    return { ...item, seen: this.storage.isSeen(item.id) };
  }

  markSeen(ids) {
    return this.enqueueMutation(() => {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
      this.storage.markSeen(list);
      return { marked: list.length };
    });
  }

  setSelection(id, selected) {
    return this.enqueueMutation(() => {
      this.storage.setSelection(String(id), Boolean(selected));
      return { id: String(id), selected: Boolean(selected) };
    });
  }

  clearSelection() {
    return this.enqueueMutation(() => {
      this.storage.clearSelection();
      return { cleared: true };
    });
  }

  async getMedia(itemId, mediaId, options = {}) {
    const rendition = options && options.rendition === "preview" ? "preview" : "thumb";
    const chunkIndex = Number.isInteger(options?.chunk) ? options.chunk : 0;
    const chunkBytes = rendition === "thumb" ? THUMB_MAX_BYTES : PREVIEW_CHUNK_BYTES;

    let cached = this.storage.getMedia(itemId, mediaId, rendition);
    if (!cached) cached = await this.fetchAndCacheMedia(itemId, mediaId, rendition);
    // Too large is not missing, and saying so is the point: an owner who is
    // told "no media" goes looking for a broken source, while one told the
    // size and the cap knows the media is fine and the cache is the limit.
    if (cached?.refused) {
      return { ok: false, code: cached.refused.code, message: cached.refused.message };
    }
    if (cached?.tooLarge) {
      const { byteLength, cap } = cached.tooLarge;
      return {
        ok: false,
        code: "media_too_large",
        message: `That ${rendition} is ${Math.ceil(byteLength / 1024)}KB, over the ${Math.floor(cap / 1024)}KB this cache holds.`
      };
    }
    // EXPECTED: a source URL expired, the door revoked mid-fetch, or the
    // media id was never valid — an owner opening a stale preview, not a
    // caller bug. `rpc.js`'s `loadMediaAsBlobUrl` turns this back into a
    // rejection at the browser boundary, which never crosses a DO RPC call.
    if (!cached) return { ok: false, code: "media_missing", message: `No ${rendition} media for ${mediaId}.` };

    const total = cached.bytes.byteLength;
    const chunks = Math.max(1, Math.ceil(total / chunkBytes));
    const start = chunkIndex * chunkBytes;
    const bytes = cached.bytes.slice(start, start + chunkBytes);
    return { mime: cached.mime, total, chunk: chunkIndex, chunks, bytes };
  }

  /**
   * Fetches media bytes through the connector door and caches them
   * (SEC-004, CON-007, RISK-003 — source URLs expire, so a cached copy is
   * what stays viewable). `doors.js`'s `fetchMedia` is a known gap: the
   * connector door's final shape (PR #1484) has no pinned byte-fetch action,
   * so this call reports `unknown` (door "does not offer fetch_media") until
   * one exists — handled the same as any other ungranted-door case below,
   * and self-heals with no change here once it lands (RISK-002).
   */
  fetchAndCacheMedia(itemId, mediaId, rendition) {
    // Reached from a read method (`getMedia`), so the lane is taken here, at
    // the write — a missing cache row checked before an `await`ed fetch is
    // the read-then-write shape this exists to serialise.
    return this.enqueueMutation(() => this.fetchAndCacheMediaLocked(itemId, mediaId, rendition));
  }

  async fetchAndCacheMediaLocked(itemId, mediaId, rendition) {
    const item = this.storage.getItem(itemId);
    /*
     * Say which of the three was missing.
     *
     * This returned a bare `null` for all of them, and the caller turned that
     * into "No thumb media for <id>" — a sentence about the media that is
     * false for two of the three causes. An unknown item, a media id that
     * matches nothing on a known item, and an entry with no URL send a reader
     * to three different places.
     */
    if (!item) {
      return { refused: { code: "item_missing", message: `No item ${itemId}.` } };
    }
    const media = item.media.find((entry) => String(entry.id) === String(mediaId));
    if (!media) {
      const known = item.media.map((entry) => JSON.stringify(entry.id)).join(", ") || "none";
      return { refused: { code: "media_id_unknown", message: `That item has no media ${JSON.stringify(mediaId)}; it has: ${known}.` } };
    }
    if (!media.url) {
      return { refused: { code: "media_missing_url", message: "That media entry carries no URL." } };
    }

    /*
     * ALREADY HELD IS ALREADY PAID FOR.
     *
     * The grid fetches a `thumb`; opening the drawer asked for a `preview`,
     * and the cache is keyed by rendition, so the same file was fetched a
     * second time through the metered door, over the network, and stored a
     * second time — every one of the four thumb/preview pairs in a real
     * account's cache is byte-identical, same length and same header. That is
     * the whole of "why is the drawer slow when we already have the picture".
     *
     * `mediaUrlFor` is the door's own rule about which file a rendition asks
     * for. When both renditions name the same URL the bytes are the same
     * bytes, so the ones already stored are copied across rather than
     * refetched. The target rendition's cap still applies: a file that fits
     * the preview cap may be too big to hold as a thumb, and reusing it would
     * quietly raise a limit that exists on purpose.
     */
    const other = rendition === "thumb" ? "preview" : "thumb";
    if (mediaUrlFor(media, rendition) === mediaUrlFor(media, other)) {
      const held = this.storage.getMedia(itemId, mediaId, other);
      const cap = rendition === "thumb" ? THUMB_MAX_BYTES : PREVIEW_MAX_BYTES;
      if (held && held.bytes.byteLength <= cap) {
        this.storage.putMedia(itemId, mediaId, rendition, held.mime, held.bytes);
        return { mime: held.mime, bytes: held.bytes };
      }
    }

    // The source's own origin decides which door owns its bytes; a media id
    // cannot be read for it, and guessing from the binding's shape is what
    // `scanOneSource` already refuses to do.
    const source = this.storage.getSource(item.sourceBinding);
    const response = await fetchMedia(this.env, item.sourceBinding, media, rendition, source?.origin);
    // Carry the door's own words. Returning a bare null here turned every
    // distinct refusal — no door granted, host not allowlisted, the CDN
    // answered 403 — into "No thumb media", which sends a reader looking at
    // the item instead of at the reason.
    if (response.outcome !== "confirmed" || !response.data) {
      return { refused: { code: response.outcome ?? "unknown", message: response.message ?? "The media could not be fetched." } };
    }

    const raw = toBytes(response.data.bytes ?? response.data.base64 ?? response.data);
    /*
     * The last bare `null` on this path, and the one that hid the door working.
     *
     * A door confirms and hands back bytes; if `toBytes` cannot read the shape
     * they arrived in, returning null made `getMedia` answer "No thumb media",
     * which is a sentence about the source and false about what happened. Say
     * what was actually received instead — the shape is the clue.
     */
    if (!raw) {
      const shape = response.data?.bytes === undefined
        ? Object.keys(response.data ?? {}).join(", ") || typeof response.data
        : `bytes as ${Object.keys(response.data.bytes ?? {}).slice(0, 4).join("|") || Object.prototype.toString.call(response.data.bytes)}`;
      return { refused: { code: "media_unreadable", message: `The door returned media this gadget could not read (${shape}).` } };
    }
    const cap = rendition === "thumb" ? THUMB_MAX_BYTES : PREVIEW_MAX_BYTES;
    /*
     * REFUSE what does not fit. Do not store a prefix of it.
     *
     * This used to be `raw.slice(0, cap)`, which turns a file too big for the
     * cap into a corrupt one of exactly the cap's size — and then stores it as
     * though it were the media. Every format here is length-sensitive: a
     * truncated MP4 will not play and a truncated JPEG will not decode. The
     * first item this gadget ever scanned is a 2.7 MB reel, so the very first
     * real fetch would have cached 1 MB of unusable bytes and reported success.
     *
     * A cap is a statement about what this cache will hold, so exceeding it is
     * an answer ("too large for a <rendition>"), not a licence to store part of
     * it. The caller turns this into a refusal an owner can read, rather than a
     * broken image with no explanation.
     */
    if (raw.byteLength > cap) return { tooLarge: { byteLength: raw.byteLength, cap } };
    const mime = typeof response.data.mime === "string" ? response.data.mime : "application/octet-stream";

    this.storage.putMedia(itemId, mediaId, rendition, mime, raw);
    return { mime, bytes: raw };
  }

  // -----------------------------------------------------------------------
  // batches (REQ-017, REQ-018, REQ-019)
  // -----------------------------------------------------------------------

  /**
   * `itemIds`, and an optional `destinationBindings` — a destination is a
   * `send` target decided at submit (`refactor-draft-before-destination-1`),
   * not a precondition for drafting, so the argument is recorded as `bound`
   * publications rather than stored on the item. REQ-017's unit is the pair
   * `(sourceItem, destinationBinding)`: while an item has no filed
   * publication, the item alone is the key (`findDuplicates`); once it has
   * been sent, `submitForReview` tests the pair.
   *
   * REFUSES, IT DOES NOT REPARENT. A second active localization for a post
   * that already has one comes back as `{ ok: false, code:
   * "duplicate_active" }` naming the batch and item that hold it (PAT-007 —
   * by value, never a throw). This used to move the existing row into the new
   * batch instead, silently: an approved localization would change batch
   * under the owner with no record that it happened, and the reviewer of the
   * new batch would find work they never approved sitting in it.
   *
   * `createNewVersion` is the owner's explicit opt-in from the requirement's
   * own "unless the owner explicitly creates a new version". It retires the
   * conflicting rows (`supersedeBatchItem`) and drafts fresh ones, so the
   * published history stays readable as version 1, version 2.
   *
   * TASK-401: Continue is the owner's own action made visible — one
   * `notify()` per call (never per item), so the conversation shows the
   * hand-off and the agent knows to read the batch and start drafting
   * (`agent.md`). No `href` is passed: `workspace.notify` already defaults
   * to this gadget's own `?w=<gadgetId>` (TASK-104), the same reason
   * `notifyNewItems` above never builds one either.
   */
  createBatch(input) {
    return this.enqueueMutation(() => this.createBatchLocked(input));
  }

  async createBatchLocked(input) {
    const opened = this.openBatch(input);
    if (opened.ok === false) return opened;

    const postWord = opened.items.length === 1 ? "post" : "posts";
    await notify(this.env, {
      title: `${opened.items.length} ${postWord} ready to localize`,
      body: `${opened.items.length} ${postWord} moved to Localize. Drafts start from here.`
    });
    return opened;
  }

  /**
   * The batch rows, written without announcing them.
   *
   * SPLIT OUT FOR TASK-019, and the notice is the reason. `createBatch` above is
   * the owner's own Continue and its `notify()` is that action made visible. A
   * scan that opened a batch through it would send that notice on its own
   * cadence, past `notifications.mode` and past quiet hours — the settings whose
   * whole purpose is to decide when this gadget may interrupt somebody.
   *
   * Refuses by value, never by throw (PAT-007).
   */
  openBatch({ itemIds, destinationBindings, createNewVersion = false }) {
    const ids = Array.isArray(itemIds) ? [...new Set(itemIds.filter((id) => typeof id === "string"))] : [];
    const destinations = Array.isArray(destinationBindings)
      ? [...new Set(destinationBindings.filter((binding) => typeof binding === "string"))]
      : [];
    if (!ids.length)
      return { ok: false, code: "batch_needs_items", message: "createBatch needs at least one item id." };

    /*
     * A DESTINATION IS A SEND TARGET, NOT A PRECONDITION (TASK-001). Drafting
     * a localized caption is `generate` — nothing about it needs a `send`
     * target, so an absent or empty `destinationBindings` is a batch like any
     * other and `batch_needs_destinations` is no longer answered here. The
     * code stays in the vocabulary for `submitForReview`, where it is true.
     *
     * While a batch item has no FILED publication, REQ-017's duplicate key is
     * the source item alone (TASK-002): two drafts of the same post is not a
     * thing an owner asked for. Once an item has been sent somewhere, the
     * pair rule takes over — at submit, not here.
     */
    if (createNewVersion !== true) {
      const duplicates = this.findDuplicates(ids);
      if (duplicates.length) return duplicateRefusal(duplicates);
    }

    const batchId = generateId("batch");
    // Every opened batch is a drafting request — the owner's Draft action
    // here, a scan's workRequest below — so the mark is durable state the
    // Content tab reads after any reload, not a flag in client memory.
    this.storage.createBatch(batchId, "requested");

    const items = [];
    for (const itemId of ids) {
      const item = this.storage.getItem(itemId);
      if (!item) continue;
      const batchItem = this.createOneBatchItem(batchId, item, destinations);
      items.push(this.projectBatchItem(batchItem));
    }

    const batch = this.storage.getBatch(batchId);
    return { id: batch.id, createdAt: batch.created_at, status: batch.status, items };
  }

  /**
   * Every source item in `itemIds` that already has an active localization
   * which never went anywhere — the item-key half of REQ-017 while drafting
   * (TASK-002). An item with a FILED publication does not block a second
   * draft here; the pair rule at submit owns that case (`submitForReview`).
   * One entry per conflicting row, carrying the batch and item ids the owner
   * needs in order to go and look at it.
   */
  findDuplicates(itemIds) {
    const conflicts = [];
    for (const itemId of itemIds) {
      for (const existing of this.storage.activeBatchItemsFor(itemId)) {
        if (this.storage.hasFiledPublication(existing.id)) continue;
        conflicts.push({
          itemId,
          batchId: existing.batchId,
          batchItemId: existing.id,
          destinationBindings: existing.destinationBindings
        });
      }
    }
    return conflicts;
  }

  createOneBatchItem(batchId, item, destinationBindings) {
    // Only reachable with the owner's `createNewVersion` opt-in (createBatch
    // refuses otherwise), so a conflicting row here is one the owner asked to
    // replace. Retired rather than edited: the old revisions and approval
    // stay exactly as they were published (REQ-011, PAT-004).
    // An item that HAS been sent somewhere stays active — its publications
    // are the record, and the pair rule at submit owns them from there.
    for (const existing of this.storage.activeBatchItemsFor(item.id)) {
      if (!this.storage.hasFiledPublication(existing.id)) {
        this.storage.supersedeBatchItem(existing.id);
      }
    }

    const batchItemId = generateId("bi");
    this.storage.createBatchItem({
      id: batchItemId,
      batchId,
      itemId: item.id,
      // TASK-003: the column is read for rows written before migration 8
      // only. What a caller still sends is recorded as `bound` publications
      // instead — a default the submit picker reads, not a send (TASK-005).
      destinationBindings: [],
      state: "drafting"
    });
    for (const binding of destinationBindings) {
      this.storage.boundPublication(batchItemId, binding);
    }
    this.storage.setOriginLink(batchItemId, {
      provider: item.provider,
      sourceBinding: item.sourceBinding,
      sourceLabel: item.sourceLabel,
      providerItemId: item.providerItemId,
      permalink: item.permalink,
      sourceContentHash: item.contentHash,
      sourcePublishedAt: item.publishedAt,
      retrievedAt: new Date().toISOString()
    });
    return this.storage.getBatchItem(batchItemId);
  }

  /**
   * `{ id, sourceItem, destinationBindings, revision, caption, posterLayout,
   * confirmedClaims, approval }` — the exact shape
   * `src/client/steps.js` (`draftFor`, `renderReview`) reads off
   * `getBatch()` / `createBatch()`'s items (`cc/social-localization-client`,
   * PR #1483). `state` rides along as extra, harmless information.
   *
   * `approval` is non-null once a submission was actually made (`version` —
   * the Social Hub `versionId` — is set), NOT once the owner has approved
   * it: `socialSubmitForReview`'s direct-call refusal never hands back an
   * `approvalId` (TASK-103's design, see `doors.js`), so this gadget never
   * learns one synchronously. `steps.js`'s `isApprovalExpired` only compares
   * `approvedRevision` (the revision that was submitted) against
   * `currentRevision`, which is exactly what "submitted, in sync" vs
   * "edited since" needs — the owner's actual decision is a `readStatus`
   * poll away (`readPublishState`), never tracked locally.
   */
  /**
   * The destinations this item is pointed at: the union of what a caller
   * recorded (the legacy column, read for pre-migration rows) and every live
   * publication's binding. This is the submit picker's default — it says
   * where a draft WOULD go, never that it has gone.
   */
  bindingsForItem(batchItem) {
    const recorded = this.storage
      .publicationsFor(batchItem.id)
      .filter((publication) => publication.state !== "superseded")
      .map((publication) => publication.destinationBinding);
    return [...new Set([...(batchItem.destinationBindings ?? []), ...recorded])];
  }

  projectBatchItem(batchItem) {
    const latest = this.storage.latestRevision(batchItem.id);
    const sourceItem = this.storage.getItem(batchItem.itemId);
    const destinationBindings = this.bindingsForItem(batchItem);
    // The protected spans, detected — the agent is handed the values rather
    // than left to infer from prose what must survive verbatim (and, on the
    // grounded path, what a ledger entry has to name).
    const config = this.storage.getConfig();
    const protectedSpans = detectProtectedLiterals(typeof sourceItem?.text === "string" ? sourceItem.text : "", {
      protectedTerms: config?.protectedTerms,
      protectedHashtags: config?.protectedHashtags,
      disclaimers: config?.disclaimers,
      claimsRequiringConfirmation: config?.claimsRequiringConfirmation
    });
    return {
      id: batchItem.id,
      sourceItem,
      protectedSpans,
      destinationBindings,
      // TASK-009: where it went — one row per destination this item was sent
      // to (or is pointed at, in the `bound` state).
      publications: this.storage.publicationsFor(batchItem.id),
      // REQ-016 — the door's own caption limit for THIS item's destinations,
      // so `steps.js`'s `computeIssues(item, ..., limits: item.limits)`
      // checks the number the server will enforce rather than reading a field
      // nothing ever set.
      limits: this.storage.limitsForDestinations(destinationBindings),
      revision: batchItem.currentRevision,
      caption: latest?.caption ?? null,
      posterLayout: latest?.posterLayout ?? null,
      confirmedClaims: latest?.confirmedClaims ?? [],
      refinementBrief: latest?.refinementBrief ?? normalizeRefinementBrief(this.storage.getConfig()?.refinementBrief),
      protectedOverrides: latest?.protectedOverrides ?? [],
      originalMediaRefs: latest?.originalMediaRefs ?? [],
      derivedMediaRefs: latest?.derivedMediaRefs ?? [],
      publicationIntent: latest?.publicationIntent ?? normalizePublicationIntent(undefined).intent,
      ledger: latest?.ledger ?? { spans: [], media: [] },
      state: batchItem.state,
      approval: batchItem.version
        ? {
            approvalId: batchItem.approvalId,
            approvedRevision: batchItem.approvedRevision,
            currentRevision: batchItem.currentRevision,
            contentHash: batchItem.contentHash,
            versionId: batchItem.version,
            postId: batchItem.postId
          }
        : null
    };
  }

  async getBatch(batchId) {
    const batch = this.storage.getBatch(batchId);
    if (!batch) return null;
    const items = this.storage.listBatchItems(batchId).map((batchItem) => this.projectBatchItem(batchItem));
    return { id: batch.id, createdAt: batch.created_at, status: batch.status, generation: batch.generation ?? null, items };
  }

  /** The owner dismissed the Content-tab generation ask for this batch. */
  dismissGenerationAsk(batchId) {
    return this.enqueueMutation(() => {
      this.storage.clearGeneration(String(batchId));
      return { ok: true };
    });
  }

  /**
   * The owner pressed Regenerate: re-arm the batch's durable generation
   * mark so the agent's next turn re-drafts it. Refuses when the batch is
   * unknown or has nothing left to draft (all items submitted).
   */
  requestGeneration(batchId) {
    return this.enqueueMutation(() => {
      const batch = this.storage.getBatch(String(batchId));
      if (!batch) return { ok: false, code: "batch_not_found", message: "This batch is no longer available." };
      const draftable = this.storage.listBatchItems(batch.id).some((item) =>
        ["drafting", "expired"].includes(item.state));
      if (!draftable) {
        return { ok: false, code: "nothing_to_draft", message: "Every item in this batch has already been submitted." };
      }
      this.storage.setGeneration(batch.id);
      return { ok: true };
    });
  }

  async listBatches() {
    return this.storage
      .listBatches()
      .map((batch) => ({ id: batch.id, createdAt: batch.created_at, status: batch.status }));
  }

  async listBatchSummaries(input = {}) {
    const options = input && typeof input === "object" ? input : {};
    return this.storage.listBatchSummaries(options);
  }

  // -----------------------------------------------------------------------
  // revisions (PAT-004, REQ-007, REQ-011)
  // -----------------------------------------------------------------------

  saveRevision(args) {
    return this.enqueueMutation(() => this.saveRevisionLocked(args));
  }

  /**
   * One agent turn, one approval card, the whole batch.
   *
   * A gadget method that is not a declared read carries no `routine` on its
   * action shape, so `decide.ts` asks on every call and a refusal ends the
   * turn — per-item `saveRevision` for a 12-post batch would be twelve
   * separate asks the owner never meant to answer one by one. This is the
   * same payload the owner sees once: every item's draft in a single write.
   * Each entry validates independently; per-item refusals ride inside
   * `results` rather than failing the whole call (PAT-007).
   */
  saveRevisions(input) {
    return this.enqueueMutation(async () => {
      const list = Array.isArray(input?.revisions) ? input.revisions.slice(0, 50) : [];
      const results = [];
      for (const entry of list) {
        // One lane, one shared inner — the batch call is not a way around
        // validation, it is the same saveRevision contract N times.
        results.push(await this.saveRevisionLocked(entry && typeof entry === "object" ? entry : {}));
      }
      return { ok: results.every((result) => result.ok), results };
    });
  }

  async saveRevisionLocked({
    batchItemId,
    expectedRevision,
    caption,
    posterLayout,
    confirmedClaims,
    refinementBrief,
    protectedOverrides,
    originalMediaRefs,
    derivedMediaRefs,
    publicationIntent,
    acceptedVisualMode,
    ledger
  }) {
    const batchItem = this.storage.getBatchItem(batchItemId);
    if (!batchItem) {
      return {
        ok: false,
        issues: [{ code: "batch_item_unknown", severity: "block", message: `No batch item ${batchItemId}.` }]
      };
    }

    const config = this.storage.getConfig();
    const sourceItem = this.storage.getItem(batchItem.itemId);
    const previous = this.storage.latestRevision(batchItemId);
    const refinement = normalizeRefinementBrief(
      refinementBrief === undefined
        ? (previous?.refinementBrief ?? (previous ? null : config?.refinementBrief))
        : refinementBrief
    );
    if (
      acceptedVisualMode !== undefined &&
      !["keep_original", "text_poster", "ai_refinement"].includes(acceptedVisualMode)
    ) {
      return {
        ok: false,
        issues: [
          { code: "visual_mode_invalid", severity: "block", message: "The accepted visual mode is not supported." }
        ]
      };
    }
    /*
     * CALLER-SUPPLIED allowedChanges, ORG-BOUND. `allowedChanges` selects the
     * ledger path — and it arrives from whoever called saveRevision, which is
     * the agent as often as the owner. A caller that wrote `["tone"]` into the
     * brief got a validation path of its own choosing. The org's stored brief
     * is the bound: only the changes it permits are honoured, so an empty
     * stored list means no allowed changes regardless of what the call asked
     * for.
     */
    const storedAllowed = normalizeRefinementBrief(config?.refinementBrief).allowedChanges;
    const brief = {
      ...refinement,
      allowedChanges: refinement.allowedChanges.filter((change) => storedAllowed.includes(change)),
      ...(acceptedVisualMode ? { visualTreatment: acceptedVisualMode } : {})
    };
    const overrides =
      protectedOverrides === undefined
        ? (previous?.protectedOverrides ?? [])
        : normalizeProtectedOverrides(protectedOverrides);
    const storedLedger = applyProtectedOverridesToLedger(
      ledger === undefined ? (previous?.ledger ?? { spans: [], media: [] }) : normalizeLedger(ledger),
      overrides
    );

    const validation = validateRevisionDraft({
      source: { text: sourceItem ? sourceItem.text : "", id: sourceItem ? sourceItem.id : "" },
      draft: caption,
      brief,
      ledger: storedLedger,
      policy: {
        protectedTerms: config?.protectedTerms,
        protectedHashtags: config?.protectedHashtags,
        disclaimers: config?.disclaimers,
        claimsRequiringConfirmation: config?.claimsRequiringConfirmation,
        confirmedClaims
      },
      // The union includes `bound` publications, so a destination recorded
      // for this item still applies its own caption limit while drafting
      // (REQ-016) — and a destinationless draft checks nothing, as it must.
      limits: this.storage.limitsForDestinations(this.bindingsForItem(batchItem))
    });
    if (!validation.ok) return { ok: false, issues: validation.issues };

    if (posterLayout) {
      const posterValidation = validatePosterLayout(posterLayout);
      if (!posterValidation.ok) {
        return { ok: false, issues: posterValidation.issues.map((issue) => ({ ...issue, severity: "block" })) };
      }
    }

    const intent = normalizePublicationIntent(
      publicationIntent === undefined ? (previous?.publicationIntent ?? undefined) : publicationIntent
    );
    if (!intent.ok) return { ok: false, issues: [{ code: intent.code, severity: "block", message: intent.message }] };
    const sourceMedia = Array.isArray(sourceItem?.media)
      ? sourceItem.media.map((media) => ({
          assetId: media.id,
          kind: media.kind,
          url: media.url,
          source: "original"
        }))
      : [];
    const originals =
      originalMediaRefs === undefined
        ? (previous?.originalMediaRefs ?? (batchItem.currentRevision === 0 ? normalizeAssetRefs(sourceMedia) : []))
        : normalizeAssetRefs(originalMediaRefs);
    const derived =
      derivedMediaRefs === undefined ? (previous?.derivedMediaRefs ?? []) : normalizeAssetRefs(derivedMediaRefs, "derived");

    const result = this.storage.appendRevision(batchItemId, expectedRevision, {
      caption,
      posterLayout,
      confirmedClaims,
      issues: validation.issues,
      refinementBrief: brief,
      protectedOverrides: overrides,
      originalMediaRefs: originals,
      derivedMediaRefs: derived,
      publicationIntent: intent.intent,
      ledger: storedLedger
    });
    if (!result.ok) return conflictResult(result.revision);

    this.storage.updateBatchItem(batchItemId, this.nextStateAfterEdit(batchItem));
    this.storage.clearGenerationIfAllDrafted(batchItem.batchId);
    await this.broadcast({ type: "revision", batchItemId, revision: result.revision });
    return { ok: true, revision: result.revision, issues: validation.issues };
  }

  savePoster(args) {
    return this.enqueueMutation(() => this.savePosterLocked(args));
  }

  async savePosterLocked({ batchItemId, expectedRevision, template, png }) {
    const batchItem = this.storage.getBatchItem(batchItemId);
    if (!batchItem) {
      return {
        ok: false,
        issues: [{ code: "batch_item_unknown", severity: "block", message: `No batch item ${batchItemId}.` }]
      };
    }

    const bytes = toBytes(png);
    // A caller bug, not an owner-facing condition — `steps.js`'s
    // `onSavePoster` always hands this `renderPosterPng`'s own Uint8Array
    // output. Still a value, not a throw (see the file header note: a
    // workerd test proved a throw here breaks the facet's output gate the
    // same way an expected refusal's did).
    if (!bytes) {
      return {
        ok: false,
        issues: [
          {
            code: "invalid_argument",
            severity: "block",
            message: "savePoster needs PNG bytes (Uint8Array, ArrayBuffer or base64 string)."
          }
        ]
      };
    }
    if (!isPngSignature(bytes)) {
      return {
        ok: false,
        issues: [{ code: "poster_not_png", severity: "block", message: "The uploaded file is not a PNG." }]
      };
    }

    const constraints = posterPngConstraints(template);
    if (bytes.byteLength > constraints.maxBytes) {
      return {
        ok: false,
        issues: [
          {
            code: "poster_too_large",
            severity: "block",
            message: `The poster PNG exceeds the ${constraints.maxBytes}-byte limit.`
          }
        ]
      };
    }
    const dimensions = readPngDimensions(bytes);
    if (!dimensions || dimensions.width !== constraints.width || dimensions.height !== constraints.height) {
      return {
        ok: false,
        issues: [
          {
            code: "poster_wrong_size",
            severity: "block",
            message: `The poster PNG must be exactly ${constraints.width}x${constraints.height}.`
          }
        ]
      };
    }

    const previous = this.storage.latestRevision(batchItemId);
    const result = this.storage.appendRevision(batchItemId, expectedRevision, {
      caption: previous?.caption ?? null,
      posterLayout: { ...(previous?.posterLayout ?? {}), template },
      confirmedClaims: previous?.confirmedClaims ?? [],
      issues: previous?.issues ?? [],
      refinementBrief: previous?.refinementBrief ?? null,
      protectedOverrides: previous?.protectedOverrides ?? [],
      originalMediaRefs: previous?.originalMediaRefs ?? [],
      derivedMediaRefs: previous?.derivedMediaRefs ?? [],
      publicationIntent: previous?.publicationIntent ?? null,
      ledger: previous?.ledger ?? { spans: [], media: [] }
    });
    if (!result.ok) return conflictResult(result.revision);

    this.storage.savePoster(batchItemId, result.revision, template, bytes);
    this.storage.updateBatchItem(batchItemId, this.nextStateAfterEdit(batchItem));
    await this.broadcast({ type: "revision", batchItemId, revision: result.revision });
    return { ok: true, revision: result.revision };
  }

  /**
   * REQ-011: an edit after submission expires the approval rather than
   * silently keeping it. Keyed on `batchItem.version` (the Social Hub
   * `versionId` `submitForReview` recorded) rather than the state string —
   * ANY batch item that has ever been submitted expires on its next edit,
   * whether the owner already acted on it or it is still sitting in
   * Approvals; an item that was never submitted (`version` null) just goes
   * back to drafting as before.
   */
  nextStateAfterEdit(batchItem) {
    // "Was this ever submitted?" used to be `batchItem.version` alone; with
    // destinations living on publications, a filed publication row is the
    // same fact.
    if (batchItem.version || this.storage.hasFiledPublication(batchItem.id)) {
      return { state: "expired", approval_id: null };
    }
    return { state: "drafting" };
  }

  // -----------------------------------------------------------------------
  // review / publish (REQ-009, REQ-010, SEC-005)
  // -----------------------------------------------------------------------

  /**
   * TWO Social Hub door calls, not one (TASK-103, TASK-402).
   *
   * 1. `createDraft` (`generate`) writes the immutable version and hands back
   *    the `versionId`/`contentHash` this call — and every later
   *    `readPublishState` poll — keys on. It runs inline; nothing about a
   *    draft leaves the workspace.
   * 2. `submitForReview` (`send`) is the ask: a direct call from gadget code
   *    ALWAYS comes back refused with `submission_required` (`gatekeepers.ts`)
   *    — that refusal is what puts the post on the existing Approvals
   *    surface, not a failure to handle. Anything else back from that call
   *    (a stale-hash refusal the door caught itself, an absent door, some
   *    other refusal code) is a real problem — reported back as an `{ ok:
   *    false }` refusal rather than a throw (see the file header note), not
   *    silently recording as submitted.
   *
   * On the expected refusal, the batch item moves to `review_requested` and
   * each filing lands as a `publications` row carrying the `versionId`/
   * `contentHash` `createDraft` returned — never an `approvalId`, which this
   * call never learns (see `projectBatchItem`).
   *
   * THE SIGNATURE CHANGED (TASK-010/011). Destination and timing were once
   * fixed on the batch item at create; they are this call's arguments now —
   * `destinationBindings` is where the submission goes (absent: the item's
   * recorded bindings, the default a caller older than this flow relies on),
   * `intent` is the timing (`publishMode` + schedule fields), and
   * `createNewVersion` is REQ-017's explicit opt-in for a pair that is
   * already claimed.
   *
   * ONE FILING PER BINDING: the door is asked per destination — one
   * `createDraft` whose `targets` is that destination alone, one
   * `submitForReview` for its `versionId` — so a `publications` row records
   * one pair's intent and receipt. A binding that fails lands in `failures`
   * and files nothing; the bindings that succeeded are still filed.
   *
   * EVERY early exit below is `{ ok: false, code, message }`, never a
   * throw — the owner can hit each one through ordinary use (a stale
   * revision, no destination chosen, a destination the
   * door cannot resolve, the Social Hub itself unreachable) and this method
   * runs as a facet RPC target, where a throw is what breaks the output
   * gate (file header note).
   */
  submitForReview(args) {
    return this.enqueueMutation(() => this.submitForReviewLocked(args));
  }

  async submitForReviewLocked({ batchItemId, expectedRevision, destinationBindings, intent, createNewVersion }) {
    const batchItem = this.storage.getBatchItem(batchItemId);
    if (!batchItem) return { ok: false, code: "batch_item_unknown", message: `No batch item ${batchItemId}.` };
    if (batchItem.currentRevision !== expectedRevision) {
      return {
        ok: false,
        code: "revision_stale",
        message: `Revision mismatch: this batch item is at revision ${batchItem.currentRevision}.`
      };
    }
    const revision = this.storage.getRevision(batchItemId, expectedRevision);
    const origin = this.storage.getOriginLink(batchItemId);
    if (!revision || !origin) {
      return { ok: false, code: "revision_missing", message: "Nothing to submit yet. Save a revision first." };
    }

    const sourceItem = this.storage.getItem(batchItem.itemId);
    /*
     * Where this submission goes. An explicit `destinationBindings` argument
     * wins — it is the picker's answer; absent, the recorded bindings are the
     * default a caller older than this flow relied on (CON-004). An empty
     * answer is the one place `batch_needs_destinations` still means what it
     * says.
     */
    const recorded = this.bindingsForItem(batchItem);
    const bindings =
      destinationBindings === undefined
        ? recorded
        : [
            ...new Set(
              (Array.isArray(destinationBindings) ? destinationBindings : []).filter(
                (binding) => typeof binding === "string" && binding
              )
            )
          ];
    if (!bindings.length) {
      return {
        ok: false,
        code: "batch_needs_destinations",
        message: "Choose a destination account before submitting for review."
      };
    }

    const caption = revision.caption ?? "";
    // Timing comes with the submission now; the stored revision's own intent
    // is only the default a caller that sends none relied on.
    const publication = normalizePublicationIntent(
      intent === undefined ? revision.publicationIntent ?? undefined : intent
    );
    if (!publication.ok) {
      return { ok: false, code: publication.code, message: publication.message };
    }

    const config = this.storage.getConfig();
    const protectedLiterals = detectProtectedLiterals(caption, {
      protectedTerms: config?.protectedTerms,
      protectedHashtags: config?.protectedHashtags,
      disclaimers: config?.disclaimers,
      claimsRequiringConfirmation: config?.claimsRequiringConfirmation
    }).map((span) => span.value);

    const packedMedia = publicationMedia({
      derivedMediaRefs: revision.derivedMediaRefs,
      sourceMedia: sourceItem?.media
    });
    if (!packedMedia.ok) {
      return { ok: false, code: packedMedia.code, message: packedMedia.message };
    }

    // TASK-015: the attribution the door carries is the observation record the
    // ledger stands on, checked against it here rather than assumed.
    const attribution = draftOrigin({
      originLink: origin,
      ledger: revision.ledger,
      sourceId: batchItem.itemId
    });
    if (!attribution.ok) {
      return { ok: false, code: attribution.code, message: attribution.message };
    }

    /*
     * REQ-017's pair rule, where the send happens (TASK-012): an active
     * publication on ANOTHER localization of this source post claims the
     * pair — `bound` included, because a recorded claim is still a claim.
     * Checked for every binding BEFORE the first door call, so a refusal
     * files nothing. The owner's `createNewVersion` opt-in retires the
     * conflicting rows as the new filing succeeds, never before.
     */
    const conflictsByBinding = new Map();
    for (const binding of bindings) {
      const conflicts = this.storage
        .activePublicationsForPair(batchItem.itemId, binding)
        .filter((publication) => publication.batchItemId !== batchItemId);
      if (conflicts.length) conflictsByBinding.set(binding, conflicts);
    }
    if (conflictsByBinding.size && createNewVersion !== true) {
      return duplicatePublicationRefusal(conflictsByBinding, batchItem.itemId);
    }

    const filed = [];
    const skipped = [];
    const failures = [];
    const mergedTargets = [];
    let lastFiled = null;

    // The door calls below are wrapped: `socialCreateDraft` /
    // `socialSubmitForReview` (`doors.js`) throw when the door itself is
    // absent, and a real Social Hub RPC can reject on its own (a genuine
    // outage) — either way that is an owner-facing "try again later", not a
    // reason to let an exception cross this facet's RPC boundary.
    for (const binding of bindings) {
      const mine = this.storage.livePublication(batchItemId, binding);
      // Already filed AT THIS revision — a retry of the same ask refreshes
      // nothing, and the owner is told rather than handed a duplicate.
      if (mine && mine.revision === expectedRevision && mine.state !== "bound") {
        skipped.push({ destinationBinding: binding, publicationId: mine.id, reason: "already_submitted" });
        continue;
      }

      let draft;
      try {
        draft = await socialCreateDraft(this.env, {
          caption,
          media: packedMedia.media,
          targets: [{ destinationBinding: binding }],
          origin: attribution.origin,
          protectedLiterals,
          // The Social Hub owns schedule validation and time resolution.
          // Carry the normalized, owner-reviewed intent through the door
          // instead of silently downgrading every revision to save_draft.
          schedule: publication.intent
        });
      } catch (error) {
        failures.push({ destinationBinding: binding, code: "provider_unavailable", message: errorMessage(error) });
        continue;
      }
      if (isDoorRefusal(draft)) {
        failures.push({
          destinationBinding: binding,
          code: draft.code || "destination_unresolved",
          message: draft.message || "Could not create a draft for this post."
        });
        continue;
      }

      let submission;
      try {
        submission = await socialSubmitForReview(this.env, {
          versionId: draft.versionId,
          expectedContentHash: draft.contentHash
        });
      } catch (error) {
        failures.push({ destinationBinding: binding, code: "provider_unavailable", message: errorMessage(error) });
        continue;
      }
      if (!isDoorRefusal(submission) || submission.code !== "submission_required") {
        failures.push({
          destinationBinding: binding,
          code: "provider_unavailable",
          message: isDoorRefusal(submission)
            ? submission.message
            : "submitForReview returned an unexpected result."
        });
        continue;
      }

      // Retire what this filing replaces: this item's older/bound row for
      // the pair, and — only under the explicit opt-in — the conflicting
      // row on another localization. Failed filings supersede nothing.
      const replaceIds = [mine, ...(conflictsByBinding.get(binding) ?? [])]
        .filter(Boolean)
        .map((publication) => publication.id);
      const publicationId = this.storage.filePublication({
        batchItemId,
        destinationBinding: binding,
        revision: expectedRevision,
        intent: publication.intent,
        state: "review_requested",
        postId: draft.postId,
        version: draft.versionId,
        replaceIds
      });
      filed.push({ destinationBinding: binding, publicationId, postId: draft.postId, versionId: draft.versionId });
      mergedTargets.push(...normalizeTargets(draft.targets, [binding]));
      lastFiled = draft;
    }

    if (!filed.length) {
      if (skipped.length) {
        return {
          ok: false,
          code: "already_submitted",
          message: "This revision was already submitted for review to every selected destination.",
          skipped
        };
      }
      const first = failures[0] ?? { code: "provider_unavailable", message: "Nothing was submitted." };
      return { ok: false, code: first.code, message: first.message, failures };
    }

    this.storage.updateBatchItem(batchItemId, {
      state: "review_requested",
      approval_id: null,
      approved_revision: expectedRevision,
      content_hash: lastFiled.contentHash,
      post_id: lastFiled.postId,
      version: lastFiled.versionId,
      targets_json: JSON.stringify(mergedTargets.length ? mergedTargets : null)
    });
    await this.broadcast({ type: "review_requested", batchItemId, versionId: lastFiled.versionId });
    return {
      ...this.projectBatchItem(this.storage.getBatchItem(batchItemId)),
      submitted: filed,
      ...(skipped.length ? { skipped } : {}),
      ...(failures.length ? { failures } : {})
    };
  }

  /**
   * `{ targets: [{ destinationBinding, label, outcome, detail?, guidance?,
   * receiptUrl? }] }` — `src/client/steps.js`'s `renderPublish`/`renderResult`.
   * `env.social.readStatus({ versionId })` is the single source of truth for
   * what happened after `submitForReview`'s ask (TASK-103, TASK-402): this
   * gadget never learns an `approvalId` synchronously, so `batchItem.version`
   * — the `versionId` `createDraft` returned — is the only thing worth
   * keying the poll on. Every outcome value, `unknown` included, is never
   * retried automatically (REQ-020) — this method only reads.
   */
  async readPublishState(batchItemId) {
    const batchItem = this.storage.getBatchItem(batchItemId);
    if (!batchItem) return { publications: [], targets: [] };

    const publications = [];
    for (const publication of this.storage.publicationsFor(batchItemId)) {
      // A `bound` row was never sent — there is no `versionId` to poll.
      let targets = [];
      if (publication.version) {
        const fresh = await socialReadStatus(this.env, publication.version);
        const freshTargets = isDoorRefusal(fresh) ? null : (fresh?.targets ?? null);
        targets = normalizeTargets(freshTargets, [publication.destinationBinding], null);
        if (freshTargets) {
          // The pair's own outcome rows are the item's canonical targets.
          this.storage.updateBatchItem(batchItemId, { targets_json: JSON.stringify(targets) });
        }
      }
      publications.push({ ...publication, targets });
    }

    return { publications, targets: publications.flatMap((publication) => publication.targets) };
  }

  // -----------------------------------------------------------------------
  // export (REQ-028)
  // -----------------------------------------------------------------------

  async exportAs(format) {
    return format === "html" ? this.exportHtml() : this.exportJson();
  }

  /**
   * REQ-028's bounded JSON export.
   *
   * BOUNDED IN BOTH DIRECTIONS, because a count is not a size. `exportBounds`
   * becomes the SQL `LIMIT` on each of the three collections, so rows this
   * export will not carry are never read; `boundExport` then measures the
   * serialized body against the host's own 8 MiB cap
   * (`MAX_GADGET_EXPORT_BODY_BYTES`) and sheds until it fits, marking what it
   * dropped. Over that cap the host does not truncate — `readGadgetExport`
   * refuses the whole answer — so an export that is one byte too big is an
   * export the owner does not get.
   *
   * Only `items` was capped before, at 200; `batches` and `revisions` were
   * read whole, and revisions were walked per batch item, which is unbounded
   * in three nested directions.
   */
  async exportJson() {
    const items = this.storage
      .listItems({ limit: exportBounds.items })
      .items.map((item) => ({ ...item, media: item.media.map((entry) => ({ id: entry.id, kind: entry.kind })) }));
    const batches = this.storage.listBatches({ limit: exportBounds.batches }).map((batch) => ({
      id: batch.id,
      createdAt: batch.created_at,
      status: batch.status,
      items: this.storage.listBatchItems(batch.id)
    }));
    const revisions = this.storage.listRecentRevisions(exportBounds.revisions);
    const bounded = boundExport(
      { items, batches, revisions },
      {
        items: this.storage.countItems().total,
        batches: this.storage.countBatches(),
        revisions: this.storage.countRevisions()
      }
    );
    return {
      filename: "social-localization-export.json",
      contentType: "application/json",
      body: bounded.body,
      encoding: "utf8"
    };
  }

  /**
   * The same cap applies to the rendered artefact — `readGadgetExport` refuses
   * an oversized body whatever its content type — so the batch list is capped
   * here too, and the page says so rather than ending mid-history with no
   * explanation. No byte-shedding pass: HTML rows are captions, already
   * bounded per destination by REQ-016's limit, and a truncation notice on a
   * page a person reads is worth more than a second serialization.
   */
  async exportHtml() {
    const totalBatches = this.storage.countBatches();
    const sections = this.storage.listBatches({ limit: exportBounds.batches }).map((batch) => {
      const rows = this.storage
        .listBatchItems(batch.id)
        .map((item) => {
          const revision = this.storage.latestRevision(item.id);
          // `destinationBindings`, plural — one batch item carries the whole
          // set the owner picked (`hydrateBatchItem`). Reading the singular
          // `destinationBinding`, which no row has ever had, made this column
          // blank on every export ever produced. Under the publications
          // model the destinations live on `publications` rows; the legacy
          // column stays in the union for rows written before migration 8.
          const publications = this.storage.publicationsFor(item.id);
          const destinations = [
            ...new Set([
              ...(item.destinationBindings ?? []),
              ...publications.map((publication) => publication.destinationBinding)
            ])
          ].join(", ");
          return `<tr><td>${escapeHtml(destinations)}</td><td>${escapeHtml(item.state)}</td><td>${escapeHtml(revision?.caption ?? "")}</td></tr>`;
        })
        .join("");
      return `<h2>Batch ${escapeHtml(batch.id)}</h2><table><thead><tr><th>Destination</th><th>State</th><th>Caption</th></tr></thead><tbody>${rows}</tbody></table>`;
    });
    return {
      filename: "social-localization-export.html",
      contentType: "text/html",
      body:
        `<!doctype html><html><body><h1>Social Content export</h1>` +
        `${sections.join("")}${truncationNotice(totalBatches - sections.length)}</body></html>`,
      encoding: "utf8"
    };
  }

  // -----------------------------------------------------------------------
  // live subscribers (matches the reference Docs gadget's shape)
  // -----------------------------------------------------------------------

  async subscribe(callback, client = {}) {
    const dup = callback.dup();
    this.subscribers.set(dup, { clientId: String(client?.clientId || "") });
    dup.onRpcBroken(() => {
      this.subscribers.delete(dup);
    });
    return this.summary();
  }

  async broadcast(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.operation(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }
}

// ---------------------------------------------------------------------------
// helpers (no `this`, so kept as plain functions rather than private methods)
// ---------------------------------------------------------------------------

/**
 * One binding's `describe()`, or null.
 *
 * A REFUSAL IS NOT A DESCRIPTION. The gate answers an unknown or revoked
 * method with `{ refused: true, code, message }` — a plain object, so reading
 * `.provider` off one yields `undefined` and reading `.captionLimit` yields
 * nothing, silently. Worse, the gate's Proxy makes `typeof door.describe`
 * "function" for EVERY name, so the guard above never fires on a door that
 * has no `describe` at all. Checked explicitly instead.
 */
async function describeConnector(env, binding) {
  const door = env && env[binding];
  if (!door || typeof door.describe !== "function") return null;
  try {
    const description = await door.describe();
    if (!description || typeof description !== "object") return null;
    if (description.refused === true) return null;
    return description;
  } catch {
    return null;
  }
}

/**
 * The instant a firing is FOR. `firedFor` is the schedule's own due instant,
 * so a run that the queue got to late is still filed under the day it was due
 * — which is what an owner reading "one digest a day" expects. Anything
 * unparseable falls back to now rather than to an invalid date.
 */
function firingInstant(firing) {
  const raw = typeof firing?.firedFor === "string" ? Date.parse(firing.firedFor) : NaN;
  return Number.isFinite(raw) ? new Date(raw) : new Date();
}

/** The label a door reported for one granted binding, falling back to the binding's own name. */
function describeLabel(describe, binding) {
  return (
    readString(describe?.resourceLabel) ?? readString(describe?.label) ?? readString(describe?.providerLabel) ?? binding
  );
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : null;
}

/**
 * `social.submitForReview` / `readStatus`'s target rows, defensively mapped
 * into `{ destinationBinding, label, outcome, detail?, guidance?, receiptUrl?
 * }` — the exact shape `src/client/steps.js`'s `renderPublish`/`renderResult`
 * read. TASK-103 is a parallel, not-yet-merged door, so its field names are
 * not confirmed; this accepts a couple of reasonable aliases (`binding` for
 * `destinationBinding`, `status` for `outcome`) and reports "unknown" per
 * destination the door said nothing about, never a guessed narrower outcome
 * (REQ-020 — unknown is a real value, not silence). Every destination the
 * batch item was submitted for gets a row even if the door omitted it, and a
 * destination missing from the fresh read keeps its last known row rather
 * than reverting to "unknown".
 */
function normalizeTargets(raw, destinationBindings, previous) {
  const fresh = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const binding = entry?.destinationBinding ?? entry?.binding;
    if (typeof binding !== "string") continue;
    fresh.set(binding, {
      destinationBinding: binding,
      label: typeof entry.label === "string" ? entry.label : null,
      outcome:
        typeof entry.outcome === "string" ? entry.outcome : typeof entry.status === "string" ? entry.status : "unknown",
      detail: typeof entry.detail === "string" ? entry.detail : null,
      guidance: typeof entry.guidance === "string" ? entry.guidance : null,
      receiptUrl:
        typeof entry.receiptUrl === "string"
          ? entry.receiptUrl
          : typeof entry.receipt_url === "string"
            ? entry.receipt_url
            : null
    });
  }
  const known = new Map((Array.isArray(previous) ? previous : []).map((entry) => [entry?.destinationBinding, entry]));
  return (Array.isArray(destinationBindings) ? destinationBindings : []).map(
    (binding) =>
      fresh.get(binding) ??
      known.get(binding) ?? {
        destinationBinding: binding,
        label: null,
        outcome: "unknown",
        detail: null,
        guidance: null,
        receiptUrl: null
      }
  );
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * REQ-017's refusal. Names the batch and the item that already hold the pair,
 * because "this is already localized" without saying WHERE is a dead end for
 * whoever reads it — and says what the owner can do instead, which is the
 * `createNewVersion` opt-in.
 */
function duplicateRefusal(duplicates) {
  const first = duplicates[0];
  const rest = duplicates.length - 1;
  const where = `batch ${first.batchId} (item ${first.batchItemId})`;
  const more =
    rest > 0
      ? ` ${rest} other selected post${rest === 1 ? "" : "s"} ${rest === 1 ? "is" : "are"} already localized too.`
      : "";
  const bound = first.destinationBindings?.length ? ` for ${first.destinationBindings.join(", ")}` : "";
  return {
    ok: false,
    code: "duplicate_active",
    message:
      `${first.itemId} already has an active localization${bound} in ${where}.${more}` +
      " Open it, or create a new version to localize it again.",
    duplicates
  };
}

/**
 * REQ-017's refusal at submit — the pair rule, applied per destination
 * (TASK-012). `conflictsByBinding` maps each requested binding to the active
 * publication rows on OTHER localizations of the same source post that
 * already claim it; the refusal names the batch and item holding the first
 * conflict and lists every claimed pair.
 */
function duplicatePublicationRefusal(conflictsByBinding, itemId) {
  const bindings = [...conflictsByBinding.keys()];
  const first = [...conflictsByBinding.values()][0][0];
  const where = `batch ${first.batchId ?? "—"} (item ${first.batchItemId})`;
  const duplicates = [...conflictsByBinding.entries()].flatMap(([binding, pubs]) =>
    pubs.map((pub) => ({
      itemId,
      batchId: pub.batchId,
      batchItemId: pub.batchItemId,
      publicationId: pub.id,
      destinationBindings: [binding]
    }))
  );
  return {
    ok: false,
    code: "duplicate_active",
    message:
      `${itemId} already has an active publication to ${bindings.join(", ")} in ${where}.` +
      " Open it, or create a new version to send this post there again.",
    duplicates
  };
}

function conflictResult(currentRevision) {
  return {
    ok: false,
    issues: [
      {
        code: "revision_conflict",
        severity: "block",
        message: `Someone already saved revision ${currentRevision}. Reload and try again.`
      }
    ]
  };
}

function isPngSignature(bytes) {
  if (bytes.byteLength < 8) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function readPngDimensions(bytes) {
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Uint8Array / ArrayBuffer / plain array / base64 string, all in — one boundary for "bytes arrived over RPC or JSON". */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  /*
   * A Buffer that has crossed the facet RPC as JSON.
   *
   * Bytes do not survive that boundary as a typed array: Node serialises a
   * Buffer to `{ type: "Buffer", data: [...] }`, so every `instanceof` above
   * misses and the media reads as unreadable. This is the shape a door's
   * bytes ACTUALLY have by the time the gadget sees them — the door was
   * working long before this function could tell, and the bare `null` it
   * returned reported that as "no media".
   */
  if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
    return new Uint8Array(value.data);
  }
  /*
   * A typed array that has crossed the facet RPC.
   *
   * `Uint8Array` does not survive that boundary as itself: it arrives as a
   * plain object keyed by index, so every `instanceof` above misses and the
   * bytes look unreadable. This is the shape a door's media actually has by
   * the time the gadget sees it — the door was working long before this
   * function could tell.
   *
   * Read by INDEX up to `length`, rather than by `Object.values`, because key
   * order is not part of the contract and a stray non-index property would
   * otherwise be spliced into the middle of an image.
   */
  if (value && typeof value === "object") {
    const length = Number(value.length ?? value.byteLength);
    if (Number.isInteger(length) && length >= 0) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        const byte = value[index];
        if (typeof byte !== "number") return null;
        bytes[index] = byte;
      }
      return bytes;
    }
  }
  if (typeof value === "string") {
    try {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * What the HTML export leaves out, said on the page (REQ-028). Empty when
 * nothing was dropped — a notice that always shows is a notice nobody reads.
 */
function truncationNotice(dropped) {
  return dropped > 0
    ? `<p>${escapeHtml(`${dropped} older batch${dropped === 1 ? "" : "es"} were not included in this export.`)}</p>`
    : "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
