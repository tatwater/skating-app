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

export function clearPendingReads(ids: readonly string[]): void {
  if (ids.length === 0) return;
  try {
    const d = getDb();
    d.withTransactionSync(() => {
      for (const id of ids) d.runSync('DELETE FROM pending_reads WHERE id = ?', [id]);
    });
  } catch {
    // Best-effort.
  }
}
