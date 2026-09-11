/**
 * The daily weather archive (N6h Workstream B / **D153**, **D161**).
 *
 * ## An archive, not a cache
 *
 * Everything else in the weather path expires. `weatherCache` prunes at 24 h because its rows are
 * window summaries reachable only inside their own hour bucket; `weatherForecastCache` is garbage the
 * moment its bucket passes. **A `weatherDays` row describes what happened between two past instants,
 * so it is true for ever** — written once, kept for the season, never swept by `storageHygiene`.
 *
 * ## Why this has its own request builder
 *
 * `weather.ts` asks for `timeformat=unixtime` and shifts each hour by a single
 * `utc_offset_seconds`, which is right for night-bucketing an integral and wrong for a calendar: one
 * offset per response means an hour lands in the wrong local day on either side of a DST change, and
 * **both transitions fall inside a Northeast skating season.**
 *
 * This builder asks for **`timeformat=iso8601`**, so Open-Meteo returns local wall-clock strings and
 * every hour arrives already knowing the date the lake actually experienced. No offset arithmetic
 * happens anywhere in this file. That is the only way to be DST-correct without shipping a timezone
 * database.
 *
 * ⚠ **This is not a second cache key, and the distinction matters.** N6h's readiness pass flagged
 * that forking the *fetch* is fine while forking the *key* is not: the strip and the decay must agree
 * on one `weatherCache` entry or Phase 10 §5 breaks silently. Both builders take the same
 * `WeatherCell` from `bodyWeatherCell`, so the keys can't diverge; only the request shape does, and
 * it does so for a stated reason.
 *
 * ## The recovery ladder (D161)
 *
 * Past data is immutable, so a gap is permanent unless something notices. `sweepWeatherDayGaps`
 * notices, and then:
 *
 *   1. **Refetch from the forecast endpoint** — `past_days` reaches 92, so any gap inside that
 *      window is fully recoverable.
 *   2. **Borrow the coarser tier** — a missing `browse` day can take its `filter` parent's, recorded
 *      as `source: 'borrowed'` so a reader knows the row is honestly lower-resolution than its tier.
 *   3. *(deferred)* **ERA5 archive** past 92 days. D153 un-banned it for exactly this range; the
 *      `archive` source literal exists so wiring it later needs no migration. See the phase doc's
 *      deferred register.
 *   4. **Record an explicit gap** — `missing: true`, never a row of zeroes. An absent day reads as
 *      *"no snow fell"* to every D159 predicate, which is the most dangerous possible failure for a
 *      filter whose whole job is finding lakes with no snow on them.
 */

