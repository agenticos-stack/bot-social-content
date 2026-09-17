// Social Localization blueprint — the storage adapter (REQ-031, CON-009).
//
// The single seam onto `ctx.storage.sql`. `server.js` never touches
// `this.ctx.storage` directly; every read and write goes through a `Storage`
// method here, so a later change to the schema or to the storage backend
// (docs/gadgets/storage.md's key/value fallback, should SQL ever regress on a
// deployed edge — RISK-013) costs this one file.
//
// SCHEMA VERSIONING. `schema_version` is a one-row table; `migrate()` runs
// every migration from its current value up to CURRENT_SCHEMA_VERSION inside
// one `ctx.storage.transactionSync`, so a crash mid-migration leaves either
// the old schema or the new one, never a partial one. Called once per facet
// start (constructor), before any other storage access.
//
// SIZE DISCIPLINE (CON-009). SQLite row/column/blob ceiling is 2 MB. Poster
// PNGs and cached media are bound as BLOB parameters (raw bytes), never
// base64 text, so a 1 MiB preview does not inflate to 1.33 MiB of TEXT and
// press against that ceiling for no reason.

import {
  generationMark as parseGenerationMark,
  itemPresentation,
  ledgerFromProtectedOverrides,
  normalizeLedger,
  PHASE_FILTERS
} from "./model.js";

// Exported for the build only: `scripts/build.mjs` asserts that
// `manifest.json`'s `storageSchemaVersion` equals this, so the declaration the
// host reads before restoring older code cannot drift from the migrations here.
export const CURRENT_SCHEMA_VERSION = 18;

/** LRU cap for `media_cache` — bounded so a chatty scan cannot grow storage without limit. */
const MEDIA_CACHE_MAX_ROWS = 500;

