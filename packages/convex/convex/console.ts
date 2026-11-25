/**
 * The Overview's counts (B01 §5.1): every Inbox lane, the People column and the Corpus card's tasks,
 * counted honestly.
 *
 * Today's dashboard counts four of about twelve queues. This counts every lane a person filed into,
 * each through an index, each capped: a lane past {@link COUNT_CAP} reads "200+" rather than
 * scanning (the read is `take(cap + 1)`, bounded however large the table grows). The intake reasons
 * are `waterBodies.reviewQueueCounts`; Machinery's jobs are `machinery.overviewJobs`.
 *
 * Also here: the colleague heartbeat and who else on staff is in the console (the top bar's faces),
 * and the machine's own events for the audit feed.
 */

import {
  COUNT_CAP,
  type Count,
  callerNow,
  cappedCount,
  type InboxLane,
  roleMeets,
} from '@skating/core';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { inboxPending } from './inboxItems';
import { hasCapability, isLockedOut, requireCapability } from './lib/auth';
import { countDedupDecisions } from './lib/dedupQueue';
import { readInboxLanes } from './lib/inboxViews';
import { readOpenFlags } from './lib/openFlags';
import { peopleCardFigures } from './lib/peopleFigures';

export type { Count };

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    const now = Date.now();

    // ── Inbox: the stored items' counts (B01-5) — the lanes' own read, so the card and the
    // Inbox's lanes agree by construction; one item per question, never per flag or per ask.
    const supportRead = hasCapability(viewer, 'inbox.support.read');
    const figures = await readInboxLanes(ctx, { support: supportRead, dayStart: null });
    const laneCount = (lane: InboxLane): Count => ({
      count: figures.lanes.find((l) => l.lane === lane)?.open ?? 0,
      capped: false,
    });
    const oldests = figures.lanes
      .map((l) => l.oldestFiledAt)
      .filter((at): at is number => at !== null);

    // Metrics' flag figures and the People card still read the open flags themselves.
    const { flags, capped: flagsCapped } = await readOpenFlags(ctx, COUNT_CAP);

    // ── People: the People lanes' own reads (`lib/peopleFigures`), so the card and the lanes agree ──
    const people = await peopleCardFigures(
      ctx,
      now,
      { flags, capped: flagsCapped },
      hasCapability(viewer, 'inbox.support.read'),
    );

    return {
      inbox: {
        safety: laneCount('safety'),
        accessReports: laneCount('accessReports'),
        requests: laneCount('requests'),
        placesAsked: laneCount('placesAsked'),
        drawnBodies: laneCount('drawnBodies'),
        contentFlags: laneCount('contentFlags'),
        support: supportRead ? laneCount('support') : null,
        oldestOpenAt: oldests.length > 0 ? Math.min(...oldests) : null,
        // When the median open item was filed, for the client to age on its own clock; `null` past
        // the lanes' median read (the oldest two hundred are not the queue).
        medianOpenedAt: figures.medianFiledAt,
        // The items' backfill not yet concluded: the stored counts may be short, so the card draws
        // no figure — the same fact `inbox.lanes` serves, read from the same job row.
        pending: await inboxPending(ctx),
      },
      people,
    };
  },
});

// ── The Corpus card's tasks ─────────────────────────────────────────────────────────────────────

/**
 * How far back the last campaign's read looks past legacy retire rows. Retirements follow a load one
 * to a campaign, so a run of more than a couple between two loads would be an operator re-running
 * it; past this many the read answers `null` for that kind rather than scan.
 */
const LEGACY_RETIRE_LOOKBACK = 20;

/**
 * A `retire-absorbed` row written before it had its own kind: `canonical_water`, labeled by
 * `scripts/etl/src/retireAbsorbed.ts` (with " (dry run)" after a dry one). It folds rows away, so it
 * is no campaign's load.
 */
function isLegacyRetireRow(run: { kind: string; label: string }): boolean {
  return run.kind === 'canonical_water' && run.label.startsWith('retire absorbed duplicates');
}

/**
 * The Corpus card's tasks that `waterBodies.reviewQueueCounts` doesn't count (B01 §5.1). Its own
 * query, not part of `overview`: these change when a campaign runs or a moderator decides, and
 * `overview` re-runs on every flag filed — a body row carries its outline, so re-reading them on
 * every flag would be the expensive half of the Overview for nothing.
 *
 * - `duplicates` — the dedup queue's `total`, from the queue's own read: rows that name each other
 *   are one merge-or-keep, not two rows (the register's S4), and a body D36 flagged on create counts
 *   the same as one a campaign flagged.
 * - `chordRefits` — bays whose mouth a moved shoreline re-fitted or left stale (D215), across bodies.
 * - `placeNames` — place names from the email groups still open (D202).
 * - `campaignAt` — when the last corpus run started (a merge or a canonical load; never a
 *   retirement of absorbed rows, which is a cleanup after one).
 * - `preIcePass` and `enrichment` are `null`: no record says when the pre-ice pass was done, and
 *   nothing indexes a body by the enrichment it lacks. Each is drawn *Not recorded yet*, never zero.
 */
