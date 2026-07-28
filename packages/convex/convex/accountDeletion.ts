/**
 * Account deletion (D33, mechanics amended by D62 and its two amendments).
 *
 * Three ideas carry this file.
 *
 * **1. A request makes you a ghost immediately; only the login waits 30 days.** The obvious design —
 * stamp a date, change nothing, decide everything on day 30 — was wrong in both directions, and the
 * founder's correction (2026-07-27) is what this file now implements.
 *
 * It was too *slow* about the person: someone who asks to be deleted should stop existing on the
 * platform then and there. So `requestDeletion` really scrubs the profile, the read gates start
 * returning nothing for them, and their surviving content reads as `Deleted skater` — **none of which
 * a cancel undoes**.
 *
 * And it was too *permissive* about content: a pending account that could still post would file a
 * report in hour 719 that gets anonymized hours later, its author already gone from under it. So a
 * ghost is read-only (`requireContributor`). That also *used* to be what made the redaction schedule
 * provable — a ghost's newest `skateEndTime` can't postdate its own request, so by finalization
 * everything they hold has aged out — and the argument was true but load-bearing in a place it
 * shouldn't have been. Three bugs came out of resting an irreversible pass on it (see
 * `lib/contentPurge`'s header), so the finalize stage now ignores the age cutoff outright and the
 * argument is a nice property rather than a guarantee anything depends on.
 *
 * The pending state stays its own field rather than a `status` value, because `status` is the security
 * gate `requireProfile` reads and it would take *reads* down with it — and a ghost has to be able to
 * read the app to change their mind. Its mirror image is the `deleting` status, which gates
 * *everything* including the read-only exemptions (see the `lock` stage): once finalization begins, an
 * account that can still write is an account whose private rows can outlive it.
 *
 * **2. Erase the person, keep the observation (D62 second amendment).** D33 said "anonymize, don't
 * erase"; the first D62 amendment replaced that with "erase at 30 days"; this is the correction to
 * *that*, and it lands between the two. The seam is not *how old* something is, it is **what a person
 * typed versus what they observed**:
 *
 * - **Erased** — private artifacts with no community value: OAuth tokens, notifications, favorites,
 *   blocks, support tickets, client signal events, unpublished recordings, abandoned photo uploads,
 *   and every bounty (a standing ask nobody is making any more).
 * - **Redacted** — free text on published content, cleared at 30 days: `reports.notes` and the notes
 *   on individual thickness readings, `hazards.description`, photo captions, and comment bodies. See
 *   `lib/contentPurge`.
 * - **Anonymized** — everything else on the public ice record, by a single write: the author pointer
 *   becomes a tombstone and the observation stays exactly as it was.
 *
 * The argument for the middle bucket is that erasing it was taking something from the next skater
 * without giving anything back to the person who left. A coordinate, an ice type, a thickness reading
 * and a date stop being facts about anybody once the name is gone.
 *
 * **3. The track rule is D58's own predicate, reused.** An activity is kept iff it's linked to a
 * visible report. That's gate (1) of the aggregate layer, *publish-is-consent*: an unlinked activity is
 * a recording the person never published, so it goes with the private bucket, while a linked one is
 * already drawn on the lake and is part of the ice record this whole posture exists to preserve.
 *
 * This rule is the one that quietly died under the first amendment and is alive again under the
 * second, which is worth knowing when reading `severTracks`. While reports were erased at 30 days, its
 * keep-branch could never fire in production: the purge stage deleted every report first and each
 * deletion took its linked activity with it, so by the time the stage ran there was nothing left to
 * keep. Only `finalizeNow` — which stamps and finalizes in the same instant, leaving content younger
 * than the cutoff — ever reached it, which is also why the tests didn't notice.
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
import { redactAgedContent } from './lib/contentPurge';
import { reclaimExportBlob } from './lib/exportBundles';
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
 * How many *pending* ghosts one tick re-runs the redaction for. Higher than the finalize budget
 * because the work is far cheaper — a pass over an account with nothing left to redact is a handful of
 * empty index reads — and because the population is bounded by construction: it is everyone who asked
 * to be deleted in the last 30 days and hasn't been finalized yet.
 */