const MIGRATIONS = {
  1(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    )`);

    sql.exec(`CREATE TABLE IF NOT EXISTS sources (
      binding TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      page_id TEXT,
      last_checked_at TEXT,
      last_outcome TEXT,
      last_message TEXT,
      cursor TEXT
    )`);

    sql.exec(`CREATE TABLE IF NOT EXISTS destinations (
      binding TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      provider TEXT NOT NULL
    )`);

    sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      source_binding TEXT NOT NULL,
      source_label TEXT,
      provider TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      author_handle TEXT,
      permalink TEXT,
      published_at TEXT,
      text TEXT NOT NULL,
      locale TEXT,
      media_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      UNIQUE (source_binding, provider_item_id)
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_items_first_seen_at ON items(first_seen_at)`);

    // REQ-013's item-level idempotency lives on the UNIQUE constraint above;
    // this table is the owner's own "have I looked at this" state, kept apart
    // from the provider-derived row so a re-scan that changes contentHash
    // never silently un-sees something the owner already reviewed.
    sql.exec(`CREATE TABLE IF NOT EXISTS seen (
      item_id TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL
    )`);

    sql.exec(`CREATE TABLE IF NOT EXISTS media_cache (
      item_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      rendition TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      byte_length INTEGER NOT NULL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY (item_id, media_id, rendition)
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_media_cache_lru ON media_cache(last_used_at)`);

    sql.exec(`CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL
    )`);

    // REQ-017: only one ACTIVE localization per `(sourceItem,
    // destinationBinding)` pair. A row covers a SET of destinations, so the
    // pair test is an overlap between this row's `destination_bindings_json`
    // and the destinations a new batch asks for — see `activeBatchItemsFor`.
    // Keying on the source item alone would refuse a second destination the
    // owner is entitled to add, and reparenting instead of refusing would
    // move an approved localization under a batch nobody reviewed it in. A
    // superseded row (the owner explicitly created a new version) sets
    // active = 0.
    sql.exec(`CREATE TABLE IF NOT EXISTS batch_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      destination_bindings_json TEXT NOT NULL,
      state TEXT NOT NULL,
      current_revision INTEGER NOT NULL DEFAULT 0,
      approved_revision INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      approval_id TEXT,
      content_hash TEXT,
      post_id TEXT,
      version TEXT,
      targets_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_batch_items_item_active ON batch_items(item_id, active)`);

    // PAT-004: append-only, one row per revision, never updated in place.
    sql.exec(`CREATE TABLE IF NOT EXISTS revisions (
      batch_item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      caption TEXT,
      poster_layout_json TEXT,
      confirmed_claims_json TEXT,
      issues_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (batch_item_id, revision)
    )`);

    sql.exec(`CREATE TABLE IF NOT EXISTS posters (
      batch_item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      template TEXT NOT NULL,
      png BLOB NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (batch_item_id, revision)
    )`);

    // REQ-018: the immutable origin reference every Social Hub version
    // carries, one row per batch item.
    sql.exec(`CREATE TABLE IF NOT EXISTS origin_links (
      batch_item_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      source_binding TEXT NOT NULL,
      source_label TEXT,
      provider_item_id TEXT NOT NULL,
      permalink TEXT,
      source_content_hash TEXT NOT NULL,
      source_published_at TEXT,
      retrieved_at TEXT NOT NULL
    )`);

    // REQ-012: one row per scan attempt, `run_id` unique so a retried fire
    // (or an overlapping manual refresh) is detected rather than re-run.
    sql.exec(`CREATE TABLE IF NOT EXISTS scan_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      new_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      failed_safe_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )`);
  },

  /**
   * REQ-016. What the connector door's `describe()` reported about a binding
   * — provider label, glyph key, supported formats, caption and media limits,
   * native scheduling, reported metrics — kept beside the binding it belongs
   * to, so validation and the UI read the door's facts rather than a guess.
   *
   * One JSON column rather than a column per fact: the descriptor is the
   * door's shape, not ours, and a new field on it must not need a migration
   * here. Nothing in this file reads inside it except `limitsFor*`.
   *
   * Forward-only, per the file header: an existing instance keeps its rows
   * and gets NULL, which reads exactly as "the door never told us" — the same
   * thing an ungranted `describe` means.
   */
  2(sql) {
    sql.exec("ALTER TABLE sources ADD COLUMN describe_json TEXT");
    sql.exec("ALTER TABLE destinations ADD COLUMN describe_json TEXT");
  },

  /**
   * REQ-014's accumulator. What has been found since the last notice went
   * out, so a `daily` policy can send ONE summary rather than one message per
   * scan, and so a notice held through quiet hours is held rather than
   * dropped.
   *
   * One row. `last_notice_day` is the owner's LOCAL day (the config carries
   * the timezone), which is what "once a day" means to a person — not a
   * rolling 24 hours from whenever the first scan happened to run.
   */
  3(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS notify_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pending_new INTEGER NOT NULL DEFAULT 0,
      pending_bindings_json TEXT NOT NULL DEFAULT '[]',
      last_notice_day TEXT,
      last_notice_at TEXT
    )`);
  },

  /**
   * What a scan run actually did, per SOURCE.
   *
   * The run's `status` says whether the RUN finished, and that is all it ever
   * said: `finishScanRun` writes `failed` only when handed an `error`, and the
   * normal path never hands it one. So a run in which every single source
   * failed was recorded `completed`, and a success rate derived from `status`
   * read 1.0 straight through a total provider outage — the release threshold
   * it exists for could not fail.
   *
   * `failed_safe_count` was already here but could not be read as a rate
   * without knowing how many sources there were. These two columns finish the
   * row: `source_count` is the denominator, `unknown_count` is the
   * unclassified bucket the canary holds at zero. Forward-only, so an existing
   * instance keeps its rows and gets NULL, which reads as "this run predates
   * the counting" rather than as zero sources.
   */
  4(sql) {
    sql.exec("ALTER TABLE scan_runs ADD COLUMN source_count INTEGER");
    sql.exec("ALTER TABLE scan_runs ADD COLUMN unknown_count INTEGER");
  },

  /**
   * A source that is a PUBLIC account rather than a granted binding.
   *
   * Until now every source row was a connector binding the organisation had
   * authorised, so `binding` was both its identity and its authority. An open
   * account has neither: nobody granted it, and the only thing that identifies
   * it is a platform and an account key the owner typed.
   *
   * `origin` is the field the RIGHTS RULE reads. `binding` means the
   * organisation holds this account and may trust its content; `open` means it
   * does not, and `trust_connected` must never apply. Storing that as a fact
   * about the row rather than inferring it later from a null column is the
   * whole point — an inference is a second model of authority.
   *
   * `binding` stays the primary key for both kinds, because
   * `UNIQUE(source_binding, provider_item_id)` on `items` already keys
   * de-duplication off it. An open source gets a synthetic, stable key
   * (`open:<platform>:<accountKey>`) so nothing downstream has to learn that
   * some sources are keyed differently.
   *
   * Forward-only: existing rows get `origin = 'binding'`, which is what they
   * have always been.
   */
  5(sql) {
    sql.exec("ALTER TABLE sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'binding'");
    sql.exec("ALTER TABLE sources ADD COLUMN platform TEXT");
    sql.exec("ALTER TABLE sources ADD COLUMN account_key TEXT");
    sql.exec("ALTER TABLE sources ADD COLUMN display_name TEXT");
    // What the last scan of this source cost and who served it, so a degrading
    // provider is answerable without reconstructing it from logs.
    sql.exec("ALTER TABLE sources ADD COLUMN last_served_by TEXT");
    sql.exec("ALTER TABLE sources ADD COLUMN last_cost_credits INTEGER");
  },

  /** TASK-015/017: immutable refinement and publication intent per revision. */
  6(sql) {
    sql.exec("ALTER TABLE revisions ADD COLUMN refinement_brief_json TEXT");
    sql.exec("ALTER TABLE revisions ADD COLUMN protected_overrides_json TEXT");
    sql.exec("ALTER TABLE revisions ADD COLUMN original_media_refs_json TEXT");
    sql.exec("ALTER TABLE revisions ADD COLUMN derived_media_refs_json TEXT");
    sql.exec("ALTER TABLE revisions ADD COLUMN publication_intent_json TEXT");
  },

  /** TASK-009: grounding ledger per revision. NULL means the row predates the ledger. */
  7(sql) {
    sql.exec("ALTER TABLE revisions ADD COLUMN ledger_json TEXT");
  },

  /**
   * Where a draft was SENT (refactor-draft-before-destination-1, TASK-006).
   *
   * A destination binding is a `send` target, and REQ-017's unit is the pair
   * (source item, destination) — so destination, timing, approval and the
   * provider's own receipt live together on one `publications` row, created
   * at submit, instead of a column on the draft.
   *
   * `state` vocabulary: `bound` is a destination recorded but never sent
   * (what a `destinationBindings` argument means under the new flow, and
   * what the backfill gives rows that carried bindings but never
   * submitted); `review_requested` once the ask was filed through the door;
   * `superseded` when the owner replaced the pair; `failed` for a filed
   * attempt that died. Anything the Social Hub later reports lands verbatim.
   *
   * The UNIQUE key is (item, destination, revision): filing the same
   * revision to the same destination again refreshes the row in place —
   * never a second row that could read as a second send.
   */
  8(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY,
      batch_item_id TEXT NOT NULL,
      destination_binding TEXT NOT NULL,
      revision INTEGER NOT NULL,
      intent_json TEXT NOT NULL,
      state TEXT NOT NULL,
      approval_id TEXT,
      post_id TEXT,
      version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (batch_item_id, destination_binding, revision)
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_publications_item ON publications(batch_item_id)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_publications_binding ON publications(destination_binding)");

    /*
     * The backfill (TASK-007): one row per binding each live batch_items row
     * carried, preserving `post_id`, `version` and `approval_id` so nothing
     * already published loses its receipt. The row keys on the revision the
     * item was actually submitted at (`approved_revision`, else the current
     * one), and inherits the item's intent from that revision when there is
     * one. An item that was never submitted keeps its bindings as `bound`
     * rows — recorded defaults, not sends.
     */
    sql.exec(`INSERT INTO publications
        (id, batch_item_id, destination_binding, revision, intent_json, state,
         approval_id, post_id, version, created_at, updated_at)
      SELECT
        'pub_' || bi.id || ':' || je.value,
        bi.id,
        je.value,
        COALESCE(bi.approved_revision, bi.current_revision, 0),
        COALESCE(r.publication_intent_json, '{}'),
        CASE WHEN bi.version IS NULL THEN 'bound' ELSE bi.state END,
        bi.approval_id,
        bi.post_id,
        bi.version,
        bi.created_at,
        bi.updated_at
      FROM batch_items bi
      JOIN json_each(bi.destination_bindings_json) je
      LEFT JOIN revisions r
        ON r.batch_item_id = bi.id
       AND r.revision = COALESCE(bi.approved_revision, bi.current_revision, 0)
      GROUP BY bi.id, je.value`);
  },

  /*
   * The durable "drafting was asked for" mark (PM decision 1, refined). The
   * Content-tab ask used to live in client memory — after a reload a batch at
   * revision 0 was indistinguishable from one the owner opened to hand-edit.
   * `"requested"` is set when the batch is opened and cleared when the owner
   * dismisses the ask or every active item carries a revision.
   */
  9(sql) {
    sql.exec("ALTER TABLE batches ADD COLUMN generation TEXT");
  },

  /*
   * The rights concept is gone — a watched post is a reference the draft is
   * generated from, not a republication awaiting a rights decision. The three
   * columns go with it rather than lingering as write-only defaults.
   */
  10(sql) {
    // A fresh database's CREATE already lacks them; an upgraded one carries
    // them. DROP COLUMN has no IF EXISTS — read the table first.
    const columns = new Set(rows(sql.exec("PRAGMA table_info(batch_items)")).map((col) => col.name));
    for (const column of ["rights_status", "rights_confirmed_by", "rights_confirmed_at"]) {
      if (columns.has(column)) sql.exec(`ALTER TABLE batch_items DROP COLUMN ${column}`);
    }
  },

  // Rows mid-flight at `held_rights` are drafts — nothing gates them now.
  // Its own migration, not folded into 10: databases that already ran 10
  // (this change shipped while it was open) still get the remap.
  11(sql) {
    sql.exec("UPDATE batch_items SET state = 'drafting' WHERE state = 'held_rights'");
  },

  /*
   * Post-audit §9.D: the durable drafting ask becomes per-ITEM, so a
   * regeneration request can name one post instead of silently re-arming its
   * whole batch. `batches.generation` stays as the roll-up ("something in
   * this batch wants drafting"); `batch_items.generation` is the
   * authoritative mark an item's `queued`/`regenerating` phase reads.
   * Backfill marks the draftable items of already-requested batches — filed
   * items were never the ask's work.
   */
  12(sql) {
    sql.exec("ALTER TABLE batch_items ADD COLUMN generation TEXT");
    sql.exec(`UPDATE batch_items SET generation = 'requested'
      WHERE active = 1 AND state IN ('drafting','expired')
        AND batch_id IN (SELECT id FROM batches WHERE generation = 'requested')`);
  },

  /*
   * AI-generated images accepted into the gadget (TASK: attachment→gadget
   * transfer). A row registers the acceptance contract first — `bytes` NULL
   * means the attachment is named but its bytes have not been delivered —
   * then `deliverGeneratedMedia` fills them in. `attachment_id` preserves
   * the platform upload's identity through edit/reload/review/publication.
   */
  13(sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS generated_media (
      id TEXT PRIMARY KEY,
      batch_item_id TEXT NOT NULL,
      attachment_id TEXT,
      mime_type TEXT,
      bytes BLOB,
      byte_length INTEGER,
      alt_text TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_generated_media_item ON generated_media(batch_item_id, created_at)");
  },

  /*
   * The registration stamps the generation ask it answered so a LATE
   * delivery can be correlated: an image registered under request A whose
   * bytes arrive after request B superseded it must not satisfy B's image
   * need — the bytes may still be kept (the owner can pick them), but they
   * are not an answer to the newer ask.
   */
  14(sql) {
    sql.exec("ALTER TABLE generated_media ADD COLUMN generation_request TEXT");
  },

  /*
   * The owner's explicit visual pick — generated image, text poster, or the
   * source media — is a fact about the REVISION, kept apart from the
   * refinement brief: `normalizeRefinementBrief` fills `visualTreatment`
   * with a default for every brief, so a value read from there can never
   * tell "the owner chose keep_original" from "nobody chose". A NULL here
   * is meaningful — a revision saved before the picker existed keeps the
   * ship-the-stored-poster behaviour it was reviewed under.
   */
  15(sql) {
    sql.exec("ALTER TABLE revisions ADD COLUMN accepted_visual_mode TEXT");
  },

  /*
   * Generation continuity (QA d57d357 "existing generation acceptance
   * risks"). Two facts that used to be inferred at read time are stored:
   *
   * - `generated_media.stale` — the registration named a generation request
   *   that was not the item's current mark. It keeps the caller's id (so it
   *   is honest history), never satisfies a mark, and is never auto-accepted.
   *   `content_digest` is the delivered bytes' fingerprint
   *   (`sha256:<hex>`, or `length:<n>` where WebCrypto is absent).
   * - `revisions.accepted_generated_media_id` / `_digest` — the exact asset
   *   an `ai_refinement` revision was reviewed with. Filing ships that asset
   *   and nothing newer.
   *
   * NO BACKFILL (changed with schema 18, audit 5ccaff1 G3). This migration
   * once pinned every historical `ai_refinement` revision to the item's newest
   * delivered image — a guess with no evidence of which image was reviewed.
   * A fresh database now leaves historical pins NULL; filing such a revision
   * refuses `generated_image_review_required` until the owner accepts an
   * image again. Databases that already ran the guessing version are handled
   * by migration 18, which marks those pins provenance-unknown.
   */
  16(sql) {
    sql.exec("ALTER TABLE generated_media ADD COLUMN stale INTEGER NOT NULL DEFAULT 0");
    sql.exec("ALTER TABLE generated_media ADD COLUMN content_digest TEXT");
    sql.exec("ALTER TABLE revisions ADD COLUMN accepted_generated_media_id TEXT");
    sql.exec("ALTER TABLE revisions ADD COLUMN accepted_generated_media_digest TEXT");
  },

  /*
   * Per-post instructions. `instruction_overrides` is the owner's own image
   * and caption instructions for ONE post (`{ image, caption }`, each a
   * string or null = use the saved default); editing it never generates or
   * rewrites anything. `last_generation` keeps a copy of the most recent
   * request mark — its needs, time and the effective instructions it was made
   * under — after the mark itself clears, so the drawer can say which
   * instructions produced the output on screen. Both NULL on existing rows.
   */
  17(sql) {
    sql.exec("ALTER TABLE batch_items ADD COLUMN instruction_overrides TEXT");
    sql.exec("ALTER TABLE batch_items ADD COLUMN last_generation TEXT");
  },

  /*
   * Provenance, immutable assets and drawer metadata (audit 5ccaff1 G3/G4).
   *
   * MIGRATION COMPATIBILITY.
   * - A database that ran the OLD migration 16 holds guessed pins: an
   *   `accepted_generated_media_id` with a NULL digest. Every runtime pin is
   *   written with a digest, so a NULL digest identifies exactly the guessed
   *   lineage (including caption saves that carried a guess forward). Those
   *   become `accepted_generated_media_provenance = 'unknown'`; the id stays
   *   as inspectable history and filing refuses until the owner re-accepts.
   * - Pins with a digest become `'recorded'`. Revisions with no pin stay NULL.
   * - A fresh database never guessed (migration 16 no longer backfills), so
   *   this update touches nothing there.
   * - Publications, receipts and every other revision column are untouched.
   * - `schema_version` gates the run; the UPDATE is also restricted to rows
   *   whose provenance is still NULL, so a replay cannot re-classify.
   * - Code older than 18 reading this database ignores the new columns; the
   *   manifest's `storageSchemaVersion` (18) stops it being restored over it.
   */
  18(sql) {
    sql.exec("ALTER TABLE revisions ADD COLUMN accepted_generated_media_provenance TEXT");
    // "generation" (implicit/correlated pick) or "owner_explicit" (named id).
    sql.exec("ALTER TABLE revisions ADD COLUMN accepted_generated_media_source TEXT");
    sql.exec("ALTER TABLE revisions ADD COLUMN alt_text TEXT");
    // A NEW row made from another row's bytes (e.g. a JPEG copy of a PNG);
    // delivered bytes are never rewritten in place.
    sql.exec("ALTER TABLE generated_media ADD COLUMN derived_from TEXT");
    sql.exec("ALTER TABLE publications ADD COLUMN last_checked_at TEXT");
    sql.exec("ALTER TABLE publications ADD COLUMN provider_id TEXT");
    sql.exec("ALTER TABLE publications ADD COLUMN receipt_url TEXT");
    sql.exec(`UPDATE revisions SET accepted_generated_media_provenance =
        CASE WHEN accepted_generated_media_digest IS NULL THEN 'unknown' ELSE 'recorded' END
      WHERE accepted_generated_media_id IS NOT NULL AND accepted_generated_media_provenance IS NULL`);
  }
};

/**
 * LEFT JOIN of the current revision's accepted generated asset, for the
 * Content thumbnail: delivered, this item's own row, under `ai_refinement`,
 * with recorded provenance. Selects no bytes.
 */
function ACCEPTED_ASSET_JOIN(alias, revisionAlias, itemAlias) {
  return `LEFT JOIN generated_media ${alias} ON ${alias}.id = ${revisionAlias}.accepted_generated_media_id
         AND ${alias}.batch_item_id = ${itemAlias}.id AND ${alias}.bytes IS NOT NULL
         AND ${revisionAlias}.accepted_visual_mode = 'ai_refinement'
         AND ${revisionAlias}.accepted_generated_media_provenance = 'recorded'`;
}

function nowIso() {
  return new Date().toISOString();
}

function rows(cursor) {
  return cursor.toArray();
}

/**
 * Whether a stored layout row and an appended revision's layout describe the
 * same rendered poster. Compared on the fields the renderer reads —
 * template, headline, subline, background kind+value, textColor, align — so
 * an unrelated key carried on the object cannot orphan an honest image, and
 * a change to anything visible cannot borrow one.
 */
function samePosterLayout(previousJson, nextLayout) {
  if (!previousJson || !nextLayout || typeof nextLayout !== "object") return false;
  let previous;
  try {
    previous = JSON.parse(previousJson);
  } catch {
    return false;
  }
  if (!previous || typeof previous !== "object") return false;
  return (
    previous.template === nextLayout.template &&
    previous.headline === nextLayout.headline &&
    previous.subline === nextLayout.subline &&
    previous.textColor === nextLayout.textColor &&
    previous.align === nextLayout.align &&
    previous.background?.kind === nextLayout.background?.kind &&
    previous.background?.value === nextLayout.background?.value
  );
}

export class Storage {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
  }

  /** Runs every unapplied migration inside one transaction. Idempotent. */
  migrate() {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)"
    );
    const existing = rows(this.sql.exec("SELECT version FROM schema_version WHERE id = 1"))[0];
    let current = existing ? Number(existing.version) : 0;
    if (current >= CURRENT_SCHEMA_VERSION) return current;

    this.ctx.storage.transactionSync(() => {
      for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
        const migration = MIGRATIONS[version];
        if (!migration) throw new Error(`social-localization: no migration registered for schema version ${version}`);
        migration(this.sql);
        this.sql.exec(
          "INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
          version
        );
      }
    });
    return CURRENT_SCHEMA_VERSION;
  }

  // ---------------------------------------------------------------------
  // config
  // ---------------------------------------------------------------------

  getConfig() {
    const row = rows(this.sql.exec("SELECT json FROM config WHERE id = 1"))[0];
    return row ? JSON.parse(row.json) : null;
  }

  setConfig(config) {
    this.sql.exec(
      "INSERT INTO config (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      JSON.stringify(config)
    );
  }

  // ---------------------------------------------------------------------
  // sources / destinations
  // ---------------------------------------------------------------------

  /**
   * Replace the BINDING sources — the ones derived from connector grants.
   *
   * Scoped to `origin = 'binding'` since schema 5. It used to delete every
   * row, which was right while every source WAS a binding: re-running setup
   * re-derived them all from the grants. An open account has no grant to
   * re-derive it from, so an unscoped delete would silently drop every public
   * account an owner had added, on the next visit to the setup form, with
   * nothing said.
   */
  setSources(sources) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM sources WHERE origin = 'binding'");
      for (const source of sources) {
        this.sql.exec(
          "INSERT INTO sources (binding, label, provider, page_id, describe_json) VALUES (?, ?, ?, ?, ?)",
          source.binding,
          source.label,
          source.provider,
          source.pageId ?? null,
          source.describe ? JSON.stringify(source.describe) : null
        );
      }
    });
  }

  /**
   * Add one grant-derived binding without disturbing the row already there.
   *
   * `setSources`/`setDestinations` are REPLACE — right for "these are the
   * bindings" at setup, wrong for `refreshGrants`: a connector granted after
   * first setup must appear WITHOUT the existing rows' cursor, scan history
   * and stored describe being rewritten. `INSERT OR IGNORE` keeps the row
   * that is there when the binding was already known.
   */
  addSourceBinding(source) {
    this.sql.exec(
      "INSERT OR IGNORE INTO sources (binding, label, provider, page_id, describe_json) VALUES (?, ?, ?, ?, ?)",
      source.binding,
      source.label,
      source.provider,
      source.pageId ?? null,
      source.describe ? JSON.stringify(source.describe) : null
    );
  }

  addDestinationBinding(destination) {
    this.sql.exec(
      "INSERT OR IGNORE INTO destinations (binding, label, provider, describe_json) VALUES (?, ?, ?, ?)",
      destination.binding,
      destination.label,
      destination.provider,
      destination.describe ? JSON.stringify(destination.describe) : null
    );
  }

  /**
   * Add one public account as a source, or leave it as it is.
   *
   * `INSERT OR IGNORE`, so adding the same account twice is not an error and
   * does not reset the cursor — an owner pasting a link they already added
   * should get the source they already have, not a rescan from the top.
   *
   * Returns whether a row was created, read from `meta.changes`... which this
   * storage layer does not expose. So it re-reads instead: `changes` cannot
   * distinguish "inserted" from "ignored" reliably here, and the caller needs
   * to tell an owner "added" from "already watching".
   */
  addOpenSource(source) {
    const existing = this.getSource(source.binding);
    if (existing) return { added: false, source: existing };
    this.sql.exec(
      `INSERT INTO sources (binding, label, provider, origin, platform, account_key, display_name)
       VALUES (?, ?, ?, 'open', ?, ?, ?)`,
      source.binding,
      source.displayName,
      source.platform,
      source.platform,
      source.accountKey,
      source.displayName
    );
    return { added: true, source: this.getSource(source.binding) };
  }

  /** Remove one source by its key. Used for an open account an owner drops. */
  removeSource(binding) {
    this.sql.exec("DELETE FROM sources WHERE binding = ?", binding);
  }

  /**
   * What metered fetching has cost this gadget in the last 30 days.
   *
   * Summed from the SOURCE rows' last recorded cost rather than from a running
   * total, so the number cannot drift from what actually happened — a counter
   * that is incremented separately is a second account of the same facts, and
   * it is the one that goes wrong.
   *
   * This is an approximation and says so: it counts each source's LAST scan,
   * not every scan in the window. A precise figure needs a per-call ledger,
   * which is worth adding when the budget starts refusing people rather than
   * before.
   */
  fetchSpendCredits() {
    const row = rows(
      this.sql.exec("SELECT COALESCE(SUM(last_cost_credits), 0) AS spent FROM sources WHERE origin = 'open'")
    )[0];
    return Number(row?.spent ?? 0);
  }

  /** What the last scan of this source cost, and which provider served it. */
  recordSourceCost(binding, { servedBy, credits }) {
    this.sql.exec(
      "UPDATE sources SET last_served_by = ?, last_cost_credits = ? WHERE binding = ?",
      servedBy ?? null,
      typeof credits === "number" ? credits : null,
      binding
    );
  }

  listSources() {
    return rows(this.sql.exec("SELECT * FROM sources ORDER BY binding")).map(hydrateSource);
  }

  getSource(binding) {
    const row = rows(this.sql.exec("SELECT * FROM sources WHERE binding = ?", binding))[0];
    return row ? hydrateSource(row) : null;
  }

  recordSourceOutcome(binding, { outcome, message, cursor }) {
    this.sql.exec(
      "UPDATE sources SET last_checked_at = ?, last_outcome = ?, last_message = ?, cursor = ? WHERE binding = ?",
      nowIso(),
      outcome,
      message ?? null,
      cursor === undefined ? null : cursor,
      binding
    );
  }

  setDestinations(destinations) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM destinations");
      for (const destination of destinations) {
        this.sql.exec(
          "INSERT INTO destinations (binding, label, provider, describe_json) VALUES (?, ?, ?, ?)",
          destination.binding,
          destination.label,
          destination.provider,
          destination.describe ? JSON.stringify(destination.describe) : null
        );
      }
    });
  }

  listDestinations() {
    return rows(this.sql.exec("SELECT * FROM destinations ORDER BY binding")).map(hydrateDestination);
  }

  getDestination(binding) {
    const row = rows(this.sql.exec("SELECT * FROM destinations WHERE binding = ?", binding))[0];
    return row ? hydrateDestination(row) : null;
  }

  /**
   * REQ-016's caption limit for a SET of destinations: the tightest one any
   * of them reported. A caption one destination would reject is not
   * publishable to the set the owner picked, so the strictest limit is the
   * only honest one to validate against.
   *
   * A destination whose door reported no limit contributes nothing — it is
   * unknown, not unlimited and not zero (GUD-003). When none of them reported
   * one, `captionMax` is null and `validateLocalization` skips the check
   * rather than inventing a bound.
   */
  limitsForDestinations(bindings) {
    let captionMax = null;
    for (const binding of bindings ?? []) {
      const destination = this.getDestination(binding);
      const limit = destination?.describe?.captionLimit;
      if (typeof limit !== "number" || !Number.isFinite(limit)) continue;
      captionMax = captionMax === null ? limit : Math.min(captionMax, limit);
    }
    return { captionMax };
  }

  // ---------------------------------------------------------------------
  // items (REQ-004, REQ-013)
  // ---------------------------------------------------------------------

  /**
   * Upserts one normalized SourceItem. Returns `{ isNew, changed }` so the
   * scan can count new / changed / unchanged without a second read.
   */
  upsertItem(item) {
    const existing = rows(
      this.sql.exec(
        "SELECT content_hash, first_seen_at FROM items WHERE source_binding = ? AND provider_item_id = ?",
        item.sourceBinding,
        item.providerItemId
      )
    )[0];

    const mediaJson = JSON.stringify(item.media ?? []);
    const metricsJson = JSON.stringify(item.metrics ?? {});

    if (!existing) {
      this.sql.exec(
        `INSERT INTO items (
          id, source_binding, source_label, provider, provider_item_id, author_handle, permalink,
          published_at, text, locale, media_json, metrics_json, content_hash, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.id,
        item.sourceBinding,
        item.sourceLabel ?? null,
        item.provider,
        item.providerItemId,
        item.authorHandle ?? null,
        item.permalink ?? null,
        item.publishedAt ?? null,
        item.text ?? "",
        item.locale ?? null,
        mediaJson,
        metricsJson,
        item.contentHash,
        item.firstSeenAt,
        item.lastSeenAt
      );
      return { isNew: true, changed: false };
    }

    const changed = existing.content_hash !== item.contentHash;
    this.sql.exec(
      `UPDATE items SET
        source_label = ?, author_handle = ?, permalink = ?, published_at = ?, text = ?, locale = ?,
        media_json = ?, metrics_json = ?, content_hash = ?, last_seen_at = ?
      WHERE source_binding = ? AND provider_item_id = ?`,
      item.sourceLabel ?? null,
      item.authorHandle ?? null,
      item.permalink ?? null,
      item.publishedAt ?? null,
      item.text ?? "",
      item.locale ?? null,
      mediaJson,
      metricsJson,
      item.contentHash,
      item.lastSeenAt,
      item.sourceBinding,
      item.providerItemId
    );
    return { isNew: false, changed };
  }

  getItem(id) {
    const row = rows(this.sql.exec("SELECT * FROM items WHERE id = ?", id))[0];
    return row ? hydrateItem(row) : null;
  }

  /** Cursor-paginated listing. Cursor is an opaque `firstSeenAt|id` pair, oldest-first excluded (newest first). */
  listItems({ filter = "all", provider, sourceBinding, query, cursor, limit = 50 } = {}) {
    const clauses = [];
    const params = [];

    if (provider) {
      clauses.push("items.provider = ?");
      params.push(provider);
    }
    if (sourceBinding) {
      clauses.push("items.source_binding = ?");
      params.push(sourceBinding);
    }
    if (filter === "new") {
      clauses.push("seen.item_id IS NULL");
    }
    if (query && query.trim()) {
      clauses.push("(items.text LIKE ? ESCAPE '\\' OR items.author_handle LIKE ? ESCAPE '\\')");
      const like = `%${query.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    if (cursor) {
      const [firstSeenAt, id] = String(cursor).split("|");
      clauses.push("(items.first_seen_at < ? OR (items.first_seen_at = ? AND items.id < ?))");
      params.push(firstSeenAt, firstSeenAt, id);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const found = rows(
      this.sql.exec(
        `SELECT items.*, seen.item_id AS seen_item_id FROM items
         LEFT JOIN seen ON seen.item_id = items.id
         ${where}
         ORDER BY items.first_seen_at DESC, items.id DESC
         LIMIT ?`,
        ...params,
        boundedLimit + 1
      )
    );

    const page = found.slice(0, boundedLimit);
    const nextCursor =
      found.length > boundedLimit ? `${page[page.length - 1].first_seen_at}|${page[page.length - 1].id}` : null;

    return {
      items: page.map((row) => ({ ...hydrateItem(row), seen: Boolean(row.seen_item_id) })),
      nextCursor
    };
  }

  markSeen(ids) {
    const at = nowIso();
    for (const id of ids) {
      this.sql.exec(
        "INSERT INTO seen (item_id, seen_at) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET seen_at = excluded.seen_at",
        id,
        at
      );
    }
  }

  isSeen(id) {
    return rows(this.sql.exec("SELECT 1 FROM seen WHERE item_id = ?", id)).length > 0;
  }

  setSelection(id, selected) {
    this.sql.exec("UPDATE items SET selected = ? WHERE id = ?", selected ? 1 : 0, id);
  }

  clearSelection() {
    this.sql.exec("UPDATE items SET selected = 0 WHERE selected = 1");
  }

  listSelectedIds() {
    return rows(this.sql.exec("SELECT id FROM items WHERE selected = 1")).map((row) => row.id);
  }

  countItems() {
    const total = rows(this.sql.exec("SELECT COUNT(*) AS n FROM items"))[0]?.n ?? 0;
    const unseen =
      rows(
        this.sql.exec(
          "SELECT COUNT(*) AS n FROM items LEFT JOIN seen ON seen.item_id = items.id WHERE seen.item_id IS NULL"
        )
      )[0]?.n ?? 0;
    const selected = rows(this.sql.exec("SELECT COUNT(*) AS n FROM items WHERE selected = 1"))[0]?.n ?? 0;
    return { total: Number(total), new: Number(unseen), selected: Number(selected) };
  }

  // ---------------------------------------------------------------------
  // media_cache (SEC-004, RISK-002) — bounded, LRU by last_used_at
  // ---------------------------------------------------------------------

  putMedia(itemId, mediaId, rendition, mime, bytes) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO media_cache (item_id, media_id, rendition, mime, bytes, byte_length, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, media_id, rendition) DO UPDATE SET
           mime = excluded.mime, bytes = excluded.bytes, byte_length = excluded.byte_length,
           last_used_at = excluded.last_used_at`,
        itemId,
        mediaId,
        rendition,
        mime,
        bytes,
        bytes.byteLength,
        nowIso()
      );
      const count = rows(this.sql.exec("SELECT COUNT(*) AS n FROM media_cache"))[0]?.n ?? 0;
      if (Number(count) > MEDIA_CACHE_MAX_ROWS) {
        this.sql.exec(
          `DELETE FROM media_cache WHERE rowid IN (
             SELECT rowid FROM media_cache ORDER BY last_used_at ASC LIMIT ?
           )`,
          Number(count) - MEDIA_CACHE_MAX_ROWS
        );
      }
    });
  }

  getMedia(itemId, mediaId, rendition) {
    const row = rows(
      this.sql.exec(
        "SELECT * FROM media_cache WHERE item_id = ? AND media_id = ? AND rendition = ?",
        itemId,
        mediaId,
        rendition
      )
    )[0];
    if (!row) return null;
    this.sql.exec(
      "UPDATE media_cache SET last_used_at = ? WHERE item_id = ? AND media_id = ? AND rendition = ?",
      nowIso(),
      itemId,
      mediaId,
      rendition
    );
    return { mime: row.mime, bytes: toUint8Array(row.bytes) };
  }

  // ---------------------------------------------------------------------
  // notifications (REQ-014)
  // ---------------------------------------------------------------------

  /** What is waiting to be told, and when the last notice went out. Never null — an untouched instance reads as empty. */
  notifyState() {
    const row = rows(this.sql.exec("SELECT * FROM notify_state WHERE id = 1"))[0];
    if (!row) return { pendingNew: 0, pendingBindings: [], lastNoticeDay: null, lastNoticeAt: null };
    let pendingBindings = [];
    try {
      const parsed = JSON.parse(row.pending_bindings_json ?? "[]");
      if (Array.isArray(parsed)) pendingBindings = parsed.filter((entry) => typeof entry === "string");
    } catch {
      pendingBindings = [];
    }
    return {
      pendingNew: Number(row.pending_new ?? 0),
      pendingBindings,
      lastNoticeDay: row.last_notice_day ?? null,
      lastNoticeAt: row.last_notice_at ?? null
    };
  }

  /**
   * Adds one scan's findings to what is waiting.
   *
   * `last_notice_day` is seeded with the day of the FIRST accumulation rather
   * than left null, because "one summary on the first scan after the day
   * rolls over" needs a day to have rolled over FROM. Left null, the very
   * first scan of a fresh instance would look like a roll-over and send a
   * digest immediately, which is the `immediate` policy wearing the daily
   * one's name.
   */
  accumulateNotice({ newCount, bindings, day }) {
    const state = this.notifyState();
    const merged = [
      ...new Set([...state.pendingBindings, ...(bindings ?? []).filter((entry) => typeof entry === "string")])
    ];
    this.sql.exec(
      `INSERT INTO notify_state (id, pending_new, pending_bindings_json, last_notice_day, last_notice_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pending_new = excluded.pending_new,
         pending_bindings_json = excluded.pending_bindings_json,
         last_notice_day = COALESCE(notify_state.last_notice_day, excluded.last_notice_day)`,
      state.pendingNew + Math.max(0, Number(newCount) || 0),
      JSON.stringify(merged),
      day ?? null,
      state.lastNoticeAt
    );
  }

  /** A notice went out: nothing is waiting any more, and this is the day it was sent on. */
  clearNotice({ day, at }) {
    this.sql.exec(
      `INSERT INTO notify_state (id, pending_new, pending_bindings_json, last_notice_day, last_notice_at)
       VALUES (1, 0, '[]', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pending_new = 0,
         pending_bindings_json = '[]',
         last_notice_day = excluded.last_notice_day,
         last_notice_at = excluded.last_notice_at`,
      day ?? null,
      at ?? nowIso()
    );
  }

  // ---------------------------------------------------------------------
  // batches / batch_items (REQ-017)
  // ---------------------------------------------------------------------

  createBatch(id, generation = null) {
    this.sql.exec("INSERT INTO batches (id, created_at, status, generation) VALUES (?, ?, ?, ?)", id, nowIso(), "open", generation);
  }

  /** The owner dismissed the Content-tab ask — durable, unlike a reload. */
  clearGeneration(batchId) {
    this.sql.exec("UPDATE batches SET generation = NULL WHERE id = ?", batchId);
    this.sql.exec("UPDATE batch_items SET generation = NULL WHERE batch_id = ?", batchId);
  }

  /** A saved revision answered this item's ask — its own mark clears, and the batch roll-up follows. */
  clearItemGeneration(batchItemId) {
    this.sql.exec("UPDATE batch_items SET generation = NULL WHERE id = ?", batchItemId);
  }

  /**
   * The owner asked for this batch (or specific items in it) to be drafted —
   * the same durable mark createBatch writes, re-armed. `itemIds` scopes the
   * ask to exactly those rows; omitted, every still-draftable item carries
   * it. Existing drafts stay; the agent's next turn sees the mark and saves
   * a new revision.
   *
   * The mark carries a request identity and base revision (`{ id, base,
   * needs }` — see `generationMark` in model.js): one `request` id is
   * minted per call and each item stamps the revision the ask was made
   * against. A later request SUPersedes an earlier one outright — a result
   * written for an older `id` can satisfy nothing on the newer mark.
   */
  setGeneration(batchId, itemIds = null, request = null, { needs = null, instructionsFor = null } = {}) {
    this.sql.exec("UPDATE batches SET generation = 'requested' WHERE id = ?", batchId);
    const stamp = nowIso();
    // `needs` scopes the ask to one part: an image-only request leaves the
    // caption need unset (and vice versa), so the part not asked for is not
    // the agent's work on this request.
    const wanted = {
      caption: needs ? needs.caption === true : true,
      image: needs ? needs.image === true : true
    };
    const write = (item) => {
      /*
       * INVARIANT: what was REQUESTED is the mark's immutable `scope`; what
       * REMAINS is its mutable `needs`. Completion only ever clears `needs`;
       * authorization of a correlated save reads `scope`.
       *
       * `instructionsFor` returns the whole request snapshot for THIS item —
       * `{ instructions, instructionSources, runInstructions, imageBrief }` —
       * because the brief is per-item: two posts in one request can resolve
       * different source media.
       */
      const snapshot = typeof instructionsFor === "function" ? instructionsFor(item) ?? {} : {};
      const mark = JSON.stringify({
        id: request,
        // `listBatchItems` hydrates `current_revision` to `currentRevision` —
        // reading the column name off the hydrated row stamps base: 0 forever.
        base: item.currentRevision ?? item.current_revision ?? item.revision ?? 0,
        scope: wanted,
        needs: wanted,
        at: stamp,
        ...(snapshot.instructions ? { instructions: snapshot.instructions } : {}),
        ...(snapshot.instructionSources ? { instructionSources: snapshot.instructionSources } : {}),
        ...(snapshot.runInstructions ? { runInstructions: snapshot.runInstructions } : {}),
        ...(snapshot.imageBrief ? { imageBrief: snapshot.imageBrief } : {})
      });
      this.sql.exec(
        "UPDATE batch_items SET generation = ?, last_generation = ?, updated_at = ? WHERE id = ?",
        mark,
        mark,
        stamp,
        item.id
      );
      // Unaccepted results of any other request are superseded from now on.
      // Persisted for honesty of the stored flag; status is also derived on
      // read (`generatedMediaStatuses`), which is the authority.
      if (request) this.markGeneratedMediaSuperseded(item.id, request);
    };
    if (Array.isArray(itemIds) && itemIds.length) {
      const byId = new Map(this.listBatchItems(batchId).map((item) => [item.id, item]));
      for (const id of itemIds) {
        const item = byId.get(id);
        if (item) write(item);
      }
      return;
    }
    for (const item of this.listBatchItems(batchId)) {
      if (!item.active || !["drafting", "expired"].includes(item.state)) continue;
      write(item);
    }
  }

  /**
   * Move an outstanding ask onto a replacement request id, without changing
   * what it asked for.
   *
   * WHY THIS IS NOT `setGeneration`. When an owner replaces ONE post of a
   * request that covered several, the replacement must not strand the others:
   * the platform approval covers the whole request, so the siblings move onto
   * the new id with it. Their scope, remaining needs and instruction snapshot
   * are exactly what they already were — re-scoping them to the replacement's
   * requested parts would silently regenerate work the owner did not ask for.
   */
  rearmGeneration(batchItemId, request, stamp = nowIso()) {
    const row = rows(this.sql.exec("SELECT generation FROM batch_items WHERE id = ?", batchItemId))[0];
    const mark = parseGenerationMark(row?.generation ?? null);
    if (!mark || !request) return;
    const next = JSON.stringify({ ...mark, id: request, at: stamp });
    this.sql.exec(
      "UPDATE batch_items SET generation = ?, last_generation = ?, updated_at = ? WHERE id = ?",
      next,
      next,
      stamp,
      batchItemId
    );
    this.markGeneratedMediaSuperseded(batchItemId, request);
  }

  /** The owner's per-post instruction overrides — `{ image, caption }`, null meaning the saved default. */
  setInstructionOverrides(batchItemId, overrides) {
    const image = typeof overrides?.image === "string" && overrides.image.trim() ? overrides.image : null;
    const caption = typeof overrides?.caption === "string" && overrides.caption.trim() ? overrides.caption : null;
    this.sql.exec(
      "UPDATE batch_items SET instruction_overrides = ?, updated_at = ? WHERE id = ?",
      image === null && caption === null ? null : JSON.stringify({ image, caption }),
      nowIso(),
      batchItemId
    );
  }

  /**
   * A save landed for this item — satisfy only the needs it actually
   * delivered, and only when the write is correlated to THIS request.
   *
   * `request` is the `generation.id` the caller read from the item and
   * echoed back; a mismatched id is a stale result and an absent one is a
   * manual owner save — neither clears anything (audit 5ccaff1 G1: an owner
   * edit while a request is pending does not complete generated work).
   * `needs` names what this write delivered (`{ caption, image }`); only
   * `needs` shrinks — `scope` is kept verbatim.
   *
   * A mark whose needs are all met clears entirely; the batch roll-up then
   * clears via `clearGenerationIfAllDrafted`.
   */
  satisfyItemGeneration(batchItemId, { request = null, needs = {} } = {}) {
    const row = rows(this.sql.exec("SELECT generation FROM batch_items WHERE id = ?", batchItemId))[0];
    const mark = parseGenerationMark(row?.generation ?? null);
    if (!mark) return;
    // Owner saves (no request id) never complete generated work.
    if (request == null || mark.id !== request) return;
    const remaining = {
      caption: mark.needs.caption && !needs.caption,
      image: mark.needs.image && !needs.image
    };
    if (!remaining.caption && !remaining.image) {
      this.clearItemGeneration(batchItemId);
      return;
    }
    /*
     * SPREAD THE PARSED MARK, THEN OVERRIDE ONLY `needs`. A partial completion
     * must not erase what the mark already recorded: rebuilding the object
     * field by field is how a correlated caption save used to drop the
     * `dispatch` acknowledgement while the image was still pending (audit
     * 2026-09-15, finding P2). Everything the mark carried — `dispatch`,
     * `scope`, `at`, `instructions` — survives, and only the outstanding parts
     * shrink.
     */
    this.sql.exec(
      "UPDATE batch_items SET generation = ?, updated_at = ? WHERE id = ?",
      JSON.stringify({ ...mark, needs: remaining }),
      nowIso(),
      batchItemId
    );
  }

  /**
   * Drafts arrived for everything the batch asked about — the ask has
   * answered itself, so it clears rather than waiting on a dismiss.
   */
  clearGenerationIfAllDrafted(batchId) {
    const pending = Number(rows(this.sql.exec(
      "SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ? AND active = 1 AND generation IS NOT NULL", batchId
    ))[0]?.n ?? 0);
    if (pending === 0) this.clearGeneration(batchId);
  }

  /**
   * Stamp what the platform did with an outstanding request.
   *
   * THE REQUEST ID IS REQUIRED. The caller names the generation request this
   * outcome acknowledges, and only rows whose mark still carries that same id
   * are touched. Matching on the batch and item alone let a delayed refusal
   * for request A overwrite the acknowledged dispatch of its replacement B
   * (audit 2026-09-15, finding P1) — an item can be named by more than one
   * request over its life, so the request is what identifies the write.
   *
   * SCOPE IS EXACT. `itemIds` omitted means every item carrying this request;
   * an explicit array — including an empty one — is honoured to the item and
   * never widened to the batch. A malformed scope is the caller's to refuse;
   * this store never reads it as "all".
   *
   * THE RECEIPT IS WRITTEN ONCE AND DOES NOT MOVE.
   *
   * A request's first acknowledgement is the platform's own account of what it
   * did, and it is what everything downstream reads. Letting a later write
   * revise it is how a matching browser confirmation downgraded a platform
   * receipt and a following contradictory browser value then replaced it
   * (audit 2026-09-15 correction, F4). So an item that already carries a
   * dispatch for this request is left exactly as it is; only the first write
   * lands. A browser cannot establish that receipt or change it — the caller
   * cannot label its own write authoritative, because provenance is not read
   * from its input.
   *
   * SCOPE IS EXACT. `itemIds` omitted means every item carrying this request;
   * an explicit array — including an empty one — is honoured to the item and
   * never widened to the batch. A malformed scope is the caller's to refuse;
   * this store never reads it as "all".
   *
   * `dispatch` is `{ filed, actionId, reason, source, at }` — see
   * `generationMark` in model.js. Returns how many marks were stamped.
   */
  recordGenerationDispatch(batchId, { request = null, itemIds, dispatch } = {}) {
    if (typeof request !== "string" || !request) return 0;
    const scoped = Array.isArray(itemIds) ? new Set(itemIds) : null;
    let updated = 0;
    for (const item of this.listBatchItems(batchId)) {
      if (scoped && !scoped.has(item.id)) continue;
      const mark = parseGenerationMark(item.generation);
      if (!mark || mark.id !== request) continue;
      // Already acknowledged for this request: the receipt stands.
      if (mark.dispatch) continue;
      this.sql.exec(
        "UPDATE batch_items SET generation = ?, updated_at = ? WHERE id = ?",
        JSON.stringify({ ...mark, dispatch }),
        nowIso(),
        item.id
      );
      updated += 1;
    }
    return updated;
  }

  /**
   * A turn's terminal outcome lands on the filing receipt it ended.
   *
   * The outcome is a second, later fact about the SAME request — it never
   * creates a dispatch (an outcome for a request that was never filed is
   * refused by the caller) and, like the API's own seed row, the LATEST
   * report stands: a later outcome for the same request replaces the
   * earlier one, so the mark agrees with the platform about how the turn
   * ended. `outcome` is `{ status, code, at }` — see
   * `FINAL_GENERATION_OUTCOMES` in model.js. Returns how many marks were
   * stamped.
   */
  recordGenerationOutcome(batchId, { request = null, itemIds, outcome } = {}) {
    if (typeof request !== "string" || !request) return 0;
    if (!outcome || typeof outcome !== "object") return 0;
    const scoped = Array.isArray(itemIds) ? new Set(itemIds) : null;
    let updated = 0;
    for (const item of this.listBatchItems(batchId)) {
      if (scoped && !scoped.has(item.id)) continue;
      const mark = parseGenerationMark(item.generation);
      if (!mark || mark.id !== request) continue;
      // No filing receipt, no outcome: the platform never took this request.
      if (!mark.dispatch) continue;
      this.sql.exec(
        "UPDATE batch_items SET generation = ?, updated_at = ? WHERE id = ?",
        JSON.stringify({ ...mark, dispatch: { ...mark.dispatch, outcome } }),
        nowIso(),
        item.id
      );
      updated += 1;
    }
    return updated;
  }

  getBatch(id) {
    return rows(this.sql.exec("SELECT * FROM batches WHERE id = ?", id))[0] ?? null;
  }

  /**
   * `limit` is optional and unbounded by default, because every caller but
   * the export wants the whole (small) list and adding a default cap here
   * would silently shorten a screen. The export names its own bound
   * (`exportBounds` in `model.js`) so the row it will not carry is never read
   * out of SQLite in the first place — REQ-028.
   */
  listBatches({ limit } = {}) {
    return typeof limit === "number"
      ? rows(this.sql.exec("SELECT * FROM batches ORDER BY created_at DESC LIMIT ?", limit))
      : rows(this.sql.exec("SELECT * FROM batches ORDER BY created_at DESC"));
  }

  /**
   * Bounded inbox projection. Counts are intentionally calculated over the
   * complete facet and only the batch rows are paged, so a limited page can
   * never masquerade as the workspace total. The state buckets are derived
   * from the current batch-item domain state, not from a
   * browser intent or the legacy batch label.
   */
  listBatchSummaries({ limit = 50, cursor = null } = {}) {
    const bounded = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Math.floor(Number(limit) || 50))) : 50;
    const params = [];
    const where = [];
    if (cursor) {
      const [createdAt, id] = String(cursor).split("|");
      where.push("(b.created_at < ? OR (b.created_at = ? AND b.id < ?))");
      params.push(createdAt, createdAt, id);
    }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rowsFound = rows(this.sql.exec(
      `SELECT b.id, b.created_at, b.status, b.generation,
         COUNT(bi.id) AS item_count,
         MIN(bi.updated_at) AS first_updated_at,
         MAX(bi.updated_at) AS last_updated_at,
         GROUP_CONCAT(DISTINCT bi.item_id) AS source_item_ids,
         sample.id AS preview_item_id,
         COALESCE(origin.source_label, source.source_label, source.provider) AS preview_source_label,
         SUBSTR(source.text, 1, 160) AS preview_source_text,
         SUBSTR(revision.caption, 1, 160) AS preview_caption,
         revision.revision AS preview_revision,
         preview_gm.id AS preview_thumb_id, preview_gm.mime_type AS preview_thumb_mime,
         CASE WHEN source.media_json IS NOT NULL AND json_array_length(source.media_json) > 0 THEN 1 ELSE 0 END AS preview_has_media
       FROM batches b LEFT JOIN batch_items bi ON bi.batch_id = b.id AND bi.active = 1
       LEFT JOIN batch_items sample ON sample.id = (
         SELECT id FROM batch_items WHERE batch_id = b.id AND active = 1 ORDER BY id LIMIT 1
       )
       LEFT JOIN items source ON source.id = sample.item_id
       LEFT JOIN origin_links origin ON origin.batch_item_id = sample.id
       LEFT JOIN revisions revision ON revision.batch_item_id = sample.id AND revision.revision = sample.current_revision
       ${ACCEPTED_ASSET_JOIN("preview_gm", "revision", "sample")}
       ${filter}
       GROUP BY b.id, b.created_at, b.status, b.generation, preview_gm.id, preview_gm.mime_type
       ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
      ...params,
      bounded + 1
    ));
    const page = rowsFound.slice(0, bounded);
    const last = page[page.length - 1];
    /*
     * Per-item projection for the Content grid — the card there is a POST
     * (cover + snapshot + state chip), not a batch header. One extra query
     * over the page's batch ids, grouped in memory; a batch card keeps its
     * `preview` for callers that only need the representative. `phase` is
     * the shared `itemPresentation` roll-up — the same policy the drawer
     * and Publish read — so a filed/published item can never fall through
     * to "drafting" here (§9.A).
     */
    const itemsByBatch = new Map();
    if (page.length) {
      const batchIds = page.map((row) => row.id);
      const itemRows = rows(this.sql.exec(
        `SELECT bi.id AS batch_item_id, bi.batch_id, bi.item_id, bi.state, bi.current_revision,
           bi.generation AS item_generation, bi.targets_json,
           COALESCE(origin.source_label, source.source_label, source.provider) AS source_label,
           source.provider AS provider, source.source_binding AS source_binding,
           SUBSTR(source.text, 1, 160) AS source_text,
           json_extract(source.media_json, '$[0].id') AS cover_media_id,
           SUBSTR(revision.caption, 1, 160) AS caption,
           revision.revision AS caption_revision,
           thumb.id AS thumb_id, thumb.mime_type AS thumb_mime
         FROM batch_items bi
         LEFT JOIN items source ON source.id = bi.item_id
         LEFT JOIN origin_links origin ON origin.batch_item_id = bi.id
         LEFT JOIN revisions revision ON revision.batch_item_id = bi.id AND revision.revision = bi.current_revision
         ${ACCEPTED_ASSET_JOIN("thumb", "revision", "bi")}
         WHERE bi.active = 1 AND bi.batch_id IN (${batchIds.map(() => "?").join(",")})
         ORDER BY bi.id`,
        ...batchIds
      ));
      const pubRows = rows(this.sql.exec(
        `SELECT p.batch_item_id, p.id, p.destination_binding, p.revision, p.state,
           p.post_id, p.version, p.updated_at, p.last_checked_at, p.provider_id, p.receipt_url
         FROM publications p
         JOIN batch_items bi ON bi.id = p.batch_item_id
         WHERE bi.active = 1 AND bi.batch_id IN (${batchIds.map(() => "?").join(",")})
         ORDER BY p.created_at, p.id`,
        ...batchIds
      ));
      const pubsByItem = new Map();
      for (const pub of pubRows) {
        const list = pubsByItem.get(pub.batch_item_id) ?? [];
        list.push(hydratePublication(pub));
        pubsByItem.set(pub.batch_item_id, list);
      }
      for (const row of itemRows) {
        let targets = null;
        try {
          targets = row.targets_json ? JSON.parse(row.targets_json) : null;
        } catch {
          targets = null;
        }
        const { phase, deliveries } = itemPresentation({
          state: row.state,
          revision: row.current_revision == null ? 0 : Number(row.current_revision),
          generation: row.item_generation ?? null,
          publications: pubsByItem.get(row.batch_item_id) ?? [],
          targets: targets ?? []
        });
        const list = itemsByBatch.get(row.batch_id) ?? [];
        list.push({
          batchItemId: row.batch_item_id,
          batchId: row.batch_id,
          itemId: row.item_id,
          state: row.state,
          revision: row.current_revision == null ? 0 : Number(row.current_revision),
          // Parsed `{ id, base, needs }` — cards read `needs` for the
          // caption/image pending placeholders.
          generation: parseGenerationMark(row.item_generation ?? null),
          phase,
          deliveries,
          sourceLabel: row.source_label ?? null,
          provider: row.provider ?? null,
          sourceBinding: row.source_binding ?? null,
          sourceText: row.source_text ?? null,
          coverMediaId: row.cover_media_id == null ? null : String(row.cover_media_id),
          caption: row.caption ?? null,
          // The current revision's accepted generated asset — never the
          // source image, never a provenance-unknown pin.
          outputThumbnail: row.thumb_id ? { generatedMediaId: row.thumb_id, mimeType: row.thumb_mime ?? null } : null
        });
        itemsByBatch.set(row.batch_id, list);
      }
    }
    const totals = this.facetItemPhaseTotals();
    return {
      batches: page.map((row) => {
        const items = itemsByBatch.get(row.id) ?? [];
        const count = (filter) => items.filter((item) => (PHASE_FILTERS[filter] ?? []).includes(item.phase)).length;
        return {
          id: row.id,
          createdAt: row.created_at,
          status: row.status,
          generation: row.generation ?? null,
          itemCount: Number(row.item_count ?? 0),
          draftCount: count("drafts"),
          reviewCount: count("review"),
          scheduledCount: count("scheduled"),
          attentionCount: count("attention"),
          firstUpdatedAt: row.first_updated_at ?? null,
          lastUpdatedAt: row.last_updated_at ?? null,
          sourceItemIds: row.source_item_ids ? String(row.source_item_ids).split(",") : [],
          preview: row.preview_item_id ? {
            batchItemId: row.preview_item_id,
            sourceLabel: row.preview_source_label ?? null,
            sourceText: row.preview_source_text ?? null,
            caption: row.preview_caption ?? null,
            revision: row.preview_revision == null ? null : Number(row.preview_revision),
            hasMediaReference: Boolean(row.preview_has_media),
            outputThumbnail: row.preview_thumb_id
              ? { generatedMediaId: row.preview_thumb_id, mimeType: row.preview_thumb_mime ?? null }
              : null
          } : null,
          items
        };
      }),
      nextCursor: rowsFound.length > bounded && last ? `${last.created_at}|${last.id}` : null,
      totals: {
        batches: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batches"))[0]?.n ?? 0),
        new: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM items LEFT JOIN seen ON seen.item_id = items.id WHERE seen.item_id IS NULL"))[0]?.n ?? 0),
        items: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batch_items WHERE active = 1"))[0]?.n ?? 0),
        drafts: totals.drafts,
        review: totals.review,
        scheduled: totals.scheduled,
        attention: totals.attention
      }
    };
  }

  /**
   * Phase counts over EVERY active batch item, not just the page — the
   * Content filter chips' totals must survive a limited page. Two flat
   * reads and the shared `itemPresentation` roll-up; the row state alone
   * cannot answer this (a `review_requested` item whose current revision
   * already published is "published", not review work).
   */
  facetItemPhaseTotals() {
    const itemRows = rows(this.sql.exec(
      `SELECT bi.id, bi.state, bi.current_revision, bi.generation, bi.targets_json
       FROM batch_items bi WHERE bi.active = 1`
    ));
    const pubRows = rows(this.sql.exec(
      `SELECT p.batch_item_id, p.id, p.destination_binding, p.revision, p.state,
         p.post_id, p.version, p.updated_at
       FROM publications p JOIN batch_items bi ON bi.id = p.batch_item_id
       WHERE bi.active = 1`
    ));
    const pubsByItem = new Map();
    for (const pub of pubRows) {
      const list = pubsByItem.get(pub.batch_item_id) ?? [];
      list.push(hydratePublication(pub));
      pubsByItem.set(pub.batch_item_id, list);
    }
    const totals = { drafts: 0, review: 0, scheduled: 0, attention: 0 };
    for (const row of itemRows) {
      let targets = null;
      try {
        targets = row.targets_json ? JSON.parse(row.targets_json) : null;
      } catch {
        targets = null;
      }
      const { phase } = itemPresentation({
        state: row.state,
        revision: row.current_revision == null ? 0 : Number(row.current_revision),
        generation: row.generation ?? null,
        publications: pubsByItem.get(row.id) ?? [],
        targets: targets ?? []
      });
      for (const [filter, phases] of Object.entries(PHASE_FILTERS)) {
        if (phases.includes(phase)) {
          totals[filter] += 1;
          break;
        }
      }
    }
    return totals;
  }

  countBatches() {
    return Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batches"))[0]?.n ?? 0);
  }

  countRevisions() {
    return Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM revisions"))[0]?.n ?? 0);
  }

  /**
   * The most recent revisions across every batch item, newest first (REQ-028).
   *
   * A flat, LIMITed read rather than one `listRevisions` per batch item: the
   * export used to walk every batch, every item, and every revision of each,
   * which is unbounded in three nested directions and is how an instance with
   * a year of edits produces a body the host refuses outright. Each row still
   * carries its `batchItemId`, so nothing about how the export joins up
   * changes.
   */
  listRecentRevisions(limit) {
    return rows(
      this.sql.exec("SELECT * FROM revisions ORDER BY created_at DESC, batch_item_id, revision DESC LIMIT ?", limit)
    ).map(hydrateRevision);
  }

  /**
   * Every ACTIVE batch_item for a source item (REQ-017).
   *
   * PLURAL, and the caller intersects `destinationBindings`, because the pair
   * the requirement names is `(sourceItem, destinationBinding)` — not the
   * source item on its own. One item legitimately holds several active rows
   * once an owner localizes it for one destination today and a different one
   * next week, and only a row that OVERLAPS the destinations being asked for
   * is the duplicate the requirement rejects.
   */
  activeBatchItemsFor(itemId) {
    return rows(
      this.sql.exec("SELECT * FROM batch_items WHERE item_id = ? AND active = 1 ORDER BY created_at", itemId)
    ).map(hydrateBatchItem);
  }

  /**
   * Retires a batch item: the owner explicitly created a new version, so this
   * row stops being the active localization of its pair (REQ-017). The row
   * itself is kept — its revisions and approval history are
   * the audit trail of what was published before.
   */
  supersedeBatchItem(id) {
    this.sql.exec("UPDATE batch_items SET active = 0, updated_at = ? WHERE id = ?", nowIso(), id);
  }

  createBatchItem(row) {
    this.sql.exec(
      `INSERT INTO batch_items (
        id, batch_id, item_id, destination_bindings_json, state, current_revision, active, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
      row.id,
      row.batchId,
      row.itemId,
      JSON.stringify(row.destinationBindings ?? []),
      row.state,
      row.generation ?? null,
      nowIso(),
      nowIso()
    );
  }

  getBatchItem(id) {
    const row = rows(this.sql.exec("SELECT * FROM batch_items WHERE id = ?", id))[0];
    return row ? hydrateBatchItem(row) : null;
  }

  listBatchItems(batchId) {
    return rows(this.sql.exec("SELECT * FROM batch_items WHERE batch_id = ? ORDER BY created_at", batchId)).map(
      hydrateBatchItem
    );
  }

  updateBatchItem(id, patch) {
    const fields = [];
    const params = [];
    for (const [column, value] of Object.entries(patch)) {
      fields.push(`${column} = ?`);
      params.push(value);
    }
    fields.push("updated_at = ?");
    params.push(nowIso());
    params.push(id);
    this.sql.exec(`UPDATE batch_items SET ${fields.join(", ")} WHERE id = ?`, ...params);
  }

  // ---------------------------------------------------------------------
  // publications — REQ-017's pair, one row per (item, destination) sent to
  // ---------------------------------------------------------------------

  /**
   * Record a `bound` destination — what a caller's `destinationBindings`
   * argument means under the new flow (TASK-005): a recorded default the
   * submit picker reads, not a send. `INSERT` is safe because a batch item's
   * bound rows are written once, at creation.
   */
  boundPublication(batchItemId, destinationBinding) {
    this.sql.exec(
      `INSERT INTO publications
        (id, batch_item_id, destination_binding, revision, intent_json, state, created_at, updated_at)
       VALUES (?, ?, ?, 0, '{}', 'bound', ?, ?)`,
      `pub_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      batchItemId,
      destinationBinding,
      nowIso(),
      nowIso()
    );
  }

  /** Every row this item ever filed or was pointed at, oldest first. */
  publicationsFor(batchItemId) {
    return rows(
      this.sql.exec("SELECT * FROM publications WHERE batch_item_id = ? ORDER BY created_at, id", batchItemId)
    ).map(hydratePublication);
  }

  /**
   * This item's live row for a destination — the newest that is neither
   * superseded nor failed. `bound` counts: a recorded default is live until
   * a filing replaces it.
   */
  livePublication(batchItemId, destinationBinding) {
    const row = rows(
      this.sql.exec(
        `SELECT * FROM publications
         WHERE batch_item_id = ? AND destination_binding = ? AND state NOT IN ('superseded','failed')
         ORDER BY revision DESC LIMIT 1`,
        batchItemId,
        destinationBinding
      )
    )[0];
    return row ? hydratePublication(row) : null;
  }

  /**
   * REQ-017's pair rule at submit: every publication claiming
   * (sourceItem, destinationBinding) across every ACTIVE localization of the
   * item — `bound` included, because a recorded claim is still a claim, and
   * the owner transfers it only by the explicit `createNewVersion` opt-in.
   * `superseded`/`failed` rows block nothing.
   */
  activePublicationsForPair(itemId, destinationBinding) {
    return rows(
      this.sql.exec(
        `SELECT p.*, bi.batch_id AS pair_batch_id FROM publications p
         JOIN batch_items bi ON bi.id = p.batch_item_id
         WHERE bi.item_id = ? AND p.destination_binding = ? AND bi.active = 1
           AND p.state NOT IN ('superseded','failed')`,
        itemId,
        destinationBinding
      )
    ).map(hydratePublication);
  }

  /**
   * Was this item ever actually SENT anywhere? `bound` rows are recorded
   * defaults, not sends — the item-key duplicate rule ("one active
   * localization per post while it is still drafting") applies only until a
   * filing exists.
   */
  hasFiledPublication(batchItemId) {
    return (
      rows(
        this.sql.exec(
          "SELECT 1 AS x FROM publications WHERE batch_item_id = ? AND state NOT IN ('bound','superseded','failed') LIMIT 1",
          batchItemId
        )
      ).length > 0
    );
  }

  /**
   * The publisher was asked about this publication. `lastCheckedAt` is
   * always stamped; receipt identifiers only ever fill in — an absent or
   * failed read never clears a receipt that was confirmed earlier.
   */
  recordPublicationCheck(id, { providerId = null, url = null } = {}) {
    this.sql.exec(
      `UPDATE publications SET last_checked_at = ?,
         provider_id = COALESCE(?, provider_id), receipt_url = COALESCE(?, receipt_url)
       WHERE id = ?`,
      nowIso(),
      providerId,
      url,
      id
    );
  }

  /** Retires a pair's claim — the owner's `createNewVersion` opt-in, or a newer revision of the same item taking over. */
  supersedePublication(id) {
    this.sql.exec("UPDATE publications SET state = 'superseded', updated_at = ? WHERE id = ?", nowIso(), id);
  }

  /**
   * One filing, recorded atomically (TASK-010): retire the rows this filing
   * replaces, then write — or revive — the row keyed by
   * (item, destination, revision). Keyed that way on purpose: re-filing the
   * same revision to the same destination refreshes one row rather than
   * stacking a second record of the same ask.
   */
  filePublication({ batchItemId, destinationBinding, revision, intent, state, postId, version, replaceIds = [] }) {
    return this.ctx.storage.transactionSync(() => {
      const atRevision = rows(
        this.sql.exec(
          "SELECT id, state FROM publications WHERE batch_item_id = ? AND destination_binding = ? AND revision = ?",
          batchItemId,
          destinationBinding,
          revision
        )
      )[0];
      // A `bound` row is THIS pair's recorded intent — the filing fills it in
      // rather than superseding it, so one row reads recorded-then-sent
      // instead of a dead r0 beside the real one. Only when nothing already
      // sits at the target revision; otherwise the bound row retires as a
      // replacement like any other.
      const bound = atRevision
        ? null
        : rows(
            this.sql.exec(
              "SELECT id FROM publications WHERE batch_item_id = ? AND destination_binding = ? AND state = 'bound' LIMIT 1",
              batchItemId,
              destinationBinding
            )
          )[0];
      for (const id of replaceIds) {
        if (bound && id === bound.id) continue;
        this.supersedePublication(id);
      }
      if (bound) {
        this.sql.exec(
          "UPDATE publications SET revision = ?, state = ?, intent_json = ?, post_id = ?, version = ?, updated_at = ? WHERE id = ?",
          revision,
          state,
          JSON.stringify(intent ?? {}),
          postId ?? null,
          version ?? null,
          nowIso(),
          bound.id
        );
        return bound.id;
      }
      if (atRevision) {
        // Any bound row for the pair was intent this filing is taking over —
        // it retires even when the filing lands on an existing row.
        this.sql.exec(
          "UPDATE publications SET state = 'superseded', updated_at = ? WHERE batch_item_id = ? AND destination_binding = ? AND state = 'bound'",
          nowIso(),
          batchItemId,
          destinationBinding
        );
        this.sql.exec(
          "UPDATE publications SET state = ?, intent_json = ?, post_id = ?, version = ?, updated_at = ? WHERE id = ?",
          state,
          JSON.stringify(intent ?? {}),
          postId ?? null,
          version ?? null,
          nowIso(),
          atRevision.id
        );
        return atRevision.id;
      }
      const id = `pub_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      this.sql.exec(
        `INSERT INTO publications
          (id, batch_item_id, destination_binding, revision, intent_json, state, approval_id, post_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        id,
        batchItemId,
        destinationBinding,
        revision,
        JSON.stringify(intent ?? {}),
        state,
        postId ?? null,
        version ?? null,
        nowIso(),
        nowIso()
      );
      return id;
    });
  }

  // ---------------------------------------------------------------------
  // revisions (PAT-004) — append-only, expected-revision compare-and-set
  // ---------------------------------------------------------------------

  /**
   * Appends a revision iff `expectedRevision` matches the batch item's
   * current one, inside one transaction. Returns `{ ok, revision }` — on a
   * mismatch, `revision` is the current one so the caller can show it.
   */
  appendRevision(batchItemId, expectedRevision, patch) {
    return this.ctx.storage.transactionSync(() => {
      const batchItem = rows(this.sql.exec("SELECT current_revision FROM batch_items WHERE id = ?", batchItemId))[0];
      if (!batchItem) return { ok: false, revision: null, reason: "not_found" };
      const current = Number(batchItem.current_revision);
      if (current !== expectedRevision) {
        return { ok: false, revision: current, reason: "conflict" };
      }
      const next = current + 1;
      this.sql.exec(
        `INSERT INTO revisions (
          batch_item_id, revision, caption, poster_layout_json, confirmed_claims_json, issues_json,
          refinement_brief_json, protected_overrides_json, original_media_refs_json, derived_media_refs_json,
          publication_intent_json, ledger_json, accepted_visual_mode,
          accepted_generated_media_id, accepted_generated_media_digest,
          accepted_generated_media_provenance, accepted_generated_media_source, alt_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        batchItemId,
        next,
        patch.caption ?? null,
        patch.posterLayout ? JSON.stringify(patch.posterLayout) : null,
        patch.confirmedClaims ? JSON.stringify(patch.confirmedClaims) : null,
        patch.issues ? JSON.stringify(patch.issues) : null,
        patch.refinementBrief ? JSON.stringify(patch.refinementBrief) : null,
        patch.protectedOverrides ? JSON.stringify(patch.protectedOverrides) : null,
        patch.originalMediaRefs ? JSON.stringify(patch.originalMediaRefs) : null,
        patch.derivedMediaRefs ? JSON.stringify(patch.derivedMediaRefs) : null,
        patch.publicationIntent ? JSON.stringify(patch.publicationIntent) : null,
        patch.ledger ? JSON.stringify(patch.ledger) : null,
        patch.acceptedVisualMode ?? null,
        patch.acceptedGeneratedMediaId ?? null,
        patch.acceptedGeneratedMediaDigest ?? null,
        patch.acceptedGeneratedMediaId ? (patch.acceptedGeneratedMediaProvenance ?? "recorded") : null,
        patch.acceptedGeneratedMediaId ? (patch.acceptedGeneratedMediaSource ?? null) : null,
        typeof patch.altText === "string" ? patch.altText : null,
        nowIso()
      );
      this.sql.exec(
        "UPDATE batch_items SET current_revision = ?, updated_at = ? WHERE id = ?",
        next,
        nowIso(),
        batchItemId
      );
      /*
       * A poster is pixels rendered for a LAYOUT, not for a caption. When the
       * appended revision carries the same layout the stored poster was
       * rendered from — the common case, a caption-only edit — the image is
       * still exactly what was reviewed, so the row carries forward and
       * `getPoster(item, currentRevision)` stays honest. A changed layout
       * carries nothing: shipping pixels rendered for a different headline
       * would silently mis-describe the revision.
       */
      const previousPoster = rows(
        this.sql.exec("SELECT template, png, byte_length FROM posters WHERE batch_item_id = ? AND revision = ?", batchItemId, current)
      )[0];
      if (previousPoster) {
        const previousLayout = rows(
          this.sql.exec("SELECT poster_layout_json FROM revisions WHERE batch_item_id = ? AND revision = ?", batchItemId, current)
        )[0];
        if (samePosterLayout(previousLayout?.poster_layout_json, patch.posterLayout)) {
          this.sql.exec(
            `INSERT INTO posters (batch_item_id, revision, template, png, byte_length, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            batchItemId,
            next,
            previousPoster.template,
            previousPoster.png,
            previousPoster.byte_length,
            nowIso()
          );
        }
      }
      return { ok: true, revision: next };
    });
  }

  getRevision(batchItemId, revision) {
    const row = rows(
      this.sql.exec("SELECT * FROM revisions WHERE batch_item_id = ? AND revision = ?", batchItemId, revision)
    )[0];
    return row ? hydrateRevision(row) : null;
  }

  latestRevision(batchItemId) {
    const row = rows(
      this.sql.exec("SELECT * FROM revisions WHERE batch_item_id = ? ORDER BY revision DESC LIMIT 1", batchItemId)
    )[0];
    return row ? hydrateRevision(row) : null;
  }

  listRevisions(batchItemId) {
    return rows(this.sql.exec("SELECT * FROM revisions WHERE batch_item_id = ? ORDER BY revision", batchItemId)).map(
      hydrateRevision
    );
  }

  // ---------------------------------------------------------------------
  // posters
  // ---------------------------------------------------------------------

  savePoster(batchItemId, revision, template, bytes) {
    this.sql.exec(
      `INSERT INTO posters (batch_item_id, revision, template, png, byte_length, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(batch_item_id, revision) DO UPDATE SET
         template = excluded.template, png = excluded.png, byte_length = excluded.byte_length`,
      batchItemId,
      revision,
      template,
      bytes,
      bytes.byteLength,
      nowIso()
    );
  }

  getPoster(batchItemId, revision) {
    const row = rows(
      this.sql.exec("SELECT * FROM posters WHERE batch_item_id = ? AND revision = ?", batchItemId, revision)
    )[0];
    return row ? { template: row.template, bytes: toUint8Array(row.png), byteLength: row.byte_length } : null;
  }

  // ---------------------------------------------------------------------
  // generated_media — AI images accepted into the gadget
  // ---------------------------------------------------------------------

  /**
   * Register an accepted generated image BEFORE its bytes arrive. The
   * two-step shape is the transfer contract: the caller (the agent through
   * `saveGeneratedImage`, or a platform/delivery transfer) names the
   * attachment and the post it belongs to; bytes follow through
   * `deliverGeneratedMedia` — image payloads never ride inside a model's
   * tool result.
   */
  saveGeneratedMedia({
    id,
    batchItemId,
    attachmentId = null,
    altText = null,
    mimeType = null,
    generationRequest = null,
    stale = false
  }) {
    // Registration never touches bytes: re-registering an id keeps its
    // delivered content (see `deliverGeneratedImage`'s immutability rule).
    this.sql.exec(
      `INSERT INTO generated_media (id, batch_item_id, attachment_id, mime_type, alt_text, generation_request, stale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         attachment_id = excluded.attachment_id, alt_text = excluded.alt_text`,
      id,
      batchItemId,
      attachmentId,
      mimeType,
      altText,
      generationRequest,
      stale ? 1 : 0,
      nowIso()
    );
  }

  /**
   * A NEW row holding bytes made from another row (a JPEG copy of a PNG).
   * Inherits the source's request, stale flag, attachment and alt text; the
   * source row is never modified.
   */
  saveDerivedGeneratedMedia({ id, source, bytes, mimeType, contentDigest }) {
    const at = nowIso();
    this.sql.exec(
      `INSERT INTO generated_media (id, batch_item_id, attachment_id, mime_type, bytes, byte_length, alt_text,
         generation_request, stale, content_digest, derived_from, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      source.batchItemId,
      source.attachmentId ?? null,
      mimeType,
      bytes,
      bytes.byteLength,
      source.altText ?? null,
      source.generationRequest ?? null,
      source.stale ? 1 : 0,
      contentDigest,
      source.id,
      at,
      at
    );
    return this.getGeneratedMedia(id);
  }

  /** An existing derived copy of `sourceId` with exactly these bytes, if any. */
  findDerivedGeneratedMedia(sourceId, contentDigest) {
    const row = rows(
      this.sql.exec(
        "SELECT rowid AS seq, * FROM generated_media WHERE derived_from = ? AND content_digest = ? ORDER BY rowid LIMIT 1",
        sourceId,
        contentDigest
      )
    )[0];
    return row ? hydrateGeneratedMedia(row) : null;
  }

  /**
   * Unaccepted rows of this item answering any request other than `request`
   * are superseded. Rows some revision pinned are left alone (they read as
   * `accepted`).
   */
  markGeneratedMediaSuperseded(batchItemId, request) {
    this.sql.exec(
      `UPDATE generated_media SET stale = 1
       WHERE batch_item_id = ? AND generation_request IS NOT NULL AND generation_request <> ?
         AND id NOT IN (SELECT accepted_generated_media_id FROM revisions
                        WHERE batch_item_id = ? AND accepted_generated_media_id IS NOT NULL)`,
      batchItemId,
      request,
      batchItemId
    );
  }

  /**
   * The freshness status of every generated_media row of an item, derived
   * from current data (audit 5ccaff1 G2) — never only from what was true at
   * registration:
   * - `accepted`   — some saved revision pinned it;
   * - `legacy`     — no request id;
   * - `superseded` — answered a request that is no longer the item's latest
   *                  (or was stale when registered), never accepted;
   * - `candidate`  — answers the item's latest request, delivered or pending.
   * The latest request is the pending mark's id, else the last mark's id.
   * Returns a function `(row) => status`.
   */
  generatedMediaStatuses(batchItemId) {
    const pinned = new Set(
      rows(
        this.sql.exec(
          "SELECT DISTINCT accepted_generated_media_id AS id FROM revisions WHERE batch_item_id = ? AND accepted_generated_media_id IS NOT NULL",
          batchItemId
        )
      ).map((row) => row.id)
    );
    const item = rows(this.sql.exec("SELECT generation, last_generation FROM batch_items WHERE id = ?", batchItemId))[0];
    const latest = parseGenerationMark(item?.generation ?? null)?.id ?? parseGenerationMark(item?.last_generation ?? null)?.id ?? null;
    return (row) => {
      if (pinned.has(row.id)) return "accepted";
      if (!row.generationRequest) return "legacy";
      if (row.stale) return "superseded";
      if (latest !== null && row.generationRequest !== latest) return "superseded";
      return "candidate";
    };
  }

  /** Fill in the bytes for a registered row. Returns the hydrated row. */
  deliverGeneratedMedia(id, { bytes, mimeType, contentDigest = null }) {
    this.sql.exec(
      "UPDATE generated_media SET bytes = ?, byte_length = ?, mime_type = ?, content_digest = ?, delivered_at = ? WHERE id = ?",
      bytes,
      bytes?.byteLength ?? 0,
      mimeType,
      contentDigest,
      nowIso(),
      id
    );
    return this.getGeneratedMedia(id);
  }

  getGeneratedMedia(id) {
    const row = rows(this.sql.exec("SELECT rowid AS seq, * FROM generated_media WHERE id = ?", id))[0];
    return row ? hydrateGeneratedMedia(row) : null;
  }

  /** The newest generated image for a post — what the drawer and submit read. */
  latestGeneratedMedia(batchItemId) {
    const row = rows(
      this.sql.exec(
        // rowid breaks a same-millisecond tie in insertion order; a random id does not.
        "SELECT rowid AS seq, * FROM generated_media WHERE batch_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        batchItemId
      )
    )[0];
    return row ? hydrateGeneratedMedia(row) : null;
  }

  /**
   * The newest registration for a post whose derived status is one of
   * `statuses` (default: `candidate` or `legacy` — what a UI may offer beside
   * the accepted image; never `superseded`). `ready` narrows to rows whose
   * bytes landed; `original` excludes derived copies. An implicit
   * `ai_refinement` pick asks for `statuses: ["candidate"]`, `original`.
   */
  latestCandidateGeneratedMedia(batchItemId, { ready = false, statuses = ["candidate", "legacy"], original = false } = {}) {
    const statusOf = this.generatedMediaStatuses(batchItemId);
    const found = rows(
      this.sql.exec(
        `SELECT rowid AS seq, id, batch_item_id, attachment_id, mime_type, byte_length, alt_text, generation_request,
                stale, content_digest, derived_from, created_at, delivered_at
         FROM generated_media
         WHERE batch_item_id = ? ${ready ? "AND bytes IS NOT NULL" : ""} ${original ? "AND derived_from IS NULL" : ""}
         ORDER BY created_at DESC, rowid DESC LIMIT 50`,
        batchItemId
      )
    ).map(hydrateGeneratedMedia);
    const hit = found.find((row) => statuses.includes(statusOf(row)));
    return hit ? this.getGeneratedMedia(hit.id) : null;
  }

  /** Every registration for a post, newest first, without bytes — the drawer's generation history. */
  listGeneratedMediaFor(batchItemId, { limit = 20 } = {}) {
    const statusOf = this.generatedMediaStatuses(batchItemId);
    return rows(
      this.sql.exec(
        `SELECT rowid AS seq, id, batch_item_id, attachment_id, mime_type, byte_length, alt_text, generation_request,
                stale, content_digest, derived_from, created_at, delivered_at, (bytes IS NOT NULL) AS has_bytes
         FROM generated_media WHERE batch_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        batchItemId,
        limit
      )
    ).map((row) => {
      const hydrated = hydrateGeneratedMedia(row);
      return { ...hydrated, ready: Number(row.has_bytes) === 1, status: statusOf(hydrated) };
    });
  }

  /** Registrations whose bytes never arrived — the delivery sweep reads these. */
  pendingGeneratedMedia() {
    return rows(this.sql.exec("SELECT rowid AS seq, * FROM generated_media WHERE bytes IS NULL ORDER BY created_at, rowid")).map(
      hydrateGeneratedMedia
    );
  }

  // ---------------------------------------------------------------------
  // origin_links (REQ-018)
  // ---------------------------------------------------------------------

  setOriginLink(batchItemId, origin) {
    this.sql.exec(
      `INSERT INTO origin_links (
        batch_item_id, provider, source_binding, source_label, provider_item_id, permalink,
        source_content_hash, source_published_at, retrieved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_item_id) DO UPDATE SET
        provider = excluded.provider, source_binding = excluded.source_binding,
        source_label = excluded.source_label, provider_item_id = excluded.provider_item_id,
        permalink = excluded.permalink, source_content_hash = excluded.source_content_hash,
        source_published_at = excluded.source_published_at, retrieved_at = excluded.retrieved_at`,
      batchItemId,
      origin.provider,
      origin.sourceBinding,
      origin.sourceLabel ?? null,
      origin.providerItemId,
      origin.permalink ?? null,
      origin.sourceContentHash,
      origin.sourcePublishedAt ?? null,
      origin.retrievedAt
    );
  }

  getOriginLink(batchItemId) {
    const row = rows(this.sql.exec("SELECT * FROM origin_links WHERE batch_item_id = ?", batchItemId))[0];
    return row ? hydrateOriginLink(row) : null;
  }

  // ---------------------------------------------------------------------
  // scan_runs (REQ-012)
  // ---------------------------------------------------------------------

  /** Starts a run, or returns null if `runId` was already recorded (idempotency). */
  startScanRun(runId) {
    try {
      this.sql.exec("INSERT INTO scan_runs (run_id, status, started_at) VALUES (?, 'running', ?)", runId, nowIso());
      return true;
    } catch {
      // UNIQUE(run_id) violation: this run already exists — a retry of the
      // same firing, or an overlapping caller. Refuse rather than re-scan.
      return false;
    }
  }

  /** A run still marked `running` and started more than `staleAfterMs` ago — treated as crashed, not a live overlap. */
  isRunStale(runId, staleAfterMs) {
    const row = rows(this.sql.exec("SELECT started_at FROM scan_runs WHERE run_id = ?", runId))[0];
    if (!row) return true;
    return Date.now() - Date.parse(row.started_at) > staleAfterMs;
  }

  /** The most recent run still marked `running`, if any — the overlap guard `runScan` checks before starting a new one. */
  activeRun() {
    return (
      rows(this.sql.exec("SELECT * FROM scan_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"))[0] ??
      null
    );
  }

  finishScanRun(runId, outcome) {
    this.sql.exec(
      `UPDATE scan_runs SET status = ?, finished_at = ?, new_count = ?, changed_count = ?, failed_safe_count = ?,
                            source_count = ?, unknown_count = ?, error = ?
       WHERE run_id = ?`,
      outcome.error ? "failed" : "completed",
      nowIso(),
      outcome.newCount ?? 0,
      outcome.changedCount ?? 0,
      outcome.failedSafeCount ?? 0,
      outcome.sourceCount ?? null,
      outcome.unknownCount ?? null,
      outcome.error ?? null,
      runId
    );
  }

  /**
   * The scan ledger, newest first — the only record of whether this instance's
   * scans are actually succeeding.
   *
   * Every row it returns was already being written (`startScanRun` /
   * `finishScanRun` for REQ-012's idempotency); nothing here records anything
   * new. It was simply unreadable: `lastCompletedScanAt` answered "when", and
   * no method answered "how often did it work", which is the one number the
   * canary's scan-success threshold is stated in.
   *
   * `since` is inclusive and compared on `started_at`, so a caller asks for a
   * window rather than pulling the whole ledger and filtering in the client.
   */
  listScanRuns({ since = null, limit = 200 } = {}) {
    const capped = Math.max(1, Math.min(1000, Number(limit) || 200));
    return since
      ? rows(
          this.sql.exec("SELECT * FROM scan_runs WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?", since, capped)
        )
      : rows(this.sql.exec("SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT ?", capped));
  }

  lastCompletedScanAt() {
    const row = rows(
      this.sql.exec("SELECT finished_at FROM scan_runs WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1")
    )[0];
    return row ? row.finished_at : null;
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

function hydrateSource(row) {
  return {
    binding: row.binding,
    label: row.label,
    provider: row.provider,
    pageId: row.page_id ?? null,
    describe: parseDescribe(row.describe_json),
    lastCheckedAt: row.last_checked_at ?? null,
    lastOutcome: row.last_outcome ?? null,
    lastMessage: row.last_message ?? null,
    cursor: row.cursor ?? null,
    // Schema 5. `binding` means a connected account; `open` means a watched
    // public account — the source posts it yields are references, not
    // republications.
    origin: row.origin === "open" ? "open" : "binding",
    platform: row.platform ?? null,
    accountKey: row.account_key ?? null,
    displayName: row.display_name ?? null,
    lastServedBy: row.last_served_by ?? null,
    lastCostCredits: row.last_cost_credits ?? null
  };
}

function hydrateDestination(row) {
  return {
    binding: row.binding,
    label: row.label,
    provider: row.provider,
    describe: parseDescribe(row.describe_json)
  };
}

function hydrateGeneratedMedia(row) {
  return {
    id: row.id,
    batchItemId: row.batch_item_id,
    attachmentId: row.attachment_id ?? null,
    mimeType: row.mime_type ?? null,
    bytes: row.bytes ? toUint8Array(row.bytes) : null,
    byteLength: row.byte_length ?? null,
    altText: row.alt_text ?? null,
    generationRequest: row.generation_request ?? null,
    stale: Number(row.stale ?? 0) === 1,
    contentDigest: row.content_digest ?? null,
    derivedFrom: row.derived_from ?? null,
    // Insertion order (rowid) — orders rows created in the same millisecond.
    seq: row.seq == null ? null : Number(row.seq),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null
  };
}

/** REQ-016's stored describe payload. Unreadable JSON is treated as absent, never as a partial description. */
function parseDescribe(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hydrateItem(row) {
  return {
    id: row.id,
    provider: row.provider,
    sourceBinding: row.source_binding,
    sourceLabel: row.source_label ?? null,
    providerItemId: row.provider_item_id,
    authorHandle: row.author_handle ?? null,
    permalink: row.permalink ?? null,
    publishedAt: row.published_at ?? null,
    text: row.text ?? "",
    locale: row.locale ?? null,
    media: JSON.parse(row.media_json ?? "[]"),
    metrics: JSON.parse(row.metrics_json ?? "{}"),
    contentHash: row.content_hash,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    selected: Boolean(row.selected)
  };
}

function hydratePublication(row) {
  return {
    id: row.id,
    batchItemId: row.batch_item_id,
    // The batch this publication belongs to — present only on the pair-rule
    // join (`activePublicationsForPair`), which is the one caller that names
    // the batch holding the conflict.
    batchId: row.pair_batch_id ?? null,
    destinationBinding: row.destination_binding,
    revision: Number(row.revision),
    intent: parseDescribe(row.intent_json) ?? {},
    state: row.state,
    approvalId: row.approval_id ?? null,
    postId: row.post_id ?? null,
    version: row.version ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at ?? null,
    // Identifiers the publisher already gave us — never an invented URL.
    receipt: {
      postId: row.post_id ?? null,
      version: row.version ?? null,
      providerId: row.provider_id ?? null,
      url: row.receipt_url ?? null
    }
  };
}

function hydrateBatchItem(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    itemId: row.item_id,
    destinationBindings: row.destination_bindings_json ? JSON.parse(row.destination_bindings_json) : [],
    state: row.state,
    currentRevision: Number(row.current_revision),
    approvedRevision:
      row.approved_revision === null || row.approved_revision === undefined ? null : Number(row.approved_revision),
    active: Boolean(row.active),
    approvalId: row.approval_id ?? null,
    contentHash: row.content_hash ?? null,
    postId: row.post_id ?? null,
    version: row.version ?? null,
    targets: row.targets_json ? JSON.parse(row.targets_json) : null,
    generation: row.generation ?? null,
    instructionOverrides: parseJsonObject(row.instruction_overrides),
    lastGeneration: row.last_generation ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJsonObject(json) {
  if (typeof json !== "string" || !json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function hydrateLedger(row) {
  if (row.ledger_json) {
    try {
      return normalizeLedger(JSON.parse(row.ledger_json));
    } catch {
      return { spans: [], media: [] };
    }
  }
  let overrides = [];
  if (row.protected_overrides_json) {
    try {
      overrides = JSON.parse(row.protected_overrides_json);
    } catch {
      overrides = [];
    }
  }
  return ledgerFromProtectedOverrides(overrides);
}

function hydrateRevision(row) {
  return {
    batchItemId: row.batch_item_id,
    revision: Number(row.revision),
    caption: row.caption ?? null,
    posterLayout: row.poster_layout_json ? JSON.parse(row.poster_layout_json) : null,
    confirmedClaims: row.confirmed_claims_json ? JSON.parse(row.confirmed_claims_json) : [],
    issues: row.issues_json ? JSON.parse(row.issues_json) : [],
    // Schema 6 fields are nullable so pre-migration revisions read without
    // fabricated provenance or intent.
    refinementBrief: row.refinement_brief_json ? JSON.parse(row.refinement_brief_json) : null,
    protectedOverrides: row.protected_overrides_json ? JSON.parse(row.protected_overrides_json) : [],
    originalMediaRefs: row.original_media_refs_json ? JSON.parse(row.original_media_refs_json) : [],
    derivedMediaRefs: row.derived_media_refs_json ? JSON.parse(row.derived_media_refs_json) : [],
    publicationIntent: row.publication_intent_json ? JSON.parse(row.publication_intent_json) : null,
    ledger: hydrateLedger(row),
    // The owner's explicit visual pick for this revision — NULL is "no pick
    // recorded", which is not the same as `keep_original` (see migration 15).
    acceptedVisualMode: row.accepted_visual_mode ?? null,
    // The exact generated asset this revision was reviewed with (migration 16).
    acceptedGeneratedMediaId: row.accepted_generated_media_id ?? null,
    acceptedGeneratedMediaDigest: row.accepted_generated_media_digest ?? null,
    // Schema 18: "recorded" (pinned at runtime with a digest), "unknown" (a
    // pin migration 16 guessed), null when nothing is pinned.
    acceptedGeneratedMediaProvenance: row.accepted_generated_media_provenance ?? null,
    acceptanceSource: row.accepted_generated_media_source ?? null,
    altText: row.alt_text ?? null,
    createdAt: row.created_at
  };
}

function hydrateOriginLink(row) {
  return {
    batchItemId: row.batch_item_id,
    provider: row.provider,
    sourceBinding: row.source_binding,
    sourceLabel: row.source_label ?? null,
    providerItemId: row.provider_item_id,
    permalink: row.permalink ?? null,
    sourceContentHash: row.source_content_hash,
    sourcePublishedAt: row.source_published_at ?? null,
    retrievedAt: row.retrieved_at
  };
}
