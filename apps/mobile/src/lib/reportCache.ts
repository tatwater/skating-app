/**
 * On-device cache of recently-seen feed reports (Phase 4, decision #8) — the `expo-sqlite` glue behind
 * the pure model in `reportCacheModel.ts`. Reuses the Phase-2 offline-queue infra pattern (`bodyCache`).
 * We cache the feed cards the user reads + the lakes they open + (pre-cached) favorites, so on the ice
 * with no signal the recent feed still reads back. Thumbnails only (the card already carries the small
 * URLs). Best-effort throughout — a cache failure never blocks the online read path.
 */

import type { FeedCardData } from '@skating/core';
import * as SQLite from 'expo-sqlite';
import {
  type CachedReportRow,
  cachedReportsFromRows,
  MAX_CACHED_REPORTS,
  toCachedRow,
} from './reportCacheModel';

let db: SQLite.SQLiteDatabase | null = null;
function getDb(): SQLite.SQLiteDatabase {
  if (db === null) {
    db = SQLite.openDatabaseSync('skating-report-cache.db');
    db.execSync(
      `CREATE TABLE IF NOT EXISTS cached_reports (
        reportId TEXT PRIMARY KEY,
        waterBodyId TEXT NOT NULL,
        cachedAt INTEGER NOT NULL,
        data TEXT NOT NULL
      )`,
    );
  }
  return db;
}

/**
 * Upsert a batch of feed cards into the cache (touching `cachedAt` so re-reading keeps them fresh in
 * the LRU), then evict beyond `MAX_CACHED_REPORTS`. Call it with the reports a screen just rendered.
 */
export function cacheReports(cards: readonly FeedCardData[], now: number = Date.now()): void {
  if (cards.length === 0) return;
  try {
    const d = getDb();
    d.withTransactionSync(() => {
      for (const card of cards) {
        const row = toCachedRow(card, now);
        d.runSync(
          `INSERT INTO cached_reports (reportId, waterBodyId, cachedAt, data)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(reportId) DO UPDATE SET
             waterBodyId = excluded.waterBodyId, cachedAt = excluded.cachedAt, data = excluded.data`,
          [row.reportId, row.waterBodyId, row.cachedAt, row.data],
        );
      }
      d.runSync(
        `DELETE FROM cached_reports WHERE reportId NOT IN
           (SELECT reportId FROM cached_reports ORDER BY cachedAt DESC LIMIT ?)`,
        [MAX_CACHED_REPORTS],
      );
    });
  } catch {
    // Best-effort — a cache write must never break viewing the feed.
  }
}

/** Read all cached feed cards, newest first (corrupt rows skipped). Empty on any sqlite error. */
export function loadCachedReports(): FeedCardData[] {
  try {
    const rows = getDb().getAllSync<CachedReportRow>('SELECT * FROM cached_reports');
    return cachedReportsFromRows(rows);
  } catch {
    return [];
  }
}

/** Cached feed cards for one water body, newest first — the offline lake-detail recall path. */
export function loadCachedReportsForBody(waterBodyId: string): FeedCardData[] {
  return loadCachedReports().filter((c) => c.waterBodyId === waterBodyId);
}
