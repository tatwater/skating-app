/**
 * The ice-thickness calibration instrument (N6h Workstream G / **D160**).
 *
 * ## This is an operator instrument. It is not a feature.
 *
 * It computes a number in inches that a reader will interpret as *"is the ice safe"*, which is the
 * most counsel-shaped quantity this codebase can produce, and D3 says we never issue a safety
 * verdict. So D160 binds it with three rules, all of which are enforced here rather than promised:
 *
 * 1. **Structurally operator-only.** Every export is `requireRole('moderator')`-gated. Nothing on
 *    this path is reachable by a skater client — not rendered-and-hidden, not fetched-and-filtered.
 * 2. **It never feeds anything.** No mutation lives in this file. Nothing writes an estimate onto a
 *    body, a report or a hazard, and no other module imports from here. The estimate is measured
 *    *against* the world and nothing reads it back; the moment a derived thickness becomes an input
 *    it acquires authority it has not earned.
 * 3. **Graduating it to a skater surface needs its own decision.** D160 authorises a dark instrument
 *    and nothing more.
 *
 * ## Why it exists at all
 *
 * `reports.iceThickness` carries a `method` discriminator separating a **measurement** from an
 * estimate. So a season of computed-vs-measured pairs is a real calibration dataset — and it can only
 * be collected by a season passing. Ship it late and the answer arrives a year later.
 *
 * ⚠ **It will probably perform poorly, and that is the finding.** Air-temperature FDD ignores snow
 * insulation, wind, water depth, current, springs and inflow — the same variables that make the
 * never-hide invariant necessary. Learning *how* poorly, with numbers, is worth a season; learning it
 * privately is what makes it safe to learn.
 */

import {
  approximateUtcOffsetSeconds,
  estimateIceThickness,
  fitStefanAlpha,
  isCompleteDay,
  localDayMsAt,
  STEFAN_ALPHA_DEFAULT,
} from '@skating/core';
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { query } from './_generated/server';
import { requireRole } from './lib/auth';
import { bodyWeatherCell } from './lib/sampling';
import { OPEN_METEO_PROVIDER } from './weather';

const DAY_MS = 86_400_000;

/**
 * How far back a growth window may reach.
 *
 * The Stefan model is a *growth* model: it answers "how much ice would form on still open water
 * exposed to this much cold", which is not "how thick is the ice on this lake" — it has no idea what
 * was there when the window opened. Anchoring the window to the season's first sustained freeze would
 * be the physically defensible choice and is not available yet (N6e's phenology brackets ship dark in
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

export interface CalibrationPair {
  reportId: string;
  waterBodyId: string;
  waterBodyName: string;
  /** When the skate ended — the instant the measurement describes. */
  skateEndTime: number;
  /** What a human measured, in cm. The mean of this report's `measured` readings. */
  observedCm: number;
  /** How many `measured` readings that mean is over — one drilled hole is weaker than four. */
  readingCount: number;
  /** What Stefan predicts from the archive's freezing-degree-hours to that instant. */
  predictedCm: number | null;
  freezingDegreeHours: number;
  thawDegreeHours: number;
  /** Days of archive actually found in the window — a short count is a weak sample, not a wrong one. */
  daysObserved: number;
  /** Set when the window carried too much thaw for a growth model to mean anything. */
  declined: boolean;
}

/**
 * The `measured` readings of one report, in cm.
 *
 * A reading is either a single `valueCm` or a `minCm`–`maxCm` range; a range is taken at its
 * midpoint, which is the only defensible reading of "between 3 and 4 inches" and is why the count is
 * reported alongside the mean. `estimated` readings are dropped here rather than filtered later, so
 * there is exactly one place that decides what counts as a measurement.
 */
