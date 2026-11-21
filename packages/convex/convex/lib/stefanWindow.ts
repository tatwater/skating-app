/**
 * **The Stefan window, one rule for its two readers** (D160, D288): the Ice calibration instrument's
 * *predicted* figure (`iceCalibration.ts`) and the Inbox's *Stefan thickness estimate* beside a
 * flagged ice claim (`inbox.claimWeather`, board 2.1). Both read the body's browse cell, the skate's
 * local calendar day and the archive's degree-hour integrals over the same window through these
 * helpers, so 2.1's figure for a report always equals the instrument's for the same report.
 *
 * It is a model's figure from air temperatures only — context for staff, never a verdict, never on
 * any skater payload, and nothing stores it (D3, D288).
 */

import {
  approximateUtcOffsetSeconds,
  estimateIceThickness,
  type IceThicknessEstimate,
  isCompleteDay,
  localDayMsAt,
  localDayMsInZone,
  utcOffsetSecondsInZone,
} from '@skating/core';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { bodyWeatherCell } from './sampling';

const DAY_MS = 86_400_000;

/**
 * How far back a growth window may reach.
 *
 * The Stefan model is a *growth* model: it answers "how much ice would form on still open water
 * exposed to this much cold", which is not "how thick is the ice on this lake" — it has no idea what
 * was there when the window opened. Anchoring the window to the season's first sustained freeze would
 * be the physically defensible choice and is not available yet (A06e's phenology brackets ship dark in
 * a later PR), so the window is a fixed lookback and **the report says so** rather than implying an
 * anchor it does not have.
 */
export const CALIBRATION_WINDOW_DAYS = 60;

/**
 * A thaw this large inside the window means the growth model is answering the wrong question, so the
 * instrument declines rather than reporting growth that melted.
 *
 * 240 thaw-degree-hours ≈ ten days averaging +1°C. Above that, whatever the FDD says accumulated has
 * demonstrably been undone in part, and a square-root growth curve cannot represent it.
 */
export const CALIBRATION_MAX_THAW_DEGREE_HOURS = 240;

/**
 * Sum the archive's degree-hour integrals for a cell over `[fromMs, toMs]`.
 *
 * ⚠ **Memoised per `(cellKey, window)` by the caller**, and it has to be. Each call collects up to
 * {@link CALIBRATION_WINDOW_DAYS} day rows, and a report table full of a busy lake's regulars is
 * exactly the shape that reads the same sixty rows two hundred times — which is how a query walks
 * into Convex's read cap. This repo has already paid twice for treating a range scan as free.
 */
export async function windowIntegrals(
  ctx: QueryCtx,
  cellKey: string,
  fromMs: number,
  toMs: number,
  todayLocalDayMs: number,
): Promise<{ fdh: number; tdh: number; days: number }> {
  const rows = await ctx.db
    .query('weatherDays')
    .withIndex('by_cell_day', (q) =>
      q.eq('cellKey', cellKey).gte('dayMs', fromMs).lte('dayMs', toMs),
    )
    .collect();
  let fdh = 0;
  let tdh = 0;
  let days = 0;
  for (const row of rows) {
    if (row.missing === true) continue;
    // ⚠ **A day still in progress must not enter a degree-hour integral.** The archive stores today's
    // row on purpose, so an unfinished row is valid data and an incomplete measurement at once —
    // summing it contributes a fraction of a day's freezing while counting as a whole one, biasing
    // the fitted Stefan coefficient in a direction nothing would reveal.
    //
    // The date is what settles this, not `hours`: Open-Meteo returns whole calendar days and nothing
    // trims them, so today's row holds 24 hours from the morning's first fetch with the un-elapsed
    // ones **forecast**. Fitting a physical constant to a forecast is the failure this prevents.
    if (!isCompleteDay(row.hours, row.dayMs, todayLocalDayMs)) continue;
    fdh += row.freezingDegreeHours ?? 0;
    tdh += row.thawDegreeHours ?? 0;
    days += 1;
  }
  return { fdh, tdh, days };
}

/**
 * The local calendar day a skate ended on, and the offset that day was on.
 *
 * ⚠ **Needed because `dayMs` is a LOCAL date and `skateEndTime` is a UTC instant.** Flooring the
 * instant to a UTC day is wrong by the offset, which here is 4–5 hours — so every skate ending after
 * about 7 PM lands on the next day's key, shifting the whole 60-day window by one and silently
 * biasing the fit. Evening skating is the common case, so this was the common path.
 *
 * ## Three attempts at this were arithmetic on an offset. All three were wrong.
 *
 * Taking the first row in range took the **oldest** day's offset, three days early. Seeding from the
 * nearest row and re-resolving confirmed its own error at a spring-forward boundary. Span containment
 * over per-date offsets was right in principle and inert in practice, because the offsets were not
 * per-date at all: the archive stamps one `utc_offset_seconds` on a whole 92-day response, so every
 * row in a window carries the offset of *the day it was fetched on*.
 *
 * The mistake common to all three was treating a calendar date as derivable from an offset. It is
 * not, at a transition: spring-forward makes an hour belong to two dates and fall-back makes one
 * belong to neither. A zone identifier carries the transition instants, so it just answers.
 * `localDayMsInZone` is exact and has no degenerate cases to enumerate.
 *
 * The offset path remains for rows written before `timeZone` existed, and longitude behind that —
 * never UTC, which is the original bug. Both are approximations and are now labeled as such.
 */
