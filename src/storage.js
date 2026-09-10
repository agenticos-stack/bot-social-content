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

import { ledgerFromProtectedOverrides, normalizeLedger } from "./model.js";

const CURRENT_SCHEMA_VERSION = 7;

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
      rights_status TEXT NOT NULL DEFAULT 'pending',
      rights_confirmed_by TEXT,
      rights_confirmed_at TEXT,
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
  }
};

function nowIso() {
  return new Date().toISOString();
}

function rows(cursor) {
  return cursor.toArray();
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

  createBatch(id) {
    this.sql.exec("INSERT INTO batches (id, created_at, status) VALUES (?, ?, ?)", id, nowIso(), "open");
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
   * from the current batch-item domain state (and rights outcome), not from a
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
      `SELECT b.id, b.created_at, b.status,
         COUNT(bi.id) AS item_count,
         SUM(CASE WHEN bi.state IN ('drafting','held_rights','expired') THEN 1 ELSE 0 END) AS draft_count,
         SUM(CASE WHEN bi.state IN ('submitted','awaiting_approval') THEN 1 ELSE 0 END) AS review_count,
         SUM(CASE WHEN bi.state = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_count,
         SUM(CASE WHEN bi.state IN ('failed','unknown','held') OR bi.rights_status IN ('pending','denied') THEN 1 ELSE 0 END) AS attention_count,
         MIN(bi.updated_at) AS first_updated_at,
         MAX(bi.updated_at) AS last_updated_at,
         GROUP_CONCAT(DISTINCT bi.item_id) AS source_item_ids,
         sample.id AS preview_item_id,
         COALESCE(origin.source_label, source.source_label, source.provider) AS preview_source_label,
         SUBSTR(source.text, 1, 160) AS preview_source_text,
         SUBSTR(revision.caption, 1, 160) AS preview_caption,
         revision.revision AS preview_revision,
         CASE WHEN source.media_json IS NOT NULL AND json_array_length(source.media_json) > 0 THEN 1 ELSE 0 END AS preview_has_media
       FROM batches b LEFT JOIN batch_items bi ON bi.batch_id = b.id AND bi.active = 1
       LEFT JOIN batch_items sample ON sample.id = (
         SELECT id FROM batch_items WHERE batch_id = b.id AND active = 1 ORDER BY id LIMIT 1
       )
       LEFT JOIN items source ON source.id = sample.item_id
       LEFT JOIN origin_links origin ON origin.batch_item_id = sample.id
       LEFT JOIN revisions revision ON revision.batch_item_id = sample.id AND revision.revision = sample.current_revision
       ${filter}
       GROUP BY b.id, b.created_at, b.status
       ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
      ...params,
      bounded + 1
    ));
    const page = rowsFound.slice(0, bounded);
    const last = page[page.length - 1];
    return {
      batches: page.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        status: row.status,
        itemCount: Number(row.item_count ?? 0),
        draftCount: Number(row.draft_count ?? 0),
        reviewCount: Number(row.review_count ?? 0),
        scheduledCount: Number(row.scheduled_count ?? 0),
        attentionCount: Number(row.attention_count ?? 0),
        firstUpdatedAt: row.first_updated_at ?? null,
        lastUpdatedAt: row.last_updated_at ?? null,
        sourceItemIds: row.source_item_ids ? String(row.source_item_ids).split(",") : [],
        preview: row.preview_item_id ? {
          batchItemId: row.preview_item_id,
          sourceLabel: row.preview_source_label ?? null,
          sourceText: row.preview_source_text ?? null,
          caption: row.preview_caption ?? null,
          revision: row.preview_revision == null ? null : Number(row.preview_revision),
          hasMediaReference: Boolean(row.preview_has_media)
        } : null
      })),
      nextCursor: rowsFound.length > bounded && last ? `${last.created_at}|${last.id}` : null,
      totals: {
        batches: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batches"))[0]?.n ?? 0),
        new: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM items LEFT JOIN seen ON seen.item_id = items.id WHERE seen.item_id IS NULL"))[0]?.n ?? 0),
        items: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batch_items WHERE active = 1"))[0]?.n ?? 0),
        drafts: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batch_items WHERE active = 1 AND state IN ('drafting','held_rights','expired')"))[0]?.n ?? 0),
        review: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batch_items WHERE active = 1 AND state IN ('submitted','awaiting_approval')"))[0]?.n ?? 0),
        scheduled: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batch_items WHERE active = 1 AND state = 'scheduled'"))[0]?.n ?? 0),
        attention: Number(rows(this.sql.exec("SELECT COUNT(*) AS n FROM batch_items WHERE active = 1 AND (state IN ('failed','unknown','held') OR rights_status IN ('pending','denied'))"))[0]?.n ?? 0)
      }
    };
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
   * itself is kept — its revisions, rights record and approval history are
   * the audit trail of what was published before.
   */
  supersedeBatchItem(id) {
    this.sql.exec("UPDATE batch_items SET active = 0, updated_at = ? WHERE id = ?", nowIso(), id);
  }

  createBatchItem(row) {
    this.sql.exec(
      `INSERT INTO batch_items (
        id, batch_id, item_id, destination_bindings_json, state, rights_status, current_revision, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      row.id,
      row.batchId,
      row.itemId,
      JSON.stringify(row.destinationBindings ?? []),
      row.state,
      row.rightsStatus,
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
          publication_intent_json, ledger_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        nowIso()
      );
      this.sql.exec(
        "UPDATE batch_items SET current_revision = ?, updated_at = ? WHERE id = ?",
        next,
        nowIso(),
        batchItemId
      );
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
    // Schema 5. `origin` is the field the rights rule reads: `binding` means
    // this organisation holds the account, `open` means it does not.
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

function hydrateBatchItem(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    itemId: row.item_id,
    destinationBindings: row.destination_bindings_json ? JSON.parse(row.destination_bindings_json) : [],
    state: row.state,
    rightsStatus: row.rights_status,
    rightsConfirmedBy: row.rights_confirmed_by ?? null,
    rightsConfirmedAt: row.rights_confirmed_at ?? null,
    currentRevision: Number(row.current_revision),
    approvedRevision:
      row.approved_revision === null || row.approved_revision === undefined ? null : Number(row.approved_revision),
    active: Boolean(row.active),
    approvalId: row.approval_id ?? null,
    contentHash: row.content_hash ?? null,
    postId: row.post_id ?? null,
    version: row.version ?? null,
    targets: row.targets_json ? JSON.parse(row.targets_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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
