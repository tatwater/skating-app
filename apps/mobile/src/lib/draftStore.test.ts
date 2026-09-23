import { DatabaseSync } from 'node:sqlite';
import type { LegacyReportDraft } from '@skating/core';
import { describe, expect, it, vi } from 'vitest';

// `draftStore` imports `expo-sqlite` at module load (→ react-native, which Vitest can't transform).
// We only exercise its db-injectable pure functions, so stub the native module out entirely; the real
// `openDatabaseSync` is never reached in these tests.
vi.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('expo-sqlite is not available under test');
  },
}));

import { ensureSchema, readHazardItems, readPostDrafts, type SqliteLike } from './draftStore';

/**
 * Covers the one part of `draftStore` that touches *existing on-device user data*: the `kind`
 * migration (`ALTER TABLE … ADD COLUMN kind NOT NULL DEFAULT 'report'`) that runs the first time a
 * pre-Phase-09a install opens the app. A bug there would strand or drop real queued drafts, so it gets
 * coverage even though the rest of this file is untestable native glue.
 *
 * The store is written against a small `SqliteLike` interface; here we back it with Node's built-in
 * SQLite so the migration runs against a *real* engine (same SQL semantics as `expo-sqlite`), not a
 * hand-rolled fake that would just re-encode the behavior under test.
 */
function adapt(db: DatabaseSync): SqliteLike {
  return {
    execSync: (sql) => {
      db.exec(sql);
    },
    runSync: (sql, params) => db.prepare(sql).run(...params),
    getAllSync: <T>(sql: string, params: (string | number | null)[] = []) =>
      db.prepare(sql).all(...params) as T[],
    getFirstSync: <T>(sql: string, params: (string | number | null)[]) =>
      (db.prepare(sql).get(...params) ?? null) as T | null,
  };
}

function reportDraft(id: string, createdAt: number): LegacyReportDraft {
  return {
    id,
    idempotencyKey: `key-${id}`,
    status: 'pending',
    bodyName: `Lake ${id}`,
    form: {} as LegacyReportDraft['form'],
    photos: [],
    createdAt,
    updatedAt: createdAt,
  };
}

/** Insert a row into the *pre-migration* table shape (no `kind` column), as an old install would. */
function insertLegacyRow(db: DatabaseSync, draft: LegacyReportDraft): void {
  db.prepare(
    'INSERT INTO report_drafts (id, status, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?)',
  ).run(draft.id, draft.status, draft.createdAt, draft.updatedAt, JSON.stringify(draft));
}

