/**
 * Watching for the imagery season to open (N6e §C3 / **D149**).
 *
 * > **D149 — Ingest is weather-gated, and the archive turns over on the first frame of the new
 * > season, never on a date.**
 *
 * ## What this does, and the one thing it deliberately does not
 *
 * Once a day from **1 October**, this samples observed overnight lows across the corpus and asks
 * `ingestWindow` — the same gate `pnpm --filter @skating/imagery ingest-window` runs — whether the
 * season has opened. When it has, the verdict is written to `imageryIngestSeasons` and never
 * recomputed for that season.
 *
 * **It does not start a backfill.** Cutting granules spends real money on infrastructure this
 * deployment cannot see, and the gate is a judgement about a season rather than a fact about a row —
 * so the cron's job is to *notice*, and an operator's job is to act on it. That is the same split the
 * CLI already draws: *"Deliberately does not run the selection itself… the operator should see it
 * before a fan-out spends anything."*
 *
 * ## Why October, and not September
 *
 * §C3's summit trigger opens a season when `Upper Lake of the Clouds` (1,531 m, and in the corpus)
 * registers a freeze — which on Mt Washington can happen in *August*. The phase doc reasoned that this
 * was safe because an early gate only wastes granule reads.
 *
 * > **Founder, 2026-08-25:** *"let's start that cron in October instead — I don't think anyone skates
 * > anywhere before November, so an Oct 1 start gives us plenty of time to catch extended freezing
 * > temps long enough to start forming ice anywhere."*
 *
 * So the calendar floor is a **cheap outer bound on nonsense**, not a second gate: it stops the
 * watcher reporting "the season opened" in August because one alpine tarn had a cold night, while
 * still leaving a month of margin before anyone could skate. The weather gate inside it is unchanged
 * and still does all the real work.
 *
 * ## ⚠ The asymmetry that licenses the whole design
 *
 * An over-eager gate costs a few dollars of granule reads. A late one **misses freeze-up entirely** —
 * the single most valuable frame of the season, gone, with nothing to say it was ever there. Every
 * threshold below leans early on purpose, and so does the site sampling.
 */

import { archiveSeasonAt, ingestWindow, type SiteSeries, seasonOf } from '@skating/core';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';

/** §C3's summit trigger, found by name rather than by a hardcoded coordinate. */
const SENTINEL_NAME = 'Upper Lake of the Clouds';

/**
 * How many ordinary bodies to sample alongside the sentinel.
 *
 * Enough that `corpusFraction`'s 10% means "a few sites agreed" rather than "one site is noisy", and
 * small enough that the whole tick is one Open-Meteo request and a bounded read.
 */
const SAMPLE_SITES = 24;

/** Open-Meteo's `past_days` ceiling, matching `weather.ts`. */
const MAX_PAST_DAYS = 92;

/** The month the watcher starts looking, 1-indexed. Founder call — see the module note. */
const START_MONTH = 10;

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/**
 * The sites to sample: the sentinel, plus the most prominent bodies we hold.
 *
 * ⚠ **Bounded reads, deliberately.** The obvious implementation walks `waterBodies` and picks an even
 * spatial stride, which is what the CLI does against the Hilbert-ordered mask file. In Convex that is
 * a full scan of ~25,000 documents and it **exceeds the 16 MB per-function read limit** — measured
 * 2026-08-25, trying exactly that. A search index for the sentinel and one ordered index range for the
 * sample keep this to a few dozen documents.
 *
 * **What that costs, stated plainly:** `by_curated_boost` returns *popular* lakes rather than a
 * spatial grid, and popularity in this corpus skews toward northern New England — so the sample runs
 * slightly colder than the region as a whole and the gate will open a little early. Given the
 * asymmetry above, that is the direction to be wrong in. The CLI's spatially-even sample remains the
 * more rigorous instrument and both feed the identical `ingestWindow`; if this ever needs to be
 * spatially fair, `waterBodyCells` is the index to reach for.
 */
