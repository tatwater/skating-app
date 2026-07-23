/**
 * Bounties (D10/D17/D44) — "someone wants fresh eyes on this lake." A request, not safety content, so
 * reputation never gates who may post; the only junk controls are a **freshness gate** (no bounty on a
 * body that already has fresh eyes, decision 8) and a **rolling per-requester cap** (decision 7). Both
 * gates are pure `@skating/core` functions, re-enforced here at the trust boundary.
 *
 * Lifecycle: `open` → `fulfilled` (the requester thumbs a fulfilling report helpful), `cancelled` (the
 * requester cancels), or `expired` (the sweep, past `expiresAt`). The reward is a **separate currency**
 * (`bountyPoints`, decision 11): fulfilling awards `bounties.rewardPoints` to the *report author*, never
 * touching `reputationPoints`, so trust stays purely about report/hazard accuracy.
 *
 * The GPS-skate half of eligibility (D44) is dark until Phase 8; Phase 6 fans out to authors who
 * *reported* on the body recently.
 */

import {
  BOUNTY_DAILY_WINDOW_MS,
  BOUNTY_ELIGIBILITY_WINDOW_HOURS,
  BOUNTY_FRESH_MAX_MULTIPLIER,
  BOUNTY_FRESH_MAX_REPORTS,
  bboxIntersects,
  DEFAULT_BOUNTY_LIFETIME_MS,
  DEFAULT_BOUNTY_REWARD_POINTS,
  FRESH_REPORT_HOURS,
  haversineMeters,
  isMinor,
  MAX_OPEN_BOUNTIES_PER_DAY,
  reportSuppressesBounty,
  weatherExplainsIceChange,
  withinDailyBountyLimit,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { nearestSamplePoint } from './hazardWeather';
import { getCurrentProfile, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { isListed } from './lib/listing';
import { awardPointEvent, checkAndAwardBadges, tallyThumbs, trustClassFor } from './lib/reputation';
import { bbox, latLng } from './lib/validators';
import { resolveWeatherSince } from './weather';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hard ceiling on the `listOpen` index scan (decision 13 browse surface). The open-bounty set is small
 * and bounded by design (≤3 open per requester in a rolling 24h × a ~30-day lifetime), so a plain
 * `by_status_expires` scan is read-cap-safe — unlike the water-body geospatial viewport path, whose
 * reads scale with search *area* (see roadmap → Later/deferred: `listInViewport` hardening). If the
 * live open set ever approaches this cap we log the truncation (never silent, D5) and would then add a
 * dedicated bounties geospatial instance; at alpha scale it never bites.
 */
const OPEN_BOUNTY_SCAN_CAP = 200;

/** Visible reports on a body with a skate-end at or after `cutoff` — the input to both create gates. */
async function recentReports(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  cutoff: number,
): Promise<Doc<'reports'>[]> {
  return ctx.db
    .query('reports')
    .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
      q
        .eq('waterBodyId', waterBodyId)
        .eq('moderationStatus', 'visible')
        .gte('skateEndTime', cutoff),
    )
    .collect();
}

/** One recent report's decay-freshness inputs (everything but the weather, which the action fetches). */
interface BountyFreshnessReport {
  skateEndTime: number;
  netThumbs: number;
  trustClass: ReturnType<typeof trustClassFor>;
}

/**
 * The decay-freshness gate's DB inputs (Phase 10 / §7c): the body's weather sample point + the recent
 * reports (newest-first, read-bounded) each weighted by author trust + net thumbs. Null when the body is
 * missing/unlisted (the action then lets `createChecked` throw the proper error). The action adds the
 * per-report **weather-since** and decides freshness.
 */
export const bountyFreshnessInputs = internalQuery({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body || !isListed(body)) return null;
    const now = Date.now();
    const maxWindowMs = FRESH_REPORT_HOURS * BOUNTY_FRESH_MAX_MULTIPLIER * HOUR_MS;
    const recent = await recentReports(ctx, body._id, now - maxWindowMs);
    const newestFirst = [...recent]
      .sort((a, b) => b.skateEndTime - a.skateEndTime)
      .slice(0, BOUNTY_FRESH_MAX_REPORTS);

    const point = nearestSamplePoint(body, body.centroid);
    const reports: BountyFreshnessReport[] = [];
    for (const r of newestFirst) {
      const author = await ctx.db.get(r.authorId);
      const { helpful, unhelpful } = await tallyThumbs(ctx, 'report', r._id);
      reports.push({
        skateEndTime: r.skateEndTime,
        netThumbs: helpful - unhelpful,
        trustClass: author ? trustClassFor(author, now) : null,
      });
    }
    return { lat: point.lat, lng: point.lng, reports };
  },
});

