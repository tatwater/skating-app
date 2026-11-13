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
  cappedCount,
  duplicateDecisions,
  medianAge,
  type REQUEST_KINDS,
  roleMeets,
} from '@skating/core';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, type QueryCtx, query } from './_generated/server';
import { hasCapability, requireCapability } from './lib/auth';
import { latestMetric } from './lib/metricReads';
import { readOpenFlags } from './lib/openFlags';

export type { Count };

type RequestKind = (typeof REQUEST_KINDS)[number];
const PLACE_KINDS: readonly RequestKind[] = ['name_bay', 'name_landmark'];

const DAY_MS = 86_400_000;

/** Fields added to a read after its first clients: always present, typed optional. */
type Added<T> = Partial<T>;

/**
 * Everyone with an account, from the 6-hourly `accounts_total` rollup — one point read, where a
 * live count would read every profile. `null` until the rollup has run once; `capped` when its scan
 * stopped short, so the number is a floor.
 */
async function totalUsers(ctx: QueryCtx): Promise<Count | null> {
  const row = await latestMetric(ctx, 'accounts_total');
  if (row?.scalar === undefined) return null;
  const meta = row.meta as { capped?: boolean } | undefined;
  return { count: row.scalar, capped: meta?.capped === true };
}

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    const now = Date.now();

    // ── Inbox: flags, split into the lanes the Inbox shows ────────────────────────────────────
    // Open means `open` or `reviewing` — one definition, `lib/openFlags` (the governor's ruling).
    const { flags, capped: flagsCapped } = await readOpenFlags(ctx, COUNT_CAP);
    // The same split `moderation.listFlags` draws: an access report is a `no_public_access` flag on a
    // *body*; the same reason on anything else (a report, a put-in) stays in the content lane.
    const isAccessReport = (f: (typeof flags)[number]) =>
      f.reason === 'no_public_access' && f.targetType === 'waterbody';
    const safety = flags.filter((f) => f.reason === 'unsafe_false_report').length;
    const access = new Set(flags.filter(isAccessReport).map((f) => f.targetId)).size;
    const content = flags.filter(
      (f) => f.reason !== 'unsafe_false_report' && !isAccessReport(f),
    ).length;
    // People, not flags: three skaters flagging one account is one person to look at.
    const flaggedPeople = new Set(
      flags.filter((f) => f.targetType === 'user').map((f) => f.targetId),
    ).size;

    // ── Inbox: requests (places are their own lane) ───────────────────────────────────────────
    const openRequests = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_status_created', (q) => q.eq('status', 'open'))
      .take(COUNT_CAP + 1);
    const requestsCapped = openRequests.length > COUNT_CAP;
    const requests = openRequests.slice(0, COUNT_CAP);
    const places = requests.filter((r) => PLACE_KINDS.includes(r.kind)).length;

    const drawn = await ctx.db
      .query('waterBodies')
      .withIndex('by_review_status', (q) => q.eq('reviewStatus', 'pending'))
      .take(COUNT_CAP + 1);

    // Support is PII (D37): counted only for a viewer who may open it. A ticket waits until it is
    // resolved — `in_progress` is still waiting — the same rule `support_queue_depth` counts by.
    let support: Count | null = null;
    let appeals: Count | null = null;
    if (hasCapability(viewer, 'inbox.support.read')) {
      const waiting: Doc<'supportTickets'>[] = [];
      let readCapped = false;
      for (const status of ['open', 'in_progress'] as const) {
        const page = await ctx.db
          .query('supportTickets')
          .withIndex('by_status', (q) => q.eq('status', status))
          .take(COUNT_CAP + 1);
        readCapped ||= page.length > COUNT_CAP;
        waiting.push(...page);
      }
      support = cappedCount(waiting.length);
      // Appeals are counted over every waiting ticket read, not the first 200 of the combined list,
      // and say "capped" whenever either status read stopped short — a full page of bugs could be
      // hiding an appeal past it.
      const accountTickets = waiting.filter((s) => s.category === 'account').length;
      appeals = {
        count: Math.min(accountTickets, COUNT_CAP),
        capped: readCapped || accountTickets > COUNT_CAP,
      };
    }

    // ── People ────────────────────────────────────────────────────────────────────────────────
    const moderators = await ctx.db
      .query('profiles')
      .withIndex('by_role', (q) => q.eq('role', 'moderator'))
      .take(COUNT_CAP + 1);
    const admins = await ctx.db
      .query('profiles')
      .withIndex('by_role', (q) => q.eq('role', 'admin'))
      .take(COUNT_CAP + 1);
    const suspended = await ctx.db
      .query('profiles')
      .withIndex('by_status', (q) => q.eq('status', 'suspended'))
      .take(COUNT_CAP + 1);
    const banned = await ctx.db
      .query('profiles')
      .withIndex('by_status', (q) => q.eq('status', 'banned'))
      .take(COUNT_CAP + 1);
    const newThisWeek = await ctx.db
      .query('profiles')
      .withIndex('by_created_at', (q) => q.gte('createdAt', now - 7 * DAY_MS))
      .take(COUNT_CAP + 1);
    // An optional field's index is not sparse — `undefined` sorts first — so the range needs a lower
    // bound, or every profile without a deletion request would match.
    const leaving = await ctx.db
      .query('profiles')
      .withIndex('by_deletion_requested_at', (q) => q.gt('deletionRequestedAt', 0))
      .take(COUNT_CAP + 1);
    // A suspension lapses at read time (D37); the stored status lags until the sweep. Count only the
    // live ones, and name the soonest end.
    const liveSuspensions = suspended
      .slice(0, COUNT_CAP)
      .filter((p) => p.suspendedUntil === undefined || p.suspendedUntil > now);
    const nextSuspensionEnds = liveSuspensions.reduce<number | null>(
      (min, p) =>
        p.suspendedUntil === undefined
          ? min
          : min === null
            ? p.suspendedUntil
            : Math.min(min, p.suspendedUntil),
      null,
    );

    // What the Inbox card's foot ages: the open flags and the open requests. The oldest of each read
    // is its oldest overall (both read oldest first); the median needs every one, so it is `null`
    // whenever either read stopped short rather than a median of the oldest two hundred.
    const openedAts = [...flags.map((f) => f.createdAt), ...requests.map((r) => r.createdAt)];
    const oldest = openedAts.length > 0 ? Math.min(...openedAts) : null;
    // The two B01-3 additions are always sent; their type is optional (`Added`) only so a client
    // built against the read before them — the Overview's fixtures — compiles unchanged.
    const inboxAdded: Added<{ medianAgeMs: number | null }> = {
      medianAgeMs: flagsCapped || requestsCapped ? null : medianAge(openedAts, now),
    };
    const peopleAdded: Added<{ totalUsers: Count | null }> = { totalUsers: await totalUsers(ctx) };
    return {
      inbox: {
        safety: { count: safety, capped: flagsCapped },
        accessReports: { count: access, capped: flagsCapped },
        requests: { count: requests.length - places, capped: requestsCapped },
        placesAsked: { count: places, capped: requestsCapped },
        drawnBodies: cappedCount(drawn.length),
        contentFlags: { count: content, capped: flagsCapped },
        support,
        oldestOpenAt: oldest,
        ...inboxAdded,
      },
      people: {
        moderators: cappedCount(moderators.length),
        admins: cappedCount(admins.length),
        newThisWeek: cappedCount(newThisWeek.length),
        // The live ones out of a read that may itself have hit the cap — which `capped` on the
        // filtered count could never say.
        suspended: { count: liveSuspensions.length, capped: suspended.length > COUNT_CAP },
        nextSuspensionEnds,
        banned: cappedCount(banned.length),
        flaggedPeople: { count: flaggedPeople, capped: flagsCapped },
        appealsOpen: appeals,
        leaving: cappedCount(leaving.length),
        ...peopleAdded,
      },
    };
  },
});

