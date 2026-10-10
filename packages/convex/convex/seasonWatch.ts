/**
 * The season watch's settings, its stored observations and the admin page's reads and writes (A06i,
 * D213). The daily decision itself stays in `imageryIngest.maybeCheckSeasonOpen`; this module is what
 * it reads its knobs from and writes its measurements to, and what `/admin/seasons` drives.
 *
 * ## Settings are versions, not a row that changes
 *
 * Every save inserts a new `seasonWatchSettings` version; the highest is current. A season row copies
 * the version that opened it, so tightening a threshold in January cannot rewrite why October's watch
 * began. With no version at all, {@link ensureSettings} seeds version 1 from the defaults, resolving
 * the roster by name and state exactly as the watcher did before A06i.
 *
 * ## ⚠ Air temperature, never ice (D3)
 *
 * Nothing here — no field, label or preview — may say a lake froze. A sentinel crossing a line is a
 * summit having a cold night. The field dates an admin enters are when people skated, recorded so the
 * preview can be compared against them, and they never leave `/admin`.
 */

import {
  archiveSeasonAt,
  archiveSeasonLabel,
  type DailyLow,
  DEFAULT_SEASON_WATCH_SETTINGS,
  EARLIEST_START_MONTH_DAY,
  expandLows,
  MAX_ROSTER_SITES,
  MAX_SAMPLE_SITES,
  mergeLows,
  type SeasonWatchSettings,
  seasonStartYear,
  validateSeasonWatchSettings,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';

import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { openMeteoCallWeight } from './lib/apiMeter';
import { requireContributorRole, requireRole } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { busyUntil, setBusyUntil } from './lib/dailyThrottle';
import { clearBackoff } from './lib/imageryPump';
import { isListed } from './lib/listing';
import { newYorkDate } from './lib/seasonWatchEmails';
import {
  rosterSite as rosterSiteValidator,
  seasonWatchSettings as settingsValidator,
} from './lib/seasonWatchValidators';
import { literals } from './lib/validators';

/**
 * A body the watcher always samples, found by name rather than by a hardcoded coordinate or a row
 * id — a coordinate drifts from the row and an id is minted per deployment, but the name is what
 * the community calls the place. `state` is part of the key because a name alone is not one:
 * the corpus holds eight bodies called Eagle Lake, and only the one on Mt Lafayette is a sentinel.
 *
 * Since A06i these seed version 1 of the settings, which then hold ids; an admin edits the roster on
 * `/admin/seasons`. Matched against the row's displayed `name` **and every `nameClaims` value**, so a
 * moderator picking another publisher's spelling does not silently drop a sentinel.
 */
export interface RosterEntry {
  name: string;
  state: string;
}

/**
 * §3.3's summit triggers — the first cold nights in the region. Any one of them firing opens the
 * watch (`ingestWindow`'s OR rule reads every `sentinel: true` site). Three rather than one since
 * 2026-09-21: a group leader's seasonal journal opens the season on Lakes of the Clouds *and* Eagle
 * Lake on the same October day, with Kinsman Pond a week behind — and a single named row is one
 * rename, merge or purge away from leaving the gate with no sentinel at all.
 */
export const SENTINELS: readonly RosterEntry[] = [
  { name: 'Upper Lake of the Clouds', state: 'NH' }, // 1,531 m, Mt Washington
  { name: 'Eagle Lake', state: 'NH' }, // 1,264 m, below Greenleaf Hut on Mt Lafayette
  { name: 'Kinsman Pond', state: 'NH' }, // 1,134 m, Kinsman Ridge
];

/**
 * Ordinary sites that ride along regardless of boost rank — Low Plains (Elkins), the same journal's
 * valley season opener. Not a sentinel: a valley pond freezing alone should not open a region's
 * season, which is the corpus rule's job.
 */
export const PINNED_SITES: readonly RosterEntry[] = [{ name: 'Low Plains', state: 'NH' }];

/** Search hits looked through for a roster entry's exact name ("Eagle Lake" has eight). */
const ROSTER_SEARCH_TAKE = 50;

/** The most boost-ordered rows the sample walk reads to find `sampleSize` listed ones. */
const SAMPLE_SCAN_CAP = 200;

/** The history fill's busy mark (one fill at a time), and the re-plan a fill asked for during one booked. */
const FILL_KEY = 'history-fill';
const REPLAN_KEY = 'history-fill-replan';

/** The first season the history fill reaches back to — the start of the imagery archive's reach. */
export const HISTORY_FIRST_SEASON_YEAR = 2016;

export interface RosterSite {
  waterBodyId: Id<'waterBodies'>;
  name: string;
  state?: string;
}

export interface WatchConfig {
  version: number;
  settings: SeasonWatchSettings;
  sentinels: RosterSite[];
  pinned: RosterSite[];
}

function rosterSite(b: Doc<'waterBodies'>, state?: string): RosterSite {
  const st = state ?? b.states?.[0];
  return { waterBodyId: b._id, name: b.name, ...(st ? { state: st } : {}) };
}

/**
 * Resolve a roster entry by exact name and state.
 *
 * ⚠ **A search hit is not a roster site until its name and state say so.** `withSearchIndex` ranks
 * by relevance and always answers if *anything* tokenises close enough, so `.take(1)` alone crowns
 * whichever lake scores highest on "lake" — and a valley lake freezing in November is a perfectly
 * plausible-looking `openedBy: ['sentinel']`. No match means no site; two matches (a duplicate the
 * dedup queue has not reached) mean none, since one pond must not vote twice. Listed rows only: a
 * merge tombstones the loser with its name intact.
 */
async function resolveByName(
  ctx: QueryCtx,
  entry: RosterEntry,
): Promise<Doc<'waterBodies'> | null> {
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
      [b.name, ...(b.nameClaims ?? []).map((c) => c.value)].some((n) => n.toLowerCase() === wanted),
  );
  return exact.length === 1 ? (exact[0] as Doc<'waterBodies'>) : null;
}

