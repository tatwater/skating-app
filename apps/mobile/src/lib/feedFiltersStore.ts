/**
 * Device-local feed-filter storage (Phase 4, decision #6) — the `expo-sqlite` glue behind the pure
 * logic in `feedFilters.ts`. A tiny key-value table holds the working copy (the UI reads it first →
 * instant, offline-safe); the pure `feedFilters` module handles parse/reconcile. Best-effort native
 * (like `bodyCache`): a storage failure never blocks the feed.
 */

import type { FeedFilters } from '@skating/core'
import * as SQLite from 'expo-sqlite'
import { FEED_FILTERS_KEY, parseFilters } from './feedFilters'

let db: SQLite.SQLiteDatabase | null = null
function getDb(): SQLite.SQLiteDatabase {
  if (db === null) {
    db = SQLite.openDatabaseSync('skating-prefs.db')
    db.execSync('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }
  return db
}

/** Read the device-local working copy (sanitized). Empty on any sqlite error. */
export function loadStoredFilters(): FeedFilters {
  try {
    const row = getDb().getFirstSync<{ value: string }>('SELECT value FROM prefs WHERE key = ?', [
      FEED_FILTERS_KEY,
    ])
    return parseFilters(row?.value)
  } catch {
    return {}
  }
}

/** Persist the working copy locally. Best-effort — a write failure never blocks the session. */
export function saveStoredFilters(filters: FeedFilters): void {
  try {
    getDb().runSync(
      `INSERT INTO prefs (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [FEED_FILTERS_KEY, JSON.stringify(filters)],
    )
  } catch {
    // Best-effort — the in-memory copy still drives this session.
  }
}