// ── The Corpus card's tasks ─────────────────────────────────────────────────────────────────────

/** The intake reasons whose rows are duplicate candidates, counted as decisions. */
const DUPLICATE_REASONS = ['duplicate-candidate', 'same-source-duplicate'] as const;

/**
 * The Corpus card's tasks that `waterBodies.reviewQueueCounts` doesn't count (B01 §5.1). Its own
 * query, not part of `overview`: these change when a campaign runs or a moderator decides, and
 * `overview` re-runs on every flag filed — a body row carries its outline, so re-reading them on
 * every flag would be the expensive half of the Overview for nothing.
 *
 * - `duplicates` — the duplicate rows counted as **decisions**: rows that name each other are one
 *   merge-or-keep, not two rows (the register's S4).
 * - `chordRefits` — bays whose mouth a moved shoreline re-fitted or left stale (D215), across bodies.
 * - `placeNames` — place names from the email groups still open (D202).
 * - `campaignAt` — when the last corpus run started (a merge or a canonical load).
 * - `preIcePass` and `enrichment` are `null`: no record says when the pre-ice pass was done, and
 *   nothing indexes a body by the enrichment it lacks. Each is drawn *Not recorded yet*, never zero.
 */
export const corpusCounts = query({
  args: {},
  handler: async (ctx) => {
    await requireCapability(ctx, 'corpus.read');

    let readCapped = false;
    const rows: Array<{ id: string; partners: string[] }> = [];
    for (const reason of DUPLICATE_REASONS) {
      const page = await ctx.db
        .query('waterBodies')
        .withIndex('by_review_reason', (q) => q.eq('reviewReason', reason))
        .take(COUNT_CAP + 1);
      readCapped ||= page.length > COUNT_CAP;
      for (const body of page.slice(0, COUNT_CAP)) {
        rows.push({ id: body._id, partners: body.duplicateCandidateIds ?? [] });
      }
    }
    const decisions = duplicateDecisions(rows);

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

    let campaignAt: number | null = null;
    for (const kind of ['corpus_merge', 'canonical_water'] as const) {
      const last = await ctx.db
        .query('importRuns')
        .withIndex('by_kind_started', (q) => q.eq('kind', kind))
        .order('desc')
        .first();
      if (last && (campaignAt === null || last.startedAt > campaignAt)) campaignAt = last.startedAt;
    }

    return {
      duplicates: { count: Math.min(decisions, COUNT_CAP), capped: readCapped },
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
    const serverNow = Date.now();
    const now = Math.min(
      Math.max(args.now, serverNow - PRESENCE_HEARTBEAT_MS),
      serverNow + PRESENCE_HEARTBEAT_MS,
    );
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
      if (!person || !roleMeets(person.role, 'moderator')) continue;
      if (
        person.status === 'banned' ||
        person.status === 'deleting' ||
        person.status === 'deleted'
      ) {
        continue;
      }
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
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 50), SYSTEM_FEED_MAX));
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
          action: run.status === 'failed' ? 'Import failed' : 'Import finished',
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
          action:
            run.outcome === 'failed' ? `Imagery ${run.kind} failed` : `Imagery ${run.kind} refused`,
          target: { type: 'imageryRun', id: run._id, label: run.season },
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
          action: 'Ice watch opened',
          target: { type: 'seasonWatch', id: s.season, label: s.opensOn },
        });
        if (s.closedAt !== undefined && s.closesOn !== undefined) {
          rows.push({
            id: `watch-close:${s._id}`,
            at: s.closedAt,
            actor: null,
            action: 'Ice watch closed',
            target: { type: 'seasonWatch', id: s.season, label: s.closesOn },
          });
        }
      }
    }

    return rows.sort((a, b) => b.at - a.at).slice(0, limit);
  },
});