async function latestSettings(ctx: QueryCtx): Promise<Doc<'seasonWatchSettings'> | null> {
  return await ctx.db.query('seasonWatchSettings').withIndex('by_version').order('desc').first();
}

function configOf(row: Doc<'seasonWatchSettings'>): WatchConfig {
  return {
    version: row.version,
    settings: row.settings,
    sentinels: row.sentinels,
    pinned: row.pinned,
  };
}

/** The defaults, with the roster resolved by name — what version 1 is seeded from. */
async function defaultConfig(ctx: QueryCtx): Promise<Omit<WatchConfig, 'version'>> {
  const resolve = async (entries: readonly RosterEntry[]) =>
    (await Promise.all(entries.map(async (e) => ({ e, b: await resolveByName(ctx, e) }))))
      .filter((r): r is { e: RosterEntry; b: Doc<'waterBodies'> } => r.b !== null)
      .map((r) => rosterSite(r.b, r.e.state));
  return {
    settings: DEFAULT_SEASON_WATCH_SETTINGS,
    sentinels: await resolve(SENTINELS),
    pinned: await resolve(PINNED_SITES),
  };
}

/**
 * Stamp any season row opened before A06i — the legacy winter-2026-27 row — with what decided it.
 *
 * It was decided under the defaults D149 shipped with and the roster those names resolved to, which
 * is **version 0**: the settings before there were versions. Not version 1, which is whatever was
 * saved first — the defaults if `ensureSettings` seeded it, an admin's edit if they saved first — and
 * stamping that would rewrite why the season opened. Its opening email has already gone (as the old
 * "season has begun" message), so it is marked sent and the queue never re-sends it. Idempotent, and
 * run on every tick and every save, so the order those happen in after a deploy does not matter.
 */
async function stampLegacyRows(ctx: MutationCtx) {
  const legacy = (await ctx.db.query('imageryIngestSeasons').take(50)).filter(
    (r) => r.settingsVersion === undefined,
  );
  if (legacy.length === 0) return;
  const defaults = await defaultConfig(ctx);
  for (const row of legacy) {
    const sentOn = newYorkDate(row.detectedAt);
    await ctx.db.patch(row._id, {
      settingsVersion: 0,
      settings: defaults.settings,
      sentinels: defaults.sentinels,
      emailsSent: row.emailsSent ?? [{ kind: 'opened', sentOn, sentAt: row.detectedAt }],
      lastEmailOn: row.lastEmailOn ?? sentOn,
    });
  }
}

/** The current settings, seeding version 1 from the defaults on first use. */
export const ensureSettings = internalMutation({
  args: {},
  handler: async (ctx): Promise<WatchConfig> => {
    await stampLegacyRows(ctx);
    const row = await latestSettings(ctx);
    if (row) return configOf(row);
    const seeded = await defaultConfig(ctx);
    await ctx.db.insert('seasonWatchSettings', {
      version: 1,
      ...seeded,
      note: 'The defaults the watch shipped with (D149), seeded by A06i.',
      savedAt: Date.now(),
    });
    return { version: 1, ...seeded };
  },
});

/**
 * The bodies to sample: the sentinels, the pinned sites, then the most prominent bodies we hold.
 *
 * ⚠ **Bounded reads, deliberately.** An even spatial stride over `waterBodies` is a full scan of
 * ~25,000 documents and exceeds the 16 MB read limit (measured 2026-08-25). One ordered index range
 * keeps this to a few dozen documents; `by_curated_boost` skews to popular northern lakes, so the
 * sample runs slightly cold and the gate opens a little early — the cheap direction to be wrong in.
 *
 * Roster ids follow merges to their survivor (D36) and must still be listed; a roster site that no
 * longer resolves is reported back as `missing`, with its role, rather than silently dropped.
 */
