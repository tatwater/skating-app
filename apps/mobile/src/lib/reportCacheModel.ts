/**
 * Pure model for the offline report read-cache (Phase 4, decision #8) — the framework-free serialize/
 * parse + prune logic behind the `expo-sqlite` glue in `reportCache.ts`, factored out so it's
 * unit-testable without a native db (same split as `offlineBody` ↔ `bodyCache`).
 *
 * We cache **feed cards** (the `FeedCardData` the server already shaped) for on-ice-without-service
 * recall: reports the user recently read, reports for any lake whose detail they opened, and (pre-
 * cached) favorites' recent reports. Thumbnails only — `FeedCardData.photoThumbUrls` are already the
 * small ~400px URLs, never the full images (which would blow the cache, decision #8).
 */

import type { FeedCardData } from '@skating/core'

/** Keep the N most-recently-cached reports (LRU by `cachedAt`) — bounds the on-device footprint. */
export const MAX_CACHED_REPORTS = 200

/** One cache row: the identity + sort key columns, plus the full card as a JSON blob. */
export interface CachedReportRow {
  reportId: string
  waterBodyId: string
  cachedAt: number
  data: string // JSON.stringify(FeedCardData)
}

/** Turn a feed card into a cache row (thumbnails only — that's already what the card carries). */
export function toCachedRow(data: FeedCardData, cachedAt: number): CachedReportRow {
  return {
    reportId: data.reportId,
    waterBodyId: data.waterBodyId,
    cachedAt,
    data: JSON.stringify(data),
  }
}

/**
 * Parse a cache row back into a `FeedCardData`, or `null` if the blob is corrupt / not an object.
 * Defensive: a schema change or a truncated write must never crash the offline read path — a bad row
 * is simply skipped.
 */
export function fromCachedRow(row: Pick<CachedReportRow, 'data'>): FeedCardData | null {
  try {
    const parsed = JSON.parse(row.data) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const card = parsed as FeedCardData
    if (typeof card.reportId !== 'string' || typeof card.waterBodyId !== 'string') return null
    return card
  } catch {
    return null
  }
}

/** Parse a set of rows, dropping any corrupt ones, newest first (by `cachedAt`). */
export function cachedReportsFromRows(rows: readonly CachedReportRow[]): FeedCardData[] {
  return [...rows]
    .sort((a, b) => b.cachedAt - a.cachedAt)
    .map(fromCachedRow)
    .filter((card): card is FeedCardData => card !== null)
}