import {
  approximateUtcOffsetSeconds,
  archiveSeasonAt,
  buildSubAreaSpread,
  dayMsToLocalDate,
  isCompleteDay,
  type LocalHourlyWeather,
  localDateToDayMs,
  localDayMsAt,
  localDayMsInZone,
  type SpreadBayDay,
  type SpreadBayInput,
  type SubAreaSpread,
  spansMultipleSampleCells,
  summarizeWeatherDays,
  utcOffsetSecondsInZone,
  WEATHER_TIERS,
  type WeatherCell,
  type WeatherDaySummary,
  type WeatherTier,
  weatherCellFor,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { ActionCtx, MutationCtx } from './_generated/server';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from './_generated/server';
import { meterOpenMeteo } from './lib/apiMeter';
import { WEATHER_DAY_SOURCES } from './lib/enums';
import { bodyWeatherCell, subAreaWeatherCell } from './lib/sampling';
import { literals } from './lib/validators';
import { HOURLY_VARS, MAX_PAST_DAYS, OPEN_METEO_FORECAST_URL } from './weather';

const DAY_MS = 86_400_000;

/**
 * Days of history a first touch pulls. The Open-Meteo ceiling, deliberately — D153's finding is that
 * **lazy backfill is not lossy**: the first person to open a lake in February gets the whole season
 * to date in one request, not merely the week before their visit.
 */
export const BACKFILL_PAST_DAYS = MAX_PAST_DAYS;

/**
 * Days a routine append re-requests.
 *
 * Three rather than one, for two reasons that both bite. A day's night window reaches back into the
 * *previous* evening (`nightMinTempC`), so writing yesterday complete needs the day before it. And
 * today's row is necessarily partial when written, so it has to be rewritten tomorrow — which the
 * idempotent upsert makes free and self-healing.
 */
export const APPEND_PAST_DAYS = 3;

/**
 * How far back the **first** sweep of a season reaches.
 *
 * ⚠ **D161 claimed the first Tier-B run "hands D159 a region-wide freeze map on day one." With a
 * 3-day append it hands over three days.** Every weather predicate worth filtering on is a window —
 * *"three nights below 20°F and no snow since"* needs a week — so a cold archive makes the discovery
 * surface useless for its first week, which is precisely the week the season opens and interest
 * peaks.
 *
 * **14 rather than 7, because 14 is free.** Open-Meteo bills `ceil(days / 14) × (vars / 10)`, so
 * 3 days and 14 days are both exactly one billing unit — the cost boundary sits at 15. The only
 * thing extra days cost is Convex write I/O, which is why the *daily* append stays at 3 (it needs
 * an overlap to complete a partial "today", not a fortnight of re-upserts).
 */
export const SEASON_OPEN_PAST_DAYS = 14;

/** Cells per cron batch. The action reschedules itself; see `refreshTierDays`. */
export const CELL_BATCH_SIZE = 40;

/** Bodies per batch while materialising the cell registry. */
export const CELL_BACKFILL_BATCH = 500;

/** How far back the gap sweep looks. Inside the 92-day window, so step 1 of the ladder can serve it. */
export const GAP_SWEEP_DAYS = 30;

/** UTC-midnight day key for "today" in the archive's own terms. */
function todayKey(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface IsoHourlyResponse {
  /**
   * Seconds east of UTC for the requested coordinate, DST included, as Open-Meteo resolved it under
   * `timezone=auto`. Free in every response and previously discarded — see `LocalHourlyBatch`.
   */
  utc_offset_seconds?: number;
  /**
   * The IANA zone Open-Meteo resolved for the coordinate under `timezone=auto` — `America/New_York`
   * for all five states.
   *
   * ⚠ **This, not `utc_offset_seconds`, is what makes a calendar date knowable.** The offset is one
   * number for the whole response and is therefore wrong for any date on the far side of a DST
   * transition from the fetch; a zone identifier carries the transition instants themselves.
   */
  timezone?: string;
  hourly?: {
    time?: string[]; // local wall-clock, `YYYY-MM-DDTHH:mm`
    [key: string]: (number | null)[] | string[] | undefined;
  };
}

function numOr0(x: number | null | undefined): number {
  return typeof x === 'number' ? x : 0;
}

/**
 * Parse `2026-01-15T13:00` into its local date and hour without constructing a `Date`.
 *
 * ⚠ **`new Date('2026-01-15T13:00')` would be actively wrong here.** A bare ISO string with no zone
 * is interpreted in the *runtime's* timezone, so the same response would parse differently on a
 * developer's laptop and on Convex's UTC servers — and the value we want is neither of those, it is
 * the lake's own wall clock, which the string already states. Read the characters.
 */
function parseLocalStamp(stamp: string): { localDate: string; localHour: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(stamp);
  if (!m) return null;
  const localDate = m[1];
  const localHour = Number(m[2]);
  if (localDate === undefined || !Number.isFinite(localHour)) return null;
  return { localDate, localHour };
}

/**
 * Hours plus the offset the place was on, which is the pair the archive actually needs.
 *
 * ⚠ **The hours alone cannot answer "which local day was this instant".** They carry local wall-clock
 * strings, which is exactly right for bucketing and useless for mapping a stored UTC timestamp (a
 * report's `skateEndTime`) onto a `dayMs` key. The offset is what closes that gap, it is in every
 * response already, and dropping it is what let the calibration window slip a day.
 */
interface LocalHourlyBatch {
  hours: LocalHourlyWeather[];
  utcOffsetSeconds: number | null;
  /** The response's IANA zone, when it gave one — see `IsoHourlyResponse.timezone`. */
  timeZone: string | null;
}

/**
 * Fetch `pastDays` of local-stamped hourly weather for a cell, plus today.
 *
 * Returns `null` on any failure so the caller can leave the days it could not get **absent rather
 * than zeroed** — the distinction the whole `missing` flag exists to preserve.
 */
async function fetchLocalHourly(
  ctx: ActionCtx,
  cell: WeatherCell,
  pastDays: number,
): Promise<LocalHourlyBatch | null> {
  const days = Math.min(MAX_PAST_DAYS, Math.max(1, pastDays));
  const params = new URLSearchParams({
    latitude: String(cell.lat),
    longitude: String(cell.lng),
    hourly: HOURLY_VARS.join(','),
    past_days: String(days),
    // One forward day so today's elapsed hours are included; the archive keeps only what has
    // happened, and today's provisional row is rewritten by tomorrow's append.
    forecast_days: '1',
    timezone: 'auto',
    // The whole reason this builder exists — see the module docblock.
    timeformat: 'iso8601',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
  });
  if (cell.elevationM !== undefined) params.set('elevation', String(cell.elevationM));

  let json: IsoHourlyResponse;
  try {
    await meterOpenMeteo(ctx, HOURLY_VARS.length, days + 1);
    const res = await fetch(`${OPEN_METEO_FORECAST_URL}?${params.toString()}`);
    if (!res.ok) {
      console.warn(`Open-Meteo archive request failed: ${res.status}`);
      return null;
    }
    json = (await res.json()) as IsoHourlyResponse;
  } catch (err) {
    console.warn('Open-Meteo archive request threw', err);
    return null;
  }

  const time = json.hourly?.time;
  if (!Array.isArray(time) || time.length === 0) return null;
  const col = (k: string) => json.hourly?.[k] as (number | null)[] | undefined;
  const temp = col('temperature_2m');
  const precip = col('precipitation');
  const rain = col('rain');
  const snowfall = col('snowfall');
  const snowDepth = col('snow_depth');
  const wind = col('wind_speed_10m');
  const gust = col('wind_gusts_10m');
  const dir = col('wind_direction_10m');
  const cloud = col('cloud_cover');
  const sunshine = col('sunshine_duration');
  const shortwave = col('shortwave_radiation');
  const weatherCode = col('weather_code');

  const out: LocalHourlyWeather[] = [];
  for (let i = 0; i < time.length; i++) {
    const stamp = time[i];
    if (typeof stamp !== 'string') continue;
    const parsed = parseLocalStamp(stamp);
    if (!parsed) continue;
    const t = temp?.[i];
    if (typeof t !== 'number') continue; // no temperature ⇒ unusable hour

    const h: LocalHourlyWeather = {
      localDate: parsed.localDate,
      localHour: parsed.localHour,
      temperatureC: t,
      precipitationMm: numOr0(precip?.[i]),
      windSpeedKph: numOr0(wind?.[i]),
    };
    const rv = rain?.[i];
    if (typeof rv === 'number') h.rainMm = rv;
    const sv = snowfall?.[i];
    if (typeof sv === 'number') h.snowfallCm = sv;
    const dv = snowDepth?.[i];
    if (typeof dv === 'number') h.snowDepthM = dv;
    const gv = gust?.[i];
    if (typeof gv === 'number') h.windGustKph = gv;
    const dirv = dir?.[i];
    if (typeof dirv === 'number') h.windDirectionDeg = dirv;
    const cv = cloud?.[i];
    if (typeof cv === 'number') h.cloudCoverPct = cv;
    const sunv = sunshine?.[i];
    if (typeof sunv === 'number') h.sunshineSeconds = sunv;
    const swv = shortwave?.[i];
    if (typeof swv === 'number') h.shortwaveWm2 = swv;
    const wcv = weatherCode?.[i];
    if (typeof wcv === 'number') h.weatherCode = wcv;
    out.push(h);
  }
  if (out.length === 0) return null;
  return {
    hours: out,
    utcOffsetSeconds: typeof json.utc_offset_seconds === 'number' ? json.utc_offset_seconds : null,
    timeZone: typeof json.timezone === 'string' && json.timezone.length > 0 ? json.timezone : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The stored shape of one summarised day, minus the key fields the mutation supplies. */
const daySummaryFields = {
  hours: v.optional(v.number()),
  minTempC: v.optional(v.number()),
  maxTempC: v.optional(v.number()),
  meanTempC: v.optional(v.number()),
  nightMinTempC: v.optional(v.number()),
  hoursBelowFreezing: v.optional(v.number()),
  hoursAboveFreezing: v.optional(v.number()),
  freezingDegreeHours: v.optional(v.number()),
  thawDegreeHours: v.optional(v.number()),
  precipitationMm: v.optional(v.number()),
  rainMm: v.optional(v.number()),
  snowfallCm: v.optional(v.number()),
  maxSnowDepthM: v.optional(v.number()),
  hoursOfSun: v.optional(v.number()),
  insolationWhM2: v.optional(v.number()),
  absorbedInsolationWhM2: v.optional(v.number()),
  sunlitThawHours: v.optional(v.number()),
  meltIndexMm: v.optional(v.number()),
  maxWindKph: v.optional(v.number()),
  maxWindGustKph: v.optional(v.number()),
  windRunKm: v.optional(v.number()),
  windSectorHours: v.optional(v.array(v.number())),
  freezingHoursMeanWindKph: v.optional(v.number()),
  freezingHoursMaxWindKph: v.optional(v.number()),
} as const;

/** Drop `null`s so an absent measure is *absent*, not stored as a value meaning "unknown". */
function storableDay(day: WeatherDaySummary): Record<string, unknown> {
  const out: Record<string, unknown> = { hours: day.hours };
  const put = (k: string, val: number | null) => {
    if (val !== null && Number.isFinite(val)) out[k] = val;
  };
  put('minTempC', day.minTempC);
  put('maxTempC', day.maxTempC);
  put('meanTempC', day.meanTempC);
  put('nightMinTempC', day.nightMinTempC);
  out.hoursBelowFreezing = day.hoursBelowFreezing;
  out.hoursAboveFreezing = day.hoursAboveFreezing;
  out.freezingDegreeHours = day.freezingDegreeHours;
  out.thawDegreeHours = day.thawDegreeHours;
  out.precipitationMm = day.precipitationMm;
  out.rainMm = day.rainMm;
  out.snowfallCm = day.snowfallCm;
  put('maxSnowDepthM', day.maxSnowDepthM);
  out.hoursOfSun = day.hoursOfSun;
  out.insolationWhM2 = day.insolationWhM2;
  out.absorbedInsolationWhM2 = day.absorbedInsolationWhM2;
  out.sunlitThawHours = day.sunlitThawHours;
  out.meltIndexMm = day.meltIndexMm;
  put('maxWindKph', day.maxWindKph);
  put('maxWindGustKph', day.maxWindGustKph);
  out.windRunKm = day.windRunKm;
  if (day.windSectorHours.length > 0) out.windSectorHours = day.windSectorHours;
  put('freezingHoursMeanWindKph', day.freezingHoursMeanWindKph);
  put('freezingHoursMaxWindKph', day.freezingHoursMaxWindKph);
  return out;
}

/**
 * Upsert summarised days for a cell — **idempotent on `(cellKey, dayMs)`**.
 *
 * The idempotence is not decoration. Every write path re-requests days it may already hold: the
 * append overlaps three days so a partial "today" gets completed, and the gap sweep re-asks for days
 * it knows are missing. Without an upsert each of those would duplicate rows, and a duplicated day
 * would be double-counted by any predicate that sums a span.
 *
 * ⚠ **A day that arrives complete never regresses to `missing`.** `writeMissingDays` refuses to
 * overwrite a real row, so a transient outage during a gap sweep cannot erase good data.
 */
export const upsertWeatherDays = internalMutation({
  args: {
    cellKey: v.string(),
    tier: literals(WEATHER_TIERS),
    source: literals(WEATHER_DAY_SOURCES),
    fetchedAt: v.number(),
    /** Seconds east of UTC at this cell, as the provider resolved it. See `LocalHourlyBatch`. */
    utcOffsetSeconds: v.optional(v.number()),
    timeZone: v.optional(v.string()),
    days: v.array(
      v.object({
        dayMs: v.number(),
        localDate: v.string(),
        ...daySummaryFields,
      }),
    ),
  },
  handler: async (ctx, a) => {
    for (const day of a.days) {
      await writeDay(ctx, {
        cellKey: a.cellKey,
        tier: a.tier,
        source: a.source,
        fetchedAt: a.fetchedAt,
        // ⚠ **Per date, not per response.** `utc_offset_seconds` describes the moment of the fetch, so
        // a 92-day backfill run in July used to stamp every January row with EDT — an hour out, which
        // near local midnight moves a calendar date. With a zone we can say what each date was
        // actually on; without one we fall back to the response's single number, as before.
        ...(a.timeZone === undefined
          ? {}
          : { timeZone: a.timeZone, ...zoneOffsetFor(day.dayMs, a.timeZone, a.utcOffsetSeconds) }),
        ...(a.timeZone !== undefined || a.utcOffsetSeconds === undefined
          ? {}
          : { utcOffsetSeconds: a.utcOffsetSeconds }),
        ...day,
      });
    }
  },
});

async function writeDay(
  ctx: MutationCtx,
  row: {
    cellKey: string;
    tier: WeatherTier;
    source: (typeof WEATHER_DAY_SOURCES)[number];
    fetchedAt: number;
    dayMs: number;
    localDate: string;
  } & Record<string, unknown>,
): Promise<void> {
  const existing = await ctx.db
    .query('weatherDays')
    .withIndex('by_cell_day', (q) => q.eq('cellKey', row.cellKey).eq('dayMs', row.dayMs))
    .first();
  // `missing` is cleared explicitly rather than left off the patch: a row that was a recorded gap and
  // is now real must stop looking like a gap, and `patch` does not remove absent keys.
  const doc = { ...row, missing: undefined };
  if (existing) await ctx.db.patch(existing._id, doc);
  else await ctx.db.insert('weatherDays', doc as never);
}

/**
 * Record days we tried for and could not get (D161 step 4).
 *
 * ⚠ **Never overwrites a row that already has data.** A gap marker is a statement about our fetching,
 * not about the weather, and it must not be able to destroy an observation — a sweep that ran during
 * an Open-Meteo outage would otherwise blank a week of good history.
 */
export const writeMissingDays = internalMutation({
  args: {
    cellKey: v.string(),
    tier: literals(WEATHER_TIERS),
    dayMs: v.array(v.number()),
    fetchedAt: v.number(),
  },
  handler: async (ctx, a) => {
    for (const dayMs of a.dayMs) {
      const existing = await ctx.db
        .query('weatherDays')
        .withIndex('by_cell_day', (q) => q.eq('cellKey', a.cellKey).eq('dayMs', dayMs))
        .first();
      if (existing && existing.missing !== true) continue; // real data wins, always
      const doc = {
        cellKey: a.cellKey,
        tier: a.tier,
        dayMs,
        localDate: dayMsToLocalDate(dayMs),
        missing: true,
        source: 'forecast' as const,
        fetchedAt: a.fetchedAt,
      };
      if (existing) await ctx.db.patch(existing._id, doc);
      else await ctx.db.insert('weatherDays', doc);
    }
  },
});

/** The day keys a cell already holds real (non-`missing`) data for, within `[fromMs, toMs]`. */
export const listCellDayKeys = internalQuery({
  args: { cellKey: v.string(), fromMs: v.number(), toMs: v.number() },
  handler: async (ctx, { cellKey, fromMs, toMs }) => {
    const rows = await ctx.db
      .query('weatherDays')
      .withIndex('by_cell_day', (q) =>
        q.eq('cellKey', cellKey).gte('dayMs', fromMs).lte('dayMs', toMs),
      )
      .collect();
    return {
      present: rows.filter((r) => r.missing !== true).map((r) => r.dayMs),
      missing: rows.filter((r) => r.missing === true).map((r) => r.dayMs),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The cell registry
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Materialise the distinct weather cells the corpus occupies, in batches.
 *
 * Walks `waterBodies` once and reschedules itself until done. The alternative — deriving the cell list
 * inside the daily cron — would re-read 25,000 fat rows every day to rediscover keys that only change
 * when the corpus does. This repo has already paid for treating a corpus scan as a cheap way to answer
 * a small question.
 *
 * Idempotent: re-running refreshes `bodyCount` and `updatedAt` rather than duplicating.
 *
 * ## ⚠ The registry is a projection of the corpus, so it needs a producer AND a reconciler
 *
 * Shipped with neither, and the failure is silent in both directions. With an empty registry
 * `refreshTierDays` pages zero cells, returns `done: true`, and the cron reports a healthy tick
 * having fetched nothing — the archive simply stays empty. As the corpus drifts, a body imported
 * after the last run occupies a cell nobody registered and is invisible to D159 for ever, while a
 * body purged or moved leaves a **vacated** cell the sweep keeps paying Open-Meteo for.
 *
 * So: `maybeSyncWeatherCells` runs it weekly (not daily — re-reading 25,000 fat rows every day is
 * the cost the registry exists to avoid, and ~75 MB once a week is ~10 MB/day amortised), the sweep
 * self-heals when it finds the registry empty, and a completed run prunes what it did not see.
 */
export const backfillWeatherCells = internalAction({
  args: {
    cursor: v.optional(v.string()),
    tier: v.optional(literals(WEATHER_TIERS)),
    /** Minted by the first batch and carried by the rest — see `weatherCells.runId`. */
    runId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { cursor, tier, runId },
  ): Promise<{ done: boolean; scanned: number; pruned: number; superseded?: true }> => {
    const targetTier = tier ?? 'filter';
    const run = runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // The first page claims the tier; later pages inherit the claim. `startedAt` is recorded here and
    // nowhere else, because it is the instant the completed run's guarantee is stated against: *this
    // run saw every write committed before this moment*.
    if (cursor === undefined) {
      await ctx.runMutation(internal.weatherArchive.beginCellSync, {
        tier: targetTier,
        runId: run,
        startedAt: Date.now(),
      });
    }

    const page = await ctx.runQuery(internal.weatherArchive.pageBodyCells, {
      cursor: cursor ?? null,
      tier: targetTier,
    });
    const { superseded } = await ctx.runMutation(internal.weatherArchive.upsertWeatherCells, {
      tier: targetTier,
      cells: page.cells,
      runId: run,
      nowMs: Date.now(),
    });
    // ⚠ **A superseded run stops here — it does not write, reschedule or prune.** Two walks running at
    // once would each see the other's rows as foreign and take turns deleting them, so the registry
    // could end up emptier the more often it was reconciled. Ownership is a single `runId` and the
    // newest claim wins; the loser abandons its remaining pages, whose work the winner is redoing.
    if (superseded) return { done: true, scanned: page.scanned, pruned: 0, superseded: true };

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.weatherArchive.backfillWeatherCells, {
        cursor: page.cursor,
        tier: targetTier,
        runId: run,
      });
      return { done: false, scanned: page.scanned, pruned: 0 };
    }

    // The bodies are done; the bays are not. Walked **inline** on the last body page rather than
    // scheduled as a phase of its own: the table is ~128 rows against ~25,000 bodies, and a
    // scheduled continuation would make this invocation report `done: false` for a walk it had
    // all but finished — the same untestable-wiring shape PR 1 learned from twice. The prune
    // below has to wait for it, because a bay-only cell is exactly what a bodies-only "not seen
    // this run" would delete. See `pageSubAreaCells` for why a bay is registered at all.
    let scanned = page.scanned;
    let subCursor: string | null = null;
    for (;;) {
      const bays: CellPage = await ctx.runQuery(internal.weatherArchive.pageSubAreaCells, {
        cursor: subCursor,
        tier: targetTier,
      });
      const res = await ctx.runMutation(internal.weatherArchive.upsertWeatherCells, {
        tier: targetTier,
        cells: bays.cells,
        runId: run,
        nowMs: Date.now(),
      });
      if (res.superseded) return { done: true, scanned, pruned: 0, superseded: true };
      scanned += bays.scanned;
      if (bays.isDone) break;
      subCursor = bays.cursor;
    }
    // ⚠ **Only after a COMPLETE walk — of both tables.** Pruning mid-run would delete every cell the remaining pages
    // were about to re-stamp — the whole registry, one page in. `isDone` is the only safe moment,
    // and the run id is what distinguishes "not seen this run" from "not seen this page".
    const pruned = await ctx.runMutation(internal.weatherArchive.pruneVacatedCells, {
      tier: targetTier,
      runId: run,
    });
    // Last, and only on a genuinely complete walk: this is what the debounce reads.
    await ctx.runMutation(internal.weatherArchive.finishCellSync, {
      tier: targetTier,
      runId: run,
      completedAt: Date.now(),
    });
    return { done: true, scanned, pruned };
  },
});

/** Claim a tier for a run, displacing any walk already in flight. */
export const beginCellSync = internalMutation({
  args: { tier: literals(WEATHER_TIERS), runId: v.string(), startedAt: v.number() },
  handler: async (ctx, { tier, runId, startedAt }) => {
    const existing = await ctx.db
      .query('weatherCellSyncs')
      .withIndex('by_tier', (q) => q.eq('tier', tier))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { runId, startedAt, completedAt: undefined });
      return;
    }
    await ctx.db.insert('weatherCellSyncs', { tier, runId, startedAt });
  },
});

/**
 * Mark a walk complete — **the only writer of the debounce's input.**
 *
 * Silently does nothing if the tier has been claimed by a newer run, so a straggler cannot backdate
 * the registry's guarantee to its own older `startedAt`.
 */
export const finishCellSync = internalMutation({
  args: { tier: literals(WEATHER_TIERS), runId: v.string(), completedAt: v.number() },
  handler: async (ctx, { tier, runId, completedAt }) => {
    const row = await ctx.db
      .query('weatherCellSyncs')
      .withIndex('by_tier', (q) => q.eq('tier', tier))
      .unique();
    if (!row || row.runId !== runId) return;
    await ctx.db.patch(row._id, { completedAt });
  },
});

/**
 * Delete registered cells a completed run did not see — the corpus no longer occupies them.
 *
 * A body that was purged, merged or moved across a cell boundary leaves its old cell behind, and
 * nothing else would ever remove it: the sweep would fetch weather for an empty patch of map daily,
 * for ever, and `bodyCount` would keep asserting bodies that are not there.
 *
 * ⚠ **`weatherDays` rows are deliberately NOT deleted with the cell.** They describe what the
 * weather did at a place, which stays true whether or not a lake is still listed there — and if the
 * cell is re-occupied later (a body edited back, a re-import) the history is still good. D153's rule
 * is that an observation is never swept; this prunes the *schedule*, not the record.
 */
export const pruneVacatedCells = internalMutation({
  args: { tier: literals(WEATHER_TIERS), runId: v.string() },
  handler: async (ctx, { tier, runId }): Promise<number> => {
    const stale = await ctx.db
      .query('weatherCells')
      .withIndex('by_tier_key', (q) => q.eq('tier', tier))
      .collect();
    let pruned = 0;
    for (const cell of stale) {
      if (cell.runId === runId) continue;
      await ctx.db.delete(cell._id);
      pruned += 1;
    }
    return pruned;
  },
});

/** True when a tier has no registered cells at all — the fresh-deployment state. */
export const tierRegistryEmpty = internalQuery({
  args: { tier: literals(WEATHER_TIERS) },
  handler: async (ctx, { tier }) => {
    const first = await ctx.db
      .query('weatherCells')
      .withIndex('by_tier_key', (q) => q.eq('tier', tier))
      .first();
    return first === null;
  },
});

/**
 * Every tier's materialisation state — the debounce's input.
 *
 * ⚠ **This replaced sampling `updatedAt` off an arbitrary `weatherCells` row, which was wrong twice
 * over.** See `weatherCellSyncs` in the schema for the full account; the short version is that the
 * sample's clock came from an unpredictable point in a paginated walk, and that even a perfect sample
 * of a *completion* time cannot answer the question being asked. A walk guarantees it saw the corpus
 * as of its **start**, so the start is what has to be recorded and compared.
 */
export const cellSyncStates = internalQuery({
  args: {},
  handler: async (ctx): Promise<CellSyncState[]> => {
    const out: CellSyncState[] = [];
    for (const tier of WEATHER_TIERS) {
      const row = await ctx.db
        .query('weatherCellSyncs')
        .withIndex('by_tier', (q) => q.eq('tier', tier))
        .unique();
      out.push({
        tier,
        startedAt: row?.startedAt ?? null,
        completedAt: row?.completedAt ?? null,
      });
    }
    return out;
  },
});

export interface CellSyncState {
  tier: (typeof WEATHER_TIERS)[number];
  startedAt: number | null;
  completedAt: number | null;
}

/**
 * When an in-flight walk stops being believed.
 *
 * A walk is 50-odd near-instant pages over ~25,000 bodies, so minutes at the outside. An hour means a
 * run killed mid-flight — a deploy, an exception in a page — costs one delayed reconcile rather than
 * wedging the debounce permanently against a claim that will never complete.
 */
export const SYNC_ASSUMED_DEAD_MS = 60 * 60 * 1000;

/**
 * Whether a reconcile requested at `requestedAt` is already answered — **the whole debounce rule.**
 *
 * A tier is satisfied when some run that started at or after the request either finished, or is still
 * running and has not been abandoned. Both arms turn on `startedAt`, because that is the only instant
 * a walk can make a claim about: *everything committed before I started, I saw*. A run that merely
 * **finished** after the request proves nothing — it may have paged past those rows before they were
 * written.
 *
 * ⚠ **The in-flight arm is what makes a campaign collapse.** Without it, five loaders finishing three
 * minutes apart would each start a walk that supersedes the last, and a long enough campaign would
 * restart the walk indefinitely without ever completing one. With it, the first walk absorbs the lot,
 * because it started after every one of their writes.
 *
 * Pure, and exported, because every interesting case here is a matter of clock arithmetic that is
 * miserable to provoke through the scheduler and trivial to state directly.
 */
export function reconcileSatisfiedBy(
  states: readonly CellSyncState[],
  requestedAt: number,
  nowMs: number,
): boolean {
  if (states.length === 0) return false;
  return states.every(({ startedAt, completedAt }) => {
    if (startedAt === null || startedAt < requestedAt) return false;
    if (completedAt !== null) return true;
    return nowMs - startedAt < SYNC_ASSUMED_DEAD_MS;
  });
}

/**
 * How long an import waits before its reconcile fires.
 *
 * A campaign is several loaders, not one — N7-3 ran five passes — and each `finish` would otherwise
 * request its own ~170 MB corpus walk. The delay lets a burst collapse: the first request through
 * does the work, and the rest find the registry already newer than their own `requestedAt` and stand
 * down. Ten minutes is comfortably longer than the gap between loaders in a campaign and far shorter
 * than anyone waits to see a body appear in discovery.
 */
export const RECONCILE_DEBOUNCE_MS = 10 * 60 * 1000;

/**
 * Re-derive both tiers' cells from the corpus.
 *
 * ## Triggered by the event that invalidates it, with the cron as the net
 *
 * The registry is a projection of `waterBodies`, so the thing that makes it stale is **a corpus
 * import completing** — not the passage of time. `importRuns.finish` schedules this for the run
 * kinds that can move a cell key (`WEATHER_CELL_INVALIDATING_KINDS`), which makes staleness ~zero on
 * the handful of days a year the corpus actually changes and costs nothing on the ~360 it does not.
 *
 * The weekly cron remains, demoted to what a periodic full reconcile should be: a safety net for
 * drift the event trigger missed — a hand-edit in the dashboard, a loader that died before `finish`,
 * a restore. **Weekly rather than daily** because a walk is ~85 MB per tier against a 3,383-byte
 * average body row, so daily-over-both-tiers is ~5.1 GB/month of read I/O (~10% of Convex Pro's
 * included 50 GB) spent re-deriving keys that did not change; weekly is ~1.5%.
 *
 * **Not season-gated, and that is the point.** The registry has to be populated *before* a season
 * opens, or the first sweep of the year pages zero cells and D161's "region-wide freeze map on day
 * one" is a map of nothing. Corpus drift also happens in the off-season as readily as in it.
 *
 * Both tiers, because `browse` cells are registered for the same reason `filter` ones are: the gap
 * sweep pages the registry per tier, and an unregistered browse cell never gets its holes repaired.
 *
 * ⚠ **Runs each tier inline rather than scheduling it**, matching `maybeRefreshFilterTier`. The
 * backfill reschedules its own remaining pages either way, so this is exactly the same work — and in
 * exchange the tick reports what it actually did instead of only that it asked. The scheduled shape
 * was tried first and made the wiring untestable, which is the second time this phase has learned
 * that lesson.
 */
export const maybeSyncWeatherCells = internalAction({
  args: {
    /**
     * When the reconcile was *asked for*. Present only on the import-triggered path.
     *
     * ⚠ **The debounce turns on one invariant: a walk that STARTED at S has seen every body written
     * before S.** So a request is satisfied by any run that began at or after it, whichever import
     * made it — which is what lets a five-loader campaign collapse into a single walk without
     * tracking who wrote what.
     *
     * It previously said *completes* rather than *starts*, and that was a real bug, not a wording
     * slip: a paginated walk finishing after an import may have paged past those rows long before
     * they were written, so the import's changes went unregistered until the weekly cron. See
     * `reconcileSatisfiedBy` and the `weatherCellSyncs` schema comment.
     */
    requestedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { requestedAt },
  ): Promise<{ skipped?: 'already reconciled'; tiers: { tier: string; pruned: number }[] }> => {
    if (requestedAt !== undefined) {
      const states = await ctx.runQuery(internal.weatherArchive.cellSyncStates, {});
      if (reconcileSatisfiedBy(states, requestedAt, Date.now())) {
        return { skipped: 'already reconciled', tiers: [] };
      }
    }
    const tiers: { tier: string; pruned: number }[] = [];
    for (const tier of WEATHER_TIERS) {
      const res = await ctx.runAction(internal.weatherArchive.backfillWeatherCells, { tier });
      tiers.push({ tier, pruned: res.pruned });
    }
    return { tiers };
  },
});

/** One page of bodies, reduced to the distinct cells they occupy. */
export const pageBodyCells = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), tier: literals(WEATHER_TIERS) },
  handler: async (ctx, { cursor, tier }) => {
    const page = await ctx.db
      .query('waterBodies')
      .paginate({ numItems: CELL_BACKFILL_BATCH, cursor });
    const byKey = new Map<
      string,
      { cellKey: string; lat: number; lng: number; elevationM?: number; bodyCount: number }
    >();
    for (const body of page.page) {
      if (body.removedAt) continue;
      const cell = bodyWeatherCell(body, tier);
      const existing = byKey.get(cell.key);
      if (existing) {
        existing.bodyCount += 1;
        continue;
      }
      const entry: {
        cellKey: string;
        lat: number;
        lng: number;
        elevationM?: number;
        bodyCount: number;
      } = { cellKey: cell.key, lat: cell.lat, lng: cell.lng, bodyCount: 1 };
      if (cell.elevationM !== undefined) entry.elevationM = cell.elevationM;
      byKey.set(cell.key, entry);
    }
    return {
      cells: [...byKey.values()],
      cursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
    };
  },
});