export async function sampleSites(
  ctx: QueryCtx,
  config: Pick<WatchConfig, 'sentinels' | 'pinned'> & { sampleSize: number },
) {
  // ⚠ **A roster lake merged into another roster lake is reported**, not folded in: the survivor
  // already votes once, and folding would let a save drop the merged entry unseen. Entries that are
  // their own survivor claim their lake first, so it is the merged loser that is named, whichever
  // list each is in.
  const roster = [
    ...config.sentinels.map((site) => ({ site, role: 'sentinel' as const })),
    ...config.pinned.map((site) => ({ site, role: 'pinned' as const })),
  ];
  const resolved: {
    site: RosterSite;
    role: 'sentinel' | 'pinned';
    b: Doc<'waterBodies'> | null;
  }[] = [];
  for (const entry of roster) {
    const b = await resolveSurvivor(ctx, entry.site.waterBodyId);
    resolved.push({ ...entry, b: b && isListed(b) ? b : null });
  }
  // (An entry listed twice under its own id is the same lake twice, not a lost one: it folds, and
  // the save refuses duplicates anyway.)
  const claimed = new Set(
    resolved.filter((r) => r.b?._id === r.site.waterBodyId).map((r) => r.site.waterBodyId),
  );
  for (const r of resolved) {
    if (!r.b || r.b._id === r.site.waterBodyId) continue;
    if (claimed.has(r.b._id)) r.b = null;
    else claimed.add(r.b._id);
  }
  const ofRole = (role: 'sentinel' | 'pinned') => ({
    found: resolved.filter((r) => r.role === role && r.b).map((r) => r.b as Doc<'waterBodies'>),
    missing: resolved.filter((r) => r.role === role && !r.b).map((r) => r.site),
  });
  const sentinels = ofRole('sentinel');
  const pinned = ofRole('pinned');

  // ⚠ **Filter while reading, not after a fixed take** (Greptile, PR #74): every boosted tombstone
  // a fixed take spent would shrink the sample, and a shrinking sample is how one freezing pond comes
  // to clear `corpusFraction` alone. Roster rows are excluded — they are already in the output.
  const rosterIds = new Set([...sentinels.found, ...pinned.found].map((b) => b._id));
  const sample: Doc<'waterBodies'>[] = [];
  let scanned = 0;
  for await (const b of ctx.db.query('waterBodies').withIndex('by_curated_boost').order('desc')) {
    if (++scanned > SAMPLE_SCAN_CAP || sample.length >= config.sampleSize) break;
    if (isListed(b) && !rosterIds.has(b._id)) sample.push(b);
  }

  const sentinelIds = new Set(sentinels.found.map((b) => b._id));
  const pinnedIds = new Set(pinned.found.map((b) => b._id));
  const seen = new Set<string>();
  const sites: {
    siteId: Id<'waterBodies'>;
    role: 'sentinel' | 'pinned' | 'sample';
    sentinel: boolean;
    name: string;
    state?: string;
    lat: number;
    lng: number;
  }[] = [];
  for (const b of [...sentinels.found, ...pinned.found, ...sample]) {
    // `centroid` is required on every body, so there is always a point; `interiorPoint` is the better
    // one — `centroid` is Turf's pointOnFeature, which can land on the shoreline.
    const p = b.interiorPoint ?? b.centroid;
    if (seen.has(b._id)) continue;
    seen.add(b._id);
    const role = sentinelIds.has(b._id) ? 'sentinel' : pinnedIds.has(b._id) ? 'pinned' : 'sample';
    sites.push({
      siteId: b._id,
      role,
      sentinel: role === 'sentinel',
      name: b.name,
      ...(b.states?.[0] ? { state: b.states[0] } : {}),
      lat: p.lat,
      lng: p.lng,
    });
  }
  return {
    sites,
    missing: [
      ...sentinels.missing.map((m) => ({ ...m, role: 'sentinel' as const })),
      ...pinned.missing.map((m) => ({ ...m, role: 'pinned' as const })),
    ],
  };
}

export const gateSites = internalQuery({
  args: {
    sentinels: v.array(rosterSiteValidator),
    pinned: v.array(rosterSiteValidator),
    sampleSize: v.number(),
  },
  handler: async (ctx, args) => (await sampleSites(ctx, args)).sites,
});

/**
 * Fold a fetch into the stored lows (A06i §3). A refetched night replaces the stored one — the
 * forecast endpoint revises its past days as observations arrive — and nights not refetched stay.
 */
