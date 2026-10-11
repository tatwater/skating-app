/**
 * The season watch — an ice watch, not a skating season (A06e §3.3 / **D149**; A06i / **D212**–D214).
 *
 * > **D149 — Ingest is weather-gated, and the archive turns over on the first frame of the new
 * > season, never on a date.**
 *
 * ## What this does
 *
 * Once a day from the settings' floor (1 October by default), this fetches observed overnight lows
 * at the sentinels, the pinned sites and a sample of prominent lakes, **keeps them**
 * (`seasonWatchSeries`, A06i §3), and asks `evaluateSeason` — the same function `/admin/seasons`
 * previews with — whether the watch has opened. Once open it keeps ticking for three more facts,
 * each recorded once: the first 20 °F sentinel night (the imagery reminder), the night winter set in
 * region-wide, and the end of the watch. Each queues a staff email, and at most one goes out a day.
 *
 * ## What it deliberately does not do
 *
 * **It does not start the imagery.** An admin presses *Start imagery* on `/admin/seasons` (D214);
 * from then `imageryLive.poll` cuts each new pass every 6 hours until the watch ends. The cron's job
 * is to notice and to say so.
 *
 * ## Why a floor at all
 *
 * The summit triggers can register a freeze on Mt Washington in August. The floor is a cheap outer
 * bound on nonsense, not a second gate.
 *
 * > **Founder, 2026-08-25:** *"let's start that cron in October instead — I don't think anyone skates
 * > anywhere before November, so an Oct 1 start gives us plenty of time to catch extended freezing
 * > temps long enough to start forming ice anywhere."*
 *
 * ## ⚠ The asymmetry that licenses the whole design
 *
 * An over-eager gate costs a few dollars of granule reads. A late one **misses freeze-up entirely** —
 * the single most valuable frame of the season, gone, with nothing to say it was ever there. The
 * defaults lean early on purpose; whether they lean *too* early is what the settings page is for.
 */

import {
  archiveSeasonAt,
  clipToFloor,
  dailyLowsFromOpenMeteo,
  evaluateSeason,
  expandLows,
  firstSentinelNightAtOrBelow,
  type SeasonWatchSettings,
  type SiteLow,
  type SiteSeries,
  seasonFloorDate,
  thawClose,
  winterOnOrAfter,
} from '@skating/core';
import { type Infer, v } from 'convex/values';

import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import { lastUsedOn, markUsedOn } from './lib/dailyThrottle';
import { fetchHourlyRows, openMeteoMeter } from './lib/openMeteoHourly';
import { composeSeasonEmail, newYorkDate, type SeasonEmail } from './lib/seasonWatchEmails';
import {
  namedSiteLow,
  openingDetail,
  rosterSite,
  seasonWatchSettings,
} from './lib/seasonWatchValidators';

type NamedSiteLow = Infer<typeof namedSiteLow>;

/** Open-Meteo's `past_days` ceiling, matching `weather.ts`. */
const MAX_PAST_DAYS = 92;

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** The recorded verdict for a season, or `null` if we have not decided one yet. */
export const seasonRecord = internalQuery({
  args: { season: v.string() },
  handler: async (ctx, { season }) =>
    await ctx.db
      .query('imageryIngestSeasons')
      .withIndex('by_season', (q) => q.eq('season', season))
      .unique(),
});

async function rowFor(ctx: MutationCtx, season: string) {
  return await ctx.db
    .query('imageryIngestSeasons')
    .withIndex('by_season', (q) => q.eq('season', season))
    .unique();
}

/** Queue an email with the settings that decided its fact, so its copy states the rule that fired. */
function enqueue(
  row: Doc<'imageryIngestSeasons'>,
  email: SeasonEmail,
  settings: SeasonWatchSettings | undefined,
) {
  return [
    ...(row.emailQueue ?? []),
    { email, queuedAt: Date.now(), ...(settings ? { settings } : {}) },
  ];
}