/**
 * Post a bounty on a body (decision 7). An **action** (Phase 10 / §7c) so the freshness gate can consult
 * the weather: for each recent report it fetches the weather-since and asks whether that plausibly changed
 * the ice — a big freeze/thaw **reopens** bounties sooner (D56). The weather-aware verdict is then handed to
 * `createChecked`, which does the auth/minor/cap checks + insert (a mutation can't fetch, so the two split).
 */
export const create = action({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }): Promise<Id<'bounties'>> => {
    const now = Date.now();
    const inputs = await ctx.runQuery(internal.bounties.bountyFreshnessInputs, { waterBodyId });

    let bodyIsFresh = false;
    if (inputs) {
      for (const r of inputs.reports) {
        const summary = await resolveWeatherSince(ctx, inputs.lat, inputs.lng, r.skateEndTime, now);
        // Only trust the weather signal when we actually have data; no data ⇒ leave it undefined so the
        // score falls back to recency × thumbs × trust (fail-open — a fetch miss never opens a bounty).
        const weatherChangedIceSince =
          summary.hours > 0 ? weatherExplainsIceChange(summary) : undefined;
        if (
          reportSuppressesBounty(r.skateEndTime, now, FRESH_REPORT_HOURS, {
            netThumbs: r.netThumbs,
            trustClass: r.trustClass,
            weatherChangedIceSince,
          })
        ) {
          bodyIsFresh = true;
          break; // one suppressing report is enough — stop fetching
        }
      }
    }
    return ctx.runMutation(internal.bounties.createChecked, { waterBodyId, bodyIsFresh });
  },
});

/**
 * Finish a bounty create once the (weather-aware) freshness verdict is known: `requireProfile`, **reject
 * minors**, honor the freshness gate + rolling open-bounty cap (decision 7), insert, and fan out
 * `bounty_request` notices. Internal — only `create` (the action) calls it, passing `bodyIsFresh`.
 */
export const createChecked = internalMutation({
  args: { waterBodyId: v.id('waterBodies'), bodyIsFresh: v.boolean() },
  handler: async (ctx, { waterBodyId, bodyIsFresh }) => {
    const profile = await requireProfile(ctx);
    const now = Date.now();
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post bounties');
    }

    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body || !isListed(body)) throw new ConvexError('Water body not found');

    // Freshness gate (decision 8) — a body with fresh eyes doesn't need a bounty. The weather-aware verdict
    // was computed in the action (§7c): a well-corroborated/trusted read holds bounties off longer, but a
    // big freeze/thaw since the report reopens them.
    if (bodyIsFresh) {
      throw new ConvexError('This lake already has fresh eyes — no bounty needed');
    }

    // Rolling per-requester cap — count the requester's currently-open bounties in the window (decision 7).
    const open = await ctx.db
      .query('bounties')
      .withIndex('by_requester_status', (q) =>
        q.eq('requesterId', profile._id).eq('status', 'open'),
      )
      .collect();
    if (
      !withinDailyBountyLimit(
        open.map((b) => b.createdAt),
        now,
        MAX_OPEN_BOUNTIES_PER_DAY,
        BOUNTY_DAILY_WINDOW_MS,
      )
    ) {
      throw new ConvexError('You already have the maximum number of open bounties');
    }

    const bountyId = await ctx.db.insert('bounties', {
      requesterId: profile._id,
      waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
      windowHours: BOUNTY_ELIGIBILITY_WINDOW_HOURS,
      status: 'open',
      rewardPoints: DEFAULT_BOUNTY_REWARD_POINTS,
      fulfillingReportIds: [],
      createdAt: now,
      expiresAt: now + DEFAULT_BOUNTY_LIFETIME_MS,
    });

    await fanOutEligibility(ctx, {
      bountyId,
      waterBodyId: body._id,
      requesterId: profile._id,
      windowHours: BOUNTY_ELIGIBILITY_WINDOW_HOURS,
      now,
    });
    return bountyId;
  },
});

/**
 * Notify the eligible: authors who reported on this body within `windowHours` (decision 9). Per-actor
 * `bounty_request` rows inserted **directly** (the body-keyed coalescing queue doesn't fit a one-off
 * request), respecting `notificationPrefs.bountyRequest` + `status === 'active'`, never the requester.
 * The GPS-skate half of eligibility (D44) lands in Phase 8.
 */
