/**
 * **The sentinels' overnight lows, this season** (B01-2b, D275) — the Overview Home's *Overnight Lows
 * at the Sentinels* row: each sentinel's stored low for every night from the season's floor (1 October
 * by default) to the last night stored, the two lines the row draws (the watch's freezing line and the
 * imagery line, from the settings that decided the season), and the two nights the season record
 * marks — the watch's opening and the first imagery-line night — as the record stored them.
 *
 * ## ⚠ Air temperature at three named sites, never ice (D3)
 *
 * A low is what Open-Meteo measured over a summit pond's coordinate; nothing here says any water froze.
 * The read is the season watch's own store (`seasonWatchSeries`) read back unchanged: the dates are the
 * calendar days the watch already cut (`dailyLowsFromOpenMeteo`, the site's own zone), the values its °C.
 * A night with no stored low is `null` — a gap, never zero and never filled in.
 *
 * ## One bounded read
 *
 * At most: the season record, the current settings, and per sentinel (ten at most) its merge chain
 * (eight hops, the cron's `resolveSurvivor` rule) and its one stored series — each read through one
 * `ReadBudget` (12 MiB of Convex's 16, its calls under 4,096) as the rows really weigh, after
 * reserving each one's worst case. A sentinel the budget can't reach is `unread`, never empty.
 */

import {
  addDaysIso,
  archiveSeasonLabel,
  callerNow,
  DEFAULT_SEASON_WATCH_SETTINGS,
  nightsBetween,
  resolveSeason,
  SENTINEL_LOWS_CAPABILITY,
  type SeasonWatchSettings,
  seasonFloorDate,
  seasonOf,
  seasonStartYear,
} from '@skating/core';
import { v } from 'convex/values';

import type { Doc, Id } from './_generated/dataModel';
import { type QueryCtx, query } from './_generated/server';
import { requireCapability } from './lib/auth';
import { ReadBudget } from './lib/readBudget';
import { newYorkDate } from './lib/seasonWatchEmails';

/** How far the caller's clock may sit from the server's (`callerNow`), as the Overview's other reads. */
const CLOCK_SLACK_MS = 5 * 60_000;

/** The cron's merge-chain cap (`lib/bodies.resolveSurvivor`). */
const MERGE_HOPS = 8;

/** One sentinel's row: its name, and its low (°C) for each night of the window; `null` is a gap. */
export type SentinelSeries = {
  /** The roster's id for it (stable across a merge of its body). */
  key: string;
  /** The body the watch stores its lows under — the roster's, or the body it was merged into. */
  bodyId: string | null;
  /** The name the roster holds it by. */
  name: string;
  /**
   * `read`: its stored lows (nights it has none for are `null`). `gone`: its body no longer resolves,
   * so nothing is stored for it. `unread`: the read's budget ran out before it.
   */
  status: 'read' | 'gone' | 'unread';
  lows: Array<number | null>;
};

/** A night the record marks, and the sentinels it names (their bodies' ids, and names). */
export type MarkedNight = {
  on: string;
  sites: Array<{ bodyId: string | null; name: string; lowC: number }>;
};

export type SentinelLows =
  /** Before the season's floor: no night of it has been measured. */
  | { state: 'before'; season: number; countsFrom: string }
  /** The window is open, but nothing is stored for any sentinel (or there is no roster). */
  | { state: 'none'; season: number; countsFrom: string; roster: number }
  | {
      state: 'value';
      season: number;
      countsFrom: string;
      /** The first and last night drawn: the floor, and the last night any sentinel has a low for. */
      firstDate: string;
      lastDate: string;
      sentinels: SentinelSeries[];
      /** The watch's freezing line and the imagery line, °C — from the settings that decided it. */
      lines: { watchC: number; imageryC: number };
      /** The watch's opening night, with the sentinels that fired and how many it watched. */
      opened: (MarkedNight & { of: number }) | null;
      /** The first sentinel night at or below the imagery line, with the sentinels that reached it. */
      imageryLine: MarkedNight | null;
    };

/** The last night of a season's store: 30 June, as the history fill keeps it. */
function seasonLastNight(label: string): string {
  return `${seasonStartYear(label) + 1}-06-30`;
}

/**
 * A series' lows over `[first, last]`, aligned: the stored value for a night it holds, `null` for any
 * other — the store's own gaps and the nights outside what it holds alike. Pure, for the tests.
 */
export function alignLows(
  series: { firstDate: string; lows: ReadonlyArray<number | null> } | null,
  first: string,
  last: string,
): Array<number | null> {
  const nights = nightsBetween(first, last);
  if (series === null || series.firstDate === '') return nights.map(() => null);
  const at = new Map<string, number | null>();
  series.lows.forEach((low, i) => {
    at.set(addDaysIso(series.firstDate, i), low);
  });
  return nights.map((night) => at.get(night) ?? null);
}

/** The last night at or after `first` and at or before `last` that `series` holds a low for. */
export function lastStoredNight(
  series: { firstDate: string; lows: ReadonlyArray<number | null> },
  first: string,
  last: string,
): string | null {
  let found: string | null = null;
  series.lows.forEach((low, i) => {
    if (low === null) return;
    const night = addDaysIso(series.firstDate, i);
    if (night >= first && night <= last && (found === null || night > found)) found = night;
  });
  return found;
}