/**
 * Record the date a season closed, once, and queue the closing email.
 *
 * ⚠ **Only ever set on a row that has none.** Ice-out is a one-way door within a season: a late cold
 * snap after ten thawed days does not un-close it, and letting a later tick move the date would make
 * the field a description of the last time we looked rather than of the melt.
 */
export const recordSeasonClose = internalMutation({
  args: {
    season: v.string(),
    closesOn: v.string(),
    sitesSampled: v.optional(v.number()),
    settings: v.optional(seasonWatchSettings),
  },
  handler: async (ctx, { season, closesOn, sitesSampled, settings }) => {
    const row = await rowFor(ctx, season);
    if (!row || row.closesOn !== undefined) return null;
    await ctx.db.patch(row._id, {
      closesOn,
      closedAt: Date.now(),
      emailQueue: enqueue(
        row,
        { kind: 'closed', date: closesOn, sitesSampled: sitesSampled ?? row.sitesSampled },
        settings,
      ),
    });
    return row._id;
  },
});

/**
 * Fill in `winterFrom` on a season that was opened before the region itself froze, and queue the
 * winter email.
 *
 * ⚠ **Without this the close can never fire in the common case.** A sentinel opens a season weeks
 * before a majority of ordinary sites freeze, so the first tick routinely writes `winterFrom: null`;
 * ice-in is a fact that arrives *after* opening, so it has to be writable after opening. **Only ever
 * set on a row that has none**, for the same one-way-door reason as the close.
 */
export const recordSeasonWinterFrom = internalMutation({
  args: {
    season: v.string(),
    winterFrom: v.string(),
    frozen: v.optional(v.array(namedSiteLow)),
    reporting: v.optional(v.number()),
    settings: v.optional(seasonWatchSettings),
  },
  handler: async (ctx, { season, winterFrom, frozen, reporting, settings }) => {
    const row = await rowFor(ctx, season);
    if (!row || row.winterFrom !== null) return null;
    const winter = { frozen: frozen ?? [], reporting: reporting ?? 0 };
    await ctx.db.patch(row._id, {
      winterFrom,
      winter,
      emailQueue: enqueue(row, { kind: 'winter', date: winterFrom, ...winter }, settings),
    });
    return row._id;
  },
});

/**
 * Record the first sentinel night at or below the imagery line, once (A06i §4). The reminder email is
 * queued only if nobody has started the imagery yet — telling someone to start what is running is
 * noise.
 */
export const recordImageryNudge = internalMutation({
  args: {
    season: v.string(),
    date: v.string(),
    sites: v.array(namedSiteLow),
    settings: v.optional(seasonWatchSettings),
  },
  handler: async (ctx, { season, date, sites, settings }) => {
    const row = await rowFor(ctx, season);
    if (!row || row.imageryNudgeOn !== undefined) return null;
    await ctx.db.patch(row._id, {
      imageryNudgeOn: date,
      imageryNudgeSites: sites,
      ...(row.imageryStartedAt === undefined
        ? { emailQueue: enqueue(row, { kind: 'imagery', date, sites }, settings) }
        : {}),
    });
    return row._id;
  },
});

/**
 * Fill in what the winter night measured on a row whose winter was recorded before A06i kept it —
 * the legacy winter-2026-27 row, whose 7 October 2026 was written by the old tick. Detail only: no
 * email is queued for a fact days old, which the old code had already decided without one.
 */
export const recordWinterDetail = internalMutation({
  args: { season: v.string(), frozen: v.array(namedSiteLow), reporting: v.number() },
  handler: async (ctx, { season, frozen, reporting }) => {
    const row = await rowFor(ctx, season);
    if (!row || row.winterFrom === null || row.winter !== undefined) return null;
    await ctx.db.patch(row._id, { winter: { frozen, reporting } });
    return row._id;
  },
});

/**
 * Fill in what the opening night measured on a row opened before A06i recorded it — the legacy
 * winter-2026-27 row, opened 3 October 2026 with only the word `sentinel` to show for it.
 */
