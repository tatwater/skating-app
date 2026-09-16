/**
 * Corpus standing — the operator surface, the seed and the season cron (N7b).
 *
 * The *rules* live in `@skating/core`'s `standing.ts` (what a body is, when it stays active) and
 * the *transition* in `lib/standing.ts` (what moves when it changes). This file is everything that
 * drives those from outside a report or a track: a moderator's hand, the one-time partition of the
 * stored corpus, and the July pass that shelves what nobody skated.
 *
 * ## The trajectory this exists for
 *
 * Twenty-five thousand bodies, of which a few hundred are actually accessible and actually skated
 * (founder, 2026-09-16: *"I would not be surprised at all if that's approximately what we end up
 * with"*). Three mechanisms get there, and each is deliberately reversible and visible:
 *
 * - **the seed** partitions the corpus once by evidence of access or use — a put-in, a curated
 *   boost, any human attachment, an admission by request, a mention in the design corpus. Dry by
 *   default, paged, re-runnable after any campaign.
 * - **the rollover** demotes, each July, every active body with no report, track or hazard in
 *   `INACTIVE_SEASONS` and no standing human decision. Automatic because dormancy is cheap to undo:
 *   one report brings a body back. Recorded as a run row so "did this season's pass finish" is a
 *   fact.
 * - **a moderator** sets a body dormant with a note, or brings one back, one at a time.
 *
 * Removal (D48) stays what it was: a human act with a reason. Nothing here deletes.
 */

import { INACTIVE_SEASONS, isActive, retainsActive, seasonOf, standingOf } from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, mutation, query } from './_generated/server';
import { requireContributorRole, requireRole } from './lib/auth';
import { takeCappedResult } from './lib/scan';
import { activateBody, anyFavorite, demoteBody, lastActivityAt } from './lib/standing';
import { literals } from './lib/validators';
import { bodyAttachmentKind } from './waterBodies';

// ── The moderator's hand ───────────────────────────────────────────────────────────────────────

/** A moderator's note renders in the drawer, so it gets the same ceiling as an access note. */
const MAX_STANDING_NOTE_LENGTH = 160;

/**
 * Moderator: set a body dormant by hand, or bring one back.
 *
 * Dormancy here is the third rung the plan asked about — *"keep it but stop it ever surfacing wide,
 * without the legal claim `none` makes"* — and the note is what makes it honest: the skater who
 * finds the lake reads why. Only an active body can be set dormant this way, and only a
 * machine-shelved or moderator-shelved body can be brought back — a removal and a `none` ruling
 * each have their own verb (`restore`, `setPublicAccess`), and answering them here would let one
 * control silently reverse another's decision.
 */
export const setStanding = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    standing: v.union(v.literal('active'), v.literal('dormant')),
    note: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { waterBodyId, standing, note, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    const body = await ctx.db.get(waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    const current = standingOf(body);
    const trimmedNote = note?.trim();
    if (trimmedNote && trimmedNote.length > MAX_STANDING_NOTE_LENGTH) {
      throw new ConvexError(
        `Keep the note under ${MAX_STANDING_NOTE_LENGTH} characters — it renders on the lake.`,
      );
    }

    if (standing === 'dormant') {
      if (current.standing !== 'active') {
        throw new ConvexError(
          current.standing === 'removed'
            ? 'This body is removed — restore it first if you want it dormant rather than removed.'
            : current.standing === 'unlisted'
              ? 'This body is not on the map.'
              : 'This body is already dormant.',
        );
      }
      await demoteBody(
        ctx,
        body,
        { reason: 'moderator', byUserId: actor._id, ...(trimmedNote ? { note: trimmedNote } : {}) },
        { actorId: actor._id, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
      );
      return waterBodyId;
    }

    if (current.standing === 'active') throw new ConvexError('This body is already active.');
    if (current.standing === 'removed') {
      throw new ConvexError('This body is removed — use Restore.');
    }
    if (current.standing === 'unlisted') throw new ConvexError('This body is not on the map.');
    if (current.reason === 'no_public_access') {
      throw new ConvexError(
        'A no-public-access ruling stands — clear or change the ruling instead.',
      );
    }
    await activateBody(ctx, body, {
      via: 'moderator',
      actorId: actor._id,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
    });
    return waterBodyId;
  },
});

// ── The standing lists ─────────────────────────────────────────────────────────────────────────

/** Rows a lane shows at once. The lanes are for acting one body at a time, not for counting. */
const LANE_CAP = 200;