const REDACT_PER_TICK = 200;

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
 * Ask to be deleted — which **immediately makes them a ghost** (D62 amendment, founder 2026-07-27).
 * Idempotent: asking twice keeps the original date rather than restarting the clock.
 *
 * This is the sharp edge of the whole feature, so it's worth being plain about what the 30 days are
 * and are not. They are **not** a grace period in which nothing has happened yet. The moment this
 * runs:
 *
 * - the profile is **really scrubbed** — name, avatar, bio, town, home coordinate, isochrones — and
 *   cancelling does not put any of it back;
 * - the public profile and profile search **stop returning them entirely**: to everyone else, this
 *   person no longer exists;
 * - every surviving report, comment and hazard reads as `Deleted skater`;
 * - the **words** come off anything older than 30 days past its skate — report notes, hazard
 *   descriptions, photo captions, comment bodies — permanently (`lib/contentPurge`).
 *
 * What the window preserves is the **login**, so the decision can be reversed. What survives it
 * entirely is the **observation** — the coordinate, the ice type, the thickness, the date — which is
 * kept for the community rather than for the person leaving. That asymmetry is the design: what you
 * saw stays while it can still keep someone off bad ice; who you were doesn't.
 *
 * Three fields are deliberately *not* scrubbed here:
 *
 * - **`clerkUserId`** — it is the sign-in. Scrubbing it is what finalization does.
 * - **`username`** — reserved, not released (founder call). Invisibility comes from the read gates,
 *   not from mutating the handle, so releasing it would buy nothing and cost someone their name to a
 *   squatter in a window they might well cancel in.
 * - **`dateOfBirth`** — scrubbing it means restoring it as `DELETED_DATE_OF_BIRTH`, which derives to
 *   *adult*. A minor who cancels would come back an adult with an adult's posting rights. The one
 *   place a privacy scrub would create a safety hole, so it waits for finalization, where there is no
 *   coming back.
 */
export const requestDeletion = mutation({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx);
    if (profile.deletionRequestedAt !== undefined) {
      return { scheduledFor: profile.deletionRequestedAt + DELETION_GRACE_MS };
    }
    const now = Date.now();
    await ctx.db.patch(profile._id, {
      deletionRequestedAt: now,
      // The wipe. Everything here is identity or private location; none of it is community record.
      displayName: DELETED_DISPLAY_NAME,
      profileImageUrl: undefined,
      bio: undefined,
      homeTownLabel: undefined,
      homeCoord: undefined,
      cachedIsochrones: undefined,
      cachedIsochronesAt: undefined,
      outerRadiusMeters: undefined,
      // Private by default on the way out: belt to the read gates' braces, and the honest setting for
      // a profile with nothing on it.
      profileVisibility: 'private',
    });

    // The words come off now, not at finalize. Scheduled rather than inline because a prolific
    // contributor's history is more than one transaction, and because the request itself must return
    // fast — this is a button press, not a batch job.
    await ctx.scheduler.runAfter(0, internal.accountDeletion.redactGhostContent, {
      userId: profile._id,
    });
    return { scheduledFor: now + DELETION_GRACE_MS };
  },
});

/**
 * Change their mind. An **explicit** action, never an implicit side effect of signing in — someone who
 * logs in once to save a photo before leaving must not silently un-delete themselves.
 *
 * **What this does and does not restore.** It stops the finalization, and it keeps every observation
 * that was still standing. It does *not* undo the wipe: the profile stays empty and the person is
 * routed back through onboarding to introduce themselves again (`needsProfileSetup`), and the text
 * already redacted is gone — their old reports keep their readings and lose their prose. That's not a
 * limitation of the implementation; the words were deleted, and pretending a cancel could recover them
 * would be the one dishonest thing this flow could do.
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

/**
 * Keep a ghost thinning out. Re-runs the redaction until a pass comes back with nothing more to do,
 * threading the continuation token `lib/contentPurge` hands back.
 *
 * Called at the request, and again on every finalize-sweep tick for as long as the account is pending
 * — because content that was three days old when they left is thirty-three days old three weeks later,
 * and "the words are gone" should keep being true rather than describing one instant.
 */