export const recordOpeningDetail = internalMutation({
  args: {
    season: v.string(),
    sentinels: v.array(namedSiteLow),
    corpus: v.object({ frozen: v.number(), reporting: v.number() }),
  },
  handler: async (ctx, { season, sentinels, corpus }) => {
    const row = await rowFor(ctx, season);
    if (!row || row.opening !== undefined) return null;
    await ctx.db.patch(row._id, { opening: { sentinels, corpus } });
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
    settingsVersion: v.optional(v.number()),
    settings: v.optional(seasonWatchSettings),
    sentinels: v.optional(v.array(rosterSite)),
    opening: v.optional(openingDetail),
    winter: v.optional(v.object({ frozen: v.array(namedSiteLow), reporting: v.number() })),
    imageryNudge: v.optional(v.object({ date: v.string(), sites: v.array(namedSiteLow) })),
  },
  handler: async (ctx, { imageryNudge, ...args }) => {
    // Idempotent by season. The cron ticks daily and a season opens once; re-running after a partial
    // failure must not produce a second row claiming a different date.
    //
    // ⚠ **`created` is what the staff email is gated on**, and it has to come from here rather than
    // from the caller's control flow: "did this tick actually open the season" is a property of the
    // write, and deciding it upstream is how a retried tick mails everyone a second time.
    const existing = await rowFor(ctx, args.season);
    if (existing) return { id: existing._id, created: false };

    const superseded = await ctx.db
      .query('imageryIngestSeasonsSuperseded')
      .withIndex('by_season', (q) => q.eq('season', args.season))
      .order('desc')
      .first();
    const now = Date.now();
    const queue: SeasonEmail[] = [
      {
        kind: 'opened',
        date: args.opensOn,
        sentinels: args.opening?.sentinels ?? [],
        corpus: args.opening?.corpus ?? { frozen: 0, reporting: args.sitesSampled },
        ...(superseded
          ? { replaces: { opensOn: superseded.opensOn, detectedAt: superseded.detectedAt } }
          : {}),
      },
    ];
    // Everything a first tick can already see, in the order it happened — one a day from here.
    if (imageryNudge) queue.push({ kind: 'imagery', ...imageryNudge });
    if (args.winterFrom && args.winter) {
      queue.push({ kind: 'winter', date: args.winterFrom, ...args.winter });
    }
    const id = await ctx.db.insert('imageryIngestSeasons', {
      ...args,
      ...(imageryNudge
        ? { imageryNudgeOn: imageryNudge.date, imageryNudgeSites: imageryNudge.sites }
        : {}),
      detectedAt: now,
      // Everything this tick queues was decided under the settings it opened with.
      emailQueue: queue.map((email) => ({
        email,
        queuedAt: now,
        ...(args.settings ? { settings: args.settings } : {}),
      })),
    });
    return { id, created: true };
  },
});

/**
 * The day the last watch email went, kept outside the season rows: a reset moves its row to the
 * superseded table, and the day's mark must not go with it, or a reopening the same day would send a
 * second email (D212).
 */
const WATCH_EMAIL_KEY = 'season-watch-email';

/**
 * Send the next queued staff email, if none has gone out today (D212: never two on one day).
 *
 * The send is scheduled **inside** this mutation, so "taken off the queue" and "sent" commit
 * together — a retried tick cannot mail anyone twice, and a failed one loses nothing. An imagery
 * reminder whose imagery has since been started is dropped without spending the day's slot.
 */
