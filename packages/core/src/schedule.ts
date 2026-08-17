/**
 * Pure scheduling helpers (Phase 4, decision #4) — the "next 8pm ET" instant the notification digest
 * flushes at. Kept framework-free + injectable (`nowMs`) so it's deterministic in tests and shared by
 * the Convex enqueue path.
 *
 * The zone primitives live in `zonedTime.ts` — they moved there when N6e's posted-access rules needed
 * the same `Intl` parse and the same DST correction.
 *
 * Per-user local-time / true-sunset timing is deferred (single-timezone pilot) — see the roadmap.
 * **N6e did not reopen that**: `solar.ts` computes sunrise/sunset for *display* in the lake drawer and
 * is deliberately not imported here.
 */

import { zonedParts, zoneOffsetMs } from './zonedTime';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The current hour-of-day (0-23) in `timeZone`. */
export function zonedHour(ms: number, timeZone: string): number {
  return zonedParts(ms, timeZone).hour;
}

/**
 * Epoch ms of the next time the clock reads `hour:00:00` in `timeZone`, strictly after `nowMs`
 * (today if that hour hasn't passed there yet, else tomorrow). The DST offset is resolved by
 * converting the target wall-clock to UTC, then re-checking the offset *at the target* and correcting
 * once — enough to settle either side of a spring-forward / fall-back boundary.
 */
export function nextZonedHourMs(nowMs: number, hour: number, timeZone: string): number {
  const p = zonedParts(nowMs, timeZone);
  // The target calendar day: today if the target hour is still ahead in-zone, else tomorrow.
  const targetIsToday = p.hour < hour;
  const dayAnchorMs = targetIsToday ? nowMs : nowMs + DAY_MS;
  const day = zonedParts(dayAnchorMs, timeZone);

  const wallClockUtc = Date.UTC(day.year, day.month - 1, day.day, hour, 0, 0);
  // First guess using the offset at `now`, then correct with the offset at the guessed instant.
  let target = wallClockUtc - zoneOffsetMs(nowMs, timeZone);
  target = wallClockUtc - zoneOffsetMs(target, timeZone);
  // A DST jump can leave the corrected target a hair before `now`; nudge to the following day.
  if (target <= nowMs) target += DAY_MS;
  return target;
}
