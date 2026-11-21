/**
 * The ice-thickness calibration instrument (A06h Workstream 7 / **D160**).
 *
 * ## This is an operator instrument. It is not a feature.
 *
 * It computes a number in inches that a reader will interpret as *"is the ice safe"*, which is the
 * most counsel-shaped quantity this codebase can produce, and D3 says we never issue a safety
 * verdict. So D160 binds it with three rules, all of which are enforced here rather than promised:
 *
 * 1. **Structurally operator-only.** Every export is gated by `requireCapability('instruments.calibration')`. Nothing on
 *    this path is reachable by a skater client — not rendered-and-hidden, not fetched-and-filtered.
 * 2. **It never feeds anything.** No mutation lives in this file. Nothing writes an estimate onto a
 *    body, a report or a hazard, and no other module imports from here. The estimate is measured
 *    *against* the world and nothing reads it back; the moment a derived thickness becomes an input
 *    it acquires authority it has not earned.
 * 3. **Graduating it to a skater surface needs its own decision.** D160 authorizes a dark instrument
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
  estimateIceThickness,
  fitStefanAlpha,
  localDayMsAt,
  STEFAN_ALPHA_DEFAULT,
  type ThicknessMethod,
} from '@skating/core';
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { bodyWeatherCell } from './lib/sampling';
import {
  CALIBRATION_MAX_THAW_DEGREE_HOURS,
  CALIBRATION_WINDOW_DAYS,
  skateLocalDay,
  windowIntegrals,
} from './lib/stefanWindow';
import { OPEN_METEO_PROVIDER } from './weather';

const DAY_MS = 86_400_000;

// The window and its thaw refusal live with the helpers both readers share (`lib/stefanWindow`).
export { CALIBRATION_MAX_THAW_DEGREE_HOURS, CALIBRATION_WINDOW_DAYS };

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
 * there is exactly one place that decides what counts as a measurement — and `poke` (A10 / D195)
 * is dropped by the same line: a pole-test count is the skater's own scale, not a centimeter. A
 * lower bound (`minCm` alone, D195) is not a midpoint of anything and is dropped too.
 */
function readingsToCm(
  readings: readonly {
    valueCm?: number;
    minCm?: number;
    maxCm?: number;
    method: ThicknessMethod;
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
 * Every measured thickness we can pair with archived weather, plus what the model would have said.
 *
 * **Measurements only.** `method` distinguishes a measurement from an estimate, and fitting to
 * somebody else's estimate fits the model to a guess and then reports the agreement as validation.
 * `measured` counts; `estimated` is excluded and counted separately so an operator can see how much
 * data the exclusion costs.
 */
/**
 * Pairs a request returns when it does not ask for a number.
 *
 * ⚠ **Named rather than inlined because both readers have to pass the *same* one.** `calibrationFit`
 * used to hand `undefined` through while the table passed its own `limit`, so the two agreed only by
 * coincidence of their defaults: a table asked for 500 rows would have been fitted against the newest
 * 200 while the page reported one `n`. The shared-sample guarantee has to be a value, not a default.
 */
export const CALIBRATION_PAIR_LIMIT = 200;

async function collectCalibrationPairs(
  ctx: QueryCtx,
  limit: number | undefined,
): Promise<{ pairs: CalibrationPair[]; excludedEstimates: number }> {
  const cap = Math.min(Math.max(limit ?? CALIBRATION_PAIR_LIMIT, 1), 500);

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
    await requireCapability(ctx, 'instruments.calibration');
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
 * The fitted coefficient and its error, over the newest {@link CALIBRATION_PAIR_LIMIT} pairs — the
 * same sample the table draws, stated rather than defaulted into.
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
    await requireCapability(ctx, 'instruments.calibration');
    // Shares `collectCalibrationPairs` with the table above rather than re-deriving, so the fit and
    // the rows it is drawn from can never disagree about their own sample — which means passing the
    // limit explicitly rather than letting two call sites land on the same default by luck.
    const { pairs } = await collectCalibrationPairs(ctx, CALIBRATION_PAIR_LIMIT);
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
 * that does not exist — the same reader-with-no-producer shape A06b's `hasContours` had. Role-gated
 * like everything else in this file; the calibration page is its reader.
 */
export const apiCallBudget = query({
  args: { provider: v.optional(v.string()), days: v.optional(v.number()) },
  handler: async (ctx, { provider, days }) => {
    await requireCapability(ctx, 'instruments.calibration');
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