/** The roster's body, followed through merges as the cron does; `null` when the chain dead-ends. */
async function survivorOf(
  ctx: QueryCtx,
  budget: ReadBudget,
  id: Id<'waterBodies'>,
): Promise<Doc<'waterBodies'> | null | 'unread'> {
  let body = await budget.measured('waterBody', () => ctx.db.get(id));
  if (body === undefined) return 'unread';
  for (let hops = 0; body?.mergedIntoId !== undefined && hops < MERGE_HOPS; hops++) {
    const next: Id<'waterBodies'> = body.mergedIntoId;
    const read: Doc<'waterBodies'> | null | undefined = await budget.measured('waterBody', () =>
      ctx.db.get(next),
    );
    if (read === undefined) return 'unread';
    body = read;
  }
  return body;
}

export async function readSentinelLows(
  ctx: QueryCtx,
  args: { season?: number; now?: number },
): Promise<SentinelLows> {
  const now = callerNow(args.now, Date.now(), CLOCK_SLACK_MS);
  const season = resolveSeason(args.season, seasonOf(now));
  const label = archiveSeasonLabel(season);
  const budget = new ReadBudget();

  const record = await budget.measured('seasonRecord', () =>
    ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', label))
      .unique(),
  );
  const latest = await budget.measured('watchSettings', () =>
    ctx.db.query('seasonWatchSettings').withIndex('by_version').order('desc').first(),
  );
  const settings: SeasonWatchSettings =
    record?.settings ?? latest?.settings ?? DEFAULT_SEASON_WATCH_SETTINGS;
  const countsFrom = seasonFloorDate(label, settings.startMonthDay);
  // The store never holds tonight (`storeSeries` drops a night until it is over), so the window ends
  // at the last night stored, read from the rows rather than the clock; a past season ends with its
  // store, on 30 June.
  const ceiling = seasonLastNight(label);

  const roster = latest?.sentinels ?? [];
  const found: Array<{
    key: string;
    name: string;
    bodyId: string | null;
    status: SentinelSeries['status'];
    series: Doc<'seasonWatchSeries'> | null;
  }> = [];
  for (const site of roster) {
    const body = await survivorOf(ctx, budget, site.waterBodyId);
    if (body === 'unread') {
      found.push({
        key: site.waterBodyId,
        name: site.name,
        bodyId: null,
        status: 'unread',
        series: null,
      });
      continue;
    }
    if (body === null) {
      found.push({
        key: site.waterBodyId,
        name: site.name,
        bodyId: null,
        status: 'gone',
        series: null,
      });
      continue;
    }
    const series = await budget.measured('seasonSeries', () =>
      ctx.db
        .query('seasonWatchSeries')
        .withIndex('by_season_body', (q) => q.eq('season', label).eq('waterBodyId', body._id))
        .unique(),
    );
    found.push({
      key: site.waterBodyId,
      name: site.name,
      bodyId: body._id,
      status: series === undefined ? 'unread' : 'read',
      series: series ?? null,
    });
  }

  const lastDate = found
    .map((f) => (f.series === null ? null : lastStoredNight(f.series, countsFrom, ceiling)))
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  if (lastDate === undefined) {
    // Nothing stored: before the floor (by the watch's own day — the corpus is US Eastern, so New
    // York's date is every site's) no night of the season has been measured; after it, nothing is
    // recorded yet.
    return newYorkDate(now) < countsFrom
      ? { state: 'before', season, countsFrom }
      : { state: 'none', season, countsFrom, roster: roster.length };
  }

  const inWindow = (night: string | undefined) =>
    night !== undefined && night >= countsFrom && night <= lastDate;
  const sitesOf = (
    sites: ReadonlyArray<{ waterBodyId?: Id<'waterBodies'>; name: string; lowC: number }>,
  ) => sites.map((s) => ({ bodyId: s.waterBodyId ?? null, name: s.name, lowC: s.lowC }));

  return {
    state: 'value',
    season,
    countsFrom,
    firstDate: countsFrom,
    lastDate,
    sentinels: found.map((f) => ({
      key: f.key,
      bodyId: f.bodyId,
      name: f.name,
      status: f.status,
      lows: alignLows(f.series, countsFrom, lastDate),
    })),
    lines: { watchC: settings.freezeC, imageryC: settings.imageryNudgeC },
    opened:
      record !== null && record !== undefined && inWindow(record.opensOn)
        ? {
            on: record.opensOn,
            sites: sitesOf(record.opening?.sentinels ?? []),
            of: record.sentinels?.length ?? roster.length,
          }
        : null,
    imageryLine:
      record?.imageryNudgeOn !== undefined && inWindow(record.imageryNudgeOn)
        ? { on: record.imageryNudgeOn, sites: sitesOf(record.imageryNudgeSites ?? []) }
        : null,
  };
}

/**
 * The Overview Home's sentinel row. Gated on `SENTINEL_LOWS_CAPABILITY` — moderators, as D275 has it;
 * the constant is the one line that would keep it to admins. `now` is the caller's clock, the start of
 * its UTC day, so a new night is a new argument rather than a cached answer.
 */
export const forSeason = query({
  args: { season: v.optional(v.number()), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<SentinelLows> => {
    await requireCapability(ctx, SENTINEL_LOWS_CAPABILITY);
    return await readSentinelLows(ctx, args);
  },
});