/**
 * One page of `waterBodySubAreas` → the distinct cells their weather points occupy.
 *
 * ## ⚠ Why a bay has to be registered at all
 *
 * The registry drives two things: the corpus-wide `filter` sweep and the gap repair on both tiers.
 * A bay's cell is keyed off the bay's own point (`subAreaWeatherCell`), and on a giant that is a
 * different cell from the parent's anchor — Champlain's ten bays land in ten Tier-A cells and seven
 * Tier-B cells, none of them the anchor's. A mid-lake bay like Broad Lake can sit in a cell that
 * contains **no body's anchor at all**, so a bodies-only walk never registers it: the Tier-B sweep
 * never fills it (the spread has a hole exactly where a reader looks), and a browse-tier day the
 * panel lost is never refetched, never borrowed and never even recorded missing — the same
 * unreachable-ladder shape `maybeSweepGaps` had for the browse tier before PR #48's review.
 *
 * ~128 rows today against ~25,000 bodies, so this pass is a rounding error on the walk's cost.
 * Parents are read once per page (`ctx.db.get`, memoised), for the elevation band only.
 */
export const pageSubAreaCells = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), tier: literals(WEATHER_TIERS) },
  handler: async (ctx, { cursor, tier }) => {
    const page = await ctx.db
      .query('waterBodySubAreas')
      .paginate({ numItems: CELL_BACKFILL_BATCH, cursor });
    const parents = new Map<string, { elevationM?: number } | null>();
    const byKey = new Map<
      string,
      { cellKey: string; lat: number; lng: number; elevationM?: number; bodyCount: number }
    >();
    for (const subArea of page.page) {
      if (subArea.removedAt !== undefined) continue;
      let parent = parents.get(subArea.waterBodyId);
      if (parent === undefined) {
        const row = await ctx.db.get(subArea.waterBodyId);
        parent = row && !row.removedAt ? { elevationM: row.elevationM } : null;
        parents.set(subArea.waterBodyId, parent);
      }
      // A bay whose lake is gone is not a place anyone can open.
      if (parent === null) continue;
      const cell = subAreaWeatherCell(subArea, parent, tier);
      const existing = byKey.get(cell.key);
      if (existing) {
        existing.bodyCount += 1;
        continue;
      }
      const entry: {
        cellKey: string;
        lat: number;
        lng: number;
        elevationM?: number;
        bodyCount: number;
      } = { cellKey: cell.key, lat: cell.lat, lng: cell.lng, bodyCount: 1 };
      if (cell.elevationM !== undefined) entry.elevationM = cell.elevationM;
      byKey.set(cell.key, entry);
    }
    return {
      cells: [...byKey.values()],
      cursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
    };
  },
});

