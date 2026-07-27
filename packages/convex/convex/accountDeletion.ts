/**
 * Account deletion (D33, mechanics amended by D62).
 *
 * Three ideas carry this file.
 *
 * **1. A request is not a deletion.** `requestDeletion` stamps a date and changes nothing else. For 30
 * days the account is completely normal — it can sign in, post, and cancel — because the obvious
 * alternative (lock the account the moment they ask) locks someone out of the very sign-in they'd need
 * to undo with. That's also why the pending state is its own field rather than a `status` value:
 * `status` is the security gate `requireProfile` reads, and a pending deletion must gate nothing.
 *
 * **2. Three buckets, not two (D62).** D33 said "anonymize, don't erase", reasoning that since all
 * reports are public there's nothing private to remove. That premise expired: Phase 4 added a home
 * coordinate and the isochrones derived from it, and Phase 8 added raw GPS traces and live OAuth
 * tokens. So private artifacts are **erased**, the public ice record is **anonymized** (the author
 * pointer moves to a tombstone; the content is untouched), and published GPS tracks are a third thing —
 * **kept but severed from identity**.
 *
 * **3. The track rule is D58's own predicate, reused.** An activity is kept iff it's linked to a
 * visible report. That's gate (1) of the aggregate layer, *publish-is-consent*: an unlinked activity is
 * a recording the person never published, so it goes with the private bucket, while a linked one is
 * already drawn on the lake and is part of the ice record this whole posture exists to preserve.
 *
 * **The prohibition worth stating out loud:** finalize must NOT set `excludeTracksFromAggregate`.
 * Flipping it on looks like the cautious privacy choice and would silently erase the contribution D62
 * exists to keep. The aggregate layer keeps working — including honoring `showPutIn` clipping — because
 * all four of its gates read data that survives deletion. There is nothing to do here but not break it.
 */

import {
  DELETED_DATE_OF_BIRTH,
  DELETED_DISPLAY_NAME,
  DELETION_GRACE_MS,
  deletedClerkUserId,
  deletedUsername,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id, TableNames } from './_generated/dataModel';
import { internalMutation, type MutationCtx, mutation } from './_generated/server';
import { requireProfile } from './lib/auth';
import { deletePhotoAndBlobs, referencedPhotoIds } from './lib/photoOrphans';

/**
 * Rows touched per invocation. Small on purpose: every stage runs in its own transaction and
 * re-schedules itself, so the ceiling that matters is "one page fits comfortably in a mutation",
 * not "the whole account fits". A prolific author with thousands of rows costs more pages, never a
 * failed deletion.
 */
const PAGE = 200;

/**
 * Test seam for the page size. Deliberately a real argument rather than a mocked constant: the path
 * that matters here is the **continuation** — a stage that hits its page limit, re-schedules, and
 * resumes from a cursor — and its failure mode is a deletion that silently stops halfway, leaving
 * private rows behind for a heavy account while reporting success. Being able to force a second page
 * with five rows instead of two hundred is what makes that testable at all.
 */
function pageSizeFor(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? PAGE, 1), PAGE);
}

/** How many accounts one cron tick may start finalizing. Each becomes its own self-continuing job. */
const FINALIZE_PER_TICK = 20;

/**
 * Marks a `providerActivityId` as belonging to a severed track. A prefix rather than a cleared field
 * because the value is required and half of the `(provider, providerActivityId)` dedup pair — a
 * synthetic-but-unique value keeps that index honest while pointing at nothing external.
 */
const SEVERED_PREFIX = 'severed:';

// ─────────────────────────────────────────────────────────────────────────────
// The user-facing half
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask to be deleted. Idempotent: asking twice keeps the *original* date rather than restarting the
 * clock, so a user who taps twice doesn't quietly buy themselves another 30 days.
 */
export const requestDeletion = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    if (profile.deletionRequestedAt !== undefined) {
      return { scheduledFor: profile.deletionRequestedAt + DELETION_GRACE_MS };
    }
    const now = Date.now();
    await ctx.db.patch(profile._id, { deletionRequestedAt: now });
    return { scheduledFor: now + DELETION_GRACE_MS };
  },
});

/**
 * Change their mind. An **explicit** action, never an implicit side effect of signing in — someone who
 * logs in once to save a photo before leaving must not silently un-delete themselves.
 */
