/**
 * Persistent store for the offline report-draft queue (F2) — the `expo-sqlite` glue behind the pure
 * `@skating/core` draft-queue logic. Each draft is stored as a JSON blob (it's a nested, reopenable
 * record) plus a few queryable columns. `saveDraft` is the `persist` effect the core `flushDraft`
 * calls after every checkpoint, so an interrupted flush always leaves a resumable draft on disk.
 * Untested native glue (like `photoPipeline`); the queue *logic* is tested in `@skating/core`.
 */

import type { HazardQueueItem, ReportDraft } from '@skating/core';
import * as SQLite from 'expo-sqlite';

/**
 * The queue is one table with a `kind` discriminator (Phase 9 offline), not a table per kind.
 *
 * They share a status machine, a flush loop and a retry contract, so splitting them would mean
 * keeping three copies of that in sync — and the flush has to drain them in **capture order**
 * anyway, which is trivial in one table and fiddly across three.
 */
const KIND_REPORT = 'report';
const HAZARD_KINDS = ['hazard', 'hazard_confirmation'] as const;

/**
 * The subset of `expo-sqlite`'s sync API this store uses. Factored out so `ensureSchema` — the one
 * piece here that touches *existing on-device user data* (the `kind` migration) — can be exercised
 * against a real SQLite engine in a unit test, which the rest of this native glue can't be.
 */
export interface SqliteLike {
  execSync(source: string): void;
  runSync(source: string, params: (string | number | null)[]): unknown;
  getAllSync<T>(source: string, params: (string | number | null)[]): T[];
  getFirstSync<T>(source: string, params: (string | number | null)[]): T | null;
}

/**
 * Create the table if missing and run the `kind` migration.
 *
 * Installs from before Phase 9 have the table without `kind`. Adding the column with a default is
 * what makes the migration a no-op for the drafts already sitting on those devices — they're reports,
 * and they keep being reports (the `NOT NULL DEFAULT 'report'` backfills every existing row). Guarded
 * by a column check because `ADD COLUMN` throws on a rerun. Pure w.r.t. the injected db so it's tested.
 */
export function ensureSchema(db: SqliteLike): void {
  db.execSync(
    `CREATE TABLE IF NOT EXISTS report_drafts (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      data TEXT NOT NULL
    )`,
  );
  const columns = db.getAllSync<{ name: string }>('PRAGMA table_info(report_drafts)', []);
  if (!columns.some((c) => c.name === 'kind')) {
    db.execSync(`ALTER TABLE report_drafts ADD COLUMN kind TEXT NOT NULL DEFAULT '${KIND_REPORT}'`);
  }
}

/** All **report** drafts, oldest first — the read half of `listDrafts`, factored out to test alongside
 *  `ensureSchema` (a migrated pre-Phase-9 row must still come back here). */
export function readReportDrafts(db: SqliteLike): ReportDraft[] {
  return db
    .getAllSync<{ data: string }>(
      'SELECT data FROM report_drafts WHERE kind = ? ORDER BY createdAt ASC',
      [KIND_REPORT],
    )
    .map((r) => JSON.parse(r.data) as ReportDraft);
}

let db: SQLite.SQLiteDatabase | null = null;
function getDb(): SQLite.SQLiteDatabase {
  if (db === null) {
    db = SQLite.openDatabaseSync('skating-drafts.db');
    ensureSchema(db);
  }
  return db;
}

function upsert(
  kind: string,
  row: { id: string; status: string; createdAt: number; updatedAt: number },
  record: unknown,
): void {
  getDb().runSync(
    `INSERT INTO report_drafts (id, kind, status, createdAt, updatedAt, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status, updatedAt = excluded.updatedAt, data = excluded.data`,
    [row.id, kind, row.status, row.createdAt, row.updatedAt, JSON.stringify(record)],
  );
}

/** Upsert a draft (the `persist` effect). Whole record serialized; status/timestamps kept queryable. */
export function saveDraft(draft: ReportDraft): void {
  upsert(KIND_REPORT, draft, draft);
}

/**
 * All **report** drafts, oldest first (capture order — the flush work list order).
 *
 * Deliberately kind-filtered: the drafts list screen and the report flush both mean reports by
 * "drafts", and a hazard silently appearing in either would be a bug rather than a feature.
 */
export function listDrafts(): ReportDraft[] {
  return readReportDrafts(getDb());
}

export function getDraft(id: string): ReportDraft | null {
  const row = getDb().getFirstSync<{ data: string }>(
    'SELECT data FROM report_drafts WHERE id = ? AND kind = ?',
    [id, KIND_REPORT],
  );
  return row ? (JSON.parse(row.data) as ReportDraft) : null;
}

export function deleteDraft(id: string): void {
  getDb().runSync('DELETE FROM report_drafts WHERE id = ?', [id]);
}

/** Upsert a queued hazard or confirmation (Phase 9 offline) — the hazard `persist` effect. */
export function saveHazardItem(item: HazardQueueItem): void {
  upsert(item.kind, item, item);
}

/** Every queued hazard + confirmation, oldest first. */
export function listHazardItems(): HazardQueueItem[] {
  return getDb()
    .getAllSync<{ data: string }>(
      `SELECT data FROM report_drafts WHERE kind IN (${HAZARD_KINDS.map(() => '?').join(',')})
       ORDER BY createdAt ASC`,
      [...HAZARD_KINDS],
    )
    .map((r) => JSON.parse(r.data) as HazardQueueItem);
}

export function getHazardItem(id: string): HazardQueueItem | null {
  const row = getDb().getFirstSync<{ data: string }>(
    `SELECT data FROM report_drafts WHERE id = ? AND kind IN (${HAZARD_KINDS.map(() => '?').join(',')})`,
    [id, ...HAZARD_KINDS],
  );
  return row ? (JSON.parse(row.data) as HazardQueueItem) : null;
}

export function deleteHazardItem(id: string): void {
  getDb().runSync('DELETE FROM report_drafts WHERE id = ?', [id]);
}
