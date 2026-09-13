/**
 * On-device cache of the inbox's last page plus the offline read overlay (N8 PR 3) — the
 * `expo-sqlite` glue behind the pure `notificationCacheModel.ts`. Reuses the `reportCache` pattern:
 * best-effort throughout, a storage failure never blocks the live path.
 */

import type { NotificationView } from '@skating/core';
import * as SQLite from 'expo-sqlite';
import {
  type CachedNotificationRow,
  cachedNotificationsFromRows,
  MAX_CACHED_NOTIFICATIONS,
  toCachedRow,
} from './notificationCacheModel';
import { readPref, writePref } from './prefsDb';

let db: SQLite.SQLiteDatabase | null = null;
function getDb(): SQLite.SQLiteDatabase {
  if (db === null) {
    db = SQLite.openDatabaseSync('skating-notification-cache.db');
    db.execSync(
      `CREATE TABLE IF NOT EXISTS cached_notifications (
        id TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL,
        data TEXT NOT NULL
      )`,
    );
    // Marks made offline, waiting to be replayed: id → when the person read it.
    db.execSync(
      `CREATE TABLE IF NOT EXISTS pending_reads (
        id TEXT PRIMARY KEY,
        readAt INTEGER NOT NULL
      )`,
    );
  }
  return db;
}

/** Replace the cached page with what the live list just showed. */
export function cacheNotifications(views: readonly NotificationView[]): void {
  try {
    const d = getDb();
    d.withTransactionSync(() => {
      d.runSync('DELETE FROM cached_notifications', []);
      for (const view of views.slice(0, MAX_CACHED_NOTIFICATIONS)) {
        const row = toCachedRow(view);
        d.runSync('INSERT INTO cached_notifications (id, createdAt, data) VALUES (?, ?, ?)', [
          row.id,
          row.createdAt,
          row.data,
        ]);
      }
    });
  } catch {
    // Best-effort.
  }
}

export function loadCachedNotifications(): NotificationView[] {
  try {
    const rows = getDb().getAllSync<CachedNotificationRow>(
      'SELECT id, createdAt, data FROM cached_notifications ORDER BY createdAt DESC',
      [],
    );
    return cachedNotificationsFromRows(rows);
  } catch {
    return [];
  }
}

/** The offline read overlay, id → readAt. */
export function loadPendingReads(): Map<string, number> {
  try {
    const rows = getDb().getAllSync<{ id: string; readAt: number }>(
      'SELECT id, readAt FROM pending_reads',
      [],
    );
    return new Map(rows.map((r) => [r.id, r.readAt] as const));
  } catch {
    return new Map();
  }
}

export function recordPendingReads(ids: readonly string[], readAt: number): void {
  try {
    const d = getDb();
    d.withTransactionSync(() => {
      for (const id of ids) {
        d.runSync('INSERT OR IGNORE INTO pending_reads (id, readAt) VALUES (?, ?)', [id, readAt]);
      }
    });
  } catch {
    // Best-effort.
  }
}

/** The overlay has been replayed — the server holds every mark it recorded. */
export function clearPendingReads(): void {
  try {
    getDb().runSync('DELETE FROM pending_reads', []);
  } catch {
    // Best-effort.
  }
}

/**
 * Drop everything. The cache is per device, not per account: a notification is private to the
 * person it was for, so the page one account left behind must not read back to the next one who
 * signs in on the same phone. Called at sign-out and whenever the signed-in profile changes.
 */
export function clearNotificationCache(): void {
  try {
    const d = getDb();
    d.withTransactionSync(() => {
      d.runSync('DELETE FROM cached_notifications', []);
      d.runSync('DELETE FROM pending_reads', []);
    });
  } catch {
    // Best-effort.
  }
}

const OWNER_KEY = 'notification_cache_owner';

/**
 * Bind the cache to a profile: the first time a different profile is seen, whatever the previous
 * one left behind is cleared. Cheap enough to call on every session mount; it writes only on change.
 */
export function claimNotificationCache(profileId: string): void {
  try {
    if (readPref(OWNER_KEY) === profileId) return;
    clearNotificationCache();
    writePref(OWNER_KEY, profileId);
  } catch {
    // Best-effort.
  }
}