export const storeSeries = internalMutation({
  args: {
    season: v.string(),
    source: literals(['forecast', 'archive'] as const),
    sites: v.array(
      v.object({
        waterBodyId: v.id('waterBodies'),
        name: v.string(),
        state: v.optional(v.string()),
        lat: v.number(),
        lng: v.number(),
        days: v.array(v.object({ date: v.string(), minTempC: v.number() })),
      }),
    ),
  },
  handler: async (ctx, { season, source, sites }) => {
    const now = Date.now();
    const today = newYorkDate(now);
    for (const site of sites) {
      const existing = await ctx.db
        .query('seasonWatchSeries')
        .withIndex('by_season_body', (q) =>
          q.eq('season', season).eq('waterBodyId', site.waterBodyId),
        )
        .unique();
      // ⚠ **Today's low is a forecast** — the night is not over — so it is never stored, and so
      // never decided on (D140: observed, never forecast). Enforced here, at the one sink every
      // writer goes through, rather than at each fetch. The corpus is all US Eastern, so New York's
      // date is every site's date; kept would be a forecast 19 °F recording the one-way imagery-line
      // date, and sending its email, before the night had happened.
      const observed = site.days.filter((d) => d.date < today);
      // ⚠ **The archive fills gaps in what the live watch kept; it never replaces it.** Those forecast
      // nights are what the season was actually decided on, and a replay must reproduce the decision.
      const keepLive = existing?.source === 'forecast' && source === 'archive';
      const kept = keepLive ? new Set(expandLows(existing).map((d) => d.date)) : null;
      const days = kept ? observed.filter((d) => !kept.has(d.date)) : observed;
      const merged = mergeLows(existing, days as DailyLow[]);
      const fields = {
        name: site.name,
        ...(site.state ? { state: site.state } : {}),
        lat: site.lat,
        lng: site.lng,
        source: keepLive ? ('forecast' as const) : source,
        // The archive has answered for this site (`fillSeason` sends no site it did not answer
        // for), so the season is whole — even if the answer held no nights to add.
        ...(keepLive ? { archiveFilledAt: now } : {}),
        firstDate: merged.firstDate,
        lows: merged.lows,
        updatedAt: now,
      };
      if (existing) await ctx.db.patch(existing._id, fields);
      // An empty first write is skipped — except the archive's: it answered for this site
      // (`fillSeason` sends no other) and had no nights, which is worth keeping, or every plan
      // would ask it again.
      else if (merged.lows.length > 0 || source === 'archive') {
        await ctx.db.insert('seasonWatchSeries', {
          season,
          waterBodyId: site.waterBodyId,
          ...fields,
          firstDate: merged.firstDate || `${seasonStartYear(season)}-${EARLIEST_START_MONTH_DAY}`,
        });
      }
    }
    return null;
  },
});

/** Every stored series for one season — at most a few dozen documents. */
export const seasonSeries = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) =>
    await ctx.db
      .query('seasonWatchSeries')
      .withIndex('by_season_body', (q) => q.eq('season', season))
      .take(200),
});

// ─── The admin page ─────────────────────────────────────────────────────────────────────────────

/** Where each default lives, so the page can say which file to change without an edit (D213). */
const DEFAULTS_IN_CODE = {
  settings: 'packages/core/src/seasonWatch.ts — DEFAULT_SEASON_WATCH_SETTINGS',
  rules: 'packages/core/src/ingestGate.ts — ingestWindow, winterOnOrAfter, thawClose',
  roster: 'packages/convex/convex/seasonWatch.ts — SENTINELS, PINNED_SITES',
  cron: 'packages/convex/convex/imageryIngest.ts — maybeCheckSeasonOpen',
  imagery: 'packages/convex/convex/imageryLive.ts — POLL_CAP, MAX_LIVE_MACHINES',
};

/** Everything `/admin/seasons` shows except the lows themselves, which {@link series} carries. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, 'admin');
    const versions = await ctx.db
      .query('seasonWatchSettings')
      .withIndex('by_version')
      .order('desc')
      .take(25);
    const current = versions[0]
      ? configOf(versions[0])
      : { version: 0, ...(await defaultConfig(ctx)) };
    const { sites, missing } = await sampleSites(ctx, {
      ...current,
      sampleSize: current.settings.sampleSize,
    });
    const seasons = await ctx.db.query('imageryIngestSeasons').take(50);
    const superseded = await ctx.db.query('imageryIngestSeasonsSuperseded').take(50);
    const fieldDates = await ctx.db.query('seasonFieldDates').take(500);
    return {
      current,
      versions: versions.map((r) => ({
        version: r.version,
        note: r.note ?? null,
        savedAt: r.savedAt,
        savedBy: r.savedBy ?? null,
        settings: r.settings,
        sentinels: r.sentinels,
        pinned: r.pinned,
      })),
      sites,
      missing,
      seasons: seasons.sort((a, b) => b.season.localeCompare(a.season)),
      superseded,
      fieldDates: fieldDates.sort((a, b) => a.date.localeCompare(b.date)),
      defaultsInCode: DEFAULTS_IN_CODE,
      historyFirstSeason: HISTORY_FIRST_SEASON_YEAR,
      // What *Fill history* covers, and how long it runs from nothing for the sites watched now —
      // the planner's own seasons and pacing, so the page's estimate cannot drift from it.
      historyFill: (() => {
        const seasons = fillSeasons(Date.now()).length;
        const perSeason = Math.ceil(sites.length / HISTORY_SITES_PER_REQUEST);
        return { seasons, spanMs: fillPacing(perSeason * seasons, seasons).spanMs };
      })(),
    };
  },
});

/**
 * The sites an edited roster and sample size would watch — {@link sampleSites} itself, so the preview
 * of an edit samples by the one rule the cron will use once it is saved: roster ids followed to their
 * survivors, and the sample re-drawn around the roster at the edited size. `null` for a sample size
 * the save would refuse.
 */