export interface SkateAnchor {
  /** The local calendar day the skate ended on — the calibration window's newest day. */
  localDayMs: number;
  /**
   * The offset that day was on, for deciding which rows have finished happening.
   *
   * Exact where it binds: the completeness guard only fires on a window ending at or near today, and
   * for those the skate is recent enough that its offset is the current one.
   */
  utcOffsetSeconds: number;
}

export async function skateLocalDay(
  ctx: QueryCtx,
  cellKey: string,
  lng: number,
  skateEndTime: number,
): Promise<SkateAnchor> {
  const utcEstimate = Math.floor(skateEndTime / DAY_MS) * DAY_MS;
  const rows = await ctx.db
    .query('weatherDays')
    .withIndex('by_cell_day', (q) =>
      q
        .eq('cellKey', cellKey)
        .gte('dayMs', utcEstimate - 2 * DAY_MS)
        .lte('dayMs', utcEstimate + DAY_MS),
    )
    .collect();

  // The zone is a property of the cell, so any row in range that carries one will do.
  const timeZone = rows.find((r) => typeof r.timeZone === 'string')?.timeZone;
  if (timeZone !== undefined) {
    const localDayMs = localDayMsInZone(skateEndTime, timeZone);
    if (localDayMs !== null) {
      return {
        localDayMs,
        utcOffsetSeconds:
          utcOffsetSecondsInZone(localDayMs, timeZone) ?? approximateUtcOffsetSeconds(lng),
      };
    }
  }

  // ── Fallbacks, both approximate ────────────────────────────────────────────────────────────────
  // Rows predating `timeZone` carry one response-wide offset, so which of them we read makes no
  // difference — there is nothing per-date left to choose between. Nearest keeps it deterministic.
  const known = rows.filter((r): r is typeof r & { utcOffsetSeconds: number } => {
    return typeof r.utcOffsetSeconds === 'number';
  });
  const offset =
    known.length > 0
      ? known.reduce((best, r) =>
          Math.abs(r.dayMs - utcEstimate) < Math.abs(best.dayMs - utcEstimate) ? r : best,
        ).utcOffsetSeconds
      : approximateUtcOffsetSeconds(lng);
  return { localDayMs: localDayMsAt(skateEndTime, offset), utcOffsetSeconds: offset };
}

/** The window's integrals for one skate at one body, and the estimate the instrument would give. */
export type StefanWindow = {
  cellKey: string;
  /** The skate's local calendar day (the window's newest). */
  localDayMs: number;
  utcOffsetSeconds: number;
  fdh: number;
  tdh: number;
  /** Complete archive days found in the window; zero means no weather covers it. */
  days: number;
  /** Too much thaw in the window for a growth model to mean anything. */
  declined: boolean;
  /** `null` when declined; its `thicknessCm` is `null` below the minimum cold. */
  estimate: IceThicknessEstimate | null;
};

/**
 * The Stefan window for a skate ending at `skateEndTime` on `body` — exactly the instrument's
 * arithmetic (`collectCalibrationPairs`): the 60 days to the local skate day, complete days only,
 * declined over the thaw limit.
 */
export async function stefanWindowFor(
  ctx: QueryCtx,
  body: Doc<'waterBodies'>,
  skateEndTime: number,
  nowMs: number,
): Promise<StefanWindow> {
  const cell = bodyWeatherCell(body, 'browse');
  const { localDayMs, utcOffsetSeconds } = await skateLocalDay(
    ctx,
    cell.key,
    cell.lng,
    skateEndTime,
  );
  const fromMs = localDayMs - (CALIBRATION_WINDOW_DAYS - 1) * DAY_MS;
  const todayLocalDayMs = localDayMsAt(nowMs, utcOffsetSeconds);
  const { fdh, tdh, days } = await windowIntegrals(
    ctx,
    cell.key,
    fromMs,
    localDayMs,
    todayLocalDayMs,
  );
  const declined = tdh > CALIBRATION_MAX_THAW_DEGREE_HOURS;
  return {
    cellKey: cell.key,
    localDayMs,
    utcOffsetSeconds,
    fdh,
    tdh,
    days,
    declined,
    estimate: declined ? null : estimateIceThickness(fdh),
  };
}