export const gateSites = internalQuery({
  args: {},
  handler: async (ctx) => {
    // ⚠ **A search hit is not the sentinel until its name says so.**
    //
    // `withSearchIndex` ranks by relevance and always answers if *anything* tokenises close enough —
    // so `.take(1)` alone crowns whichever lake scores highest on "lake"/"clouds" and hands it the
    // one privilege no other site has: opening a whole region's season on its own. The corpus holds
    // thousands of bodies with "Lake" in the name, so the wrong one is the likely outcome the day
    // this pond is renamed, merged or purged — and it fails *silently*, because a valley lake
    // freezing in November is a perfectly plausible-looking `openedBy: ['sentinel']`.
    //
    // Same shape as `waterBodies.applyCuratedBoosts`: take a handful and filter on the exact name.
    // No match means no sentinel, and the corpus signal carries the gate alone — which is precisely
    // what the OR rule exists for.
    const sentinel = (
      await ctx.db
        .query('waterBodies')
        .withSearchIndex('search_name', (q) => q.search('searchText', SENTINEL_NAME))
        .take(10)
    )
      .filter((b) => b.name?.toLowerCase() === SENTINEL_NAME.toLowerCase())
      .slice(0, 1);

    const sample = await ctx.db
      .query('waterBodies')
      .withIndex('by_curated_boost')
      .order('desc')
      .take(SAMPLE_SITES);

    const point = (b: Doc<'waterBodies'>) => b.interiorPoint ?? b.centroid;
    const out: { siteId: string; sentinel: boolean; lat: number; lng: number }[] = [];
    const seen = new Set<string>();

    for (const b of [...sentinel, ...sample]) {
      const p = point(b);
      // A body with no usable point is skipped rather than defaulted. A gate is a claim about
      // somewhere, and (0, 0) is the Gulf of Guinea.
      if (!p || seen.has(b._id)) continue;
      seen.add(b._id);
      out.push({
        siteId: b._id,
        sentinel: sentinel[0]?._id === b._id,
        lat: p.lat,
        lng: p.lng,
      });
    }
    return out;
  },
});

/** The recorded verdict for a season, or `null` if we have not decided one yet. */
export const seasonRecord = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) =>
    await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique(),
});

export const recordSeasonOpen = internalMutation({
  args: {
    season: v.string(),
    opensOn: v.string(),
    openedBy: v.array(v.string()),
    winterFrom: v.union(v.string(), v.null()),
    sitesSampled: v.number(),
  },
  handler: async (ctx, args) => {
    // Idempotent by season. The cron ticks daily and a season opens once; re-running after a partial
    // failure must not produce a second row claiming a different date.
    const existing = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', args.season))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert('imageryIngestSeasons', { ...args, detectedAt: Date.now() });
  },
});

interface DailyResponse {
  daily?: { time?: string[]; temperature_2m_min?: (number | null)[] };
}

/**
 * Observed daily lows for every site, in one request.
 *
 * ⚠ **Observed, never forecast** — D140. Open-Meteo's *forecast* endpoint with `past_days` is the
 * right source anyway: the ERA5 archive lags ~5 days, so an archive-backed gate opens the season the
 * better part of a week late, which is the expensive direction.
 *
 * Multi-coordinate form: passing comma-separated `latitude`/`longitude` returns an *array* of
 * per-location objects, so 25 sites cost one HTTP call rather than 25.
 */
async function fetchDailyLows(
  sites: readonly { siteId: string; sentinel: boolean; lat: number; lng: number }[],
): Promise<SiteSeries[]> {
  const params = new URLSearchParams({
    latitude: sites.map((s) => s.lat.toFixed(4)).join(','),
    longitude: sites.map((s) => s.lng.toFixed(4)).join(','),
    daily: 'temperature_2m_min',
    past_days: String(MAX_PAST_DAYS),
    forecast_days: '1',
    timezone: 'auto',
    temperature_unit: 'celsius',
  });

  const res = await fetch(`${OPEN_METEO_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} ${res.statusText}`);
  const json = (await res.json()) as DailyResponse | DailyResponse[];
  // One coordinate returns an object; several return an array. Normalised so the caller never has to
  // care how many sites survived the point check above.
  const rows = Array.isArray(json) ? json : [json];

  const out: SiteSeries[] = [];
  for (const [i, site] of sites.entries()) {
    const daily = rows[i]?.daily;
    const times = daily?.time ?? [];
    const mins = daily?.temperature_2m_min ?? [];
    const days = times
      .map((date, j) => ({ date, minTempC: mins[j] }))
      // A null low is a gap in the record, not a warm night. Dropping it lets the site abstain for
      // that day rather than vote "did not freeze", which is what a `?? 0` would have made it do.
      .filter((d): d is { date: string; minTempC: number } => typeof d.minTempC === 'number');
    if (days.length > 0) {
      out.push({ siteId: site.siteId, sentinel: site.sentinel, days });
    }
  }
  return out;
}