export const previewSites = query({
  args: {
    sentinels: v.array(rosterSiteValidator),
    pinned: v.array(rosterSiteValidator),
    sampleSize: v.number(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, 'admin');
    const size = args.sampleSize;
    if (!Number.isInteger(size) || size < 1 || size > MAX_SAMPLE_SITES) return null;
    if (args.sentinels.length > MAX_ROSTER_SITES || args.pinned.length > MAX_ROSTER_SITES)
      return null;
    return await sampleSites(ctx, args);
  },
});

/**
 * Every stored low, every season — the preview replays these in the browser through the same
 * `evaluateSeason` the cron uses. ~30 sites × ~11 seasons of ~300 numbers: well under a megabyte.
 */
export const series = query({
  // ⚠ The page passes the season under way rather than the query reading the clock: a query is
  // cached on the rows it reads, and the July turnover changes none of them.
  args: { current: v.string() },
  handler: async (ctx, { current }) => {
    await requireRole(ctx, 'admin');
    const docs = await ctx.db.query('seasonWatchSeries').take(2_000);
    return docs.map((d) => ({
      season: d.season,
      waterBodyId: d.waterBodyId,
      name: d.name,
      state: d.state ?? null,
      source: d.source,
      // Whether a fill would leave it be (`holdsSeason`): the page counts one that is not as missing.
      whole: holdsSeason(d, d.season === current),
      firstDate: d.firstDate,
      lows: d.lows,
    }));
  },
});

/**
 * Save a new settings version. Whatever the new settings watch but has no lows stored is filled in
 * the background.
 */
export const saveSettings = mutation({
  args: {
    settings: settingsValidator,
    sentinels: v.array(v.id('waterBodies')),
    pinned: v.array(v.id('waterBodies')),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireContributorRole(ctx, 'admin');
    const errors = validateSeasonWatchSettings(args.settings);
    if (new Set(args.sentinels).size !== args.sentinels.length)
      errors.push('A sentinel is listed twice.');
    if (new Set(args.pinned).size !== args.pinned.length)
      errors.push('A pinned lake is listed twice.');
    if (args.sentinels.some((id) => args.pinned.includes(id))) {
      errors.push('A lake cannot be both a sentinel and a pinned site.');
    }
    if (args.sentinels.length > MAX_ROSTER_SITES || args.pinned.length > MAX_ROSTER_SITES) {
      errors.push('At most ten sentinels and ten pinned sites.');
    }
    const snapshot = async (ids: Id<'waterBodies'>[]) => {
      const out: RosterSite[] = [];
      for (const id of ids) {
        const b = await ctx.db.get(id);
        if (!b || !isListed(b)) {
          errors.push(`${b?.name ?? 'One of the chosen lakes'} is not listed — remove it.`);
        } else out.push(rosterSite(b));
      }
      return out;
    };
    const sentinels = await snapshot(args.sentinels);
    const pinned = await snapshot(args.pinned);
    if (errors.length > 0) throw new ConvexError(errors.join(' '));

    await stampLegacyRows(ctx);
    const previous = await latestSettings(ctx);
    const version = (previous?.version ?? 0) + 1;
    await ctx.db.insert('seasonWatchSettings', {
      version,
      settings: args.settings,
      sentinels,
      pinned,
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      savedBy: admin._id,
      savedAt: Date.now(),
    });

    // ⚠ **Fill what is missing, not what the save names.** A larger sample, a lake displaced from
    // the sample, a merged sentinel's survivor (its past seasons stay under the loser's id) and a
    // fill request that failed all leave a watched lake without lows; only asking the store finds
    // every one. Scheduled, so the planner reads the version this transaction committed.
    await ctx.scheduler.runAfter(0, internal.seasonWatch.scheduleHistoryFill, {});
    return { version };
  },
});

const RESET_CONFIRMATION = 'reset';

/**
 * Reset a season's watch (D213): move its row whole into `imageryIngestSeasonsSuperseded` so the
 * next daily tick decides it again under the current settings. The weather sweep and live imagery
 * both stand down until it re-opens, which is the point — a reset is how a too-early opening is
 * postponed. The re-sent opening email names the notice it replaces.
 */
export const resetSeason = mutation({
  args: { season: v.string(), confirm: v.string() },
  handler: async (ctx, { season, confirm }) => {
    const admin = await requireContributorRole(ctx, 'admin');
    if (confirm.trim().toLowerCase() !== RESET_CONFIRMATION) {
      throw new ConvexError(`Type "${RESET_CONFIRMATION}" to confirm.`);
    }
    const row = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    if (!row) throw new ConvexError(`No watch is recorded for ${season}.`);
    const { _id, _creationTime, ...fields } = row;
    await ctx.db.insert('imageryIngestSeasonsSuperseded', {
      ...fields,
      supersededAt: Date.now(),
      supersededBy: admin._id,
    });
    await ctx.db.delete(_id);
    return null;
  },
});