/** One page of a registry walk, whichever table it came from. Named so the inline loop above can be typed without the circular inference `internal.*` invites inside its own file. */
type CellPage = {
  cells: { cellKey: string; lat: number; lng: number; elevationM?: number; bodyCount: number }[];
  cursor: string | null;
  isDone: boolean;
  scanned: number;
};

/** Upsert a batch of cells. `bodyCount` accumulates across pages, since a cell can straddle one. */
export const upsertWeatherCells = internalMutation({
  args: {
    tier: literals(WEATHER_TIERS),
    runId: v.string(),
    nowMs: v.number(),
    cells: v.array(
      v.object({
        cellKey: v.string(),
        lat: v.number(),
        lng: v.number(),
        elevationM: v.optional(v.number()),
        bodyCount: v.number(),
      }),
    ),
  },
  handler: async (ctx, { tier, runId, nowMs, cells }): Promise<{ superseded: boolean }> => {
    // ⚠ Checked here rather than in the action so the claim and the write share one transaction: a
    // run that reads "still mine", then gets displaced, then writes would resurrect rows the winner
    // has already pruned.
    const claim = await ctx.db
      .query('weatherCellSyncs')
      .withIndex('by_tier', (q) => q.eq('tier', tier))
      .unique();
    if (claim && claim.runId !== runId) return { superseded: true };

    for (const cell of cells) {
      const existing = await ctx.db
        .query('weatherCells')
        .withIndex('by_key', (q) => q.eq('cellKey', cell.cellKey))
        .first();
      if (existing) {
        // A cell can straddle a page boundary, so counts *accumulate* within a run and are *replaced*
        // by a later one. The discriminator is the run id, not the clock: two runs in the same
        // millisecond both read as "same run" under a timestamp comparison and double-count every
        // body — which is exactly what the registry test caught.
        const sameRun = existing.runId === runId;
        await ctx.db.patch(existing._id, {
          ...cell,
          tier,
          runId,
          bodyCount: sameRun ? existing.bodyCount + cell.bodyCount : cell.bodyCount,
          updatedAt: nowMs,
        });
        continue;
      }
      await ctx.db.insert('weatherCells', { ...cell, tier, runId, updatedAt: nowMs });
    }
    return { superseded: false };
  },
});

