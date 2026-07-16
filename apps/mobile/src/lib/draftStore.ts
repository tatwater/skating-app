/**
 * Persistent store for the offline report-draft queue (F2) — the `expo-sqlite` glue behind the pure
 * `@skating/core` draft-queue logic. Each draft is stored as a JSON blob (it's a nested, reopenable
 * record) plus a few queryable columns. `saveDraft` is the `persist` effect the core `flushDraft`
 * calls after every checkpoint, so an interrupted flush always leaves a resumable draft on disk.
 * Untested native glue (like `photoPipeline`); the queue *logic* is tested in `@skating/core`.
 */

import type { ReportDraft } from '@skating/core'
import * as SQLite from 'expo-sqlite'

let db: SQLite.SQLiteDatabase | null = null
function getDb(): SQLite.SQLiteDatabase {
  if (db === null) {
    db = SQLite.openDatabaseSync('skating-drafts.db')
    db.execSync(
      `CREATE TABLE IF NOT EXISTS report_drafts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      )`,
    )
  }
  return db
}

/** Upsert a draft (the `persist` effect). Whole record serialized; status/timestamps kept queryable. */
export function saveDraft(draft: ReportDraft): void {
  getDb().runSync(
    `INSERT INTO report_drafts (id, status, createdAt, updatedAt, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status, updatedAt = excluded.updatedAt, data = excluded.data`,
    [draft.id, draft.status, draft.createdAt, draft.updatedAt, JSON.stringify(draft)],
  )
}

/** All drafts, oldest first (capture order — the flush work list order). */
export function listDrafts(): ReportDraft[] {
  return getDb()
    .getAllSync<{ data: string }>('SELECT data FROM report_drafts ORDER BY createdAt ASC')
    .map((r) => JSON.parse(r.data) as ReportDraft)
}

export function getDraft(id: string): ReportDraft | null {
  const row = getDb().getFirstSync<{ data: string }>(
    'SELECT data FROM report_drafts WHERE id = ?',
    [id],
  )
  return row ? (JSON.parse(row.data) as ReportDraft) : null
}

export function deleteDraft(id: string): void {
  getDb().runSync('DELETE FROM report_drafts WHERE id = ?', [id])
}