export const cancelDeletion = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    if (profile.deletionRequestedAt === undefined) return { cancelled: false };
    await ctx.db.patch(profile._id, { deletionRequestedAt: undefined });
    return { cancelled: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Finalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cron entry: start finalizing every account whose grace window has run out.
 *
 * **The lower bound is not decoration.** An index on an optional field is *not* sparse in Convex: rows
 * without the field are in it, and `undefined` sorts **before every number**. So the obvious query —
 * `lte('deletionRequestedAt', cutoff)` — matches every profile that never asked to be deleted, and this
 * cron would have queued the entire user table for deletion on its first tick. That is exactly what it
 * did the first time it ran against dev (`due: 2, started: 2`, on a deployment where nobody had
 * requested anything), and only `finalizeAccount`'s own re-check of the stamp stopped it.
 *
 * `gt(0)` excludes `undefined` because it sits below the numbers in that same ordering. The per-row
 * check below is kept as well: two independent guards for a job whose failure mode is deleting
 * everyone, which is not the place to rely on one.
 */
export const finalizeDueDeletions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query('profiles')
      .withIndex('by_deletion_requested_at', (q) =>
        q.gt('deletionRequestedAt', 0).lte('deletionRequestedAt', Date.now() - DELETION_GRACE_MS),
      )
      .take(FINALIZE_PER_TICK);

    let started = 0;
    let skipped = 0;
    for (const profile of due) {
      // Belt to the range query's braces — never queue a profile that hasn't actually asked.
      if (profile.deletionRequestedAt === undefined) {
        skipped++;
        continue;
      }
      // A row can be due *and* already finalized if a previous tick got through the tombstone but the
      // stamp survived; skip rather than re-run the scrub over a tombstone.
      if (profile.status === 'deleted') continue;
      await ctx.scheduler.runAfter(0, internal.accountDeletion.finalizeAccount, {
        userId: profile._id,
      });
      started++;
    }
    return { due: due.length, started, skipped };
  },
});

/**
 * The stages, in order. Named rather than numbered so a log line or a resumed job says what it's doing,
 * and so inserting one later doesn't renumber the rest.
 *
 * Order is not arbitrary: **`tombstone` is last**. Every earlier stage is re-runnable and reads the
 * live profile, so a job that dies halfway leaves an account that is partly cleaned and still findable
 * by the sweep. Scrubbing the profile first would strand the remaining private rows behind an identity
 * nobody can look up again.
 */
const STAGES = ['erase', 'tracks', 'photos', 'tombstone'] as const;
type Stage = (typeof STAGES)[number];

/**
 * What a stage reports back. `cursor` is threaded only by the stages that *keep* some of what they
 * read — see `severTracks` for why re-`take()`ing would loop forever there.
 */
interface StageResult {
  more: boolean;
  cursor?: string;
  /** Rows removed by this page — returned so a test or an operator console can watch it converge. */
  deleted?: number;
}