function readingsToCm(
  readings: readonly {
    valueCm?: number;
    minCm?: number;
    maxCm?: number;
    method: 'measured' | 'estimated';
  }[],
): number[] {
  const out: number[] = [];
  for (const r of readings) {
    if (r.method !== 'measured') continue;
    if (typeof r.valueCm === 'number' && r.valueCm > 0) {
      out.push(r.valueCm);
      continue;
    }
    if (typeof r.minCm === 'number' && typeof r.maxCm === 'number') {
      const mid = (r.minCm + r.maxCm) / 2;
      if (mid > 0) out.push(mid);
    }
  }
  return out;
}

/**
 * Sum the archive's degree-hour integrals for a cell over `[fromMs, toMs]`.
 *
 * ⚠ **Memoised per `(cellKey, window)` by the caller**, and it has to be. Each call collects up to
 * {@link CALIBRATION_WINDOW_DAYS} day rows, and a report table full of a busy lake's regulars is
 * exactly the shape that reads the same sixty rows two hundred times — which is how a query walks
 * into Convex's read cap. This repo has already paid twice for treating a range scan as free.
 */
async function windowIntegrals(
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
 * ## It returns the day, not an offset — because deriving one from the other is circular
 *
 * The previous two attempts both tried to pick an *offset* and let the caller floor with it, and both
 * were wrong on a DST boundary. Taking the first row in range took the **oldest** day's offset, three
 * days early. Seeding from the nearest row and re-resolving looked principled and was worse: for a
 * skate at 23:30 on the day *before* spring-forward, the nearest row is the transition day itself, its
 * post-transition offset moves the instant onto that day, and the second pass then finds that day's
 * row and **confirms its own error**. A fixed point is not the same as a correct answer.
 *
 * So this asks the question directly. A stored day `D` whose offset is `o` covers the UTC span
 * `[D − o, D + 24h − o)`. Exactly one span contains a given instant on all but two days a year, and
 * on those two:
 *
 * - **Spring-forward** doubles an hour: two spans contain the instant. The earlier day is right,
 *   because the transition happens at 2 AM — an instant that can still belong to the previous
 *   evening does, since the clocks have not moved yet.
 * - **Fall-back** removes one: no span contains it, and it falls in the gap between two. The later
 *   day is right, for the mirror reason.
 *
 * Day-granularity offsets cannot do better than this: the provider tells us what offset a *date* was
 * on, never the instant a transition fired. Both rules above are exact for the real transition times
 * and the residual error is bounded at one hour, twice a year, for skates ending within that hour.
 */
interface SkateAnchor {
  /** The local calendar day the skate ended on — the calibration window's newest day. */
  localDayMs: number;
  /**
   * The offset that day was on.
   *
   * Reused for "has today finished at this lake?", which is exact where it matters: the completeness
   * guard only binds on a window ending at or near today, and for those the skate is recent enough
   * that its offset *is* the current one. For older skates every day in the window finished long ago
   * and the guard never fires.
   */
  utcOffsetSeconds: number;
}

async function skateLocalDay(
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

  const known = rows
    .filter((r): r is typeof r & { utcOffsetSeconds: number } => {
      return typeof r.utcOffsetSeconds === 'number';
    })
    .sort((a, b) => a.dayMs - b.dayMs);

  // Old rows predate the field. The fallback is longitude, right to the hour across all five states —
  // never zero, since a UTC assumption is the original bug.
  const approximate = (): SkateAnchor => {
    const o = approximateUtcOffsetSeconds(lng);
    return { localDayMs: localDayMsAt(skateEndTime, o), utcOffsetSeconds: o };
  };
  if (known.length === 0) return approximate();

  const startOf = (r: { dayMs: number; utcOffsetSeconds: number }) =>
    r.dayMs - r.utcOffsetSeconds * 1000;
  const anchor = (r: { dayMs: number; utcOffsetSeconds: number }): SkateAnchor => ({
    localDayMs: r.dayMs,
    utcOffsetSeconds: r.utcOffsetSeconds,
  });

  // `known` is ascending, so the first match is the earliest — the spring-forward rule.
  const containing = known.find(
    (r) => skateEndTime >= startOf(r) && skateEndTime < startOf(r) + DAY_MS,
  );
  if (containing) return anchor(containing);

  // Nothing contains it: the hour fall-back removes. The next day along is the right side of the gap.
  const after = known.find((r) => startOf(r) > skateEndTime);
  return after ? anchor(after) : approximate();
}

/**
 * Every measured thickness we can pair with archived weather, plus what the model would have said.
 *
 * **Measurements only.** `method` distinguishes a measurement from an estimate, and fitting to
 * somebody else's estimate fits the model to a guess and then reports the agreement as validation.
 * `measured` counts; `estimated` is excluded and counted separately so an operator can see how much
 * data the exclusion costs.
 */
async function collectCalibrationPairs(
  ctx: QueryCtx,
  limit: number | undefined,
): Promise<{ pairs: CalibrationPair[]; excludedEstimates: number }> {
  const cap = Math.min(Math.max(limit ?? 200, 1), 500);

  // Newest first: a calibration report is read to see how this season is going, and the oldest
  // pairs are the ones whose window is most likely to predate the archive entirely.
  const reports = await ctx.db
    .query('reports')
    .order('desc')
    .take(cap * 4);

  const pairs: CalibrationPair[] = [];
  let excludedEstimates = 0;
  // Read once: a run that straddled midnight would otherwise classify the same day differently for
  // two reports, and the cached window key would serve whichever asked first.
  const nowMs = Date.now();
  const bodyCache = new Map<string, { name: string; cellKey: string; lng: number } | null>();
  // Reports cluster: one popular lake, many skate days sharing a 60-day window. Without this every
  // one of them re-reads the same archive rows and the query walks into Convex's read cap.
  const windowCache = new Map<string, { fdh: number; tdh: number; days: number }>();

  for (const report of reports) {
    if (pairs.length >= cap) break;
    const thickness = report.iceThickness;
    if (!thickness) continue;
    if (report.moderationStatus !== 'visible') continue;

    // A report carries several readings, each with its own method. Only the measured ones count —
    // fitting to somebody else's estimate fits the model to a guess and then reports the agreement
    // as validation. A report whose readings are *all* estimates is counted as excluded so an
    // operator can see what the exclusion costs.
    const measured = readingsToCm(thickness.readings);
    if (measured.length === 0) {
      if (thickness.readings.length > 0) excludedEstimates += 1;
      continue;
    }
    const observedCm = measured.reduce((a, b) => a + b, 0) / measured.length;

    const key = report.waterBodyId as string;
    let body = bodyCache.get(key);
    if (body === undefined) {
      const doc = await ctx.db.get(report.waterBodyId);
      if (doc && !doc.removedAt) {
        const cell = bodyWeatherCell(doc, 'browse');
        body = { name: doc.name, cellKey: cell.key, lng: cell.lng };
      } else {
        body = null;
      }
      bodyCache.set(key, body);
    }
    if (!body) continue;

    // The lake's local calendar day, not the UTC one — resolved by span containment rather than by
    // flooring with a guessed offset, which is what made both earlier attempts wrong on a DST edge.
    const { localDayMs: toMs, utcOffsetSeconds } = await skateLocalDay(
      ctx,
      body.cellKey,
      body.lng,
      report.skateEndTime,
    );
    const fromMs = toMs - (CALIBRATION_WINDOW_DAYS - 1) * DAY_MS;
    // Today at *this* lake. A window ending today would otherwise integrate a row whose un-elapsed
    // hours are forecast.
    const todayLocalDayMs = localDayMsAt(nowMs, utcOffsetSeconds);
    const windowKey = `${body.cellKey}:${toMs}`;
    let integrals = windowCache.get(windowKey);
    if (integrals === undefined) {
      integrals = await windowIntegrals(ctx, body.cellKey, fromMs, toMs, todayLocalDayMs);
      windowCache.set(windowKey, integrals);
    }
    const { fdh, tdh, days } = integrals;
    if (days === 0) continue; // no archive covers this report — not a failure, just not a pair yet

    const declined = tdh > CALIBRATION_MAX_THAW_DEGREE_HOURS;
    const estimate = declined ? null : estimateIceThickness(fdh);

    pairs.push({
      reportId: report._id as string,
      waterBodyId: key,
      waterBodyName: body.name,
      skateEndTime: report.skateEndTime,
      observedCm,
      readingCount: measured.length,
      predictedCm: estimate?.thicknessCm ?? null,
      freezingDegreeHours: fdh,
      thawDegreeHours: tdh,
      daysObserved: days,
      declined,
    });
  }

  return { pairs, excludedEstimates };
}

/** The gated table. See `collectCalibrationPairs` for what counts as a pair. */
export const calibrationPairs = query({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<{
    pairs: CalibrationPair[];
    excludedEstimates: number;
    windowDays: number;
    alpha: number;
  }> => {
    await requireRole(ctx, 'moderator');
    const { pairs, excludedEstimates } = await collectCalibrationPairs(ctx, limit);
    return {
      pairs,
      excludedEstimates,
      windowDays: CALIBRATION_WINDOW_DAYS,
      alpha: STEFAN_ALPHA_DEFAULT,
    };
  },
});

/**
 * The fitted coefficient and its error, over whatever pairs exist.
 *
 * ⚠ **Reported, never applied.** Nothing in this file writes `alpha` anywhere, and
 * `estimateIceThickness` keeps its published default until a human decides otherwise. An
 * auto-retuning model would be a derived thickness feeding itself, which is exactly what D160's
 * second rule forbids.
 *
 * `n` is the honest headline: a fit over four pairs is a curiosity, and the UI says which it has.
 */
export const calibrationFit = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    fitted: { alpha: number; n: number; rmseCm: number } | null;
    defaultAlpha: number;
    declined: number;
  }> => {
    await requireRole(ctx, 'moderator');
    // Shares `collectCalibrationPairs` with the table above rather than re-deriving, so the fit and
    // the rows it is drawn from can never disagree about their own sample.
    const { pairs } = await collectCalibrationPairs(ctx, undefined);
    const usable = pairs.filter((p) => !p.declined);
    return {
      fitted: fitStefanAlpha(
        usable.map((p) => ({
          freezingDegreeHours: p.freezingDegreeHours,
          observedCm: p.observedCm,
        })),
      ),
      defaultAlpha: STEFAN_ALPHA_DEFAULT,
      declined: pairs.length - usable.length,
    };
  },
});