export const sendNextEmail = internalMutation({
  args: { today: v.string() },
  handler: async (ctx, { today }): Promise<{ sent: string | null }> => {
    const rows = await ctx.db.query('imageryIngestSeasons').take(50);
    if ((await lastUsedOn(ctx, WATCH_EMAIL_KEY)) === today) return { sent: null };
    if (rows.some((r) => r.lastEmailOn === today)) return { sent: null };
    const settingsRow = await ctx.db
      .query('seasonWatchSettings')
      .withIndex('by_version')
      .order('desc')
      .first();

    // Oldest season first, so a closing email from last winter goes before anything from this one.
    for (const row of rows.sort((a, b) => a.season.localeCompare(b.season))) {
      const queue = [...(row.emailQueue ?? [])];
      while (queue.length > 0) {
        const next = queue.shift() as (typeof queue)[number];
        if (next.email.kind === 'imagery' && row.imageryStartedAt !== undefined) continue;
        // The settings that decided this email's fact; then the opening's, for one queued before
        // entries carried their own; then the current version.
        const settings: SeasonWatchSettings | undefined =
          next.settings ?? row.settings ?? settingsRow?.settings;
        // No settings anywhere means `ensureSettings` has never run — leave everything queued.
        if (!settings) return { sent: null };
        const sentinels = row.sentinels ?? settingsRow?.sentinels ?? [];
        const composed = composeSeasonEmail(next.email, {
          season: row.season,
          settings,
          sentinelNames: sentinels.map((s) => s.name),
        });
        await markUsedOn(ctx, WATCH_EMAIL_KEY, today);
        await ctx.db.patch(row._id, {
          emailQueue: queue,
          lastEmailOn: today,
          emailsSent: [
            ...(row.emailsSent ?? []),
            { kind: next.email.kind, sentOn: today, sentAt: Date.now() },
          ],
        });
        await ctx.scheduler.runAfter(0, internal.operatorAlerts.broadcastToStaff, {
          subject: composed.subject,
          heading: composed.heading,
          blocks: composed.blocks,
          deepLinkPath: '/admin/seasons',
        });
        return { sent: next.email.kind };
      }
      // Only dropped reminders left: clear them so they are not walked again tomorrow.
      if ((row.emailQueue ?? []).length > 0) await ctx.db.patch(row._id, { emailQueue: [] });
    }
    return { sent: null };
  },
});

interface GateSite {
  siteId: Id<'waterBodies'>;
  sentinel: boolean;
  name: string;
  state?: string;
  lat: number;
  lng: number;
}

/**
 * Observed daily lows for every site, in one request.
 *
 * ⚠ **Observed, never forecast** — D140. Open-Meteo's *forecast* endpoint with `past_days` is the
 * right source anyway: the ERA5 archive lags ~5 days, so an archive-backed gate opens the season the
 * better part of a week late, which is the expensive direction.
 *
 * ⚠ **Hourly, and the days are cut here.** `daily=temperature_2m_min` cuts every day at the offset in
 * force when the request is made, so a November tick split every October day at the wrong midnight.
 * `dailyLowsFromOpenMeteo` cuts them by the zone — the same cut the history fill stores.
 *
 * Multi-coordinate form, a few sites a request (`lib/openMeteoHourly`).
 */
async function fetchDailyLows(ctx: ActionCtx, sites: readonly GateSite[]) {
  const params = new URLSearchParams({
    hourly: 'temperature_2m',
    past_days: String(MAX_PAST_DAYS),
    forecast_days: '1',
    timezone: 'auto',
    timeformat: 'unixtime',
    temperature_unit: 'celsius',
  });
  const fetched = await fetchHourlyRows(
    OPEN_METEO_URL,
    params,
    sites,
    MAX_PAST_DAYS + 1,
    openMeteoMeter(ctx, MAX_PAST_DAYS + 1),
  );
  // ⚠ **All of the sample or none of it.** Deciding on the sites that answered would shrink the
  // sample, and a shrinking sample is how one freezing pond comes to clear `corpusFraction` alone.
  // A failed tick is retried tomorrow; its email still goes (the `finally` above).
  if (fetched.failed > 0) {
    throw new Error(`${fetched.lastError} (${fetched.failed} of ${fetched.requests} requests)`);
  }
  const rows = fetched.rows;

  return sites.map((site, i) => ({
    site,
    // A null reading is a gap in the record, not a warm hour, and a day short of readings is
    // dropped, so the site abstains for it. Today's low — still a forecast — is dropped where every
    // low is stored (`seasonWatch.storeSeries`).
    days: dailyLowsFromOpenMeteo(rows[i], site.lng),
  }));
}