async function seasonRow(ctx: MutationCtx, season: string) {
  const row = await ctx.db
    .query('imageryIngestSeasons')
    .withIndex('by_season', (q) => q.eq('season', season))
    .unique();
  if (!row) throw new ConvexError(`No watch is open for ${season}.`);
  return row;
}

/**
 * *Start imagery* (D214): from now until the watch ends, the 6-hourly poll cuts each new pass.
 * Refused once the watch has ended — there is nothing left in season to look for.
 */
export const startImagery = mutation({
  args: { season: v.string() },
  handler: async (ctx, { season }) => {
    const admin = await requireContributorRole(ctx, 'admin');
    const row = await seasonRow(ctx, season);
    if (row.closesOn !== undefined) throw new ConvexError(`The ${season} watch has ended.`);
    await ctx.db.patch(row._id, {
      imageryStartedAt: row.imageryStartedAt ?? Date.now(),
      imageryStartedBy: row.imageryStartedBy ?? admin._id,
      imageryPausedAt: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.imageryLive.poll, {});
    // Pressing *Start* is also how an admin says "I fixed it" — clear any backoff.
    await clearBackoff(ctx, 'pump');
    return null;
  },
});

export const pauseImagery = mutation({
  args: { season: v.string() },
  handler: async (ctx, { season }) => {
    await requireContributorRole(ctx, 'admin');
    const row = await seasonRow(ctx, season);
    await ctx.db.patch(row._id, { imageryPausedAt: Date.now() });
    return null;
  },
});

export const addFieldDate = mutation({
  args: {
    season: v.string(),
    kind: literals(['first_skated', 'last_skated'] as const),
    date: v.string(),
    waterBodyId: v.optional(v.id('waterBodies')),
    place: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireContributorRole(ctx, 'admin');
    try {
      seasonStartYear(args.season);
    } catch {
      throw new ConvexError(`Not a season: ${args.season}.`);
    }
    // A real calendar day (V8 rolls 2027-02-31 over to 3 March), inside the season it is filed under.
    const [y, m, d] = args.date.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    const real =
      /^\d{4}-\d{2}-\d{2}$/.test(args.date) &&
      probe.getUTCFullYear() === y &&
      probe.getUTCMonth() === m - 1 &&
      probe.getUTCDate() === d;
    if (!real) throw new ConvexError('The date must be a real day, YYYY-MM-DD.');
    const year = seasonStartYear(args.season);
    if (args.date < `${year}-07-01` || args.date > `${year + 1}-06-30`) {
      throw new ConvexError(
        `${args.date} is not in ${args.season} (July ${year} – June ${year + 1}).`,
      );
    }
    const place = args.place?.trim();
    const note = args.note?.trim();
    return await ctx.db.insert('seasonFieldDates', {
      season: args.season,
      kind: args.kind,
      date: args.date,
      ...(args.waterBodyId ? { waterBodyId: args.waterBodyId } : {}),
      ...(place ? { place } : {}),
      ...(note ? { note } : {}),
      enteredBy: admin._id,
      enteredAt: Date.now(),
    });
  },
});

export const removeFieldDate = mutation({
  args: { id: v.id('seasonFieldDates') },
  handler: async (ctx, { id }) => {
    await requireContributorRole(ctx, 'admin');
    await ctx.db.delete(id);
    return null;
  },
});

/** The page's *Fill history* button: every season a site the watch reads now has no lows for. */
export const requestHistoryFill = mutation({
  args: {},
  handler: async (ctx) => {
    await requireContributorRole(ctx, 'admin');
    // A fill from nothing is ~6,000 weighted Open-Meteo calls spread over a day and a half; a click
    // during one is told when it ends (a save during one books a re-plan instead).
    const busy = await busyUntil(ctx, FILL_KEY);
    if (busy !== null && busy > Date.now()) {
      throw new ConvexError(
        `A history fill is still running, until ${new Date(busy).toUTCString()}.`,
      );
    }
    // Planned in this same transaction, so the busy mark and the scheduled requests commit
    // together: a second click sees it, and a planner that fails leaves no false hold behind.
    return await planHistoryFill(ctx);
  },
});

// ─── History ────────────────────────────────────────────────────────────────────────────────────

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Sites per archive request: 12 × ~22 weighted calls stays under Open-Meteo's 600-a-minute cap. */
const HISTORY_SITES_PER_REQUEST = 12;

/**
 * Spacing between archive requests. A full fill is ~6,000 weighted calls, and the corpus sweep
 * already spends ~4,300 a day against a free ceiling of 10,000 — so the fill is spread over about a
 * day and a half rather than landing in one hour and starving the sweep.
 */
const HISTORY_SPACING_MS = 75 * 60_000;

/** Spacing for a small fill — at most one request per season — each request a few hundred calls. */
const SMALL_FILL_SPACING_MS = 2 * 60_000;

/**
 * The seasons a fill covers: the current one — once its floor can have come; between July and
 * 1 September it has no night a fill would keep — then every past season.
 */
function fillSeasons(nowMs: number): string[] {
  const current = archiveSeasonAt(nowMs);
  const floor = `${seasonStartYear(current)}-${EARLIEST_START_MONTH_DAY}`;
  return [...(newYorkDate(nowMs) > floor ? [current] : []), ...historySeasons(nowMs)];
}

/**
 * How a fill of `requests` over `seasons` seasons is paced. At most one request a season is small:
 * two minutes apart. More weighs like a fill from nothing on the shared daily Open-Meteo budget:
 * 75 minutes apart.
 */
function fillPacing(requests: number, seasons: number) {
  const large = requests > seasons;
  const spacing = large ? HISTORY_SPACING_MS : SMALL_FILL_SPACING_MS;
  return { large, spacing, spanMs: Math.max(0, requests - 1) * spacing };
}

/** The seasons history covers: the first archive season up to the one before the current. */
export function historySeasons(nowMs: number): string[] {
  const current = seasonStartYear(archiveSeasonAt(nowMs));
  const out: string[] = [];
  for (let y = HISTORY_FIRST_SEASON_YEAR; y < current; y++) out.push(archiveSeasonLabel(y));
  return out;
}

/**
 * Whether a stored season leaves a fill nothing to add. The current season: once it has lows at all
 * (the live watch keeps it up). A past season: once the archive has been over it — a season the
 * live watch kept ends at its close, and the spring a thaw rule replays is still to fill.
 */
export function holdsSeason(
  doc: Pick<Doc<'seasonWatchSeries'>, 'source' | 'archiveFilledAt'> | null,
  isCurrent: boolean,
): boolean {
  if (!doc) return false;
  return isCurrent || doc.source === 'archive' || doc.archiveFilledAt !== undefined;
}

/**
 * Plan a fill of every (site, season) the watch reads that {@link holdsSeason} says lacks lows —
 * which sites, which seasons, and when each request runs — in the caller's transaction. The current
 * season is filled from the forecast endpoint's past days (what the live watch reads), and only once
 * its floor can have come; past seasons from the archive.
 *
 * ⚠ **One fill at a time.** Every fill marks itself busy until its last request. A fill asked for
 * while one runs plans nothing now: it books one re-plan for when that fill ends, which then sees
 * only what the first left lacking — so saves during a fill neither queue its work twice nor
 * stretch its hold. A small fill (at most one request a season) runs two minutes apart; a larger one
 * weighs like a fill from nothing on the shared daily Open-Meteo budget and runs 75 minutes apart.
 */
async function planHistoryFill(
  ctx: MutationCtx,
): Promise<{ requests: number; deferredUntil?: number }> {
  const now = Date.now();
  const busy = await busyUntil(ctx, FILL_KEY);
  // A minute's slack, so the re-plan booked for a fill's end never reads itself as early.
  if (busy !== null && busy > now + 60_000) {
    const booked = await busyUntil(ctx, REPLAN_KEY);
    if (booked === null || booked < busy) {
      await setBusyUntil(ctx, REPLAN_KEY, busy);
      await ctx.scheduler.runAt(busy, internal.seasonWatch.scheduleHistoryFill, {});
    }
    return { requests: 0, deferredUntil: busy };
  }

  const row = await latestSettings(ctx);
  const config = row ? configOf(row) : { version: 0, ...(await defaultConfig(ctx)) };
  const { sites } = await sampleSites(ctx, { ...config, sampleSize: config.settings.sampleSize });
  const current = archiveSeasonAt(now);
  const seasons = fillSeasons(now);

  const requests: { season: string; sites: typeof sites }[] = [];
  for (const season of seasons) {
    const held = new Set<string>(
      await heldIn(
        ctx,
        season,
        sites.map((s) => s.siteId),
        season === current,
      ),
    );
    const lacking = sites.filter((site) => !held.has(site.siteId));
    for (let i = 0; i < lacking.length; i += HISTORY_SITES_PER_REQUEST) {
      requests.push({ season, sites: lacking.slice(i, i + HISTORY_SITES_PER_REQUEST) });
    }
  }
  if (requests.length === 0) return { requests: 0 };

  const { large, spacing, spanMs } = fillPacing(requests.length, seasons.length);
  for (const [i, request] of requests.entries()) {
    await ctx.scheduler.runAfter(i * spacing, internal.seasonWatch.fillSeason, {
      season: request.season,
      sites: request.sites.map((s) => ({
        waterBodyId: s.siteId,
        name: s.name,
        ...(s.state ? { state: s.state } : {}),
        lat: s.lat,
        lng: s.lng,
      })),
    });
  }
  // Busy until the last request has had time to land.
  await setBusyUntil(ctx, FILL_KEY, now + spanMs + (large ? 60 * 60_000 : 10 * 60_000));
  return { requests: requests.length };
}

/** The history fill a settings save asks for (`saveSettings`), and a re-plan a busy fill booked. */
export const scheduleHistoryFill = internalMutation({
  args: {},
  handler: async (ctx) => await planHistoryFill(ctx),
});

/**
 * Which of these sites hold a season ({@link holdsSeason}) — one point lookup each, so the read is
 * the watched sites and nothing else. The planner and `fillSeason` both ask it.
 */
async function heldIn(
  ctx: QueryCtx,
  season: string,
  waterBodyIds: readonly Id<'waterBodies'>[],
  isCurrent: boolean,
): Promise<Id<'waterBodies'>[]> {
  const docs = await Promise.all(
    waterBodyIds.map((id) =>
      ctx.db
        .query('seasonWatchSeries')
        .withIndex('by_season_body', (q) => q.eq('season', season).eq('waterBodyId', id))
        .unique(),
    ),
  );
  return waterBodyIds.filter((_, i) => holdsSeason(docs[i] ?? null, isCurrent));
}

/** {@link heldIn}, for `fillSeason` to ask when it runs. */
export const heldSites = internalQuery({
  args: { season: v.string(), waterBodyIds: v.array(v.id('waterBodies')), isCurrent: v.boolean() },
  handler: async (ctx, { season, waterBodyIds, isCurrent }) =>
    await heldIn(ctx, season, waterBodyIds, isCurrent),
});

interface DailyResponse {
  daily?: { time?: string[]; temperature_2m_min?: (number | null)[] };
}

/** Fill one season for a handful of sites — one Open-Meteo request. */
export const fillSeason = internalAction({
  args: {
    season: v.string(),
    sites: v.array(
      v.object({
        waterBodyId: v.id('waterBodies'),
        name: v.string(),
        state: v.optional(v.string()),
        lat: v.number(),
        lng: v.number(),
      }),
    ),
  },
  handler: async (ctx, { season, sites: planned }) => {
    // Planned perhaps hours ago: fetch only what is still missing when it runs.
    const now = Date.now();
    const isCurrent = archiveSeasonAt(now) === season;
    const held = new Set<string>(
      await ctx.runQuery(internal.seasonWatch.heldSites, {
        season,
        waterBodyIds: planned.map((s) => s.waterBodyId),
        isCurrent,
      }),
    );
    const sites = planned.filter((s) => !held.has(s.waterBodyId));
    if (sites.length === 0) return null;
    const year = seasonStartYear(season);
    const params = new URLSearchParams({
      latitude: sites.map((s) => s.lat.toFixed(4)).join(','),
      longitude: sites.map((s) => s.lng.toFixed(4)).join(','),
      daily: 'temperature_2m_min',
      timezone: 'auto',
      temperature_unit: 'celsius',
    });
    // From the earliest floor the editor accepts (1 September), so a preview can move the floor
    // earlier than October and still have every night the live cron would count.
    const floor = `${year}-${EARLIEST_START_MONTH_DAY}`;
    let days: number;
    if (isCurrent) {
      params.set('past_days', '92');
      params.set('forecast_days', '1');
      days = 93;
    } else {
      params.set('start_date', floor);
      params.set('end_date', `${year + 1}-06-30`);
      days = 303;
    }
    const res = await fetch(`${isCurrent ? FORECAST_URL : ARCHIVE_URL}?${params.toString()}`);
    await ctx.runMutation(internal.weather.recordOpenMeteoCallMutation, {
      weightedCalls: openMeteoCallWeight(1, days) * sites.length,
      nowMs: now,
    });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status} ${res.statusText} filling ${season}`);
    const json = (await res.json()) as DailyResponse | DailyResponse[];
    const rows = Array.isArray(json) ? json : [json];
    await ctx.runMutation(internal.seasonWatch.storeSeries, {
      season,
      source: isCurrent ? 'forecast' : 'archive',
      sites: sites.flatMap((site, i) => {
        const daily = rows[i]?.daily;
        // No answer for this site at all: send nothing, so it is still lacking and asked again.
        if (!daily?.time) return [];
        const mins = daily.temperature_2m_min ?? [];
        return [
          {
            ...site,
            days: daily.time
              .map((date, j) => ({ date, minTempC: mins[j] }))
              // A null low is a gap, not a warm night.
              .filter((d): d is DailyLow => typeof d.minTempC === 'number' && d.date >= floor),
          },
        ];
      }),
    });
    return null;
  },
});

/** What `ingest-window` prints (A06i §7): the recorded watch and the settings, from the deployment. */
export const cliStatus = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) => {
    const row = await latestSettings(ctx);
    const config = row ? configOf(row) : { version: 0, ...(await defaultConfig(ctx)) };
    const record = await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique();
    return { config, record };
  },
});