export const finalizeAccount = internalMutation({
  args: {
    userId: v.id('profiles'),
    stage: v.optional(v.union(...STAGES.map((s) => v.literal(s)))),
    cursor: v.optional(v.string()),
    /** See `pageSizeFor` — a test seam for the continuation path, clamped to `PAGE`. */
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { userId, stage = 'erase', cursor, pageSize }) => {
    const profile = await ctx.db.get(userId);
    if (!profile) return { stopped: 'gone' as const };
    // Cancelled mid-flight: the user changed their mind between the sweep and this page. Stop, and
    // leave what's already erased erased — those rows are notifications and cached bands, all of which
    // regenerate. Nothing that was anonymized or severed has been touched yet (see the stage order).
    if (profile.deletionRequestedAt === undefined) return { stopped: 'cancelled' as const };
    if (profile.status === 'deleted') return { stopped: 'already_deleted' as const };

    const size = pageSizeFor(pageSize);
    const result = await runStage(ctx, profile, stage, cursor, size);
    if (result.more) {
      // Same stage again — it hit its page limit.
      await ctx.scheduler.runAfter(0, internal.accountDeletion.finalizeAccount, {
        userId,
        stage,
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
      return { stage, done: false };
    }

    const next = STAGES[STAGES.indexOf(stage) + 1];
    if (next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.accountDeletion.finalizeAccount, {
        userId,
        stage: next,
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
      return { stage, done: true, next };
    }
    return { stage, done: true, next: null };
  },
});

/** Run one page of one stage. */
async function runStage(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  stage: Stage,
  cursor: string | undefined,
  size: number,
): Promise<StageResult> {
  switch (stage) {
    case 'erase':
      return erasePrivate(ctx, profile, size);
    case 'tracks':
      return severTracks(ctx, profile._id, cursor, size);
    case 'photos':
      return erasePhotos(ctx, profile._id, cursor, size);
    case 'tombstone':
      await writeTombstone(ctx, profile);
      return { more: false };
  }
}

/**
 * Bucket 1 — **erase**. Private artifacts with no community value.
 *
 * Every table here is either indexed by user or (blocks) by both directions of the pair. What's
 * deliberately *absent* is as much the point as what's present: reports, comments, hazards,
 * confirmations, ratings, bounties, flags, point events, put-ins and body features are all bucket 2,
 * anonymized by the tombstone rather than deleted, because they're the community's ice record.
 *
 * `supportTickets` are erased rather than anonymized: they're private correspondence between one
 * person and the operator, free text likely to carry a name or an email, and not community record.
 * The `moderationActions` audit trail is a separate table and survives regardless.
 *
 * These are pure deletes, so the table shrinks under the query: re-running `.take(PAGE)` walks forward
 * on its own and needs no cursor. The stage reports "more" whenever a page came back full.
 */
async function erasePrivate(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  size: number,
): Promise<StageResult> {
  const userId = profile._id;
  let deleted = 0;
  let full = false;

  /** Delete one page from one table, remembering whether that page was full. */
  async function drain(rows: { _id: Id<TableNames> }[]): Promise<void> {
    for (const row of rows) await ctx.db.delete(row._id);
    deleted += rows.length;
    if (rows.length >= size) full = true;
  }

  await drain(
    await ctx.db
      .query('activityConnections')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(size),
  );
  await drain(
    await ctx.db
      .query('notifications')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(size),
  );
  await drain(
    await ctx.db
      .query('notificationQueue')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(size),
  );
  await drain(
    await ctx.db
      .query('waterBodyFavorites')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(size),
  );
  // Both directions: a block they made, and a block someone made against them. The second one matters
  // more than it looks — leaving it would go on filtering a tombstone's content for the blocker
  // forever, over a person who no longer exists.
  await drain(
    await ctx.db
      .query('blocks')
      .withIndex('by_blocker', (q) => q.eq('blockerId', userId))
      .take(size),
  );
  await drain(
    await ctx.db
      .query('blocks')
      .withIndex('by_blocked', (q) => q.eq('blockedId', userId))
      .take(size),
  );
  await drain(
    await ctx.db
      .query('clientSignalEvents')
      .withIndex('by_user_created', (q) => q.eq('userId', userId))
      .take(size),
  );

  // Export bundles: the row *and* the blob. An assembled export is every report, every track and every
  // photo of the person in one file — keeping one for an account that asked to be deleted would undo
  // the rest of this job in a single artifact.
  const exports = await ctx.db
    .query('dataExports')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(size);
  for (const row of exports) {
    if (row.storageId !== undefined) {
      await ctx.storage.delete(row.storageId as Id<'_storage'>).catch(() => {});
    }
  }
  await drain(exports);

  // Support tickets have no by-user index — they're looked up by status and by Clerk subject — so they
  // come off the Clerk-subject index. That's the identifier the tombstone is about to scrub, which is
  // one concrete reason the stage order isn't arbitrary: `erase` runs first, while it still resolves.
  await drain(
    await ctx.db
      .query('supportTickets')
      .withIndex('by_clerk_user_created', (q) => q.eq('clerkUserId', profile.clerkUserId))
      .take(size),
  );

  return { more: full, deleted };
}

/**
 * Bucket 3 — **keep, severed from identity**. The D62 rule, which is D58's gate (1) reused:
 *
 * > a `gpsActivities` row is kept iff it is linked to a **visible** report.
 *
 * A kept row keeps its `path`, its times and its lake — that's the contribution to the aggregate map
 * the founder asked to preserve, and it keeps drawing correctly because every gate the aggregate layer
 * checks reads data that survives (the linked report, its `showPutIn`, and this profile's
 * `excludeTracksFromAggregate`, which finalize deliberately does not touch).
 *
 * What it loses is the handles that point back at a person: `providerActivityId` is a key into a
 * possibly-public Strava activity, and `photoUrls` are provider-CDN links. Both are re-identification
 * vectors that say nothing about ice. `providerActivityId` is replaced rather than cleared because it's
 * a required field and half of a uniqueness pair — a synthetic value keeps the dedup index honest.
 */
async function severTracks(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
): Promise<StageResult> {
  // **Paginated, not `.take()`.** This stage keeps some of what it reads, so the query doesn't shrink
  // under it the way the pure-delete stages do — re-taking the first page would re-read the same kept
  // rows forever and never reach row PAGE + 1.
  const page = await ctx.db
    .query('gpsActivities')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  for (const activity of page.page) {
    const report =
      activity.linkedReportId !== undefined ? await ctx.db.get(activity.linkedReportId) : null;

    // The D62 rule, which is D58 gate (1): kept iff linked to a *visible* report.
    if (report?.moderationStatus !== 'visible') {
      await ctx.db.delete(activity._id);
      continue;
    }
    if (activity.providerActivityId.startsWith(SEVERED_PREFIX)) continue; // idempotent re-run
    await ctx.db.patch(activity._id, {
      providerActivityId: `${SEVERED_PREFIX}${activity._id}`,
      photoUrls: undefined,
    });
  }

  return page.isDone ? { more: false } : { more: true, cursor: page.continueCursor };
}

/**
 * Photos: **erase the unattached, keep the published.** A photo referenced by a report or hazard is
 * part of the public record the tombstone anonymizes; one that isn't is an abandoned upload, and
 * deleting it here is the same job the orphan-GC cron does on a schedule.
 *
 * Whether a photo is referenced is decided by `lib/photoOrphans`, shared with the GC cron so the two
 * destructive paths can't drift apart on the definition. When that helper can't determine the answer it
 * returns `null` and the page is kept — an orphan the cron sweeps later is cheaper than a hole in a
 * public report.
 */
async function erasePhotos(
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  cursor: string | undefined,
  size: number,
): Promise<StageResult> {
  // Paginated rather than re-`take()`n, for the same reason as `severTracks`: referenced photos stay
  // put, so the query doesn't shrink under a repeated first-page read.
  const page = await ctx.db
    .query('photos')
    .withIndex('by_uploader', (q) => q.eq('uploaderId', userId))
    .paginate({ cursor: cursor ?? null, numItems: size });

  const next = page.isDone ? { more: false } : { more: true as const, cursor: page.continueCursor };
  if (page.page.length === 0) return next;

  const referenced = await referencedPhotoIds(ctx, userId);
  if (referenced === null) {
    console.warn(
      `accountDeletion: reference scan for ${userId} hit its cap — keeping this page of photos for the orphan GC cron rather than guessing`,
    );
    return next;
  }

  let deleted = 0;
  for (const photo of page.page) {
    if (referenced.has(photo._id)) continue;
    await deletePhotoAndBlobs(ctx, photo);
    deleted++;
  }
  return { ...next, deleted };
}

/**
 * Bucket 2 — **anonymize**, which is a single write. Every `v.id('profiles')` pointer in the app keeps
 * pointing here; what changes is that "here" no longer identifies anyone. Reports, comments, hazards,
 * ratings, bounties, flags and point events are untouched, which is the whole D33 posture: the ice
 * record belongs to the community even when the person leaves.
 *
 * The two sentinels are per-row-unique by construction (see `@skating/core`), because
 * `by_clerk_user_id` and `by_username` are read with `.unique()` and a shared constant would break
 * authentication app-wide on the *second* deleted account.
 *
 * Ends by scheduling the Clerk delete, which is fire-and-forget by design: Convex is the security
 * boundary (`requireProfile` already rejects `status: 'deleted'`), so a Clerk call that fails retries
 * and then pages a human rather than rolling back a deletion the user asked for.
 */
async function writeTombstone(ctx: MutationCtx, profile: Doc<'profiles'>): Promise<void> {
  const clerkUserId = profile.clerkUserId;
  await ctx.db.patch(profile._id, {
    status: 'deleted',
    deletedAt: Date.now(),
    deletionRequestedAt: undefined,
    displayName: DELETED_DISPLAY_NAME,
    username: deletedUsername(profile._id),
    clerkUserId: deletedClerkUserId(profile._id),
    dateOfBirth: DELETED_DATE_OF_BIRTH,
    homeCoord: undefined,
    homeTownLabel: undefined,
    bio: undefined,
    profileImageUrl: undefined,
    cachedIsochrones: undefined,
    outerRadiusMeters: undefined,
    cachedIsochronesAt: undefined,
    feedFilterPrefs: undefined,
    riskAckVersion: undefined,
    riskAckAt: undefined,
    // NOT touched, deliberately (D62): `excludeTracksFromAggregate`. Setting it here would look like
    // the careful privacy choice and would silently pull every track this person contributed off the
    // map — the exact opposite of what keeping published tracks is for.
  });

  await ctx.scheduler.runAfter(0, internal.clerkAdmin.deleteUser, { clerkUserId });
}

/**
 * Operator escape hatch: finalize one account now, skipping the remaining grace window. Exists for the
 * support case where someone asks to be removed immediately, and it deliberately still runs the *same*
 * staged job rather than a second, less-tested path.
 */
export const finalizeNow = internalMutation({
  args: { userId: v.id('profiles') },
  handler: async (ctx, { userId }) => {
    const profile = await ctx.db.get(userId);
    if (!profile) throw new ConvexError('No such profile');
    if (profile.deletionRequestedAt === undefined) {
      await ctx.db.patch(userId, { deletionRequestedAt: Date.now() });
    }
    await ctx.scheduler.runAfter(0, internal.accountDeletion.finalizeAccount, { userId });
  },
});
