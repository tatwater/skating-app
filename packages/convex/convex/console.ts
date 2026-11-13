/**
 * The Overview's counts (B01 §5.1): every Inbox lane and the People column, counted honestly.
 *
 * Today's dashboard counts four of about twelve queues. This counts every lane a person filed into,
 * each through an index, each capped: a lane past {@link COUNT_CAP} reads "200+" rather than
 * scanning (the read is `take(cap + 1)`, bounded however large the table grows). Corpus counts are
 * `waterBodies.reviewQueueCounts`; Machinery's wait for §5's heartbeat, so a running import is never
 * counted as healthy before it can be told from a dead one.
 */

import type { REQUEST_KINDS } from '@skating/core';
import type { Doc } from './_generated/dataModel';
import { query } from './_generated/server';
import { hasCapability, requireCapability } from './lib/auth';

/** Past this, a count reads "200+" — enough to say "a lot" without reading the lot. */
const COUNT_CAP = 200;

export interface Count {
  count: number;
  capped: boolean;
}

const capped = (rows: number): Count => ({
  count: Math.min(rows, COUNT_CAP),
  capped: rows > COUNT_CAP,
});

type RequestKind = (typeof REQUEST_KINDS)[number];
const PLACE_KINDS: readonly RequestKind[] = ['name_bay', 'name_landmark'];

const DAY_MS = 86_400_000;

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireCapability(ctx, 'inbox.read');
    const now = Date.now();

    // ── Inbox: flags, split into the lanes the Inbox shows ────────────────────────────────────
    const openFlags = await ctx.db
      .query('contentFlags')
      .withIndex('by_status', (q) => q.eq('status', 'open'))
      .take(COUNT_CAP + 1);
    const flagsCapped = openFlags.length > COUNT_CAP;
    const flags = openFlags.slice(0, COUNT_CAP);
    // The same split `moderation.listFlags` draws: an access report is a `no_public_access` flag on a
    // *body*; the same reason on anything else (a report, a put-in) stays in the content lane.
    const isAccessReport = (f: (typeof flags)[number]) =>
      f.reason === 'no_public_access' && f.targetType === 'waterbody';
    const safety = flags.filter((f) => f.reason === 'unsafe_false_report').length;
    const access = new Set(flags.filter(isAccessReport).map((f) => f.targetId)).size;
    const content = flags.filter(
      (f) => f.reason !== 'unsafe_false_report' && !isAccessReport(f),
    ).length;
    const flaggedPeople = flags.filter((f) => f.targetType === 'user').length;
    const oldestFlag = flags.reduce(
      (min, f) => Math.min(min, f.createdAt),
      Number.POSITIVE_INFINITY,
    );

    // ── Inbox: requests (places are their own lane) ───────────────────────────────────────────
    const openRequests = await ctx.db
      .query('waterBodyRequests')
      .withIndex('by_status_created', (q) => q.eq('status', 'open'))
      .take(COUNT_CAP + 1);
    const requestsCapped = openRequests.length > COUNT_CAP;
    const requests = openRequests.slice(0, COUNT_CAP);
    const places = requests.filter((r) => PLACE_KINDS.includes(r.kind)).length;
    const oldestRequest = requests[0]?.createdAt ?? Number.POSITIVE_INFINITY;

    const drawn = await ctx.db
      .query('waterBodies')
      .withIndex('by_review_status', (q) => q.eq('reviewStatus', 'pending'))
      .take(COUNT_CAP + 1);

    // Support is PII (D37): counted only for a viewer who may open it. A ticket waits until it is
    // resolved — `in_progress` is still waiting — the same rule `support_queue_depth` counts by.
    let support: Count | null = null;
    let appeals: number | null = null;
    if (hasCapability(viewer, 'inbox.support.read')) {
      const waiting: Doc<'supportTickets'>[] = [];
      for (const status of ['open', 'in_progress'] as const) {
        waiting.push(
          ...(await ctx.db
            .query('supportTickets')
            .withIndex('by_status', (q) => q.eq('status', status))
            .take(COUNT_CAP + 1)),
        );
      }
      support = capped(waiting.length);
      appeals = waiting.slice(0, COUNT_CAP).filter((s) => s.category === 'account').length;
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

    const oldest = Math.min(oldestFlag, oldestRequest);
    return {
      inbox: {
        safety: { count: safety, capped: flagsCapped },
        accessReports: { count: access, capped: flagsCapped },
        requests: { count: requests.length - places, capped: requestsCapped },
        placesAsked: { count: places, capped: requestsCapped },
        drawnBodies: capped(drawn.length),
        contentFlags: { count: content, capped: flagsCapped },
        support,
        oldestOpenAt: Number.isFinite(oldest) ? oldest : null,
      },
      people: {
        moderators: capped(moderators.length),
        admins: capped(admins.length),
        newThisWeek: capped(newThisWeek.length),
        // The live ones out of a read that may itself have hit the cap — which `capped` on the
        // filtered count could never say.
        suspended: { count: liveSuspensions.length, capped: suspended.length > COUNT_CAP },
        nextSuspensionEnds,
        banned: capped(banned.length),
        flaggedPeople: { count: flaggedPeople, capped: flagsCapped },
        appealsOpen: appeals,
        leaving: capped(leaving.length),
      },
    };
  },
});
