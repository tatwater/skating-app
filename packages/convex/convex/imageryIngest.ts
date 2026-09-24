/**
 * Watching for the imagery season to open (A06e §3.3 / **D149**).
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
 * deployment cannot see, and the gate is a judgment about a season rather than a fact about a row —
 * so the cron's job is to *notice*, and an operator's job is to act on it. That is the same split the
 * CLI already draws: *"Deliberately does not run the selection itself… the operator should see it
 * before a fan-out spends anything."*
 *
 * ## Why October, and not September
 *
 * §3.3's summit trigger opens a season when `Upper Lake of the Clouds` (1,531 m, and in the corpus)
 * registers a freeze — which on Mt Washington can happen in *August*. Since 2026-09-21 the two
 * other alpine tarns the community opens its season on stand beside it (`SENTINELS`). The phase doc reasoned that this
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

import {
  archiveSeasonAt,
  DEFAULT_THAW_RUN_DAYS,
  ingestWindow,
  type SiteSeries,
  seasonOf,
  thawClose,
} from '@skating/core';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { isListed } from './lib/listing';

/**
 * A body the watcher always samples, found by name rather than by a hardcoded coordinate or a row
 * id — a coordinate drifts from the row and an id is minted per deployment, but the name is what
 * the community calls the place. `state` is part of the key because a name alone is not one:
 * the corpus holds eight bodies called Eagle Lake, and only the one on Mt Lafayette is a sentinel.
 *
 * Matched against the row's displayed `name` **and every `nameClaims` value**, so a moderator
 * picking another publisher's spelling on `/admin/water/$id` (`setWaterBodyName`) does not
 * silently drop a sentinel — the roster name is still one of the row's claims after a pick.
 */
interface RosterEntry {
  name: string;
  state: string;
}

/**
 * §3.3's summit triggers — the first ice in the region, and the last place anyone would want the
 * watcher to be looking somewhere else. Any one of them freezing opens the season (`ingestWindow`'s
 * OR rule already reads every `sentinel: true` site). Three rather than one since 2026-09-21: a
 * group leader's seasonal journal opens the season on Lakes of the Clouds *and* Eagle Lake on the
 * same October day, with Kinsman Pond a week behind — and a single named row is one rename, merge
 * or purge away from leaving the gate with no sentinel at all.
 */
const SENTINELS: readonly RosterEntry[] = [
  { name: 'Upper Lake of the Clouds', state: 'NH' }, // 1,531 m, Mt Washington
  { name: 'Eagle Lake', state: 'NH' }, // 1,264 m, below Greenleaf Hut on Mt Lafayette
  { name: 'Kinsman Pond', state: 'NH' }, // 1,134 m, Kinsman Ridge
];

/**
 * Ordinary sites that ride along regardless of boost rank. The `by_curated_boost` sample below is
 * "the top 24", but ~100 bodies tie at 0.3, so which 24 arrive is index order — a body the
 * founder wants watched cannot rely on it. Low Plains (Elkins) is the same journal's valley
 * season opener: shallow, marshy, two minutes from the lot, skated 1 December. Not a sentinel:
 * a valley pond freezing alone should not open a region's season, which is the corpus rule's job.
 *
 * ⚠ Low Plains has no catalog name: it is an unnamed NHD row until a moderator gives it its
 * community name (`setWaterBodyName`, the no-catalog-claim case — done on dev 2026-09-21). On a
 * deployment where that has not happened this entry finds nothing and the roster is simply shorter.
 */
const PINNED_SITES: readonly RosterEntry[] = [{ name: 'Low Plains', state: 'NH' }];

/**
 * How many search hits to look through for a roster entry's exact name. "Eagle Lake" has eight
 * exact-name rows across five states before any near-miss; the filter, not the take, decides.
 */
const ROSTER_SEARCH_TAKE = 50;

/**
 * How many ordinary bodies to sample alongside the roster.
 *
 * Enough that `corpusFraction`'s 10% means "a few sites agreed" rather than "one site is noisy", and
 * small enough that the whole tick is one Open-Meteo request and a bounded read.
 */
