/**
 * Hazard freshness lifecycle (D15). Freshness is *derived at read time* from
 * `lastConfirmedAt` — never stored — so the map reflects real elapsed time.
 */

export type HazardFreshness = 'fresh' | 'aging' | 'stale'

const HOUR_MS = 3_600_000

/** < this many hours since last confirmation → fresh. */
export const FRESH_MAX_HOURS = 24
/** ≤ this many hours → aging; beyond it → stale. */
export const AGING_MAX_HOURS = 72

/**
 * Freshness given the last confirmation time and the current time (both epoch ms):
 * `< 24h` fresh · `24–72h` aging · `> 72h` stale (D15). A "still there"
 * confirmation resets `lastConfirmedAt`, so this returns `fresh` again.
 */
export function hazardFreshness(lastConfirmedAt: number, now: number): HazardFreshness {
  const hours = (now - lastConfirmedAt) / HOUR_MS
  if (hours < FRESH_MAX_HOURS) return 'fresh'
  if (hours <= AGING_MAX_HOURS) return 'aging'
  return 'stale'
}

/** Stale hazards are hidden by default behind a "show older" toggle (D15). */
export function isHazardVisibleByDefault(freshness: HazardFreshness): boolean {
  return freshness !== 'stale'
}

/** Default "gone" threshold before a hazard archives (small; later reputation-weighted, D15). */
export const DEFAULT_GONE_THRESHOLD = 2

/**
 * Whether a hazard should archive (not hard-delete, so it can resurface) given how
 * many independent "gone" reports it has (D15).
 */
export function shouldArchiveHazard(
  goneCount: number,
  threshold = DEFAULT_GONE_THRESHOLD,
): boolean {
  return goneCount >= threshold
}