const LANES = ['inactive', 'not_in_campaign', 'moderator', 'no_public_access', 'removed'] as const;
export type StandingLane = (typeof LANES)[number];

/**
 * Moderator: one lane of the standing page — every body in a given non-active standing, newest
 * first, capped.
 *
 * Five lanes, five index reads, none of which touch the active majority: the three stored
 * dormancy reasons come off `by_dormant_reason`, `none` rulings off `by_public_access_verdict`, and
 * removals off `by_removed_at` with a `gt(0)` range that excludes the `undefined` the optional
 * field sorts first. Each row carries what a moderator needs to judge it without opening it — the
 * last time anyone was on it, so an `inactive` lane reads as a list of dates.
 */
export const listLane = query({
  args: { lane: literals(LANES), limit: v.optional(v.number()) },
  handler: async (ctx, { lane, limit }) => {
    await requireRole(ctx, 'moderator');
    const cap = Math.min(LANE_CAP, Math.max(1, limit ?? LANE_CAP));
    const source =
      lane === 'removed'
        ? ctx.db
            .query('waterBodies')
            .withIndex('by_removed_at', (q) => q.gt('removedAt', 0))
            .order('desc')
        : lane === 'no_public_access'
          ? ctx.db
              .query('waterBodies')
              .withIndex('by_public_access_verdict', (q) => q.eq('publicAccess.verdict', 'none'))
              .order('desc')
          : ctx.db
              .query('waterBodies')
              .withIndex('by_dormant_reason', (q) => q.eq('dormant.reason', lane))
              .order('desc');
    const { rows, truncated } = await takeCappedResult(source, cap, `standing.listLane(${lane})`);
    const out = [];
    for (const body of rows) {
      const s = standingOf(body);
      // A row can sit in a lane's index and belong to a stronger lane — a removed body still carries
      // its old `dormant` field. Show it where `standingOf` says it is, once.
      if (s.standing === 'unlisted') continue;
      const inLane =
        (lane === 'removed' && s.standing === 'removed') ||
        (lane !== 'removed' && s.standing === 'dormant' && s.reason === lane);
      if (!inLane) continue;
      out.push({
        _id: body._id,
        name: body.name,
        type: body.type,
        states: body.states ?? [],
        surfaceAreaSqM: body.surfaceAreaSqM ?? 0,
        centroid: body.centroid,
        standing: s,
        lastActivityAt: await lastActivityAt(ctx, body._id),
        includedByRequest: body.includedByRequest === true,
        curatedBoost: body.curatedBoost ?? 0,
      });
    }
    return { rows: out, truncated };
  },
});

/**
 * Moderator: bodies that recently became active, newest first — **the machine's re-activations,
 * seen by a person.** A report on a shelved pond brings it back with no moderator in the loop; this
 * is where that shows up, beside who or what did it (the audit row's `via`).
 */
export const listRecentActivations = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireRole(ctx, 'moderator');
    const cap = Math.min(LANE_CAP, Math.max(1, limit ?? 50));
    const rows = await ctx.db
      .query('waterBodies')
      .withIndex('by_activated_at', (q) => q.gt('activatedAt', 0))
      .order('desc')
      .take(cap);
    const out = [];
    for (const body of rows) {
      if (body.activatedAt === undefined) continue;
      const audit = await ctx.db
        .query('moderationActions')
        .withIndex('by_target', (q) => q.eq('targetType', 'waterbody').eq('targetId', body._id))
        .order('desc')
        .filter((q) => q.eq(q.field('action'), 'activate_body'))
        .first();
      const via = (audit?.metadata as { via?: string } | undefined)?.via;
      out.push({
        _id: body._id,
        name: body.name,
        type: body.type,
        states: body.states ?? [],
        surfaceAreaSqM: body.surfaceAreaSqM ?? 0,
        centroid: body.centroid,
        activatedAt: body.activatedAt,
        standing: standingOf(body),
        ...(via !== undefined ? { via } : {}),
        /** What the enrichment passes have not yet given it — the "awaiting enrichment" column. */
        missing: [
          ...(body.elevationM === undefined ? ['elevation'] : []),
          ...(body.windRose === undefined ? ['wind'] : []),
          ...(body.meanDepthM === undefined && body.maxDepthM === undefined ? ['depth'] : []),
        ],
      });
    }
    return out;
  },
});

// ── The seed ───────────────────────────────────────────────────────────────────────────────────