export const redactGhostContent = internalMutation({
  args: {
    userId: v.id('profiles'),
    cursor: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { userId, cursor, pageSize }) => {
    const profile = await ctx.db.get(userId);
    if (!profile) return { stopped: 'gone' as const };
    // Cancelled between two passes: stop. What is already redacted stays redacted — see
    // `cancelDeletion`.
    if (profile.deletionRequestedAt === undefined && profile.status !== 'deleting') {
      return { stopped: 'cancelled' as const };
    }

    // No `final` here, deliberately: this is the ghost-window sweep, where the age cutoff *is* the
    // promise being kept. `final` belongs to the finalize chain's `redact` stage alone.
    const result = await redactAgedContent(ctx, userId, Date.now(), {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
    });
    if (result.more) {
      await ctx.scheduler.runAfter(0, internal.accountDeletion.redactGhostContent, {
        userId,
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
      });
    }
    return result;
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
    const dueAt = Date.now() - DELETION_GRACE_MS;
    const due = await ctx.db
      .query('profiles')
      .withIndex('by_deletion_requested_at', (q) =>
        q.gt('deletionRequestedAt', 0).lte('deletionRequestedAt', dueAt),
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
      //
      // `deleting` is deliberately **not** skipped: that's an account whose chain started and didn't
      // finish, and re-queueing it is how a lost scheduler tick heals. Every stage is idempotent, so
      // the cost of re-driving one that was merely slow is a few wasted reads.
      if (profile.status === 'deleted') continue;
      await ctx.scheduler.runAfter(0, internal.accountDeletion.finalizeAccount, {
        userId: profile._id,
      });
      started++;
    }

    // Ghosts that aren't due yet still keep thinning out. Content three days old at the request is
    // thirty-three days old three weeks later, and "the words are gone" has to keep being true rather
    // than describing the single instant they pressed the button.
    //
    // **The bound is `gt(dueAt)`, and it is the fix for a starvation bug rather than a tidier way to
    // write the same query.** This used to read the whole pending range and drop the due rows with a
    // post-filter — but the range is ordered by request time, so the due accounts are always the
    // *oldest* ones, always at the front, and always the ones filling the page. On a tick with a full
    // page of due accounts every row read here was discarded and not one pending ghost was thinned.
    // Excluding them in-index means the page is spent on rows that can actually use it.
    //
    // The remaining cap is a priority order, not a starvation: the oldest pending ghosts are the ones
    // closest to finalization, which is exactly when their content has to be clean.
    const pending = await ctx.db
      .query('profiles')
      .withIndex('by_deletion_requested_at', (q) => q.gt('deletionRequestedAt', dueAt))
      .take(REDACT_PER_TICK);
    let redacting = 0;
    for (const profile of pending) {
      if (profile.deletionRequestedAt === undefined) continue;
      if (profile.status === 'deleted') continue;
      await ctx.scheduler.runAfter(0, internal.accountDeletion.redactGhostContent, {
        userId: profile._id,
      });
      redacting++;
    }

    return { due: due.length, started, skipped, redacting };
  },
});

/**
 * The stages, in order. Named rather than numbered so a log line or a resumed job says what it's doing,
 * and so inserting one later doesn't renumber the rest.
 *
 * Order is not arbitrary at either end.
 *
 * **`lock` is first** (PR #29 review). Each stage is its own transaction, and until this existed the
 * account stayed fully usable across all of them — so a person who asked to be deleted 30 days ago,
 * forgot, and happens to be using the app right now could favorite a lake, file a support ticket or
 * connect Strava *after* the pass that erased those tables, and the row would outlive their deletion.
 * No later stage rescans, so nothing would ever catch it. `lock` closes that by making the profile
 * unable to write before anything is read.
 *
 * **`tombstone` is last.** Every stage before it reads the live profile — `erase` needs
 * `clerkUserId`, which is the only way support tickets can be found — so scrubbing the identity first
 * would strand the remaining private rows behind a key nobody can look up again.
 *
 * **`redact` is second**, and it is emphatically *not* a formality, which is what a previous version of
 * this comment got wrong. The ghost sweep has been clearing this account's text since the request, so
 * usually little is left — but this pass runs with no age cutoff at all (`final: true`), because it is
 * the last one that will ever see these rows. What it skips is kept forever. It sits before `tracks`
 * for a reason that survived the posture change — it erases the *unpublished* recordings, so `tracks`
 * only ever sees activities that are still worth deciding about.
 */