async function fanOutEligibility(
  ctx: MutationCtx,
  args: {
    bountyId: Id<'bounties'>;
    waterBodyId: Id<'waterBodies'>;
    requesterId: Id<'profiles'>;
    windowHours: number;
    now: number;
  },
): Promise<void> {
  const recent = await recentReports(ctx, args.waterBodyId, args.now - args.windowHours * HOUR_MS);
  const notified = new Set<string>([args.requesterId]); // never notify the requester; dedup authors
  for (const report of recent) {
    if (notified.has(report.authorId)) continue;
    notified.add(report.authorId);
    const author = await ctx.db.get(report.authorId);
    if (!author) continue;
    if (author.status !== 'active' || !author.notificationPrefs.bountyRequest) continue;
    await ctx.db.insert('notifications', {
      userId: report.authorId,
      type: 'bounty_request',
      payload: {
        bountyId: args.bountyId,
        waterBodyId: args.waterBodyId,
        requesterId: args.requesterId,
      },
      createdAt: args.now,
    });
  }
}

/** Cancel your own open bounty (→ `cancelled`, decision 10). Only the requester; only while open. */
export const cancel = mutation({
  args: { bountyId: v.id('bounties') },
  handler: async (ctx, { bountyId }) => {
    const profile = await requireProfile(ctx);
    const bounty = await ctx.db.get(bountyId);
    if (!bounty) throw new ConvexError('Bounty not found');
    if (bounty.requesterId !== profile._id) throw new ConvexError('Only the requester can cancel');
    if (bounty.status !== 'open') throw new ConvexError('Bounty is not open');
    await ctx.db.patch(bountyId, { status: 'cancelled' });
  },
});

/**
 * Auto-attach (decision 10) — invoked from `reports.create` for each new **visible** report. Appends the
 * report to every open bounty on its body's `fulfillingReportIds` (the minimum bar is deliberately simple:
 * any new visible report on the body). Fulfillment itself waits for the requester's helpful thumb.
 */
export async function attachReportToOpenBounties(
  ctx: MutationCtx,
  report: Doc<'reports'>,
): Promise<void> {
  const open = await ctx.db
    .query('bounties')
    .withIndex('by_water_body_status', (q) =>
      q.eq('waterBodyId', report.waterBodyId).eq('status', 'open'),
    )
    .collect();
  for (const bounty of open) {
    if (bounty.fulfillingReportIds.includes(report._id)) continue;
    await ctx.db.patch(bounty._id, {
      fulfillingReportIds: [...bounty.fulfillingReportIds, report._id],
    });
  }
}

/**
 * Fulfillment-on-helpful (decisions 10–11) — invoked from `ratings.rate` when the **requester** thumbs a
 * fulfilling report helpful. Flips the bounty to `fulfilled` and awards `rewardPoints` (as
 * `bounty_fulfilled` → `bountyPoints`) to the **report author**, then notifies them. Guarded so a bounty
 * fulfills once: no-op unless still `open`, the rater is the requester, and the report is in its
 * fulfilling set. (The rater can't be the report author — self-rating is already blocked upstream — so
 * nobody rewards themselves.)
 *
 * **Fulfillment is terminal — a later retracted thumb does NOT un-fulfill (deliberate).** If the requester
 * later flips their vote to `unhelpful`, the `helpful_thumb` *reputation* boost reverses honestly (a
 * compensating ledger row), but the bounty stays `fulfilled` and the author keeps their `bountyPoints`: a
 * report that satisfied the request WAS provided, and clawing back an earned achievement currency on a
 * requester's later whim is worse than a cosmetic status/vote mismatch (which is split across two surfaces
 * anyway — the bounty hides its thumbs once fulfilled). Reversal would also need to record *which* report
 * fulfilled the bounty; if we ever want it, add `fulfilledByReportId` and reverse only on that report.
 */
