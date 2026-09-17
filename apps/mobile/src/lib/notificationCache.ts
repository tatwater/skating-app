/**
 * On-device cache of the inbox's last page plus the offline read overlay (A08 PR 3) — the
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
    // Whose rows these are — a single-row table in the SAME database as the rows, on purpose: the
    // owner check, the clear and the new owner are then one transaction on one store, and a store
    // that can't answer "whose?" is the same store that can't hand the rows back. Kept in the prefs
    // db instead, a prefs failure once skipped the clear while the rows stayed perfectly readable.
    db.execSync(
      `CREATE TABLE IF NOT EXISTS cache_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        profileId TEXT NOT NULL
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
      d.runSync('DELETE FROM cache_owner', []);
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Bind the cache to a profile: the first time a different profile is seen, whatever the previous
 * one left behind is cleared. Cheap enough to call on every session mount; it writes only on change.
 *
 * Fails **closed**. Every path that isn't "the owner is provably this profile" clears — a different
 * owner, no owner, or a store that threw before it could say. The clear then runs outside the
 * failed transaction as well, so the one thing a broken store cannot do is keep the last account's
 * private page readable for the next. Returns whether the rows were kept, so the caller can drop
 * anything it derived from them before the claim.
 */
export function claimNotificationCache(profileId: string): boolean {
  let kept = false;
  try {
    const d = getDb();
    d.withTransactionSync(() => {
      const owner = d.getFirstSync<{ profileId: string }>(
        'SELECT profileId FROM cache_owner WHERE singleton = 1',
        [],
      )?.profileId;
      if (owner === profileId) {
        kept = true;
        return;
      }
      d.runSync('DELETE FROM cached_notifications', []);
      d.runSync('DELETE FROM pending_reads', []);
      d.runSync(
        `INSERT INTO cache_owner (singleton, profileId) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET profileId = excluded.profileId`,
        [profileId],
      );
    });
  } catch {
    // Ownership couldn't be established, so nothing may survive; the owner stays unrecorded and
    // the next mount tries again.
    clearNotificationCache();
    kept = false;
  }
  return kept;
}