const STAGES = ['lock', 'redact', 'erase', 'tracks', 'photos', 'tombstone'] as const;
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
  // Defaults to the *first* stage rather than naming one: an entry point that starts at `erase` skips
  // the lock, which is the whole guarantee.
  handler: async (ctx, { userId, stage = STAGES[0], cursor, pageSize }) => {
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
    case 'lock':
      await lockAccount(ctx, profile);
      return { more: false };
    case 'redact': {
      // **`final: true` — no age cutoff.** This is the last pass that will ever run for this account:
      // `tombstone` clears `deletionRequestedAt`, the row leaves `by_deletion_requested_at`, and no
      // cron can reach it again. So anything an age gate skips here is kept *forever*, which is how
      // the same one-line condition produced three separate bugs — hazards whose `lastConfirmedAt`
      // other people kept pushing forward, every `finalizeNow` invocation, and the hour of
      // future-skate-time overhang. See `lib/contentPurge`'s header.
      //
      // The old reasoning wasn't wrong, only fragile: a ghost can't post, so *usually* everything they
      // hold is already past the line by now. Resting an irreversible pass on "usually" is what this
      // replaces. The observations themselves still stay — `final` governs the cutoff, not the seam —
      // and the `tombstone` stage is what takes their author's name off them.
      const result = await redactAgedContent(ctx, profile._id, Date.now(), {
        final: true,
        pageSize: size,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return {
        more: result.more,
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
      };
    }
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
 * Stage 0 — **stop the account writing**, before a single row is read (PR #29 review).
 *
 * The bug this closes is a staging bug rather than a deletion bug, and it's invisible in any single
 * stage: `erase` drains favorites, blocks, tickets, notifications and OAuth connections, commits, and
 * schedules the next stage. Until this stage existed, the profile was still `active` for that whole
 * chain, so a request that arrived in between was accepted normally and its row was never looked at
 * again — a private record that survived a completed deletion, with nothing in the system aware of it.
 * The 30-day window makes that unlikely, not impossible: the person is not locked out during it, so
 * "asked to be deleted a month ago and is using the app right now" is an ordinary state to be in.
 *
 * **Read-only narrows this, and deliberately does not replace it.** `requireContributor` already
 * refuses reports, hazards, photos and new provider connections for a pending account, so the tables
 * still reachable mid-chain are exactly the protective ones the grace window keeps open — a favorite,
 * a block, a support ticket, an export request. Those are erased rows too, and a person tapping
 * "block this user" the second before the sweep runs shouldn't have it silently kept.
 *
 * `deleting` is a real `status` and `requireProfile` rejects it, which is what makes this a lock rather
 * than a note. Convex's OCC is what makes it airtight rather than merely narrow: **every write path
 * resolves the caller through `getCurrentProfile`, so every write reads this row.** A mutation that
 * read the profile as `active` and tries to commit after this patch lands conflicts on that read, and
 * on retry it sees `deleting` and throws.
 *
 * Two consequences worth stating:
 *
 * - **Finalization is no longer cancellable**, because `cancelDeletion` needs an active profile.
 *   That's the correct end state, and it also removes a hole: cancelling mid-chain used to leave a
 *   live account whose favorites, blocks and support tickets had already been erased, described in a
 *   comment as things that "regenerate". Notifications regenerate. Blocks do not.
 * - **A crashed job self-heals.** The hourly sweep skips only `deleted`, so an account left in
 *   `deleting` by a lost scheduler tick is re-queued and the chain restarts from here. Every stage is
 *   idempotent, so re-driving one that is merely slow costs a little work and breaks nothing.
 */
async function lockAccount(ctx: MutationCtx, profile: Doc<'profiles'>): Promise<void> {
  if (profile.status === 'deleting') return; // re-driven job, already locked
  await ctx.db.patch(profile._id, { status: 'deleting' });
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

  // Export bundles. An assembled export is every report, every track and every photo of the person in
  // one file — the densest concentration of one person's data anywhere in the system — so the default
  // here is to reclaim the row *and* the blob.
  //
  // **The carve-out: a bundle they can still reach outlives the account** (founder call). Deleting is
  // the moment someone most wants their own record, and the account going away is exactly what makes a
  // link the only way back to it — `myExports` needs a sign-in, and after this stage there isn't one.
  // So a bundle that is still inside its TTL *and* was actually emailed is left alone, and the hourly
  // hygiene sweep reclaims it when it expires like any other.
  //
  // `emailedAt` is doing real work in that condition rather than decorating it. With Resend
  // unprovisioned nothing is sent, and keeping an un-emailed bundle would retain the densest artifact
  // in the system while leaving no way on earth to fetch it — the worst of both. Unreachable ⇒ reclaim
  // now.
  //
  // A row whose blob **couldn't** be reclaimed is kept rather than dropped (`lib/exportBundles`): the
  // row is the only pointer to that bundle, and losing it here would be the worst version of this
  // failure — a full copy of a deleted person's data, in storage, unfindable. Its `expiresAt` is
  // pulled to now so the hygiene sweep retries on its next tick instead of waiting out the TTL.
  const now = Date.now();
  const exports = await ctx.db
    .query('dataExports')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(size);
  const reclaimed: Doc<'dataExports'>[] = [];
  for (const row of exports) {
    if (row.expiresAt > now && row.emailedAt !== undefined) continue; // still theirs to download
    if (await reclaimExportBlob(ctx, row)) {
      reclaimed.push(row);
    } else if (row.expiresAt > now) {
      await ctx.db.patch(row._id, { expiresAt: now });
    }
  }
  await drain(reclaimed);

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
    // Keeping the page is the safe direction and stays the answer: "couldn't determine" must never
    // become "delete it", because a photo torn out of a surviving public report is unrecoverable.
    //
    // What this is *not* allowed to mean is that the person's prose survives with it. The `redact`
    // stage runs before this one and clears captions independently of the reference scan (see
    // `lib/contentPurge`'s `sweepPhotos`), so a capped scan here costs storage — the blobs of uploads
    // that may have been abandoned — and nothing else. Logged at error level because, unlike the
    // orphan cron's daily retry, this pass is terminal for the account: the tombstone is two stages
    // away and no sweep will re-derive this answer.
    console.error(
      `accountDeletion: reference scan for ${userId} hit its cap at finalization — keeping this page of photos rather than guessing. Captions are already cleared by the redact stage; the blobs need an operator to reconcile.`,
    );
    return next;
  }

  let deleted = 0;
  for (const photo of page.page) {
    if (referenced.has(photo._id)) continue;
    if (await deletePhotoAndBlobs(ctx, photo)) {
      deleted++;
      continue;
    }
    // The blob outlived the attempt, so the row stays as the only pointer to it (`lib/photoOrphans`)
    // and the orphan cron retries daily. What it does *not* get to do is stay a record of a person:
    // the caption, the timestamp and — the one that matters — the GPS coordinate come off now, leaving
    // a row that is nothing but two storage ids and the job of reclaiming them.
    await ctx.db.patch(photo._id, {
      caption: undefined,
      takenAt: undefined,
      coord: undefined,
      placeOnMap: false,
    });
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
    // A moderator's free-text reason for a past suspension or ban, denormalized onto the profile —
    // prose about this person, frequently naming another one ("repeatedly abusive to @someone in
    // comments"). It is on the same side of the D62 seam as everything else here, and it was missed
    // because it is the one PII field on `profiles` that the *operator* wrote rather than the user.
    // Nothing is lost: `moderationActions` is a separate table with a required `reason`, and that
    // audit trail deliberately survives deletion.
    statusReason: undefined,
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
 *
 * **This is the compliance lever, so it has to redact the most rather than the least.** It used to do
 * the opposite: it stamps and finalizes in the same instant, so the `redact` stage's age cutoff sat
 * thirty days in the past and *nothing* the person held was due — the one path meaning "remove me right
 * now" left their most recent month of prose up permanently, since no later sweep can reach a tombstone.
 * The stage is unconditional now (`final: true`), which fixes this here without a second code path.
 *
 * The reason it went unnoticed is worth keeping: every finalization test reached the chain through
 * *this* function, so no test ever had content that aged. That's the same blind spot that hid the dead
 * kept-tracks branch, found in the same review.
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