/**
 * Partition the stored corpus into active and dormant — **the one-time seed, re-runnable after any
 * campaign** (N7b, founder call 2026-09-16, option (b)).
 *
 * A body stays active on any evidence of *access or use*: a put-in, a curated boost, any human
 * attachment (a report, a hazard, a track, a favourite, a bounty, a body feature, a hand-drawn bay),
 * an admission by request, a user-drawn origin, or a name on the caller's keep list (the
 * design-corpus mentions, matched offline by `seed-destinations seed-standing`). Everything else
 * becomes dormant with reason `inactive` — and comes back the moment someone reports, tracks or
 * places a put-in on it.
 *
 * **Dry by default**, like every prune: the tallies are identical either way. Paged and resumable;
 * a page of 50 costs ~10 attachment probes per body plus ~25 reads per demotion, which keeps the
 * worst page (all demotions) under the 4,096-read cap with room.
 */
export const seedStanding = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    apply: v.optional(v.boolean()),
    /** Bodies to keep active whatever the evidence says — the training-data matches. */
    keepIds: v.optional(v.array(v.id('waterBodies'))),
  },
  handler: async (ctx, { cursor, batchSize, apply, keepIds }) => {
    const numItems = Math.min(100, Math.max(1, batchSize ?? 50));
    const keep = new Set<string>(keepIds ?? []);
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });

    const kept = {
      alreadyInactive: 0,
      keepList: 0,
      userCreated: 0,
      curated: 0,
      includedByRequest: 0,
      attached: 0,
    };
    const attachedBy: Record<string, number> = {};
    let demoted = 0;

    for (const body of page.page) {
      if (!isActive(body)) {
        kept.alreadyInactive++;
        continue;
      }
      if (keep.has(body._id)) {
        kept.keepList++;
        continue;
      }
      if (body.source === 'user') {
        kept.userCreated++;
        continue;
      }
      if ((body.curatedBoost ?? 0) > 0) {
        kept.curated++;
        continue;
      }
      if (body.includedByRequest === true) {
        kept.includedByRequest++;
        continue;
      }
      const attachment = await bodyAttachmentKind(ctx, body._id);
      // A gate event is analytics about a bounty somebody was *refused*, not a human act on the lake.
      if (attachment !== null && attachment !== 'bountyGateEvents') {
        kept.attached++;
        attachedBy[attachment] = (attachedBy[attachment] ?? 0) + 1;
        continue;
      }
      if (apply === true) await demoteBody(ctx, body, { reason: 'inactive' });
      demoted++;
    }

    return {
      applied: apply === true,
      scanned: page.page.length,
      demoted,
      kept,
      attachedBy,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

// ── The rollover ───────────────────────────────────────────────────────────────────────────────

/**
 * One page of the season rollover: every active body with no evidence of use in the retention
 * window and no standing human decision becomes dormant (`inactive`).
 *
 * `season` is the season being rolled *into*; the window is the `INACTIVE_SEASONS` before it — see
 * `inactivityCutoffMs`. Four reads per active body (three for `lastActivityAt`, one for a
 * favourite) plus the demotion's own, so a page of 100 all-demoted sits around 3,000 reads.
 */
export const demoteInactiveBodies = internalMutation({
  args: {
    season: v.number(),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, { season, cursor, batchSize, apply }) => {
    const numItems = Math.min(100, Math.max(1, batchSize ?? 100));
    const page = await ctx.db.query('waterBodies').paginate({ cursor: cursor ?? null, numItems });
    const kept = { notActive: 0, retained: 0 };
    let demoted = 0;
    for (const body of page.page) {
      if (!isActive(body)) {
        kept.notActive++;
        continue;
      }
      const retained = retainsActive(
        {
          lastActivityAt: await lastActivityAt(ctx, body._id),
          curatedBoost: body.curatedBoost,
          favorited: await anyFavorite(ctx, body._id),
        },
        season,
      );
      if (retained) {
        kept.retained++;
        continue;
      }
      if (apply === true) await demoteBody(ctx, body, { reason: 'inactive' });
      demoted++;
    }
    return {
      applied: apply === true,
      scanned: page.page.length,
      demoted,
      kept,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * The campaign id a season's rollover is recorded under — one live row per season, by construction.
 *
 * A dry run gets its own id, because the daily gate reads this: a `succeeded` dry row under the live
 * id would silently suppress the real July pass for that season (review finding, 2026-09-16).
 */
export function rolloverCampaignId(season: number, apply: boolean): string {
  return apply ? `standing-rollover-${season}` : `standing-rollover-${season}-dry`;
}

/**
 * How long a `running` rollover row is trusted before the gate treats it as a dead action and
 * retries. A live pass over 25,000 bodies at 100 a page is minutes; six hours is generous and still
 * inside the July window.
 */
const ROLLOVER_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * The whole rollover, as a run: opens an `importRuns` row, walks every page, closes it. An action
 * because it pages (one paginated query per function), like `regionStats.recompute`.
 *
 * Callable by hand — `pnpm exec convex run standing:runStandingRollover '{"season": 2029}'` — which
 * is also how a dry run is done (`"apply": false`) before the first live July.
 */
export const runStandingRollover = internalAction({
  args: { season: v.number(), apply: v.optional(v.boolean()), batchSize: v.optional(v.number()) },
  handler: async (
    ctx,
    { season, apply, batchSize },
  ): Promise<{ scanned: number; demoted: number; retained: number; pages: number }> => {
    const runId = await ctx.runMutation(internal.importRuns.start, {
      kind: 'standing_rollover',
      label: `standing rollover into ${season}${apply === true ? '' : ' (dry)'}`,
      campaignId: rolloverCampaignId(season, apply === true),
      deployment: process.env.CONVEX_CLOUD_URL ?? 'unknown',
      isProd: !(process.env.CONVEX_CLOUD_URL ?? '').includes('agile-bee-397'),
      stages: [
        {
          name: 'rollover',
          detail: `demoteInactiveBodies — active bodies with nothing in the last ${INACTIVE_SEASONS} seasons and no boost or favourite become dormant`,
        },
      ],
    });
    try {
      let cursor: string | undefined;
      let isDone = false;
      let scanned = 0;
      let demoted = 0;
      let retained = 0;
      let pages = 0;
      while (!isDone && pages < 5000) {
        const page: {
          scanned: number;
          demoted: number;
          kept: { retained: number };
          cursor: string;
          isDone: boolean;
        } = await ctx.runMutation(internal.standing.demoteInactiveBodies, {
          season,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(apply !== undefined ? { apply } : {}),
          ...(batchSize !== undefined ? { batchSize } : {}),
        });
        cursor = page.cursor;
        isDone = page.isDone;
        scanned += page.scanned;
        demoted += page.demoted;
        retained += page.kept.retained;
        pages++;
      }
      await ctx.runMutation(internal.importRuns.finish, {
        runId,
        status: 'succeeded',
        counts: [
          { name: 'scanned', value: scanned },
          { name: apply === true ? 'demoted' : 'wouldDemote', value: demoted },
          { name: 'retained', value: retained },
        ],
      });
      return { scanned, demoted, retained, pages };
    } catch (err) {
      await ctx.runMutation(internal.importRuns.finish, {
        runId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        notes: ['Partial rollover — re-run; demotions already made are idempotent.'],
      });
      throw err;
    }
  },
});

/**
 * The daily cron's entry point, gated on the season boundary.
 *
 * A daily interval with a date check rather than a `crons.cron` expression, for the reason
 * `recurrence.maybeRunRollover` gives: it keeps `crons.ts` uniform and makes the pass retryable
 * across the first two weeks of July. The run row is the idempotence stamp — a `running` or
 * `succeeded` row for this season means nothing to do; a `failed` one is retried tomorrow.
 */
export const maybeRunStandingRollover = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const date = new Date(now);
    // July 1–14 UTC (D63's boundary is UTC). Two weeks so a failed run has room to retry.
    if (date.getUTCMonth() !== 6 || date.getUTCDate() > 14) return { ran: false as const };
    const season = seasonOf(now);
    const prior = await ctx.db
      .query('importRuns')
      .withIndex('by_campaign', (q) => q.eq('campaignId', rolloverCampaignId(season, true)))
      .order('desc')
      .first();
    if (prior?.status === 'succeeded') return { ran: false as const, season };
    // A `running` row is trusted for a while, then treated as an action that died mid-walk: the
    // demotions it made are idempotent, and a row that is `running` forever would otherwise block
    // the season for good.
    if (prior?.status === 'running' && now - prior.startedAt < ROLLOVER_STALE_MS) {
      return { ran: false as const, season };
    }
    await ctx.scheduler.runAfter(0, internal.standing.runStandingRollover, {
      season,
      apply: true,
    });
    return { ran: true as const, season };
  },
});