export const corpusCounts = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, 'corpus.read');

    // The dedup queue's own read and grouping, so this is its `total` by construction. Only the
    // candidates that can change the number are fetched: not every candidate's outline, and not a
    // subscription to every popular lake a drawn pond was matched against.
    const dedup = await countDedupDecisions(ctx);

    // A bay can be both re-fitted and stale; it is one re-fit to look at.
    const refits = new Set<Id<'waterBodySubAreas'>>();
    let refitsCapped = false;
    for (const outcome of ['kept', 'refitted'] as const) {
      const page = await ctx.db
        .query('waterBodySubAreas')
        .withIndex('by_mouth_review', (q) => q.eq('mouthReview.outcome', outcome))
        .take(COUNT_CAP + 1);
      refitsCapped ||= page.length > COUNT_CAP;
      for (const bay of page) refits.add(bay._id);
    }
    // `mouthStale` is optional: the lower bound keeps the range off every row without one.
    const stale = await ctx.db
      .query('waterBodySubAreas')
      .withIndex('by_mouth_stale', (q) => q.gt('mouthStale', ''))
      .take(COUNT_CAP + 1);
    refitsCapped ||= stale.length > COUNT_CAP;
    for (const bay of stale) refits.add(bay._id);

    const names = await ctx.db
      .query('corpusPlaceNames')
      .withIndex('by_status_messages', (q) => q.eq('status', 'open'))
      .take(COUNT_CAP + 1);

    // The last campaign: its merge or its load. `retire-absorbed` has its own kind since B01-6a
    // (`absorbed_retire`), so it is not read here; the rows it wrote before that sit under
    // `canonical_water` with their own label, and are passed over by it (`isLegacyRetireRow`).
    let campaignAt: number | null = null;
    for (const kind of ['corpus_merge', 'canonical_water'] as const) {
      const recent = await ctx.db
        .query('importRuns')
        .withIndex('by_kind_started', (q) => q.eq('kind', kind))
        .order('desc')
        .take(LEGACY_RETIRE_LOOKBACK);
      const last = recent.find((run) => !isLegacyRetireRow(run));
      if (last && (campaignAt === null || last.startedAt > campaignAt)) campaignAt = last.startedAt;
    }

    return {
      // A queue read that stopped short leaves a floor, and the figure says so.
      duplicates: {
        count: Math.min(dedup.count, COUNT_CAP),
        capped: dedup.truncated || dedup.count > COUNT_CAP,
      },
      chordRefits: {
        count: Math.min(refits.size, COUNT_CAP),
        capped: refitsCapped || refits.size > COUNT_CAP,
      },
      placeNames: cappedCount(names.length),
      preIcePass: null,
      enrichment: null,
      campaignAt,
    };
  },
});

// ── Colleague presence (the top bar's faces) ────────────────────────────────────────────────────

/**
 * How often a console page says it is open. The client sends a heartbeat on this interval while a
 * console page is visible; the server writes at most one per interval per person, whatever the
 * client sends.
 */
export const PRESENCE_HEARTBEAT_MS = 60_000;

/** Seen within this, a colleague is *on a console page now* (lit): two missed beats and a margin. */
export const PRESENCE_LIVE_MS = 2.5 * PRESENCE_HEARTBEAT_MS;

/** Seen within this, a colleague is *idle* (dim); longer than this, they are not shown. */
export const PRESENCE_IDLE_MS = 15 * 60_000;

/** The most colleagues the read returns: the top bar folds the rest into "+N" long before this. */
const PRESENCE_READ_LIMIT = 50;

/**
 * Say the caller is in the console. One small write a heartbeat interval at most: a beat that comes
 * inside half an interval of the last one writes nothing, so a page open in two tabs costs no more
 * than one. Staff only (`console.presence`), and nothing but the instant is kept.
 */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireCapability(ctx, 'console.presence');
    const now = Date.now();
    const row = await ctx.db
      .query('consolePresence')
      .withIndex('by_user', (q) => q.eq('userId', viewer._id))
      .first();
    if (row === null) {
      await ctx.db.insert('consolePresence', { userId: viewer._id, seenAt: now });
      return null;
    }
    if (now - row.seenAt >= PRESENCE_HEARTBEAT_MS / 2) await ctx.db.patch(row._id, { seenAt: now });
    return null;
  },
});

/**
 * Who else on staff is in the console: seen within the idle window, newest first, the viewer left
 * out. `present` is whether they were seen within the live window (on a console page now); the rest
 * are idle. Anyone no longer staff, or locked out, is skipped even with a row.
 *
 * `now` is the caller's clock, rounded by the client to the heartbeat interval: a query is cached on
 * the rows it reads, so it is the argument that moves an idle colleague out as time passes. It is
 * clamped to the server's clock, so a skewed client can't widen the window into the past or future.
 */