/** A page of registered cells for a tier, ordered by key so a batched sweep resumes cleanly. */
export const pageTierCells = internalQuery({
  args: { tier: literals(WEATHER_TIERS), afterKey: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, { tier, afterKey, limit }) => {
    const q = ctx.db
      .query('weatherCells')
      .withIndex('by_tier_key', (ix) =>
        afterKey === undefined ? ix.eq('tier', tier) : ix.eq('tier', tier).gt('cellKey', afterKey),
      );
    const cells = await q.take(limit);
    return cells.map((c) => ({
      cellKey: c.cellKey,
      lat: c.lat,
      lng: c.lng,
      ...(c.elevationM !== undefined ? { elevationM: c.elevationM } : {}),
    }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Writing days for a cell
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fetch and store `pastDays` of history for one cell. Returns the number of days written, or `null`
 * when the fetch failed (so a caller can distinguish "nothing to store" from "could not ask").
 *
 * When `tier` is `browse` the raw hours are stored too — see {@link upsertWeatherHours}. The `filter`
 * sweep deliberately discards them: nothing corpus-wide asks an hourly question, and keeping them
 * would write ~3,000 rows a day for ever to serve a chart nobody opened.
 *
 * ⚠ **`hourlyDays` bounds the hourly write independently of the daily one, and the two really are
 * different questions.** D153's lazy backfill pulls the 92-day ceiling because a *daily* row is
 * cheap, permanent and exactly what a later climatology wants. An *hourly* row is ~24 records, is
 * never swept either, and serves one chart with a bounded window — so a first touch was writing 93
 * hourly documents (~2,200 hour records in a single mutation) to draw thirty days. Callers that know
 * how far the chart can pan pass that, and the rest keep everything they fetched.
 */
export async function ingestCellDays(
  ctx: ActionCtx,
  tier: WeatherTier,
  cell: WeatherCell,
  pastDays: number,
  options: { hourlyDays?: number } = {},
): Promise<number | null> {
  const batch = await fetchLocalHourly(ctx, cell, pastDays);
  if (batch === null) return null;
  const days = summarizeWeatherDays(batch.hours);
  if (days.length === 0) return 0;
  await ctx.runMutation(internal.weatherArchive.upsertWeatherDays, {
    cellKey: cell.key,
    tier,
    source: 'forecast',
    fetchedAt: Date.now(),
    ...(batch.utcOffsetSeconds === null ? {} : { utcOffsetSeconds: batch.utcOffsetSeconds }),
    ...(batch.timeZone === null ? {} : { timeZone: batch.timeZone }),
    days: days.map((d) => ({ dayMs: d.dayMs, localDate: d.localDate, ...storableDay(d) })),
  });
  if (tier === 'browse') {
    const grouped = groupHoursByDay(batch.hours);
    // Newest-first trim, +1 for the forecast day the request always carries: the chart reads
    // backwards from today, so if anything has to be dropped it is the far end of the window.
    const hourly =
      options.hourlyDays === undefined
        ? grouped
        : grouped.slice(-Math.max(1, Math.ceil(options.hourlyDays) + 1));
    await ctx.runMutation(internal.weatherArchive.upsertWeatherHours, {
      cellKey: cell.key,
      fetchedAt: Date.now(),
      days: hourly,
    });
  }
  return days.length;
}

/**
 * Bumped whenever `storableHour` starts persisting a **new field**.
 *
 * ⚠ **Without this, adding an hourly measure is silently a no-op on every cell anyone has already
 * opened.** The panel's top-up only refetches when it is short of *rows*, so a cell holding thirty
 * complete hourly rows is considered satisfied for ever — and a row written last week simply lacks
 * whatever field was added this week. Nothing errors; the feature just never appears, and only on the
 * popular lakes, which are the last place anyone would look for it.
 *
 * This is the second time that shape has come up in this workstream (the first was hourly rows
 * missing entirely), so it is fixed at the root rather than by hand: a row stamped with an older
 * version counts as stale, and the next drawer-open rewrites it from a fetch it was going to make
 * anyway. **Adding a field to `storableHour` without bumping this is the bug.**
 *
 * - 1: the original set (temperature, precipitation, rain, snow, depth, wind speed, shortwave, code)
 * - 2: `windDirectionDeg`, for the scrub readout's compass bearing
 */
export const HOURLY_ROW_VERSION = 2;

/** The hourly fields `weatherHours` stores, dropped to exactly what the timeline draws. */
function storableHour(h: LocalHourlyWeather): Record<string, number> {
  const out: Record<string, number> = { localHour: h.localHour, temperatureC: h.temperatureC };
  const put = (k: string, val: number | undefined) => {
    if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
  };
  put('precipitationMm', h.precipitationMm);
  put('rainMm', h.rainMm);
  put('snowfallCm', h.snowfallCm);
  put('snowDepthM', h.snowDepthM);
  put('windSpeedKph', h.windSpeedKph);
  put('windDirectionDeg', h.windDirectionDeg);
  put('shortwaveWm2', h.shortwaveWm2);
  put('weatherCode', h.weatherCode);
  return out;
}

/**
 * The offset a specific stored date was on, preferring the zone over the response's single number.
 *
 * Returns a spreadable fragment so a caller can stay a one-liner: `{}` would drop the field, which is
 * wrong — an absent offset is a different thing from a fallback one.
 */
function zoneOffsetFor(
  dayMs: number,
  timeZone: string,
  responseOffset: number | undefined,
): { utcOffsetSeconds: number } | Record<string, never> {
  const exact = utcOffsetSecondsInZone(dayMs, timeZone);
  if (exact !== null) return { utcOffsetSeconds: exact };
  return responseOffset === undefined ? {} : { utcOffsetSeconds: responseOffset };
}

/**
 * Bucket a run of local-stamped hours into one payload per local calendar day.
 *
 * ⚠ **Groups on the hour's own `localDate` string**, never by dividing a timestamp. That is the same
 * rule the day reducer follows and for the same reason: a response carries one `utc_offset_seconds`
 * for its whole span, and both DST transitions fall inside a skating season, so arithmetic on a
 * shifted timestamp misfiles an hour on either side of the change.
 */
function groupHoursByDay(
  hours: readonly LocalHourlyWeather[],
): { dayMs: number; localDate: string; hours: Record<string, number>[] }[] {
  const byDate = new Map<
    string,
    { dayMs: number; localDate: string; hours: Record<string, number>[] }
  >();
  for (const h of hours) {
    const dayMs = localDateToDayMs(h.localDate);
    if (dayMs === null) continue; // a misfiled day is worse than a missing one
    let entry = byDate.get(h.localDate);
    if (!entry) {
      entry = { dayMs, localDate: h.localDate, hours: [] };
      byDate.set(h.localDate, entry);
    }
    entry.hours.push(storableHour(h));
  }
  return [...byDate.values()].sort((a, b) => a.dayMs - b.dayMs);
}

/**
 * Upsert a cell's hourly rows — **idempotent on `(cellKey, dayMs)`**, like its daily twin.
 *
 * The idempotence matters for the same reason it does there: today's row is partial when written and
 * is rewritten tomorrow, and the panel's top-up re-requests days it already holds. A whole day is
 * *replaced* rather than merged, because a re-fetch of a past day returns the same hours plus any
 * that were missing, and merging two versions of an hour has no defined winner.
 */
export const upsertWeatherHours = internalMutation({
  args: {
    cellKey: v.string(),
    fetchedAt: v.number(),
    days: v.array(
      v.object({
        dayMs: v.number(),
        localDate: v.string(),
        hours: v.array(v.record(v.string(), v.number())),
      }),
    ),
  },
  handler: async (ctx, a) => {
    for (const day of a.days) {
      const doc = {
        cellKey: a.cellKey,
        dayMs: day.dayMs,
        localDate: day.localDate,
        version: HOURLY_ROW_VERSION,
        // Cast because the record validator above accepts the loose shape `storableHour` produces;
        // the table's own validator is what actually pins the field names, and it runs on write.
        hours: day.hours as unknown as { localHour: number; temperatureC: number }[],
        fetchedAt: a.fetchedAt,
      };
      const existing = await ctx.db
        .query('weatherHours')
        .withIndex('by_cell_day', (q) => q.eq('cellKey', a.cellKey).eq('dayMs', day.dayMs))
        .first();
      if (existing) await ctx.db.patch(existing._id, doc);
      else await ctx.db.insert('weatherHours', doc);
    }
  },
});

/**
 * Which of these days the cell holds hourly rows for.
 *
 * ⚠ **The query that stops a silent permanent blank.** `getWeatherDaysForBody` only refetches when
 * it is short of *daily* rows, so every cell someone had already opened before this workstream —
 * which is every popular lake — would have satisfied that test for ever and never once written an
 * hourly row. The chart would have been empty exactly where the app is most used, with no error
 * anywhere. The panel's top-up now asks this too.
 */
export const listCellHourDayKeys = internalQuery({
  args: { cellKey: v.string(), fromMs: v.number(), toMs: v.number() },
  handler: async (ctx, { cellKey, fromMs, toMs }) => {
    const rows = await ctx.db
      .query('weatherHours')
      .withIndex('by_cell_day', (q) =>
        q.eq('cellKey', cellKey).gte('dayMs', fromMs).lte('dayMs', toMs),
      )
      .collect();
    // Only days that actually carry hours AND were written by the current writer. An empty array
    // would satisfy a presence test while drawing nothing; an out-of-date row satisfies it while
    // missing whatever field was added since. Both are the same failure at different depths.
    return rows
      .filter((r) => r.hours.length > 0 && (r.version ?? 1) >= HOURLY_ROW_VERSION)
      .map((r) => r.dayMs);
  },
});

/** A cell's hourly rows over a day range, ascending — the timeline's read. */
export const readCellHourRange = internalQuery({
  args: { cellKey: v.string(), fromMs: v.number(), toMs: v.number() },
  handler: async (ctx, { cellKey, fromMs, toMs }) => {
    const rows = await ctx.db
      .query('weatherHours')
      .withIndex('by_cell_day', (q) =>
        q.eq('cellKey', cellKey).gte('dayMs', fromMs).lte('dayMs', toMs),
      )
      .collect();
    return rows
      .sort((a, b) => a.dayMs - b.dayMs)
      .map((r) => ({ dayMs: r.dayMs, localDate: r.localDate, hours: r.hours }));
  },
});

/**
 * The Tier-B sweep: append recent days for every registered `filter` cell, one batch at a time,
 * rescheduling itself until the tier is done.
 *
 * ⚠ **Batched because neither a Convex action's time limit nor Open-Meteo's daily budget survives
 * 3,043 sequential fetches in one call.** The batch-and-reschedule shape is N6d's `backfillCells`
 * pattern (24,961 bodies in 84 batches) rather than a new invention.
 *
 * ⚠ **Season-gated by its caller, not here (D161).** The cheap 25-site checker decides when a season
 * is open and starts this; running it year-round would spend ~43% of the annual free-tier budget
 * mostly in July, asking frozen-lake questions about warm water. This function does what it is told.
 */
export const refreshTierDays = internalAction({
  args: {
    tier: literals(WEATHER_TIERS),
    afterKey: v.optional(v.string()),
    pastDays: v.optional(v.number()),
  },
  handler: async (ctx, { tier, afterKey, pastDays }): Promise<{ done: boolean; cells: number }> => {
    const cells = await ctx.runQuery(internal.weatherArchive.pageTierCells, {
      tier,
      ...(afterKey === undefined ? {} : { afterKey }),
      limit: CELL_BATCH_SIZE,
    });
    if (cells.length === 0) return { done: true, cells: 0 };

    let lastKey = afterKey;
    for (const cell of cells) {
      lastKey = cell.cellKey;
      // Per-cell isolation: one cell's transport failure must not abandon the rest of the batch, and
      // the gap sweep will come back for whatever this missed.
      try {
        await ingestCellDays(
          ctx,
          tier,
          { key: cell.cellKey, ...cell },
          pastDays ?? APPEND_PAST_DAYS,
        );
      } catch (err) {
        console.warn(`weatherArchive: cell ${cell.cellKey} failed`, err);
      }
    }

    if (cells.length === CELL_BATCH_SIZE && lastKey !== undefined) {
      await ctx.scheduler.runAfter(0, internal.weatherArchive.refreshTierDays, {
        tier,
        afterKey: lastKey,
        ...(pastDays === undefined ? {} : { pastDays }),
      });
      return { done: false, cells: cells.length };
    }
    return { done: true, cells: cells.length };
  },
});

/**
 * Find and repair holes in what we hold (D161's ladder).
 *
 * Runs over one tier's cells in batches, looking only inside `GAP_SWEEP_DAYS` so step 1 — refetch
 * from the forecast endpoint — can always serve. **A cell with no rows at all is skipped, not
 * backfilled**: an untouched cell has no gap, it has never been asked about, and treating absence as
 * a hole would turn the sweep into a corpus-wide backfill nobody requested.
 */
export const sweepWeatherDayGaps = internalAction({
  args: { tier: literals(WEATHER_TIERS), afterKey: v.optional(v.string()) },
  handler: async (ctx, { tier, afterKey }): Promise<{ done: boolean; repaired: number }> => {
    const now = Date.now();
    const today = todayKey(now);
    // Yesterday is the newest day worth judging: today's row is legitimately partial until tomorrow.
    const toMs = today - DAY_MS;
    const fromMs = toMs - (GAP_SWEEP_DAYS - 1) * DAY_MS;

    const cells = await ctx.runQuery(internal.weatherArchive.pageTierCells, {
      tier,
      ...(afterKey === undefined ? {} : { afterKey }),
      limit: CELL_BATCH_SIZE,
    });
    if (cells.length === 0) return { done: true, repaired: 0 };

    let repaired = 0;
    let lastKey = afterKey;
    for (const cell of cells) {
      lastKey = cell.cellKey;
      const held = await ctx.runQuery(internal.weatherArchive.listCellDayKeys, {
        cellKey: cell.cellKey,
        fromMs,
        toMs,
      });
      if (held.present.length === 0 && held.missing.length === 0) continue; // never touched

      const have = new Set(held.present);
      const holes: number[] = [];
      // Only inside the cell's own known range — a cell first touched a week ago is not missing the
      // three weeks before that.
      const earliest = Math.min(...held.present, ...held.missing);
      for (let d = Math.max(fromMs, earliest); d <= toMs; d += DAY_MS) {
        if (!have.has(d)) holes.push(d);
      }
      if (holes.length === 0) continue;

      // Step 1: refetch. One request covers every hole in the window, so ask once and widely rather
      // than per hole.
      const spanDays = Math.ceil((toMs - Math.min(...holes)) / DAY_MS) + 2;
      try {
        await ingestCellDays(ctx, tier, { key: cell.cellKey, ...cell }, spanDays);
      } catch (err) {
        console.warn(`weatherArchive: gap refetch for ${cell.cellKey} threw`, err);
      }

      const after = await ctx.runQuery(internal.weatherArchive.listCellDayKeys, {
        cellKey: cell.cellKey,
        fromMs,
        toMs,
      });
      // Built once, not once per hole — the Set was being reconstructed inside the predicate.
      const recovered = new Set(after.present);
      const stillMissing = holes.filter((d) => !recovered.has(d));
      repaired += holes.length - stillMissing.length;

      if (stillMissing.length > 0) {
        // Step 2 (borrow the coarser tier) applies only to `browse`; `filter` has no parent, and step
        // 3 (ERA5, past 92 days) is deferred — so `filter` goes straight to step 4. Recording the gap
        // is what keeps a D159 predicate from reading an absent day as "no snow fell".
        //
        // ⚠ **The borrow reports *which* days it filled, not how many.** The parent holds an
        // arbitrary subset of the holes, so subtracting a count off the front of `stillMissing`
        // would mark the wrong days: a parent that covered only the newest hole would leave the
        // oldest one silently unrecorded — the precise failure step 4 exists to prevent.
        const borrowed = tier === 'browse' ? await borrowFromFilter(ctx, cell, stillMissing) : [];
        const borrowedDays = new Set(borrowed);
        const unrecovered = stillMissing.filter((d) => !borrowedDays.has(d));
        if (unrecovered.length > 0) {
          await ctx.runMutation(internal.weatherArchive.writeMissingDays, {
            cellKey: cell.cellKey,
            tier,
            dayMs: unrecovered,
            fetchedAt: now,
          });
        }
        repaired += borrowed.length;
      }
    }

    if (cells.length === CELL_BATCH_SIZE && lastKey !== undefined) {
      await ctx.scheduler.runAfter(0, internal.weatherArchive.sweepWeatherDayGaps, {
        tier,
        afterKey: lastKey,
      });
      return { done: false, repaired };
    }
    return { done: true, repaired };
  },
});

/**
 * Step 2 of the ladder: fill a `browse` cell's missing days from its coarser `filter` parent.
 *
 * Coarser and honest about it — the copied row is stored with `source: 'borrowed'`, so a reader can
 * tell the difference between "5 km resolution" and "11 km resolution wearing a 5 km label".
 *
 * Returns **the day keys it actually filled**, not a count: the parent holds an arbitrary subset of
 * the asked-for days, so a count tells the caller nothing about *which* holes remain.
 */
async function borrowFromFilter(
  ctx: ActionCtx,
  cell: { cellKey: string; lat: number; lng: number },
  days: number[],
): Promise<number[]> {
  const parent = weatherCellFor('filter', cell.lat, cell.lng);
  const rows = await ctx.runQuery(internal.weatherArchive.readCellDays, {
    cellKey: parent.key,
    dayMs: days,
  });
  if (rows.length === 0) return [];
  await ctx.runMutation(internal.weatherArchive.upsertWeatherDays, {
    cellKey: cell.cellKey,
    tier: 'browse',
    source: 'borrowed',
    fetchedAt: Date.now(),
    days: rows,
  });
  return rows.map((r) => r.dayMs);
}

/**
 * The measure fields a day row carries, as a list — used to copy a row between cell keys without
 * naming twenty fields twice, and without a spread that would drag `_id`/`tier`/`source` along with
 * it (which is how a borrowed row would end up claiming to be a `forecast` one).
 */
const DAY_MEASURE_KEYS = [
  'hours',
  'minTempC',
  'maxTempC',
  'meanTempC',
  'nightMinTempC',
  'hoursBelowFreezing',
  'hoursAboveFreezing',
  'freezingDegreeHours',
  'thawDegreeHours',
  'precipitationMm',
  'rainMm',
  'snowfallCm',
  'maxSnowDepthM',
  'hoursOfSun',
  'insolationWhM2',
  'absorbedInsolationWhM2',
  'sunlitThawHours',
  'meltIndexMm',
  'maxWindKph',
  'maxWindGustKph',
  'windRunKm',
  'freezingHoursMeanWindKph',
  'freezingHoursMaxWindKph',
] as const;

/** One day, shaped exactly as `upsertWeatherDays` accepts it. */
export interface StoredDayPayload {
  dayMs: number;
  localDate: string;
  windSectorHours?: number[];
  [measure: string]: number | number[] | string | undefined;
}

/** Read specific days for a cell, shaped for re-writing under another key. */
export const readCellDays = internalQuery({
  args: { cellKey: v.string(), dayMs: v.array(v.number()) },
  handler: async (ctx, { cellKey, dayMs }): Promise<StoredDayPayload[]> => {
    const out: StoredDayPayload[] = [];
    for (const day of dayMs) {
      const row = await ctx.db
        .query('weatherDays')
        .withIndex('by_cell_day', (q) => q.eq('cellKey', cellKey).eq('dayMs', day))
        .first();
      if (!row || row.missing === true) continue;
      const payload: StoredDayPayload = { dayMs: row.dayMs, localDate: row.localDate };
      for (const key of DAY_MEASURE_KEYS) {
        const value = row[key];
        if (typeof value === 'number') payload[key] = value;
      }
      if (row.windSectorHours !== undefined) payload.windSectorHours = row.windSectorHours;
      out.push(payload);
    }
    return out;
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Days held for a cell in `[fromMs, toMs]`, ascending, gaps included so a caller can see them. */
export const readCellDayRange = internalQuery({
  args: { cellKey: v.string(), fromMs: v.number(), toMs: v.number() },
  handler: async (ctx, { cellKey, fromMs, toMs }) => {
    const rows = await ctx.db
      .query('weatherDays')
      .withIndex('by_cell_day', (q) =>
        q.eq('cellKey', cellKey).gte('dayMs', fromMs).lte('dayMs', toMs),
      )
      .collect();
    return rows.sort((a, b) => a.dayMs - b.dayMs);
  },
});

// A body resolves to its `browse` cell through `sampleCoverage` below, which reads the same document
// the panel's size caveat needs. There is deliberately no second `bodyBrowseCell` helper: a second
// way to reach a cell is how the four consumers D152 united would drift apart again.

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The season gate (D161)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Is the corpus-wide sweep allowed to run right now?
 *
 * **D161 in one query.** The Tier-B sweep costs ~4,300 weighted Open-Meteo calls a day; run
 * year-round that is ~1.57M against a free ceiling of ~3.65M — roughly 43% of the annual budget, most
 * of it spent in July asking frozen-lake questions about warm water. The Google Group corpus puts 97%
 * of a season's activity in November–March, so gating gives up nothing real.
 *
 * The gate is the **existing 25-site checker's recorded verdict** (`imageryIngestSeasons`), which
 * costs ~365 calls a year and already runs daily. Two notes on the shape:
 *
 * - **Pull, not push.** D161 describes the checker "starting" the sweep; reading its verdict is the
 *   same dependency inverted, and strictly more robust — a missed cron tick cannot lose a start
 *   signal that is re-derived every day. It also leaves `maybeCheckSeasonOpen` untouched, which
 *   matters because that function carries a documented circular-type landmine.
 * - **⚠ Never re-derive "the season has begun" from cell weather.** A single cold cell in an
 *   Adirondack hollow in early November is weather, not a season. The gate wants the coarse, boring,
 *   region-wide signal precisely because it is hard to fool.
 *
 * ## ⚠ The gate has two edges, and for one PR it only had one
 *
 * Opening on `opensOn` and never closing meant the sweep ran from mid-November to the July season
 * rollover — ~228 days against the ~151 D161 was costed on, quietly spending most of the saving the
 * gate exists to make. The close is `closesOn`, recorded by the same checker (ten consecutive days
 * with no overnight freeze at any ordinary site).
 *
 * **The close is deliberately reluctant, and this consumer wants that.** It lands roughly two weeks
 * after a typical Vermont ice-out. Closing early would blind discovery during the last skateable
 * weeks of the season — exactly when the ice is most marginal and a skater most wants to know what
 * the weather has done to it — to save a few thousand calls against a budget with 2 M spare.
 */
export const isSweepSeasonOpen = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, { nowMs }) => {
    const season = archiveSeasonAt(nowMs);
    const record = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    return {
      season,
      open: record?.opensOn !== undefined && record.closesOn === undefined,
      opensOn: record?.opensOn ?? null,
      closesOn: record?.closesOn ?? null,
    };
  },
});

/**
 * The daily Tier-B tick: gate on the season, then start the batched sweep.
 *
 * Thin on purpose. The sweep itself (`refreshTierDays`) knows nothing about seasons, so it stays
 * callable by hand for an operator backfill out of season.
 */
export const maybeRefreshFilterTier = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ started: boolean; season: string; pastDays?: number; reason?: string }> => {
    const now = Date.now();
    const gate = await ctx.runQuery(internal.weatherArchive.isSweepSeasonOpen, { nowMs: now });
    if (!gate.open) {
      return {
        started: false,
        season: gate.season,
        reason: gate.closesOn === null ? 'season not open' : `season closed ${gate.closesOn}`,
      };
    }

    // ⚠ **Self-heal an empty registry before sweeping it.** `refreshTierDays` pages `weatherCells`,
    // so on a fresh deployment — or any deployment where the weekly reconciler has not run yet — it
    // would page zero cells, return `done: true`, and report a perfectly healthy tick that fetched
    // nothing at all. Waiting up to a week for `maybeSyncWeatherCells` would mean a week of an empty
    // archive at the exact moment the season opens.
    if (await ctx.runQuery(internal.weatherArchive.tierRegistryEmpty, { tier: 'filter' })) {
      console.warn(
        '[weatherArchive] filter registry empty at sweep time — backfilling cells inline. ' +
          'This should normally have been done by the weekly maybeSyncWeatherCells.',
      );
      await ctx.runAction(internal.weatherArchive.backfillWeatherCells, { tier: 'filter' });
      if (await ctx.runQuery(internal.weatherArchive.tierRegistryEmpty, { tier: 'filter' })) {
        // A corpus with no listed bodies is the only honest way to reach here, and it is worth
        // saying out loud rather than sweeping zero cells in silence every day for ever.
        console.error('[weatherArchive] registry still empty after backfill — corpus has no cells');
        return { started: false, season: gate.season, reason: 'cell registry empty' };
      }
    }

    // Cold start? Yesterday is the newest day the sweep would ever have completed, so its absence
    // means this tier holds nothing current — a season that just opened, or a sweep that has been
    // down long enough for the gap ladder not to help. Reach back a fortnight instead of three days,
    // which costs the same single Open-Meteo billing unit. See `SEASON_OPEN_PAST_DAYS`.
    const cold = !(await ctx.runQuery(internal.weatherArchive.tierHasDay, {
      tier: 'filter',
      dayMs: todayKey(now) - DAY_MS,
    }));
    const pastDays = cold ? SEASON_OPEN_PAST_DAYS : APPEND_PAST_DAYS;

    // **Runs the first batch inline rather than scheduling it.** The sweep reschedules its own
    // remaining batches either way, so this costs exactly one batch of the same work the scheduled
    // version would have done — and in exchange the tick reports what actually happened instead of
    // only that it asked for something to happen.
    await ctx.runAction(internal.weatherArchive.refreshTierDays, { tier: 'filter', pastDays });
    return { started: true, season: gate.season, pastDays };
  },
});

/**
 * Does this tier hold anything at all for a given day? The cold-start test for
 * {@link SEASON_OPEN_PAST_DAYS}.
 *
 * `.first()` rather than a count: the question is existence, and counting a corpus-wide day would
 * read 3,043 rows to answer a boolean.
 */
export const tierHasDay = internalQuery({
  args: { tier: literals(WEATHER_TIERS), dayMs: v.number() },
  handler: async (ctx, { tier, dayMs }) => {
    const row = await ctx.db
      .query('weatherDays')
      .withIndex('by_tier_day', (q) => q.eq('tier', tier).eq('dayMs', dayMs))
      .first();
    return row !== null;
  },
});

/**
 * The daily gap sweep, same gate and same reasoning.
 *
 * ⚠ **Both tiers, and the `browse` half is not optional.** `maybeSyncWeatherCells` registers `browse`
 * cells expressly so this can page them, and step 2 of D161's recovery ladder
 * (`borrowFromFilter`) only ever applies to `browse` — sweeping `filter` alone left the ladder's
 * middle rung unreachable in production and left every hole in a drawer-opened cell permanently
 * unrepaired and unrecorded, which is exactly the "an absent day reads as *no snow fell*" failure
 * step 4 exists to prevent.
 *
 * It costs little: the sweep skips any cell it has never fetched for
 * (`present.length === 0 && missing.length === 0`), and a `browse` cell only ever has rows because a
 * person opened that lake. So the browse half is proportional to attention, not to the corpus.
 */
export const maybeSweepGaps = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ started: boolean; season: string; repaired?: Record<string, number> }> => {
    const gate = await ctx.runQuery(internal.weatherArchive.isSweepSeasonOpen, {
      nowMs: Date.now(),
    });
    if (!gate.open) return { started: false, season: gate.season };
    const repaired: Record<string, number> = {};
    for (const tier of WEATHER_TIERS) {
      const res = await ctx.runAction(internal.weatherArchive.sweepWeatherDayGaps, { tier });
      repaired[tier] = res.repaired;
    }
    return { started: true, season: gate.season, repaired };
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The public read (Workstream C's data path)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Days the past-weather panel shows by default. */
export const PANEL_DAYS = 7;

/** One day's raw hours, as `weatherHours` stores them and the timeline consumes them. */
export interface StoredHourDayPayload {
  dayMs: number;
  localDate: string;
  hours: { localHour: number; temperatureC: number; [measure: string]: number }[];
}

export interface WeatherDaysResult {
  days: StoredDayPayload[];
  /**
   * Raw hours for the timeline chart, one entry per day that has them.
   *
   * **Empty is a normal state, not an error.** A cell whose daily rows predate Workstream D serves
   * its hours from the next drawer-open onward; until then the panel falls back to the day summaries
   * it already has. Clients must therefore render the timeline from `hours` and the sentences from
   * `days`, never assume the two cover the same window.
   */
  hours: StoredHourDayPayload[];
  /** Day keys we asked for and could not get. Rendered as gaps, never as zeroes. */
  missingDayMs: number[];
  /**
   * The **lake's** current local day, so a client can tell a settled day from one still happening.
   *
   * ⚠ Served rather than computed on the device: only this side knows the cell's stored
   * `utcOffsetSeconds`, and a phone in another timezone must not get to decide when the day ends at
   * the lake. See `isCompleteDay` in core for what goes wrong without it.
   */
  todayLocalDayMs: number;
  /** True when any returned day came from the coarser `filter` tier (D161 step 2). */
  anyBorrowed: boolean;
  /**
   * True when this body is larger than one weather sample can honestly describe, and only one was
   * taken.
   *
   * **Lake Champlain is 170 km end to end and carries zero `weatherSamplePoints` on dev** — so every
   * reading in its panel comes from one point near the middle, and nothing said so. N2 shipped the
   * suggester and the moderator writer for exactly this and nobody has run it, which is the same
   * reader-with-no-producer shape N6b's `hasContours` had.
   *
   * Until an operator places a grid, the honest move is to **say which claim we are making** — D151's
   * grammar, one sensor over: the subject of the sentence is us, not the lake. Threshold is
   * `spansMultipleSampleCells`, tied to the same `DEFAULT_SAMPLE_SPACING_KM` the suggester uses, so
   * the caveat and the grid can never disagree about what "too big for one point" means.
   */
  oneSampleForALargeBody: boolean;
  /**
   * The place these readings are about — the lake's anchor, or a named bay of it (open question 5).
   * Served back rather than assumed from the request, because the server may have refused a stale
   * `subAreaId` and answered for the lake; the panel labels what it was *given*, never what it asked.
   */
  scope: { kind: 'body' } | { kind: 'subArea'; subAreaId: Id<'waterBodySubAreas'>; name: string };
  /**
   * The body's 16-sector fetch profile in metres, when it has one.
   *
   * Feeds the wind lane's fill density and the scrub readout's open-water clause. Absent on a body
   * that has never been measured; both consumers simply draw and say less.
   */
  fetchProfileM?: number[];
}

/**
 * The past-weather panel's data, for one body.
 *
 * **An action rather than a query, for the reason the strip is one:** a query cannot fetch, so a
 * read-only panel would stay permanently blank on the lakes nobody has opened before — which is most
 * of a 25,000-body corpus and precisely the population D159 exists to make visible.
 *
 * **First touch pulls 92 days, not 7.** D153's finding: `past_days` reaches the Open-Meteo ceiling, so
 * the first person to open a lake in February backfills the whole season to date in one request. Lazy
 * backfill is not lossy, and the days beyond the panel's window are exactly what a later climatology
 * or a widened panel will want — refusing them now would mean paying twice.
 *
 * The resource guard matches `getForecastForBody`: signed-in callers only, and the only
 * client-supplied value is a body id, so the reachable fetch set is one backfill per cell, ever, plus
 * one append per cell per day.
 */
export const getWeatherDaysForBody = action({
  args: {
    waterBodyId: v.id('waterBodies'),
    days: v.optional(v.number()),
    /**
     * The bay this panel is about (N6h / open question 5). Resolved on the client with
     * `resolveWeatherSubArea`; validated here and silently dropped if it is not a live bay of this
     * lake. Absent on the ~99% of bodies that have no bays.
     */
    subAreaId: v.optional(v.id('waterBodySubAreas')),
  },
  handler: async (ctx, { waterBodyId, days, subAreaId }): Promise<WeatherDaysResult | null> => {
    if (!(await ctx.auth.getUserIdentity())) return null;
    // One round-trip, not two: the cell and the coverage caveat both come off the same body document,
    // and loading it twice for one panel is the kind of small waste this repo pays for at corpus scale.
    const info = await ctx.runQuery(internal.weatherArchive.sampleCoverage, {
      waterBodyId,
      ...(subAreaId ? { subAreaId } : {}),
    });
    if (!info) return null;
    const cell = info.cell;

    const utcToday = todayKey(Date.now());
    const span = Math.min(Math.max(1, days ?? PANEL_DAYS), MAX_PAST_DAYS);
    // Read one day wider than the panel needs so the local anchor below has something to resolve
    // against even when the lake's clock is a day behind UTC.
    const readFromMs = utcToday - span * DAY_MS;

    let held = await ctx.runQuery(internal.weatherArchive.readCellDayRange, {
      cellKey: cell.key,
      fromMs: readFromMs,
      toMs: utcToday,
    });
    let toMs = panelAnchorDay(held, utcToday);
    let fromMs = toMs - (span - 1) * DAY_MS;
    const inWindow = (r: { dayMs: number }) => r.dayMs >= fromMs && r.dayMs <= toMs;

    const realDays = held.filter((r) => r.missing !== true && inWindow(r));

    // ⚠ **The hourly rows have to be tested for separately, or they are never written at all.**
    // Before N6h Workstream D this branch keyed only on daily rows, so any cell somebody had already
    // opened satisfied it for ever — the archive was complete, so nothing refetched, so no hourly row
    // was ever created. The timeline would have been permanently blank on exactly the popular lakes,
    // with nothing logged and nothing thrown. It is invisible precisely because the daily half is
    // healthy.
    const heldHourDays = await ctx.runQuery(internal.weatherArchive.listCellHourDayKeys, {
      cellKey: cell.key,
      fromMs: readFromMs,
      toMs: utcToday,
    });
    const hoursShort = heldHourDays.filter((d) => d >= fromMs && d <= toMs).length < span;

    // A cell with nothing at all is a first touch: pull the ceiling. A cell that has *some* of the
    // window is topped up with a short append, which is the cheap common case.
    if (realDays.length === 0) {
      // The daily half takes the 92-day ceiling (D153: lazy backfill is not lossy); the hourly half
      // is bounded to the window this panel can actually draw. See `ingestCellDays`.
      await ingestCellDays(ctx, 'browse', cell, BACKFILL_PAST_DAYS, { hourlyDays: span });
    } else if (realDays.length < span || hoursShort) {
      await ingestCellDays(ctx, 'browse', cell, Math.min(span + 1, MAX_PAST_DAYS), {
        hourlyDays: span,
      });
    }

    if (realDays.length < span) {
      held = await ctx.runQuery(internal.weatherArchive.readCellDayRange, {
        cellKey: cell.key,
        fromMs: readFromMs,
        toMs: utcToday,
      });
      toMs = panelAnchorDay(held, utcToday);
      fromMs = toMs - (span - 1) * DAY_MS;
    }

    const out: StoredDayPayload[] = [];
    const missingDayMs: number[] = [];
    let anyBorrowed = false;
    for (const row of held) {
      if (!inWindow(row)) continue;
      if (row.missing === true) {
        missingDayMs.push(row.dayMs);
        continue;
      }
      if (row.source === 'borrowed') anyBorrowed = true;
      const payload: StoredDayPayload = { dayMs: row.dayMs, localDate: row.localDate };
      for (const key of DAY_MEASURE_KEYS) {
        const value = row[key];
        if (typeof value === 'number') payload[key] = value;
      }
      if (row.windSectorHours !== undefined) payload.windSectorHours = row.windSectorHours;
      out.push(payload);
    }

    // Days the window covers that produced no row at all — distinct from a recorded `missing`, and
    // reported the same way so the panel can draw both as holes rather than silently short-changing
    // a span. (`snowfallTotalCm` over 5 of 7 days is not "less snow", it is less knowledge.)
    const seen = new Set([...out.map((d) => d.dayMs), ...missingDayMs]);
    for (let d = fromMs; d <= toMs; d += DAY_MS) {
      if (!seen.has(d)) missingDayMs.push(d);
    }
    missingDayMs.sort((a, b) => a - b);

    // Read after the top-up above, so a cell that had daily rows but no hourly ones serves its chart
    // on the *same* drawer-open that discovered the shortfall rather than on the next one.
    const hourRows = await ctx.runQuery(internal.weatherArchive.readCellHourRange, {
      cellKey: cell.key,
      fromMs,
      toMs,
    });

    // ⚠ The zone first, and an offset only behind it. A stored offset is the one the *fetch* happened
    // on, so on the far side of a DST change it is an hour out — which near local midnight makes
    // "today" the wrong date and marks a settled day as still in progress, or worse the reverse.
    const zone = [...held].reverse().find((r) => typeof r.timeZone === 'string')?.timeZone;
    const nowMs = Date.now();
    const todayLocalDayMs =
      (zone === undefined ? null : localDayMsInZone(nowMs, zone)) ??
      localDayMsAt(
        nowMs,
        [...held].reverse().find((r) => typeof r.utcOffsetSeconds === 'number')?.utcOffsetSeconds ??
          approximateUtcOffsetSeconds(cell.lng),
      );

    return {
      days: out,
      hours: hourRows,
      missingDayMs,
      todayLocalDayMs,
      anyBorrowed,
      oneSampleForALargeBody: info.oneSampleForALargeBody,
      scope: info.scope,
      ...('fetchProfileM' in info && info.fetchProfileM
        ? { fetchProfileM: info.fetchProfileM }
        : {}),
    };
  },
});

/**
 * The newest day this cell can honestly be asked about.
 *
 * ⚠ **`todayKey` is a UTC day; `dayMs` is the lake's LOCAL date.** Between UTC midnight and the
 * lake's own midnight — 00:00–05:00 UTC, which is 7 PM to midnight in the Northeast and therefore
 * prime browsing — the newest day the archive *can* hold is UTC-today minus one, because the lake has
 * not reached tomorrow yet. Anchoring the window on UTC-today there costs twice: the panel reports a
 * permanent phantom gap ("1 day of weather unavailable", every evening), and `realDays.length < span`
 * stays true for ever, so **every drawer-open re-fetches Open-Meteo** chasing a day that does not
 * exist. The archive's own test harness hides it, because it mints local dates from the UTC clock.
 *
 * So the anchor is the newest day we actually hold, clamped to at most one day behind UTC — no
 * timezone is further from a UTC date than that, and a cell holding nothing yet (a first touch) falls
 * back to UTC-today until the ingest gives it something to anchor on.
 */
function panelAnchorDay(held: readonly { dayMs: number; missing?: boolean }[], utcToday: number) {
  let newest = Number.NEGATIVE_INFINITY;
  for (const row of held) {
    if (row.missing !== true && row.dayMs > newest) newest = row.dayMs;
  }
  if (!Number.isFinite(newest)) return utcToday;
  return Math.min(utcToday, Math.max(newest, utcToday - DAY_MS));
}

/**
 * Everything the panel needs off the body document, in one read: its `browse` cell, and whether the
 * body is big enough that one weather sample understates the question.
 *
 * The size test reads the bbox rather than the polygon — the question is extent, not shape, and a
 * 40 km river reach and a 40 km lake are equally beyond one reading.
 */
export const sampleCoverage = internalQuery({
  args: { waterBodyId: v.id('waterBodies'), subAreaId: v.optional(v.id('waterBodySubAreas')) },
  handler: async (ctx, { waterBodyId, subAreaId }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return null;

    // **A bay, when the client asked for one and it is really a live bay of this lake.** The client
    // resolves *which* bay (`resolveWeatherSubArea` in core — the route's `?sub=` or the most
    // prominent); this side only refuses an id that is delisted or belongs to another body, and
    // then answers for the lake rather than erroring, because a stale deep link is not a fault a
    // skater can act on. A bay is its own place, so the "one sample for a large body" caveat does
    // not apply to it — that caveat is about the lake.
    if (subAreaId) {
      const subArea = await ctx.db.get(subAreaId);
      if (subArea && subArea.waterBodyId === body._id && subArea.removedAt === undefined) {
        return {
          cell: subAreaWeatherCell(subArea, body, 'browse'),
          scope: { kind: 'subArea' as const, subAreaId: subArea._id, name: subArea.name },
          samplePoints: 1,
          oneSampleForALargeBody: false,
          // ⚠ No fetch profile for a bay. The profile is the *lake's* — cast from its interior point
          // over its whole extent — and Malletts Bay is sheltered where Champlain's 11 miles of
          // south-easterly fetch is not. Drawing the lake's exposure under a bay's wind would overstate
          // exactly the bays people pick for shelter, so the lane draws flat and the readout says
          // less until a per-bay profile exists.
        };
      }
    }

    const points = body.weatherSamplePoints?.length ?? 0;
    return {
      cell: bodyWeatherCell(body, 'browse'),
      scope: { kind: 'body' as const },
      samplePoints: points,
      oneSampleForALargeBody: points <= 1 && spansMultipleSampleCells(body.bbox),
      // The wind lane's second channel. Read off the body document the panel already loads, so the
      // chart costs no extra round trip — and served raw, because whether a lake is exposed enough
      // for it to mean anything is `fetchIntensityAt`'s call, not this query's.
      ...(Array.isArray(body.fetchProfileM) ? { fetchProfileM: body.fetchProfileM } : {}),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The sub-area spread (open question 5, second half)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Days the spread compares bays over — the same window the panel's sentences describe. */
export const SPREAD_DAYS = PANEL_DAYS;

/**
 * How a giant describes itself: the spread across its named bays, with the ends named
 * (`buildSubAreaSpread` in core). *"Lows 0°F to 12°F — coldest at Missisquoi Bay, mildest at
 * Burlington Bay."*
 *
 * **A query, not an action, and that is the whole cost argument.** It reads the corpus-wide
 * `filter` tier's rows, which the season sweep populates daily for every registered cell — bays
 * included, since the registry's sub-area pass — so ranking ten bays costs no fetch at all on
 * drawer-open, and the panel stays fast. 0.1° is coarse for a *reading* and ample for a *ranking*;
 * the bay the reader then picks gets its own browse-tier reading from `getWeatherDaysForBody`.
 * D152's two tiers, applied to one lake.
 *
 * Bays sharing a Tier-B cell share rows and tie. The in-progress today is dropped per cell using
 * that cell's own zone, and `missing` markers are dropped — the builder then compares every bay over
 * the days they *all* have, so a hole in one bay's record cannot read as "less snow".
 *
 * `null` outside the season and until the first sweep: Tier B is empty, and an empty spread is the
 * honest state rather than a fallback to the browse tier (which would cost a fetch per bay).
 */
export const getSubAreaSpread = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<SubAreaSpread | null> => {
    if (!(await ctx.auth.getUserIdentity())) return null;
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return null;
    const bays = (
      await ctx.db
        .query('waterBodySubAreas')
        .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
        .collect()
    ).filter((s) => s.removedAt === undefined);
    if (bays.length < 2) return null;

    const nowMs = Date.now();
    const utcToday = todayKey(nowMs);
    // Two days wider than the window, not one: the in-progress today is always dropped below, and
    // between UTC midnight and the lake's own midnight (7 PM–midnight in the Northeast) the lake's
    // today is `utcToday - 1`, so the newest *complete* day is `utcToday - 2`. A read that started
    // `SPREAD_DAYS` back then held only `SPREAD_DAYS - 1` complete days, and the sentence flipped
    // between "the last 7 days" and "the last 6 days" every evening. The newest-first slice below
    // trims the surplus in the daytime case.
    const fromMs = utcToday - (SPREAD_DAYS + 1) * DAY_MS;
    // Bays sharing a Tier-B cell share one read.
    const byCell = new Map<string, SpreadBayDay[]>();
    const inputs: SpreadBayInput[] = [];
    for (const bay of bays) {
      const cell = subAreaWeatherCell(bay, body, 'filter');
      let days = byCell.get(cell.key);
      if (days === undefined) {
        const rows = await ctx.db
          .query('weatherDays')
          .withIndex('by_cell_day', (q) =>
            q.eq('cellKey', cell.key).gte('dayMs', fromMs).lte('dayMs', utcToday),
          )
          .collect();
        // The cell's own today, from its own zone — a phone elsewhere must not decide when the day
        // ends at the lake, and a stored offset is the one the fetch happened on (see the panel).
        const zone = [...rows].reverse().find((r) => typeof r.timeZone === 'string')?.timeZone;
        const todayLocal =
          (zone === undefined ? null : localDayMsInZone(nowMs, zone)) ??
          localDayMsAt(
            nowMs,
            [...rows].reverse().find((r) => typeof r.utcOffsetSeconds === 'number')
              ?.utcOffsetSeconds ?? approximateUtcOffsetSeconds(cell.lng),
          );
        days = rows
          .filter((r) => r.missing !== true && isCompleteDay(r.hours, r.dayMs, todayLocal))
          .sort((a, b) => b.dayMs - a.dayMs)
          .slice(0, SPREAD_DAYS)
          .map((r) => ({
            dayMs: r.dayMs,
            nightMinTempC: r.nightMinTempC ?? null,
            minTempC: r.minTempC ?? null,
            snowfallCm: r.snowfallCm ?? null,
          }));
        byCell.set(cell.key, days);
      }
      inputs.push({ subAreaId: bay._id, name: bay.name, days });
    }
    return buildSubAreaSpread(inputs);
  },
});

/**
 * **Operator tool: fill a lake's bay cells at the filter tier, out of season.**
 *
 * The spread reads Tier B, and Tier B is empty until D163's gate opens on a real regional freeze —
 * mid-November, typically. That makes the spread unverifiable on dev for two months of every year,
 * which is how a ranking, its copy and its collapse threshold would otherwise ship against a table
 * nobody can look at. This primes one lake's bays with `pastDays` of real weather so the real panel
 * can be read (founder call, 2026-09-11: Champlain's ~7 Tier-B bay cells, ~7 weighted calls).
 *
 * Metered like every other fetch, and deliberately not reachable from a client: the sweep is the
 * producer in season, and this is a hand tool for the two months it is not.
 */
export const primeSubAreaWeather = internalAction({
  args: { waterBodyId: v.id('waterBodies'), pastDays: v.optional(v.number()) },
  // ⚠ Annotated on purpose: an action that reaches `internal.weatherArchive.*` from inside its own
  // module with an inferred return type is the circular-inference landmine this file already warns
  // about — TypeScript gives up on the whole `api` type and every test in the package loses its types.
  handler: async (
    ctx,
    { waterBodyId, pastDays },
  ): Promise<{ cells: number; days: number; written: Record<string, number | null> }> => {
    const cells: WeatherCell[] = await ctx.runQuery(internal.weatherArchive.subAreaFilterCells, {
      waterBodyId,
    });
    const days = Math.min(MAX_PAST_DAYS, Math.max(1, pastDays ?? SEASON_OPEN_PAST_DAYS));
    const out: Record<string, number | null> = {};
    for (const cell of cells) out[cell.key] = await ingestCellDays(ctx, 'filter', cell, days);
    return { cells: cells.length, days, written: out };
  },
});

/** The distinct filter-tier cells a lake's live bays occupy. */
export const subAreaFilterCells = internalQuery({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<WeatherCell[]> => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return [];
    const bays = await ctx.db
      .query('waterBodySubAreas')
      .withIndex('by_parent', (q) => q.eq('waterBodyId', waterBodyId))
      .collect();
    const byKey = new Map<string, WeatherCell>();
    for (const bay of bays) {
      if (bay.removedAt !== undefined) continue;
      const cell = subAreaWeatherCell(bay, body, 'filter');
      byKey.set(cell.key, cell);
    }
    return [...byKey.values()];
  },
});