/**
 * What a tick decided.
 *
 * ⚠ **Written out rather than inferred, and it has to be.** `maybeCheckSeasonOpen` calls
 * `internal.imageryIngest.*` — its own module — so letting TypeScript infer the return type makes the
 * type depend on `_generated/api.d.ts`, which imports this file, which is the type back where it
 * started. TypeScript resolves that circularity by widening `DataModel`, and the damage lands
 * *everywhere else*: `Doc<'accessAlerts'>` collapses into a union of all 44 tables and ~456 errors
 * appear in files this one never touches. Measured 2026-08-25, and the symptom points nowhere near
 * the cause — hence this note.
 */
type SeasonWatchResult =
  | {
      skipped: 'before October' | 'already recorded' | 'no sites' | 'no observations';
      season: string;
      opensOn?: string;
    }
  | { open: false; season: string; sitesSampled: number }
  | { open: true; season: string; opensOn: string; openedBy: string[] };

/**
 * The daily tick.
 *
 * A daily interval with a month gate rather than a `crons.cron` expression, matching
 * `recurrence.maybeRunRollover` — it keeps `crons.ts` uniform and, more usefully, makes the check
 * **retryable**: a tick that fails on 12 October is picked up on the 13th, where a once-a-year
 * expression would wait a year.
 *
 * Cheap on the ~10 months it does nothing: a no-op before October and a single indexed read once the
 * season has been recorded.
 */
export const maybeCheckSeasonOpen = internalAction({
  args: {},
  handler: async (ctx): Promise<SeasonWatchResult> => {
    const now = new Date();
    const month = now.getUTCMonth() + 1;

    // D63's July boundary, via the one definition of the label. `bakeMasks` names the mask artifact
    // with the same function, so a cut and the row recording why it happened cannot disagree.
    const season = archiveSeasonAt(now.getTime());

    // ⚠ The floor is on the *calendar*, not on the season label. Between July and September the
    // season label already reads `winter-YYYY-YY` and the sentinel pond can freeze — see the module
    // note on why the founder moved this to October.
    if (month < START_MONTH && month >= 7) return { skipped: 'before October' as const, season };

    const already = await ctx.runQuery(internal.imageryIngest.seasonRecord, { season });
    if (already) return { skipped: 'already recorded' as const, season, opensOn: already.opensOn };

    const sites = await ctx.runQuery(internal.imageryIngest.gateSites, {});
    if (sites.length === 0) return { skipped: 'no sites' as const, season };

    const fetched = await fetchDailyLows(sites);

    // ⚠ **The October floor has to bound the OBSERVATIONS, not just the tick.**
    //
    // Gating only on `month` delays *when we look* and does nothing about *what we look at*:
    // `past_days` is 92, so the very first tick on 1 October carries the series back to roughly
    // 1 July. `ingestWindow` returns the earliest freeze in whatever it is handed — and the module
    // note above says plainly that the summit pond can freeze in August. The gate would therefore
    // record `opensOn` in August on day one, print it as the `--from=` an operator pastes into
    // `select-granules`, and spend exactly the money the founder's October call was made to avoid.
    //
    // So the series is clipped to 1 October of the season's own opening year. `seasonOf` is the same
    // July boundary `archiveSeasonAt` uses, so a January tick clips to the *previous* October rather
    // than to one that has not happened yet.
    const floor = `${seasonOf(now.getTime())}-${String(START_MONTH).padStart(2, '0')}-01`;
    const series = fetched
      .map((s) => ({ ...s, days: s.days.filter((d) => d.date >= floor) }))
      .filter((s) => s.days.length > 0);
    if (series.length === 0) return { skipped: 'no observations' as const, season };

    const window = ingestWindow(series);
    if (!window.opensOn) return { open: false as const, season, sitesSampled: series.length };

    await ctx.runMutation(internal.imageryIngest.recordSeasonOpen, {
      season,
      opensOn: window.opensOn,
      openedBy: window.openedBy,
      winterFrom: window.winterFrom,
      sitesSampled: series.length,
    });

    // The operator-facing signal. Deliberately loud and deliberately not a user notification: this
    // says "go spend money on a fan-out", which is nobody's push notification.
    console.warn(
      `[imagery] ${season} ingest window OPENED on ${window.opensOn} ` +
        `(by ${window.openedBy.join('+')}, ${series.length} sites). ` +
        `Next: pnpm --filter @skating/imagery ingest-window`,
    );
    return { open: true as const, season, opensOn: window.opensOn, openedBy: window.openedBy };
  },
});