const SAMPLE_SITES = 24;

/**
 * The most boost-ordered rows the sample walk reads to find {@link SAMPLE_SITES} listed ones. A
 * ceiling on the read, not a target: ~140 bodies carry a boost on dev, so a full sample normally
 * arrives in the first few dozen.
 */
const SAMPLE_SCAN_CAP = 200;

/** Open-Meteo's `past_days` ceiling, matching `weather.ts`. */
const MAX_PAST_DAYS = 92;

/** The month the watcher starts looking, 1-indexed. Founder call — see the module note. */
const START_MONTH = 10;

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/**
 * The sites to sample: the sentinels, the pinned sites, plus the most prominent bodies we hold.
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
    // ⚠ **A search hit is not a roster site until its name and state say so.**
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
    // what the OR rule exists for. A roster entry that resolves to *two* rows (a duplicate the
    // dedup queue has not reached) is dropped rather than doubled: two sentinels for one pond is
    // one pond voting twice.
    //
    // **Listed rows only.** A merge tombstones the loser rather than deleting it (D36), with its
    // name and states intact — so without `isListed` the day the dedup queue *does* reach a
    // duplicate sentinel is the day the entry resolves to two rows for ever, and the fix for the
    // duplicate is what loses the sentinel. A removed body stays: a landowner takedown changes who
    // may skate it, not whether it freezes.
    const resolve = async (entry: RosterEntry): Promise<Doc<'waterBodies'> | undefined> => {
      const wanted = entry.name.toLowerCase();
      const exact = (
        await ctx.db
          .query('waterBodies')
          .withSearchIndex('search_name', (q) => q.search('searchText', entry.name))
          .take(ROSTER_SEARCH_TAKE)
      ).filter(
        (b) =>
          isListed(b) &&
          (b.states ?? []).includes(entry.state) &&
          [b.name, ...(b.nameClaims ?? []).map((c) => c.value)].some(
            (v) => v.toLowerCase() === wanted,
          ),
      );
      return exact.length === 1 ? exact[0] : undefined;
    };
    const resolveAll = async (entries: readonly RosterEntry[]) =>
      (await Promise.all(entries.map(resolve))).filter(
        (b): b is Doc<'waterBodies'> => b !== undefined,
      );
    const [sentinels, pinned] = await Promise.all([
      resolveAll(SENTINELS),
      resolveAll(PINNED_SITES),
    ]);

    // Same `isListed` here: a merge does not clear the loser's boost, so a tombstone would
    // otherwise sit in the sample at the survivor's own coordinate — one pond voting twice.
    //
    // ⚠ **Filter while reading, not after a fixed take** (Greptile, PR #74). `take(24)` then
    // `filter` lets every boosted tombstone cost the sample a site, and a shrinking sample is how
    // one freezing pond comes to clear `corpusFraction`'s 10% alone. So the walk keeps going until
    // it holds 24 listed non-roster sites — roster rows are excluded here because they are already
    // in the output, and a sentinel counted in the sample would shrink the ordinary vote the same
    // way. Bounded by `SAMPLE_SCAN_CAP`, so a corpus of tombstones costs a few hundred reads, never
    // a table scan.
    const rosterIds = new Set([...sentinels, ...pinned].map((b) => b._id));
    const sample: Doc<'waterBodies'>[] = [];
    let scanned = 0;
    for await (const b of ctx.db.query('waterBodies').withIndex('by_curated_boost').order('desc')) {
      if (++scanned > SAMPLE_SCAN_CAP || sample.length >= SAMPLE_SITES) break;
      if (isListed(b) && !rosterIds.has(b._id)) sample.push(b);
    }

    const point = (b: Doc<'waterBodies'>) => b.interiorPoint ?? b.centroid;
    const out: { siteId: string; sentinel: boolean; lat: number; lng: number }[] = [];
    const seen = new Set<string>();
    const sentinelIds = new Set(sentinels.map((b) => b._id));

    // The flag comes from `sentinelIds`, not from which list a row arrived in — a sentinel that
    // also ranks in the boost sample is listed once (`seen`) and flagged either way.
    for (const b of [...sentinels, ...pinned, ...sample]) {
      const p = point(b);
      // A body with no usable point is skipped rather than defaulted. A gate is a claim about
      // somewhere, and (0, 0) is the Gulf of Guinea.
      if (!p || seen.has(b._id)) continue;
      seen.add(b._id);
      out.push({
        siteId: b._id,
        sentinel: sentinelIds.has(b._id),
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

/**
 * Record the date a season closed, once.
 *
 * ⚠ **Only ever set on a row that has none.** Ice-out is a one-way door within a season: a late cold
 * snap after ten thawed days does not un-close it, and letting a later tick move the date would make
 * the field a description of the last time we looked rather than of the melt.
 */