describe('draftStore kind migration', () => {
  it('backfills existing report drafts and still lists them after the migration', () => {
    const raw = new DatabaseSync(':memory:');
    // The exact schema a pre-Phase-09a device carries — no `kind` column.
    raw.exec(
      `CREATE TABLE report_drafts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      )`,
    );
    insertLegacyRow(raw, reportDraft('b', 2000));
    insertLegacyRow(raw, reportDraft('a', 1000));

    const db = adapt(raw);
    ensureSchema(db);

    // Migration is what makes the pre-existing rows readable through the kind-filtered query —
    // first as `report` rows, then lifted to the one-Report `post` each of them is (A10 §9.1).
    const drafts = readPostDrafts(db);
    expect(drafts.map((d) => d.id)).toEqual(['a', 'b']); // oldest first (capture order)
    expect(drafts[0]).toMatchObject({ kind: 'post', idempotencyKey: 'key-a', status: 'pending' });
    expect(drafts[0]?.reports).toHaveLength(1);
    expect(drafts[0]?.reports[0]).toMatchObject({
      id: 'a',
      idempotencyKey: 'key-a',
      bodyName: 'Lake a',
    });

    // Every backfilled row is now a post, so none was lost to the filter and none is still a report.
    const kinds = raw.prepare('SELECT kind FROM report_drafts').all() as { kind: string }[];
    expect(kinds).toEqual([{ kind: 'post' }, { kind: 'post' }]);

    raw.close();
  });

  it('renames a queued confirmation from the pre-A08 kind, in the column and the blob alike', () => {
    const raw = new DatabaseSync(':memory:');
    const db = adapt(raw);
    ensureSchema(db);
    // A vote cast on the ice under the old build and left waiting for signal across the update.
    const legacy = {
      kind: 'hazard_confirmation',
      id: 'v1',
      status: 'pending',
      hazardId: 'h1',
      verdict: 'still_there',
      via: 'proximity_alert',
      observedAt: 4000,
      createdAt: 4000,
      updatedAt: 4000,
    };
    raw
      .prepare(
        'INSERT INTO report_drafts (id, kind, status, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        legacy.id,
        legacy.kind,
        legacy.status,
        legacy.createdAt,
        legacy.updatedAt,
        JSON.stringify(legacy),
      );
    // A row already on the new name must come through untouched.
    const current = {
      ...legacy,
      kind: 'confirmation_vote',
      id: 'v2',
      createdAt: 5000,
      updatedAt: 5000,
    };
    raw
      .prepare(
        'INSERT INTO report_drafts (id, kind, status, createdAt, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        current.id,
        current.kind,
        current.status,
        current.createdAt,
        current.updatedAt,
        JSON.stringify(current),
      );

    ensureSchema(db); // the rename runs on every open; this is the one that matters

    const items = readHazardItems(db);
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ['v1', 'confirmation_vote'],
      ['v2', 'confirmation_vote'],
    ]);
    // The blob's other fields survived `json_set` — the vote is still the vote that was cast.
    expect(items[0]).toMatchObject({ hazardId: 'h1', verdict: 'still_there', observedAt: 4000 });
    const kinds = raw.prepare('SELECT kind FROM report_drafts ORDER BY createdAt').all() as {
      kind: string;
    }[];
    expect(kinds).toEqual([{ kind: 'confirmation_vote' }, { kind: 'confirmation_vote' }]);

    raw.close();
  });

  it('backfills form.showPutIn on drafts saved before the switch existed, and only on those', () => {
    const raw = new DatabaseSync(':memory:');
    const db = adapt(raw);
    ensureSchema(db);
    // A draft from before 2026-09-20: the form has no `showPutIn` at all. The switch must read as
    // *shown* — the same default the stored report field has — not render as off.
    insertLegacyRow(raw, reportDraft('old', 1000));
    // Two drafts saved after: each carries an explicit choice that the backfill must not overwrite.
    const opted = reportDraft('hidden', 2000);
    opted.form = { showPutIn: false } as LegacyReportDraft['form'];
    insertLegacyRow(raw, opted);
    const shown = reportDraft('shown', 3000);
    shown.form = { showPutIn: true } as LegacyReportDraft['form'];
    insertLegacyRow(raw, shown);

    ensureSchema(db); // the backfill runs on every open; this is the one that matters

    const byId = Object.fromEntries(
      readPostDrafts(db).map((d) => [d.id, d.reports[0]?.form.showPutIn]),
    );
    expect(byId).toEqual({ old: true, hidden: false, shown: true });
    // A real boolean in the blob, not the string 'true' — the form reads it as one.
    expect(typeof byId.old).toBe('boolean');

    raw.close();
  });

  it('is idempotent — a second run neither throws nor re-adds the column', () => {
    const raw = new DatabaseSync(':memory:');
    const db = adapt(raw);
    ensureSchema(db); // fresh install: creates the table already carrying `kind`
    expect(() => ensureSchema(db)).not.toThrow();

    // A row inserted without an explicit kind takes the column default (`report`) and is lifted to
    // a post on the next open, so it lists.
    insertLegacyRow(raw, reportDraft('c', 3000));
    ensureSchema(db);
    expect(readPostDrafts(db).map((d) => d.id)).toEqual(['c']);

    raw.close();
  });
});
