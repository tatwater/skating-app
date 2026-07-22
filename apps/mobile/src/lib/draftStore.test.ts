import { DatabaseSync } from 'node:sqlite'
import type { ReportDraft } from '@skating/core'
import { describe, expect, it, vi } from 'vitest'

// `draftStore` imports `expo-sqlite` at module load (→ react-native, which Vitest can't transform).
// We only exercise its db-injectable pure functions, so stub the native module out entirely; the real
// `openDatabaseSync` is never reached in these tests.
vi.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('expo-sqlite is not available under test')
  },
}))

import { ensureSchema, readReportDrafts, type SqliteLike } from './draftStore'

/**
 * Covers the one part of `draftStore` that touches *existing on-device user data*: the `kind`
 * migration (`ALTER TABLE … ADD COLUMN kind NOT NULL DEFAULT 'report'`) that runs the first time a
 * pre-Phase-9 install opens the app. A bug there would strand or drop real queued drafts, so it gets
 * coverage even though the rest of this file is untestable native glue.
 *
 * The store is written against a small `SqliteLike` interface; here we back it with Node's built-in
 * SQLite so the migration runs against a *real* engine (same SQL semantics as `expo-sqlite`), not a
 * hand-rolled fake that would just re-encode the behaviour under test.
 */
function adapt(db: DatabaseSync): SqliteLike {
  return {
    execSync: (sql) => {
      db.exec(sql)
    },
    runSync: (sql, params) => db.prepare(sql).run(...params),
    getAllSync: <T>(sql: string, params: (string | number | null)[] = []) =>
      db.prepare(sql).all(...params) as T[],
    getFirstSync: <T>(sql: string, params: (string | number | null)[]) =>
      (db.prepare(sql).get(...params) ?? null) as T | null,
  }
}

function reportDraft(id: string, createdAt: number): ReportDraft {
  return {
    id,
    idempotencyKey: `key-${id}`,
    status: 'pending',
    bodyName: `Lake ${id}`,
    form: {} as ReportDraft['form'],
    photos: [],
    createdAt,
    updatedAt: createdAt,
  }
}

/** Insert a row into the *pre-migration* table shape (no `kind` column), as an old install would. */
function insertLegacyRow(db: DatabaseSync, draft: ReportDraft): void {
  db.prepare(
    'INSERT INTO report_drafts (id, status, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?)',
  ).run(draft.id, draft.status, draft.createdAt, draft.updatedAt, JSON.stringify(draft))
}

describe('draftStore kind migration', () => {
  it('backfills existing report drafts and still lists them after the migration', () => {
    const raw = new DatabaseSync(':memory:')
    // The exact schema a pre-Phase-9 device carries — no `kind` column.
    raw.exec(
      `CREATE TABLE report_drafts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      )`,
    )
    insertLegacyRow(raw, reportDraft('b', 2000))
    insertLegacyRow(raw, reportDraft('a', 1000))

    const db = adapt(raw)
    ensureSchema(db)

    // Migration is what makes the pre-existing rows readable through the kind-filtered query.
    const drafts = readReportDrafts(db)
    expect(drafts.map((d) => d.id)).toEqual(['a', 'b']) // oldest first (capture order)

    // Every backfilled row got the default kind, so none was lost to the filter.
    const kinds = raw.prepare('SELECT kind FROM report_drafts').all() as { kind: string }[]
    expect(kinds).toEqual([{ kind: 'report' }, { kind: 'report' }])

    raw.close()
  })

  it('is idempotent — a second run neither throws nor re-adds the column', () => {
    const raw = new DatabaseSync(':memory:')
    const db = adapt(raw)
    ensureSchema(db) // fresh install: creates the table already carrying `kind`
    expect(() => ensureSchema(db)).not.toThrow()

    // A row inserted without an explicit kind still takes the column default, so it lists.
    insertLegacyRow(raw, reportDraft('c', 3000))
    expect(readReportDrafts(db).map((d) => d.id)).toEqual(['c'])

    raw.close()
  })
})