export const recordSeasonClose = internalMutation({
  args: { season: v.string(), closesOn: v.string() },
  handler: async (ctx, { season, closesOn }) => {
    const row = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    if (!row || row.closesOn !== undefined) return null;
    await ctx.db.patch(row._id, { closesOn, closedAt: Date.now() });
    return row._id;
  },
});

/**
 * Fill in `winterFrom` on a season that was opened before the region itself froze.
 *
 * ⚠ **Without this the close can never fire in the common case.** The sentinel pond is *allowed* to
 * open a season on its own — that is the whole point of the OR rule — and it does so weeks before a
 * majority of ordinary sites see an overnight freeze. So the very first October tick routinely writes
 * `winterFrom: null`, and `recordSeasonOpen` is insert-only, so nothing would ever revisit it: the
 * row would sit open for ever, imagery ingest would cut granules into July and the corpus-wide
 * weather sweep would spend ~4,300 Open-Meteo calls a day right through the summer. Ice-in is a fact
 * that arrives *after* opening, so it has to be writable after opening.
 *
 * **Only ever set on a row that has none**, for the same reason `recordSeasonClose` is: the date the
 * region froze is a one-way door within a season, and letting a later tick move it would make the
 * field describe the last time we looked rather than the freeze.
 */
export const recordSeasonWinterFrom = internalMutation({
  args: { season: v.string(), winterFrom: v.string() },
  handler: async (ctx, { season, winterFrom }) => {
    const row = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    if (!row || row.winterFrom !== null) return null;
    await ctx.db.patch(row._id, { winterFrom });
    return row._id;
  },
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
    //
    // ⚠ **`created` is what the staff email is gated on**, and it has to come from here rather than
    // from the caller's control flow: "did this tick actually open the season" is a property of the
    // write, and deciding it upstream is how a retried tick mails everyone a second time.
    const existing = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', args.season))
      .unique();
    if (existing) return { id: existing._id, created: false };
    const id = await ctx.db.insert('imageryIngestSeasons', { ...args, detectedAt: Date.now() });
    return { id, created: true };
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
  // One coordinate returns an object; several return an array. Normalized so the caller never has to
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
  | { open: true; season: string; opensOn: string; openedBy: string[] }
  | { closed: true; season: string; closesOn: string };

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

    // ⚠ **An opened season is not a finished one — the tick keeps running to find the close.**
    //
    // This used to return here on any recorded row, which meant `ingestWindow` computed a perfectly
    // good `closesOn` that nothing ever persisted. Two consumers pay for that: imagery keeps cutting
    // granules into July, and A06h's corpus-wide weather sweep (D161) keeps spending ~4,300
    // Open-Meteo calls a day right through the spring, because the only thing it can gate on is the
    // presence of `opensOn`. So the row is complete when it has *both* dates, not one.
    const already = await ctx.runQuery(internal.imageryIngest.seasonRecord, { season });
    if (already?.closesOn !== undefined) {
      return { skipped: 'already recorded' as const, season, opensOn: already.opensOn };
    }

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

    // ⚠ **A season opened before the region froze carries `winterFrom: null`, and that is the normal
    // October state, not an edge case.** The sentinel pond opens a season on its own weeks before a
    // majority of ordinary sites see an overnight freeze, and `recordSeasonOpen` is insert-only — so
    // without this the row would keep `winterFrom: null` for ever, the close could never be measured
    // from anything, and both consumers (imagery ingest, the D161 weather sweep) would run through
    // the summer. Ice-in arrives after opening, so it is resolved here, on a later tick, from the
    // window that now contains it.
    let winterFrom = already?.winterFrom ?? null;
    if (already && winterFrom === null) {
      winterFrom = ingestWindow(series).winterFrom;
      if (winterFrom !== null) {
        await ctx.runMutation(internal.imageryIngest.recordSeasonWinterFrom, {
          season,
          winterFrom,
        });
        console.warn(`[imagery] ${season} winter established region-wide on ${winterFrom}`);
      }
    }

    // The already-open case: look only for the close, and do it against the **recorded**
    // `winterFrom`. Re-deriving it at close time is impossible — `past_days` is 92, so by the spring
    // tick that would actually close a season the date the region froze is months out of the window,
    // and `ingestWindow` would return `closesOn: null` for ever. See `thawClose`.
    if (already) {
      // Still no region-wide freeze: nothing to measure a close from, so wait for the next tick.
      if (winterFrom === null) {
        return { skipped: 'already recorded' as const, season, opensOn: already.opensOn };
      }
      const closesOn = thawClose(series, winterFrom);
      if (!closesOn) {
        return {
          open: true as const,
          season,
          opensOn: already.opensOn,
          openedBy: already.openedBy,
        };
      }
      const wrote = await ctx.runMutation(internal.imageryIngest.recordSeasonClose, {
        season,
        closesOn,
      });
      // Both the log and the mail are gated on the mutation having actually written, not on reaching
      // this line — `recordSeasonClose` refuses to re-close, so a racing second tick neither tells
      // anybody twice nor prints a second "CLOSED" for a write it did not make.
      if (wrote !== null) {
        console.warn(
          `[imagery] ${season} ingest window CLOSED on ${closesOn} ` +
            `(${series.length} sites, ${DEFAULT_THAW_RUN_DAYS} thawed days). ` +
            `Corpus-wide weather sweep stands down until the next season opens.`,
        );
        await ctx.scheduler.runAfter(0, internal.operatorAlerts.broadcastToStaff, {
          subject: `Skating season ${season} has closed`,
          heading: `The ${season} season closed on ${closesOn}`,
          lines: [
            `Ten consecutive days with no overnight freeze at any of the ${series.length} sampled sites — the reluctant ice-out proxy, which typically lands a couple of weeks after a real Vermont ice-out.`,
            'Satellite imagery ingest stands down, and so does the corpus-wide weather sweep, until the next season opens.',
            'This is a region-wide signal about spend, not a claim that any particular lake is unskateable.',
          ],
          deepLinkPath: '/admin',
        });
      }
      return { closed: true as const, season, closesOn };
    }

    const window = ingestWindow(series);
    if (!window.opensOn) return { open: false as const, season, sitesSampled: series.length };

    const opened = await ctx.runMutation(internal.imageryIngest.recordSeasonOpen, {
      season,
      opensOn: window.opensOn,
      openedBy: window.openedBy,
      winterFrom: window.winterFrom,
      sitesSampled: series.length,
    });

    if (opened.created) {
      await ctx.scheduler.runAfter(0, internal.operatorAlerts.broadcastToStaff, {
        subject: `Skating season ${season} has begun`,
        heading: `The ${season} season opened on ${window.opensOn}`,
        lines: [
          `Opened by: ${window.openedBy.join(' + ')} (${series.length} sites reporting).`,
          window.winterFrom
            ? `The region itself first froze on ${window.winterFrom}.`
            : 'Winter has not established region-wide yet — a sentinel pond opened this on its own, which it is allowed to do.',
          'Satellite imagery ingest is now in season. Next operator step: pnpm --filter @skating/imagery ingest-window',
          'The corpus-wide weather sweep starts on its next daily tick.',
        ],
        deepLinkPath: '/admin',
      });
    }

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
