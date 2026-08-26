/**
 * The device-local preferences database — one tiny key-value table, several tenants.
 *
 * `feedFiltersStore` and `themePreferenceStore` both keep a row in `skating-prefs.db`, and each used
 * to open it and declare the schema itself. Two copies of a `CREATE TABLE` for one table is a drift
 * hazard with no upside: whichever module happens to open the database first wins, `IF NOT EXISTS`
 * makes the loser's DDL a silent no-op, and the two only agree as long as nobody edits one of them.
 * The schema lives here once so that can't happen.
 *
 * `openDatabaseSync` caches by database name (`useNewConnection` defaults to `false`), so this was
 * always one connection shared by both callers — this module just makes that explicit.
 *
 * Everything built on this is best-effort in the `bodyCache` tradition: a storage failure costs a
 * preference, never the launch. Callers own their own try/catch, since what to fall back *to* is a
 * question only the caller can answer.
 */

import * as SQLite from 'expo-sqlite';

let db: SQLite.SQLiteDatabase | null = null;

/** Open (once) the shared prefs database, creating the key-value table if it isn't there yet. */
export function getPrefsDb(): SQLite.SQLiteDatabase {
  if (db === null) {
    db = SQLite.openDatabaseSync('skating-prefs.db');
    db.execSync('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  return db;
}

/** Read one row's value, or `undefined` when the row is missing. Throws only on a sqlite error. */
export function readPref(key: string): string | undefined {
  return getPrefsDb().getFirstSync<{ value: string }>('SELECT value FROM prefs WHERE key = ?', [
    key,
  ])?.value;
}

/** Upsert one row. Throws only on a sqlite error. */
export function writePref(key: string, value: string): void {
  getPrefsDb().runSync(
    `INSERT INTO prefs (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