/**
 * What a tick decided.
 *
 * ⚠ **Written out rather than inferred, and it has to be.** `maybeCheckSeasonOpen` calls
 * `internal.imageryIngest.*` — its own module — so letting TypeScript infer the return type makes the
 * type depend on `_generated/api.d.ts`, which imports this file. TypeScript resolves that circularity
 * by widening `DataModel`, and ~456 errors appear in files this one never touches (2026-08-25).
 */
type SeasonWatchResult =
  | {
      skipped: 'before the floor' | 'already recorded' | 'no sites' | 'no observations';
      season: string;
      opensOn?: string;
    }
  | { open: false; season: string; sitesSampled: number }
  | { open: true; season: string; opensOn: string; openedBy: string[] }
  | { closed: true; season: string; closesOn: string };

/**
 * The daily tick.
 *
 * A daily interval with a gate rather than a `crons.cron` expression, matching
 * `recurrence.maybeRunRollover` — it keeps `crons.ts` uniform and makes the check **retryable**: a
 * tick that fails on 12 October is picked up on the 13th.
 */
export const maybeCheckSeasonOpen = internalAction({
  args: {},
  handler: async (ctx): Promise<SeasonWatchResult> => {
    const nowMs = Date.now();
    try {
      return await tick(ctx, nowMs);
    } finally {
      // Whatever is queued — including what this tick just found — goes out last, one a day (D212),
      // and even when the tick itself failed: a dead weather API must not hold back yesterday's news.
      await ctx.runMutation(internal.imageryIngest.sendNextEmail, { today: newYorkDate(nowMs) });
    }
  },
});

async function tick(ctx: ActionCtx, nowMs: number): Promise<SeasonWatchResult> {
  const today = newYorkDate(nowMs);

  // D63's July boundary, via the one definition of the label. `bakeMasks` names the mask artifact
  // with the same function, so a cut and the row recording why it happened cannot disagree.
  const season = archiveSeasonAt(nowMs);
  const config: WatchConfigLike = await ctx.runMutation(internal.seasonWatch.ensureSettings, {});
  const { settings } = config;

  // ⚠ The floor is on the *calendar*, not on the season label: between July and the floor the
  // label already reads `winter-YYYY-YY` and a summit can freeze.
  const floor = seasonFloorDate(season, settings.startMonthDay);
  if (today < floor) return { skipped: 'before the floor' as const, season };

  // ⚠ **An opened season is not a finished one — the tick keeps running to find the close.**
  // Imagery and A06h's weather sweep (D161) both stand down only on `closesOn`.
  const already: Doc<'imageryIngestSeasons'> | null = await ctx.runQuery(
    internal.imageryIngest.seasonRecord,
    { season },
  );
  if (already?.closesOn !== undefined) {
    return { skipped: 'already recorded' as const, season, opensOn: already.opensOn };
  }

  const sites: GateSite[] = await ctx.runQuery(internal.seasonWatch.gateSites, {
    sentinels: config.sentinels,
    pinned: config.pinned,
    sampleSize: settings.sampleSize,
  });
  if (sites.length === 0) return { skipped: 'no sites' as const, season };

  const fetched = await fetchDailyLows(ctx, sites);
  await ctx.runMutation(internal.seasonWatch.storeSeries, {
    season,
    source: 'forecast',
    sites: fetched
      .filter((f) => f.days.length > 0)
      .map(({ site, days }) => ({
        waterBodyId: site.siteId,
        name: site.name,
        ...(site.state ? { state: site.state } : {}),
        lat: site.lat,
        lng: site.lng,
        days,
      })),
  });

  // Decide on everything stored this season for the sites sampled now — so a decision can see
  // further back than one 92-day fetch, and a site dropped from the roster no longer votes.
  const stored: Doc<'seasonWatchSeries'>[] = await ctx.runQuery(internal.seasonWatch.seasonSeries, {
    season,
  });
  const byId = new Map(sites.map((s) => [s.siteId as string, s]));
  const series: SiteSeries[] = stored
    .filter((d) => byId.has(d.waterBodyId))
    .map((d) => ({
      siteId: d.waterBodyId,
      ...(byId.get(d.waterBodyId)?.sentinel ? { sentinel: true } : {}),
      days: expandLows(d),
    }));
  const clipped = clipToFloor(series, floor);
  if (clipped.length === 0) return { skipped: 'no observations' as const, season };

  const named = (lows: readonly SiteLow[]): NamedSiteLow[] =>
    lows.map(({ siteId, lowC }) => {
      const site = byId.get(siteId);
      return {
        waterBodyId: siteId as Id<'waterBodies'>,
        name: site?.name ?? siteId,
        ...(site?.state ? { state: site.state } : {}),
        lowC,
      };
    });

  if (!already) return await openIfDue(ctx, { season, config, clipped, named });
  return await followOpenSeason(ctx, { season, settings, already, clipped, named });
}