export async function fulfillBountyOnHelpful(
  ctx: MutationCtx,
  args: { bountyId: Id<'bounties'>; reportId: Id<'reports'>; raterId: Id<'profiles'> },
): Promise<void> {
  const bounty = await ctx.db.get(args.bountyId);
  if (!bounty) return;
  if (bounty.status !== 'open') return;
  if (bounty.requesterId !== args.raterId) return;
  if (!bounty.fulfillingReportIds.includes(args.reportId)) return;
  const report = await ctx.db.get(args.reportId);
  if (!report) return;

  await ctx.db.patch(args.bountyId, { status: 'fulfilled' });
  await awardPointEvent(ctx, {
    userId: report.authorId,
    reason: 'bounty_fulfilled',
    refId: args.bountyId,
    delta: bounty.rewardPoints,
  });
  await checkAndAwardBadges(ctx, report.authorId);

  const author = await ctx.db.get(report.authorId);
  if (!author) return;
  if (author.status !== 'active' || !author.notificationPrefs.bountyFulfilled) return;
  await ctx.db.insert('notifications', {
    userId: report.authorId,
    type: 'bounty_fulfilled',
    payload: { bountyId: args.bountyId, reportId: args.reportId, requesterId: bounty.requesterId },
    createdAt: Date.now(),
  });
}

/**
 * Expiry sweep (decision 12) — flip every `open` bounty past `expiresAt` to `expired`. Reads the
 * dedicated `by_status_expires` index so a global sweep never full-scans. Run by the `crons.ts` interval.
 */
export const expireBounties = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('bounties')
      .withIndex('by_status_expires', (q) => q.eq('status', 'open').lte('expiresAt', now))
      .collect();
    for (const bounty of due) await ctx.db.patch(bounty._id, { status: 'expired' });
    return { expired: due.length };
  },
});

/** One bounty for its detail view. Public — bounties aren't gated by trust or blocks. */
export const get = query({
  args: { bountyId: v.id('bounties') },
  handler: (ctx, { bountyId }) => ctx.db.get(bountyId),
});

/**
 * The enriched `/bounty/$id` detail payload (D47) in one round-trip: the requester (ringed by trust), the
 * survivor water body, and the **visible** candidate reports that have auto-attached — each with its author
 * and an `isOwn` flag so the client knows whether the requester may thumb it (self-rating can't fulfill).
 * `isRequester` gates the cancel + fulfillment affordances. Returns `null` if the bounty is gone.
 */
export const getDetail = query({
  args: { bountyId: v.id('bounties') },
  handler: async (ctx, { bountyId }) => {
    const bounty = await ctx.db.get(bountyId);
    if (!bounty) return null;
    const now = Date.now();
    const viewer = await getCurrentProfile(ctx);
    const requester = await ctx.db.get(bounty.requesterId);
    const body = await resolveSurvivor(ctx, bounty.waterBodyId);

    const fulfillingReports = [];
    for (const reportId of bounty.fulfillingReportIds) {
      const report = await ctx.db.get(reportId);
      if (report?.moderationStatus !== 'visible') continue;
      const author = await ctx.db.get(report.authorId);
      fulfillingReports.push({
        _id: report._id,
        skateEndTime: report.skateEndTime,
        ...(report.skateQuality !== undefined ? { skateQuality: report.skateQuality } : {}),
        authorName: author?.displayName ?? 'Unknown',
        authorTrustClass: author ? trustClassFor(author, now) : null,
        isOwn: viewer?._id === report.authorId,
      });
    }

    return {
      _id: bounty._id,
      status: bounty.status,
      rewardPoints: bounty.rewardPoints,
      createdAt: bounty.createdAt,
      expiresAt: bounty.expiresAt,
      waterBody: body && isListed(body) ? { _id: body._id, name: body.name } : null,
      requester: requester
        ? {
            userId: requester._id,
            displayName: requester.displayName,
            username: requester.username,
            trustClass: trustClassFor(requester, now),
          }
        : { userId: bounty.requesterId, displayName: 'Unknown', username: '', trustClass: null },
      isRequester: !!viewer && viewer._id === bounty.requesterId,
      fulfillingReports,
    };
  },
});

/** The open bounties on a body (for the map/detail surfaces), newest first, with the requester's name. */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const now = Date.now();
    const open = await ctx.db
      .query('bounties')
      .withIndex('by_water_body_status', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('status', 'open'),
      )
      .collect();
    open.sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(
      open.map(async (b) => {
        const requester = await ctx.db.get(b.requesterId);
        return {
          _id: b._id,
          requester: requester
            ? {
                displayName: requester.displayName,
                username: requester.username,
                trustClass: trustClassFor(requester, now),
              }
            : { displayName: 'Unknown', username: '', trustClass: null },
          rewardPoints: b.rewardPoints,
          fulfillingCount: b.fulfillingReportIds.length,
          createdAt: b.createdAt,
          expiresAt: b.expiresAt,
        };
      }),
    );
  },
});

