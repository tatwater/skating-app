/**
 * Pure scheduling helpers (Phase 4, decision #4) — the "next 8pm ET" instant the notification digest
 * flushes at. Kept framework-free + injectable (`nowMs`) so it's deterministic in tests and shared by
 * the Convex enqueue path. Timezone math is done with `Intl` (full ICU in both the Convex runtime and
 * Node/edge test runner) rather than a fixed UTC offset, so it stays correct across the EST↔EDT shift.
 *
 * Per-user local-time / true-sunset timing is deferred (single-timezone pilot) — see the roadmap.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

interface ZonedParts {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23
  minute: number
  second: number
}

/** Wall-clock parts of `ms` in `timeZone` (via `Intl`), as numbers. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const map: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  // `hour12: false` can render midnight as "24"; normalize it to 0.
  const hour = Number(map.hour) % 24
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

/** Signed offset (ms) such that `localWallClock = utc + offset` at instant `ms` in `timeZone`. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - ms
}

/** The current hour-of-day (0-23) in `timeZone`. */
export function zonedHour(ms: number, timeZone: string): number {
  return zonedParts(ms, timeZone).hour
}

/**
 * Epoch ms of the next time the clock reads `hour:00:00` in `timeZone`, strictly after `nowMs`
 * (today if that hour hasn't passed there yet, else tomorrow). The DST offset is resolved by
 * converting the target wall-clock to UTC, then re-checking the offset *at the target* and correcting
 * once — enough to settle either side of a spring-forward / fall-back boundary.
 */
export function nextZonedHourMs(nowMs: number, hour: number, timeZone: string): number {
  const p = zonedParts(nowMs, timeZone)
  // The target calendar day: today if the target hour is still ahead in-zone, else tomorrow.
  const targetIsToday = p.hour < hour
  const dayAnchorMs = targetIsToday ? nowMs : nowMs + DAY_MS
  const day = zonedParts(dayAnchorMs, timeZone)

  const wallClockUtc = Date.UTC(day.year, day.month - 1, day.day, hour, 0, 0)
  // First guess using the offset at `now`, then correct with the offset at the guessed instant.
  let target = wallClockUtc - zoneOffsetMs(nowMs, timeZone)
  target = wallClockUtc - zoneOffsetMs(target, timeZone)
  // A DST jump can leave the corrected target a hair before `now`; nudge to the following day.
  if (target <= nowMs) target += DAY_MS
  return target
}