interface WatchConfigLike {
  version: number;
  settings: SeasonWatchSettings;
  sentinels: Infer<typeof rosterSite>[];
  pinned: Infer<typeof rosterSite>[];
}

interface Evaluated {
  season: string;
  clipped: SiteSeries[];
  named: (lows: readonly SiteLow[]) => NamedSiteLow[];
}

/** The not-yet-open branch: evaluate the whole season and record the opening if it has come. */
async function openIfDue(
  ctx: ActionCtx,
  { season, config, clipped, named }: Evaluated & { config: WatchConfigLike },
): Promise<SeasonWatchResult> {
  const { settings } = config;
  const evaluation = evaluateSeason(clipped, settings, season);
  if (!evaluation.opensOn || !evaluation.opening) {
    return { open: false as const, season, sitesSampled: clipped.length };
  }
  await ctx.runMutation(internal.imageryIngest.recordSeasonOpen, {
    season,
    opensOn: evaluation.opensOn,
    openedBy: evaluation.openedBy,
    winterFrom: evaluation.winterFrom,
    sitesSampled: clipped.length,
    settingsVersion: config.version,
    settings,
    sentinels: config.sentinels,
    opening: {
      sentinels: named(evaluation.opening.sentinels),
      corpus: evaluation.opening.corpus,
    },
    ...(evaluation.winter
      ? {
          winter: {
            frozen: named(evaluation.winter.frozen),
            reporting: evaluation.winter.reporting,
          },
        }
      : {}),
    ...(evaluation.imageryNudge
      ? {
          imageryNudge: {
            date: evaluation.imageryNudge.date,
            sites: named(evaluation.imageryNudge.sites),
          },
        }
      : {}),
  });
  // The operator-facing log line. The staff email is queued by the write itself.
  console.warn(
    `[season watch] ${season} ice watch OPENED on ${evaluation.opensOn} ` +
      `(by ${evaluation.openedBy.join('+')}, ${clipped.length} sites).`,
  );
  return {
    open: true as const,
    season,
    opensOn: evaluation.opensOn,
    openedBy: evaluation.openedBy,
  };
}

/**
 * The open branch: fill in what the season has reached since — each fact once, under today's
 * settings, measured from the **recorded** opening.
 */