/**
 * The **global / near-me / in-viewport open-bounty browse** (decision 3 clarification, 2026-07-22). This
 * deliberately sidesteps the read-cap-fragile water-body geospatial viewport path: the open-bounty set is
 * small and bounded, so we scan the dedicated `by_status_expires` index (open, not-yet-expired), hydrate
 * each body + requester, then filter/sort **in JS** — no S2 read-ahead, no 4,096-reads crash surface.
 *
 * - `viewport` (web map markers / in-view list): keep only bounties whose body's bbox intersects the rect.
 * - `near` (client-supplied coord, e.g. live GPS): attach `distanceMeters` and sort ascending — safe to
 *   return the distance because the caller already knows its own location.
 * - `sortByHome` (mobile "bounties near me" tab): sort by distance to the **viewer's private home coord**,
 *   read server-side. The home coord never leaves the server (D11), and we deliberately **do not** return
 *   `distanceMeters` in this mode — exact distances to several public lakes could trilaterate the home.
 *   Falls back to newest-first when the viewer has no home set.
 * - none of the above: newest-first (`createdAt` desc).
 *
 * Bounties are not gated by trust or blocks (see `get`), so no viewer-scoped hiding. Bodies since removed
 * (unlisted) are dropped. `limit` caps the returned rows; the scan itself is capped at `OPEN_BOUNTY_SCAN_CAP`.
 */
export const listOpen = query({
  args: {
    viewport: v.optional(bbox),
    near: v.optional(latLng),
    sortByHome: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { viewport, near, sortByHome, limit }) => {
    const now = Date.now();
    // The coord we sort by: an explicit client coord wins; otherwise the viewer's private home (D11) when
    // they asked to sort near home. Distances are only *returned* for a client-supplied `near` (above).
    const viewer = sortByHome && !near ? await getCurrentProfile(ctx) : null;
    const sortCoord = near ?? viewer?.homeCoord;
    // Still-valid open bounties, soonest-expiring first, bounded read. `.gt('expiresAt', now)` drops any
    // past `expiresAt` the sweep hasn't flipped yet — a browse should never surface a dead bounty.
    const open = await ctx.db
      .query('bounties')
      .withIndex('by_status_expires', (q) => q.eq('status', 'open').gt('expiresAt', now))
      .take(OPEN_BOUNTY_SCAN_CAP);
    if (open.length === OPEN_BOUNTY_SCAN_CAP) {
      console.warn(
        `bounties.listOpen hit the ${OPEN_BOUNTY_SCAN_CAP}-row scan cap; some open bounties may be omitted.`,
      );
    }

    const rows = [];
    for (const b of open) {
      const body = await resolveSurvivor(ctx, b.waterBodyId);
      if (!body || !isListed(body)) continue; // bounty on a since-removed body — skip
      if (viewport && !bboxIntersects(body.bbox, viewport)) continue;
      const requester = await ctx.db.get(b.requesterId);
      rows.push({
        _id: b._id,
        waterBodyId: body._id,
        waterBodyName: body.name,
        centroid: body.centroid,
        requester: requester
          ? {
              displayName: requester.displayName,
              username: requester.username,
              trustClass: trustClassFor(requester, now),
            }
          : { displayName: 'Unknown', username: '', trustClass: null },
        rewardPoints: b.rewardPoints,
        fulfillingCount: b.fulfillingReportIds.length,
        createdAt: b.createdAt,
        expiresAt: b.expiresAt,
        ...(near ? { distanceMeters: haversineMeters(near, body.centroid) } : {}),
      });
    }

    if (sortCoord) {
      // Precompute each row's distance once (n calls), not per comparison (≈ n·log n calls), then sort on
      // the cached numbers — the comparator stays a pure subtraction.
      const distance = new Map(rows.map((r) => [r._id, haversineMeters(sortCoord, r.centroid)]));
      rows.sort((a, b) => (distance.get(a._id) ?? 0) - (distance.get(b._id) ?? 0));
    } else {
      rows.sort((a, b) => b.createdAt - a.createdAt);
    }
    const cap =
      limit !== undefined && limit > 0 ? Math.min(limit, OPEN_BOUNTY_SCAN_CAP) : rows.length;
    return rows.slice(0, cap);
  },
});

/** The caller's own bounties across all statuses, newest first (the "my bounties" surface). */
export const myBounties = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getCurrentProfile(ctx);
    if (!viewer) return [];
    const mine = await ctx.db
      .query('bounties')
      .withIndex('by_requester_status', (q) => q.eq('requesterId', viewer._id))
      .collect();
    return mine.sort((a, b) => b.createdAt - a.createdAt);
  },
});