/**
 * The Open-Meteo call meter, for the D158 trigger.
 *
 * Lives here rather than in a metrics module because it answers the same operator question this file
 * exists for — *is the model worth what it costs*.
 *
 * ⚠ **A `query`, not an `internalQuery`, and that is the whole point.** D158's trigger is *a human
 * reading a number and deciding whether to buy a plan*, so a meter no surface can read is a meter
 * that does not exist — the same reader-with-no-producer shape N6b's `hasContours` had. Role-gated
 * like everything else in this file; the calibration page is its reader.
 */
export const apiCallBudget = query({
  args: { provider: v.optional(v.string()), days: v.optional(v.number()) },
  handler: async (ctx, { provider, days }) => {
    await requireRole(ctx, 'moderator');
    const span = Math.min(Math.max(days ?? 30, 1), 365);
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const rows = await ctx.db
      .query('externalApiCalls')
      .withIndex('by_provider_day', (q) =>
        q.eq('provider', provider ?? OPEN_METEO_PROVIDER).gte('dayMs', today - (span - 1) * DAY_MS),
      )
      .collect();
    const sorted = rows.sort((a, b) => a.dayMs - b.dayMs);
    return {
      days: sorted.map((r) => ({
        dayMs: r.dayMs,
        calls: r.calls,
        weightedCalls: r.weightedCalls,
      })),
      peakWeighted: sorted.reduce((max, r) => Math.max(max, r.weightedCalls), 0),
      todayWeighted: sorted.find((r) => r.dayMs === today)?.weightedCalls ?? 0,
    };
  },
});