export const colleagues = query({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'console.colleagues');
    const now = callerNow(args.now, Date.now(), PRESENCE_HEARTBEAT_MS);
    const rows = await ctx.db
      .query('consolePresence')
      .withIndex('by_seen_at', (q) => q.gte('seenAt', now - PRESENCE_IDLE_MS))
      .order('desc')
      .take(PRESENCE_READ_LIMIT);
    const out: Array<{ id: Id<'profiles'>; name: string; src: string | null; present: boolean }> =
      [];
    for (const row of rows) {
      if (row.userId === viewer._id) continue;
      const person = await ctx.db.get(row.userId);
      if (!person || !roleMeets(person.role, 'moderator') || isLockedOut(person)) continue;
      out.push({
        id: person._id,
        name: person.displayName.trim() || person.username,
        src: person.profileImageUrl ?? null,
        present: now - row.seenAt <= PRESENCE_LIVE_MS,
      });
    }
    return out;
  },
});

// ── The machine's events, for the audit feed ────────────────────────────────────────────────────

/** The most rows the feed asks for. */
const SYSTEM_FEED_MAX = 100;

/** Imagery runs looked through for the failures among them (the pump beats every few minutes). */
const IMAGERY_RUN_SCAN = 200;

/** `winter-2026-27` → "Winter 2026–27", the season's name as the console writes it. */
function seasonName(label: string): string {
  const m = /^winter-(\d{4})-(\d{2})$/.exec(label);
  return m ? `Winter ${m[1]}–${m[2]}` : label;
}

/** A row of the audit feed the machine wrote: no actor, a verb in words, a target it names. */
type SystemFeedRow = {
  id: string;
  at: number;
  actor: null;
  action: string;
  target: { type: 'importRun' | 'imageryRun' | 'seasonWatch'; id: string; label: string };
};

/**
 * What the machines did, as audit-feed rows (`actor: null`, the feed's *system*) for Home to merge
 * with `moderation.listActions` by time, newest first:
 *
 * - **imports** (`importRuns`), each as it finished — admins only (`machinery.read`), as Machinery is;
 * - **live imagery runs that failed or were refused** — admins only; the ordinary beats would bury
 *   everything else;
 * - **the season watch** opening and closing (the instants they were recorded), for every moderator
 *   (`season.summary`). Air temperatures opened it; nothing here says a lake froze (D3).
 *
 * Bounded: `limit` rows at most from each source, newest first.
 */
export const systemFeed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const viewer = await requireCapability(ctx, 'audit.read');
    // A limit that isn't a number reads as the default, never as an index bound that matches nothing.
    const asked =
      args.limit !== undefined && Number.isFinite(args.limit) ? Math.floor(args.limit) : 50;
    const limit = Math.max(1, Math.min(asked, SYSTEM_FEED_MAX));
    const rows: SystemFeedRow[] = [];

    if (hasCapability(viewer, 'machinery.read')) {
      const imports = await ctx.db
        .query('importRuns')
        .withIndex('by_started')
        .order('desc')
        .take(limit);
      for (const run of imports) {
        if (run.status === 'running') continue;
        rows.push({
          id: `import:${run._id}`,
          at: run.finishedAt ?? run.startedAt,
          actor: null,
          action: run.status === 'failed' ? 'Run failed' : 'Run succeeded',
          target: { type: 'importRun', id: run._id, label: run.label },
        });
      }
      const imagery = await ctx.db
        .query('imageryRuns')
        .withIndex('by_started')
        .order('desc')
        .take(IMAGERY_RUN_SCAN);
      for (const run of imagery.filter((r) => r.outcome === 'failed' || r.outcome === 'refused')) {
        rows.push({
          id: `imagery:${run._id}`,
          at: run.finishedAt ?? run.startedAt,
          actor: null,
          action: run.outcome === 'failed' ? 'Run failed' : 'Run refused',
          target: { type: 'imageryRun', id: run._id, label: `Imagery ${run.kind}` },
        });
      }
    }

    if (hasCapability(viewer, 'season.summary')) {
      const seasons = await ctx.db
        .query('imageryIngestSeasons')
        .withIndex('by_season')
        .order('desc')
        .take(2);
      for (const s of seasons) {
        rows.push({
          id: `watch-open:${s._id}`,
          at: s.detectedAt,
          actor: null,
          action: 'Opened ice watch',
          target: { type: 'seasonWatch', id: s.season, label: seasonName(s.season) },
        });
        if (s.closedAt !== undefined && s.closesOn !== undefined) {
          rows.push({
            id: `watch-close:${s._id}`,
            at: s.closedAt,
            actor: null,
            action: 'Closed ice watch',
            target: { type: 'seasonWatch', id: s.season, label: seasonName(s.season) },
          });
        }
      }
    }

    return rows.sort((a, b) => b.at - a.at).slice(0, limit);
  },
});