async function followOpenSeason(
  ctx: ActionCtx,
  {
    season,
    settings,
    already,
    clipped,
    named,
  }: Evaluated & { settings: SeasonWatchSettings; already: Doc<'imageryIngestSeasons'> },
): Promise<SeasonWatchResult> {
  const options = {
    freezeC: settings.freezeC,
    winterFraction: settings.winterFraction,
    thawC: settings.thawC,
    thawRunDays: settings.thawRunDays,
  };

  // The opening night's detail, for a row opened before A06i recorded it.
  if (already.opening === undefined) {
    const lowOn = (s: SiteSeries) => s.days.find((d) => d.date === already.opensOn)?.minTempC;
    const night = clipped.filter((s) => lowOn(s) !== undefined);
    if (night.length > 0) {
      const fired = night
        .filter((s) => s.sentinel && (lowOn(s) as number) <= settings.freezeC)
        .map((s) => ({ siteId: s.siteId, lowC: lowOn(s) as number }))
        .sort((a, b) => a.lowC - b.lowC);
      const ordinary = night.filter((s) => !s.sentinel);
      await ctx.runMutation(internal.imageryIngest.recordOpeningDetail, {
        season,
        sentinels: named(fired),
        corpus: {
          frozen: ordinary.filter((s) => (lowOn(s) as number) <= settings.freezeC).length,
          reporting: ordinary.length,
        },
      });
    }
  }

  // The winter night's detail, for a row whose winter the old tick recorded without it.
  if (already.winterFrom !== null && already.winter === undefined) {
    const on = already.winterFrom;
    const ordinary = clipped
      .filter((s) => !s.sentinel)
      .map((s) => ({ siteId: s.siteId, low: s.days.find((d) => d.date === on)?.minTempC }))
      .filter((s): s is { siteId: string; low: number } => s.low !== undefined);
    if (ordinary.length > 0) {
      await ctx.runMutation(internal.imageryIngest.recordWinterDetail, {
        season,
        frozen: named(
          ordinary
            .filter((s) => s.low <= settings.freezeC)
            .map((s) => ({ siteId: s.siteId, lowC: s.low }))
            .sort((a, b) => a.lowC - b.lowC),
        ),
        reporting: ordinary.length,
      });
    }
  }

  // The imagery reminder — looked for from the recorded opening.
  if (already.imageryNudgeOn === undefined) {
    const nudge = firstSentinelNightAtOrBelow(clipped, settings.imageryNudgeC, already.opensOn);
    if (nudge) {
      await ctx.runMutation(internal.imageryIngest.recordImageryNudge, {
        season,
        date: nudge.date,
        sites: named(nudge.sites),
        settings,
      });
    }
  }

  // ⚠ **Winter from the RECORDED opening**, not from a re-run of the opening rule: after a stricter
  // edit that re-run could land later or nowhere, and a season plainly in winter would never close.
  let winterFrom = already.winterFrom;
  if (winterFrom === null) {
    const winter = winterOnOrAfter(clipped, already.opensOn, options);
    if (winter) {
      await ctx.runMutation(internal.imageryIngest.recordSeasonWinterFrom, {
        season,
        winterFrom: winter.date,
        frozen: named(winter.frozen),
        reporting: winter.reporting,
        settings,
      });
      winterFrom = winter.date;
      console.warn(`[season watch] ${season} winter established region-wide on ${winter.date}`);
    }
  }
  if (winterFrom === null) {
    return { skipped: 'already recorded' as const, season, opensOn: already.opensOn };
  }

  // The close, against the RECORDED winterFrom: by the spring tick that would close a season, the
  // date the region froze may be months back — see `thawClose`.
  const closesOn = thawClose(clipped, winterFrom, options);
  if (!closesOn) {
    return { open: true as const, season, opensOn: already.opensOn, openedBy: already.openedBy };
  }
  const wrote = await ctx.runMutation(internal.imageryIngest.recordSeasonClose, {
    season,
    closesOn,
    sitesSampled: clipped.filter((s) => !s.sentinel).length,
    settings,
  });
  // Logged only on the write that actually closed it — a racing tick prints nothing.
  if (wrote !== null) {
    console.warn(
      `[season watch] ${season} ice watch ENDED on ${closesOn} (${clipped.length} sites, ` +
        `${settings.thawRunDays} thawed days). Imagery and the weather sweep stand down.`,
    );
  }
  return { closed: true as const, season, closesOn };
}
