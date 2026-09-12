/**
 * Pure model for the offline inbox (N8 PR 3) — the framework-free half behind `notificationCache.ts`,
 * factored out so it's unit-testable without a native db (the `reportCacheModel` ↔ `reportCache` split).
 *
 * What the cache is for: the last page of the inbox and the unread count, readable on the ice with no
 * signal, plus a **read overlay** — marks made offline are applied locally at once and replayed to the
 * server on the next open with a connection. Nothing here is authoritative: the live query wins the
 * moment it answers, and the overlay is dropped once the server has stamped the rows.
 *
 * What it is deliberately not: a notification *delivery* path. Nothing arrives offline (a push is a
 * push); the offline case that matters for safety is the on-ice hazard alert, which Phase 9.5 built
 * client-side and which never touches this table.
 */

import type { NotificationView } from '@skating/core';

/** The cache holds one page — the last one the live list showed. */
export const MAX_CACHED_NOTIFICATIONS = 50;

export interface CachedNotificationRow {
  id: string;
  createdAt: number;
  data: string; // JSON.stringify(NotificationView)
}

export function toCachedRow(view: NotificationView): CachedNotificationRow {
  return { id: view.id, createdAt: view.createdAt, data: JSON.stringify(view) };
}

/** Parse a row back, or `null` for a corrupt blob — a bad row is skipped, never a crash. */
export function fromCachedRow(row: Pick<CachedNotificationRow, 'data'>): NotificationView | null {
  try {
    const parsed = JSON.parse(row.data) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const view = parsed as NotificationView;
    if (typeof view.id !== 'string' || typeof view.type !== 'string') return null;
    if (typeof view.createdAt !== 'number') return null;
    return view;
  } catch {
    return null;
  }
}

/** Parse rows newest first, dropping corrupt ones. */
export function cachedNotificationsFromRows(
  rows: readonly CachedNotificationRow[],
): NotificationView[] {
  return [...rows]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(fromCachedRow)
    .filter((v): v is NotificationView => v !== null);
}

/**
 * Apply an offline read overlay to a list: every id in `readAt` that the server still shows unread
 * reads as read at that time. The server's own stamp wins when present — the overlay only fills gaps.
 */
export function applyReadOverlay(
  views: readonly NotificationView[],
  overlay: ReadonlyMap<string, number>,
): NotificationView[] {
  return views.map((v) => {
    if (v.readAt !== undefined) return v;
    const local = overlay.get(v.id);
    return local === undefined ? v : { ...v, readAt: local };
  });
}

/** Unread count after the overlay — what the badge shows offline. */
export function unreadAfterOverlay(
  views: readonly NotificationView[],
  overlay: ReadonlyMap<string, number>,
): number {
  return applyReadOverlay(views, overlay).filter((v) => v.readAt === undefined).length;
}

/**
 * Which overlay entries the server has caught up on — the ones whose row now carries a server
 * `readAt`, or whose row is gone (purged). Those can be dropped; the rest still need replaying.
 */
export function settledOverlayIds(
  overlay: ReadonlyMap<string, number>,
  live: readonly NotificationView[],
): string[] {
  const byId = new Map(live.map((v) => [v.id, v] as const));
  const settled: string[] = [];
  for (const id of overlay.keys()) {
    const row = byId.get(id);
    if (row === undefined || row.readAt !== undefined) settled.push(id);
  }
  return settled;
}
