/**
 * The season-rollover recurrence pass (N5c / §C4) — once a year, plus a button.
 *
 * **Why a job rather than a query.** `hazards` never ages out, so "every hazard on this lake across
 * four winters" is a read that grows forever; the within-season half can cluster at read time precisely
 * because `listForBody` is already bounded by body and season. The asymmetry is about read bounds, and
 * it is written down in both places so nobody "unifies" them later.
 *
 * **Why July.** D63 put the season boundary at July 1 because it is the deadest point of the year in
 * the Northeast — the reset lands when nobody is looking, and so does this. The output is a
 * *pre-first-ice reading list*: an operator spends an hour in October with a queue that was computed
 * while the lakes were warm.
 *
 * Two phases, and the split is structural rather than stylistic: Convex allows **one `.paginate()` per
 * function execution**, so discovering which bodies have hazards and recomputing them cannot happen in
 * the same call. Phase one pages the corpus into `recurrenceQueue`; phase two drains it one body per
 * call, each body **completely**.
 */

import {
  type HazardShape,
  hazardFamilyFor,
  hazardFootprint,
  isPubliclyVisible,
  polygonDistanceMeters,
  RECURRENCE_FAMILIES,
  RECURRENCE_MATCH_METERS,
  RECURRENCE_WINDOW_SEASONS,
  type Season,
  seasonOf,
} from '@skating/core';
import { paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, mutation, query } from './_generated/server';
import { insertBodyFeature } from './bodyFeatures';
import { requireContributorRole } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { BODY_FEATURE_TYPES } from './lib/enums';
import { computeClustersForBody, windowStartMs } from './lib/recurrence';
import { literals } from './lib/validators';

/**
 * How long a queued body may sit claimed before another run may take it over.
 *
 * A single body's recompute is one transaction and therefore atomic — there is no half-done body to
 * protect. What this bounds is *overlap between runs*: the annual cron and an operator pressing
 * "recompute now" on the same lake, or a run that died between calls. A stale claim is taken over
 * rather than respected, because the alternative to a wrong retry here is a body that is never
 * recomputed at all, which is the failure this pass exists to prevent.
 */
export const RECURRENCE_LEASE_MS = 60 * 60 * 1000;

/** Hazard rows read per discovery page. Small: the phase re-schedules itself until the cursor is done. */
const DISCOVERY_PAGE = 200;

/**
 * How much of two clusters' membership must coincide for a recompute to call them the same cluster.
 *
 * **Overlap, not identity** (§C4.3). A cluster that grew by one member is the same cluster — and if the
 * match were by identity, every new winter's sighting would mint a fresh row and silently drop the
 * suppression or the promotion a human had attached to the old one.
 *
 * ⚠ **Measured as the overlap coefficient, not Jaccard, and the plan's own sentence is why.** §C4 says
 * *"Jaccard > 0.5"* and *"a cluster that grew by one member is the same cluster"*, and those two
 * disagree in exactly the case that matters: one member growing to two is a Jaccard of 0.5 — not
 * greater than — so the row a human had suppressed would be abandoned the first winter anyone added a
 * sighting. Two growing to four is 0.5 as well. Small clusters are the *only* clusters for years, so
 * the symmetric measure fails for the whole corpus before it ever succeeds.
 *
 * `shared / min(|old|, |new|)` says the thing the sentence meant: most of the smaller set survived. It
 * matches a cluster that grew, and a cluster that shrank because pins were hidden, and it refuses two
 * clusters that merely brush past each other. A split still only lets **one** half inherit, because a
 * claimed row is out of the running for the rest of the pass.
 */
export const CLUSTER_MATCH_MIN_OVERLAP = 0.5;

/** Kick off a full run. The cron's target, and idempotent — a second call finds the queue already built. */
export const startRecurrenceRun = internalMutation({
  args: { season: v.optional(v.number()) },
  handler: async (ctx, { season }) => {
    const runForSeason: Season = season ?? seasonOf(Date.now());
    // Leftovers from an abandoned run would make phase two think there is work it has already done.
    // Cleared here rather than at the end of a run, because the end of an abandoned run never comes.
    for (const stale of await ctx.db
      .query('recurrenceQueue')
      .withIndex('by_season', (q) => q.lt('runForSeason', runForSeason))
      .take(DISCOVERY_PAGE)) {
      await ctx.db.delete(stale._id);
    }
    await ctx.scheduler.runAfter(0, internal.recurrence.discoverBodies, { runForSeason });
  },
});

/**
 * Phase one: page the corpus's hazards inside the window and queue every distinct body.
 *
 * Read off `by_first_reported`, which is the index this pass justified: `by_water_body` is
 * creation-ordered and `by_water_body_status` is per body, so neither can answer "every hazard first
 * reported inside these four winters". `firstReportedAt` is the season clock nobody can move (D63),
 * which is the only clock a cross-season record may agree with.
 */
export const discoverBodies = internalMutation({
  args: { runForSeason: v.number(), cursor: v.optional(v.string()) },
  handler: async (ctx, { runForSeason, cursor }) => {
    const page = await ctx.db
      .query('hazards')
      .withIndex('by_first_reported', (q) => q.gte('firstReportedAt', windowStartMs(runForSeason)))
      .paginate({ cursor: cursor ?? null, numItems: DISCOVERY_PAGE });

    const now = Date.now();
    for (const hazard of page.page) {
      // One row per body per run, however many pages that body's hazards span. The equality read is
      // what makes the dedup cheap enough to do per hazard rather than per page.
      const existing = await ctx.db
        .query('recurrenceQueue')
        .withIndex('by_season_and_body', (q) =>
          q.eq('runForSeason', runForSeason).eq('waterBodyId', hazard.waterBodyId),
        )
        .first();
      if (existing) continue;
      await ctx.db.insert('recurrenceQueue', {
        waterBodyId: hazard.waterBodyId,
        runForSeason,
        createdAt: now,
      });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.recurrence.discoverBodies, {
        runForSeason,
        cursor: page.continueCursor,
      });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.recurrence.processNextBody, { runForSeason });
  },
});

/**
 * How many times one body may be handed to a recompute before the pass steps over it.
 *
 * The backstop for a lake whose recompute cannot commit for a reason the ceiling in
 * `lib/recurrence` does not cover. Three, because the July window is a week: a genuinely poisoned body
 * is stepped over by the third day and the rest of the corpus still gets its year's recompute.
 */
export const MAX_BODY_ATTEMPTS = 3;

/** Stored clusters read per body when diffing a recompute. Far above any real lake; see the call site. */
const MAX_BODY_CLUSTERS = 1_000;

/**
 * Phase two, part one: **claim** the next queued body and hand it to a recompute.
 *
 * ⚠ **Claiming and computing are two transactions, and that split is the whole point of this
 * function.** They used to be one: claim, recompute, delete, schedule the next — which reads well and
 * fails terribly. A recompute that cannot commit rolls its transaction back, so the claim went with
 * it, the queue row was never deleted, and nothing downstream was scheduled. Every later run then
 * picked the same body first and died the same way: **one lake could stop the annual pass for the
 * whole corpus, permanently** (Greptile, PR #35). And because the read set that failed is a function
 * of user-created hazards and confirmations, that was reachable from ordinary use of the app.
 *
 * Split, the attempt counter commits *before* the work is attempted, so a failure is remembered rather
 * than undone. After {@link MAX_BODY_ATTEMPTS} the body is marked skipped and the queue moves on — the
 * corpus's recompute is not held hostage to one lake, and the skipped row stays as a thing an operator
 * can find, because a silently dropped body presents as "this lake has no patterns".
 */
export const processNextBody = internalMutation({
  args: { runForSeason: v.number() },
  handler: async (ctx, { runForSeason }) => {
    const now = Date.now();
    const queued = await ctx.db
      .query('recurrenceQueue')
      .withIndex('by_season', (q) => q.eq('runForSeason', runForSeason))
      .take(DISCOVERY_PAGE);

    const next = queued.find(
      (row) =>
        row.skippedAt === undefined &&
        (row.claimedAt === undefined || now - row.claimedAt > RECURRENCE_LEASE_MS),
    );
    if (!next) {
      // Either the queue is drained, or what is left is claimed and fresh (another run has it), or
      // skipped. None of those is an error and all of them mean this chain stops.
      return;
    }

    const attempts = (next.attempts ?? 0) + 1;
    if (attempts > MAX_BODY_ATTEMPTS) {
      console.error(
        `recurrence: ${next.waterBodyId} failed ${MAX_BODY_ATTEMPTS} recomputes — skipping it so the rest of the queue can drain`,
      );
      await ctx.db.patch(next._id, { skippedAt: now });
      await ctx.scheduler.runAfter(0, internal.recurrence.processNextBody, { runForSeason });
      return;
    }

    // Committed before the work is attempted. If the recompute below dies, this is what remembers.
    await ctx.db.patch(next._id, { claimedAt: now, attempts });
    await ctx.scheduler.runAfter(0, internal.recurrence.recomputeQueuedBody, {
      queueId: next._id,
      runForSeason,
    });
  },
});

/**
 * Phase two, part two: recompute the claimed body, drop its queue row, and continue the chain.
 *
 * **One body per call, and the body itself is processed completely.** The pass's job is completeness,
 * and this is still the transaction boundary — a body is either fully recomputed or not at all, with
 * no half-computed lake to reason about. What changed is only that a failure here can no longer erase
 * the record that it was attempted.
 */
export const recomputeQueuedBody = internalMutation({
  args: { queueId: v.id('recurrenceQueue'), runForSeason: v.number() },
  handler: async (ctx, { queueId, runForSeason }) => {
    const queued = await ctx.db.get(queueId);
    // Gone already — another run took it, or the queue was cleared. Continue rather than stop: the
    // chain is the only thing driving the drain.
    if (!queued) {
      await ctx.scheduler.runAfter(0, internal.recurrence.processNextBody, { runForSeason });
      return;
    }

    const body = await ctx.db.get(queued.waterBodyId);
    if (body) await recomputeBody(ctx, body, runForSeason, Date.now());
    // Deleted whether or not the body still exists: a queue row for a body that has been removed is
    // work that can never complete, and leaving it would stall every later run on the same season.
    await ctx.db.delete(queueId);

    await ctx.scheduler.runAfter(0, internal.recurrence.processNextBody, { runForSeason });
  },
});

/**
 * Recompute one body's stored recurrence — **diffing, never replacing** (§C4.3).
 *
 * Delete-and-reinsert would be simpler and would throw away every human decision attached to these
 * rows: a suppression is a moderator saying *this is not a pattern*, and a promotion is one saying
 * *this is, and here is the feature*. Both have to survive a job that runs while nobody is watching.
 *
 * So new clusters are matched to existing rows on **member overlap**, and an old row that matches
 * nothing is deleted *unless* a human touched it, in which case it is kept and marked stale — visible
 * to an operator as "this no longer matches anything we can see" rather than vanishing.
 */
export async function recomputeBody(
  ctx: MutationCtx,
  body: Doc<'waterBodies'>,
  runForSeason: Season,
  now: number,
): Promise<void> {
  const computed = await computeClustersForBody(ctx, body, runForSeason);
  // Bounded like everything else this transaction touches. Clusters are a small fraction of a body's
  // hazards — realistically tens — so this ceiling is unreachable in practice; it is here because
  // "unreachable in practice" is what the per-body hazard read was too, right up until it wasn't.
  const existing = await ctx.db
    .query('hazardRecurrence')
    .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
    .take(MAX_BODY_CLUSTERS);

  const claimed = new Set<string>();
  for (const cluster of computed) {
    const match = bestMatch(cluster.memberHazardIds, existing, claimed);
    const publiclyVisible = isPublic(cluster, match);
    const row = {
      waterBodyId: body._id,
      ...cluster,
      publiclyVisible,
      computedAt: now,
      computedForSeason: runForSeason,
      // A recompute that found this cluster again clears any stale mark: whatever made it unmatchable
      // last time is over, and leaving the mark would tell an operator the row is dead when it isn't.
      staleSince: undefined,
    };
    if (match) {
      claimed.add(match._id);
      await ctx.db.patch(match._id, row);
    } else {
      await ctx.db.insert('hazardRecurrence', row);
    }
  }

  for (const old of existing) {
    if (claimed.has(old._id)) continue;
    const humanTouched = old.suppressedAt !== undefined || old.promotedToFeatureId !== undefined;
    if (!humanTouched) {
      await ctx.db.delete(old._id);
      continue;
    }
    // Kept, and said so. A cluster somebody suppressed or promoted that no longer matches anything is
    // a fact an operator should be able to see — the hazards behind it may have been hidden, merged or
    // voted bogus since — and deleting it would drop the decision along with the reason for it.
    await ctx.db.patch(old._id, {
      staleSince: old.staleSince ?? now,
      publiclyVisible: false,
      computedForSeason: runForSeason,
      computedAt: now,
    });
  }
}

/**
 * The existing row a computed cluster continues, or `null` for a genuinely new one.
 *
 * Highest overlap wins, and a row already claimed by another cluster is out of the running — a split
 * (one cluster becoming two as the tolerance finds a gap) must not have both halves inherit the same
 * suppression.
 */
function bestMatch(
  memberIds: readonly Id<'hazards'>[],
  existing: readonly Doc<'hazardRecurrence'>[],
  claimed: ReadonlySet<string>,
): Doc<'hazardRecurrence'> | null {
  const fresh = new Set<string>(memberIds);
  let best: { row: Doc<'hazardRecurrence'>; score: number } | null = null;
  for (const row of existing) {
    if (claimed.has(row._id)) continue;
    const prior = new Set<string>(row.memberHazardIds);
    let shared = 0;
    for (const id of fresh) if (prior.has(id)) shared += 1;
    const smaller = Math.min(fresh.size, prior.size);
    const overlap = smaller === 0 ? 0 : shared / smaller;
    if (overlap <= CLUSTER_MATCH_MIN_OVERLAP) continue;
    if (best === null || overlap > best.score) best = { row, score: overlap };
  }
  return best?.row ?? null;
}

/**
 * Whether a recomputed cluster may be seen by a skater — carrying the human decisions across.
 *
 * `isPubliclyVisible` lives in core and is where the bar is written; this is the shell that hands it
 * the suppression and promotion state the *existing* row is holding, since a recompute must not
 * un-suppress a cluster by forgetting it was suppressed.
 */
function isPublic(
  cluster: { family: Doc<'hazardRecurrence'>['family']; seasonsObserved: readonly Season[] },
  existing: Doc<'hazardRecurrence'> | null,
): boolean {
  return isPubliclyVisible({
    family: cluster.family,
    seasonsObserved: cluster.seasonsObserved,
    ...(existing?.suppressedAt !== undefined ? { suppressedAt: existing.suppressedAt } : {}),
    ...(existing?.promotedToFeatureId !== undefined
      ? { promotedToFeatureId: existing.promotedToFeatureId }
      : {}),
  });
}

/**
 * The July cron's entry point, gated on the month.
 *
 * `crons.cron` would say this in one expression, and the repo has never used one — every existing job
 * is a `crons.interval`. A daily interval with a month check keeps the file uniform and, more usefully,
 * makes the rollover *retryable*: a run that fails on July 2 is picked up on July 3, where a
 * once-a-year cron expression would wait a year. The `computedForSeason` stamp is what makes the
 * re-run a no-op rather than a duplicate.
 */
export const maybeRunRollover = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = new Date(Date.now());
    // July, the deadest point of the Northeast year (D63) — and the first week of it, so a failure has
    // the rest of the month to retry in.
    if (now.getUTCMonth() !== 6 || now.getUTCDate() > 7) return;
    const runForSeason = seasonOf(Date.now());

    // **A leftover queue means the last attempt did not finish, whatever the stamp says.**
    //
    // The stamp below records that *some* body was computed for this season, which is not the same
    // thing as the run having completed — a chain that dies after body 1 of 200 sets the stamp and
    // leaves 199 rows queued. Gating on the stamp alone would make every remaining tick in the window
    // a no-op and the pass really would wait a year, which is the precise failure a daily interval was
    // chosen to avoid.
    //
    // Restarted from the top rather than resumed from the queue, because a run can also die *during*
    // discovery, and a queue that was never finished being built cannot be told apart from one that
    // was. Re-running is cheap to reason about and safe to repeat: discovery dedups against rows
    // already queued, and re-processing a body it already did is byte-identical output by the same
    // idempotence the pass asserts. One extra pass in a failure year is the right price for a pass
    // that finishes.
    // Skipped rows are left in place on purpose (they are the record of a lake the pass could not
    // compute), so "is there work left" has to mean *unskipped* work — otherwise one stepped-over body
    // would make every remaining tick in the window restart a run with nothing to do.
    const pending = await ctx.db
      .query('recurrenceQueue')
      .withIndex('by_season', (q) => q.eq('runForSeason', runForSeason))
      .take(DISCOVERY_PAGE);
    if (pending.some((row) => row.skippedAt === undefined)) {
      await ctx.scheduler.runAfter(0, internal.recurrence.startRecurrenceRun, {
        season: runForSeason,
      });
      return;
    }

    const alreadyRun = await ctx.db
      .query('hazardRecurrence')
      .withIndex('by_computed_season_and_priority', (q) => q.eq('computedForSeason', runForSeason))
      .first();
    if (alreadyRun) return;
    await ctx.scheduler.runAfter(0, internal.recurrence.startRecurrenceRun, {
      season: runForSeason,
    });
  },
});

/**
 * Queue one body for recompute — the "recompute now" button, and the hook a body merge fires.
 *
 * A D36 body merge reassigns hazards to the survivor (`waterBodies.ts`), so **both** bodies need
 * recomputing: the survivor because it just gained a winter's worth of sightings, and the loser because
 * last year's clusters would otherwise sit on a tombstoned lake, ranked in a queue, linking nowhere.
 */
export const enqueueBody = internalMutation({
  args: { waterBodyId: v.id('waterBodies'), season: v.optional(v.number()) },
  handler: async (ctx, { waterBodyId, season }) => {
    const runForSeason: Season = season ?? seasonOf(Date.now());
    const body = await ctx.db.get(waterBodyId);
    if (!body) return;
    await recomputeBody(ctx, body, runForSeason, Date.now());
  },
});

/** Re-exported for the tests, which assert the window bound rather than recomputing it. */
export { RECURRENCE_WINDOW_SEASONS };

/**
 * What a skater may see about a lake's history (D78) — **nothing at all until the flag flips.**
 *
 * The bar is applied at the index rather than after the read, which is the difference between
 * "admin-only" and "admin-only unless you open the network tab". A thin pattern is not filtered out of
 * a payload that carried it; it never leaves the server.
 *
 * Everything returned here is history with a denominator attached. It never enters the on-ice payload,
 * never feeds `displayScore`, and never touches trust, points or the bounty gate — see the module
 * docstring on `hazardAdvisory` in core for the copy discipline that goes with it.
 */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    const rows = await ctx.db
      .query('hazardRecurrence')
      .withIndex('by_water_body_public', (q) =>
        q.eq('waterBodyId', body._id).eq('publiclyVisible', true),
      )
      .collect();
    // Nothing to yield *to*, so nothing to read this lake's hazards for. While the master switch is
    // off that is every single call, and a full active-hazard collect on every drawer open, on both
    // clients, for a query that returns `[]` by construction is the kind of cost that never announces
    // itself. The bar is applied at the index above, so an empty result here is the normal answer.
    if (rows.length === 0) return [];

    // **Live information wins** (§9.3). A pin reported this season inside a cluster's footprint has a
    // date, a reporter and a confirm loop, and is better than history in every respect — so the
    // advisory for that cluster stands down rather than competing with it.
    const thisSeason = seasonOf(Date.now());
    const live = (
      await ctx.db
        .query('hazards')
        .withIndex('by_water_body_status', (q) =>
          q.eq('waterBodyId', body._id).eq('status', 'active'),
        )
        .collect()
    ).filter(
      (h) =>
        h.moderationStatus === 'visible' &&
        h.mergedIntoHazardId === undefined &&
        seasonOf(h.firstReportedAt) === thisSeason,
    );

    return rows
      .filter((row) => !hasLiveSighting(row, live))
      .sort((a, b) => b.priority - a.priority);
  },
});

/**
 * Has this winter already put a pin on the ice a pattern is about? (§9.3)
 *
 * **Geometry, not membership, and the difference is the whole rule.** `memberHazardIds` is frozen at
 * the rollover, and the rollover runs in the first week of July — when the season it is computing for
 * is days old and holds no hazards at all. So a ridge pinned in January is *never* a member of the
 * cluster that describes it, and a membership test would leave the advisory talking over a live pin
 * for the entire winter, which is exactly the season it was supposed to stand down in. §9.3's own
 * words are *"inside the cluster footprint"*; this is that sentence.
 *
 * Same family and within `RECURRENCE_MATCH_METERS` — the tolerance the cluster was built at, so a pin
 * that would have joined this cluster in July is the pin that silences it in January. Erring wide is
 * the safe direction here: yielding too readily costs a history panel, and yielding too rarely puts a
 * statement about past winters beside a report of the ice right now.
 */
function hasLiveSighting(row: Doc<'hazardRecurrence'>, live: readonly Doc<'hazards'>[]): boolean {
  const footprint = footprintOrNull({
    geometryKind: row.geometryKind,
    geometry: row.geometry as HazardShape['geometry'],
    ...(row.radiusMeters !== undefined ? { radiusMeters: row.radiusMeters } : {}),
    ...(row.bufferMeters !== undefined ? { bufferMeters: row.bufferMeters } : {}),
  });
  // A row whose stored shape will not build is one nobody can measure against. Yielding is the
  // conservative answer: it withholds a claim about past winters rather than making one beside a pin
  // it could not compare itself to.
  if (footprint === null) return true;

  for (const hazard of live) {
    if (hazardFamilyFor(hazard.type) !== row.family) continue;
    const other = footprintOrNull({
      geometryKind: hazard.geometryKind,
      geometry: hazard.geometry as HazardShape['geometry'],
      ...(hazard.radiusMeters !== undefined ? { radiusMeters: hazard.radiusMeters } : {}),
      ...(hazard.bufferMeters !== undefined ? { bufferMeters: hazard.bufferMeters } : {}),
      // The clip is what render and proximity measure, so it is what "inside the footprint" means.
      ...(hazard.clippedFootprint !== undefined
        ? { clippedFootprint: hazard.clippedFootprint as HazardShape['geometry'] }
        : {}),
    });
    if (other === null) continue;
    if (polygonDistanceMeters(footprint, other) <= RECURRENCE_MATCH_METERS) return true;
  }
  return false;
}

/** `hazardFootprint` with the same swallow-and-degrade posture the render and proximity paths take. */
function footprintOrNull(shape: HazardShape & { clippedFootprint?: HazardShape['geometry'] }) {
  try {
    const clipped = shape.clippedFootprint;
    if (clipped && (clipped.type === 'Polygon' || clipped.type === 'MultiPolygon')) return clipped;
    return hazardFootprint(shape);
  } catch {
    return null;
  }
}

/** Everything about one lake's clusters, for the operator card — thin patterns included. */
export const listForBodyAdmin = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireContributorRole(ctx, 'moderator');
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    const rows = await ctx.db
      .query('hazardRecurrence')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
      .collect();
    return rows.sort((a, b) => b.priority - a.priority);
  },
});

/**
 * The cross-lake pre-first-ice queue (§7.2) — every cluster, ranked, paginated.
 *
 * **Bounded by construction.** It reads the precomputed table off
 * `by_computed_season_and_priority` and never touches `hazards` or `waterBodies` in bulk, which is the
 * Phase 7b rule. This is where an operator spends an hour in October and covers the whole corpus,
 * which is the difference between the feature existing and the feature working.
 *
 * ⚠ **Genuinely paginated, not capped, and the distinction is one this repo has already paid for.**
 * The filters below — family, minimum seasons, promoted, suppressed — cannot be expressed on the
 * index, so they run per page. A single `.take(n)` followed by those filters would be the §16.3
 * finding wearing a different hat: on a corpus whose top-ranked clusters are mostly promoted, the cap
 * fills with rows the operator asked not to see and the queue reads *empty* while unpromoted patterns
 * sit just below it. Paginating instead makes "the next page" mean the next page of **matches**, with
 * every read still bounded to one page of the index — `listFeed`'s note on the same shape applies:
 * a page filtered down to nothing is how a filtered scroll makes progress, and `usePaginatedQuery`
 * keeps going rather than treating it as the end.
 */
export const listQueue = query({
  args: {
    paginationOpts: paginationOptsValidator,
    season: v.optional(v.number()),
    family: v.optional(literals(RECURRENCE_FAMILIES)),
    minSeasons: v.optional(v.number()),
    includePromoted: v.optional(v.boolean()),
    includeSuppressed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireContributorRole(ctx, 'moderator');
    const season = args.season ?? seasonOf(Date.now());
    // Descending on `priority`, which the index carries — so the ranking *is* the read order and a
    // page is the top of what is left rather than an arbitrary slice.
    const result = await ctx.db
      .query('hazardRecurrence')
      .withIndex('by_computed_season_and_priority', (q) => q.eq('computedForSeason', season))
      .order('desc')
      .paginate(args.paginationOpts);

    const filtered = result.page.filter((row) => {
      if (args.family !== undefined && row.family !== args.family) return false;
      if (args.minSeasons !== undefined && row.seasonsObserved.length < args.minSeasons)
        return false;
      if (!args.includePromoted && row.promotedToFeatureId !== undefined) return false;
      if (!args.includeSuppressed && row.suppressedAt !== undefined) return false;
      return true;
    });

    // One body read per distinct lake, cached: a queue is many clusters over few lakes, so this must
    // not be a read per row.
    const names = new Map<string, string>();
    const page = await Promise.all(
      filtered.map(async (row) => {
        if (!names.has(row.waterBodyId)) {
          const body = await ctx.db.get(row.waterBodyId);
          names.set(row.waterBodyId, body?.name ?? 'Unknown water body');
        }
        return { ...row, waterBodyName: names.get(row.waterBodyId) as string };
      }),
    );
    return { ...result, page };
  },
});

/**
 * Suppress a cluster: it stops being suggested and stops being publicly advisable, permanently, across
 * recomputes (§7.3).
 *
 * For three pins in one cove across three winters that are three people misreading the same shadow.
 * **Reversible, never a delete** — the same posture every destructive-looking path in this app takes
 * (D15 hazard archive, D36 merge tombstone, D53 demote), and a required reason for the same
 * accountability every other moderation action carries.
 */
export const suppress = mutation({
  args: { recurrenceId: v.id('hazardRecurrence'), reason: v.string() },
  handler: async (ctx, { recurrenceId, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const row = await ctx.db.get(recurrenceId);
    if (!row) throw new ConvexError('Recurrence not found');
    await ctx.db.patch(recurrenceId, {
      suppressedAt: Date.now(),
      suppressedByUserId: actor._id,
      suppressReason: reason.trim(),
      publiclyVisible: false,
    });
    await audit(ctx, actor._id, 'suppress_recurrence', recurrenceId, reason.trim(), {
      waterBodyId: row.waterBodyId,
    });
  },
});

/** Undo a suppression. The cluster returns to the queue and regains the public bar on the next pass. */
export const unsuppress = mutation({
  args: { recurrenceId: v.id('hazardRecurrence'), reason: v.string() },
  handler: async (ctx, { recurrenceId, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const row = await ctx.db.get(recurrenceId);
    if (!row) throw new ConvexError('Recurrence not found');
    await ctx.db.patch(recurrenceId, {
      suppressedAt: undefined,
      suppressedByUserId: undefined,
      suppressReason: undefined,
      // Recomputed here rather than left to the next rollover: an operator who un-suppresses expects
      // the cluster to behave normally now, not next July.
      publiclyVisible: isPubliclyVisible({
        family: row.family,
        seasonsObserved: row.seasonsObserved,
        ...(row.promotedToFeatureId !== undefined
          ? { promotedToFeatureId: row.promotedToFeatureId }
          : {}),
      }),
    });
    await audit(ctx, actor._id, 'unsuppress_recurrence', recurrenceId, reason.trim(), {
      waterBodyId: row.waterBodyId,
    });
  },
});

/**
 * Graduate a whole cluster into a permanent body feature (§8.2).
 *
 * The difference from `bodyFeatures.promote` is the claim being made. That one promotes **one
 * sighting** somebody judged permanent; this one promotes **a pattern across winters**, and the
 * evidence is the reason it can be trusted.
 *
 * Three things it does *not* do, each deliberate:
 *
 * - **It does not hide the hazards.** `promotedToFeatureId` is a backlink on every member and nothing
 *   more (the D53 amendment). Skaters go on filing sightings here, those sightings go on counting, and
 *   the denominator goes on meaning something after the promotion.
 * - **It does not remove the cluster.** The row keeps accumulating members; it just leaves the
 *   suggestion queue, because there is nothing left to decide.
 * - **It does not synthesise a shape.** The feature takes the medoid's own geometry, so a promoted
 *   ridge is a ridge somebody actually drew rather than an average that could bend through ice nobody
 *   ever marked.
 */
export const promoteFromRecurrence = mutation({
  args: {
    recurrenceId: v.id('hazardRecurrence'),
    type: literals(BODY_FEATURE_TYPES),
    note: v.optional(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, { recurrenceId, type, note, reason }) => {
    const actor = await requireContributorRole(ctx, 'moderator');
    if (reason.trim().length === 0) throw new ConvexError('A reason is required');
    const row = await ctx.db.get(recurrenceId);
    if (!row) throw new ConvexError('Recurrence not found');
    if (row.promotedToFeatureId !== undefined) {
      throw new ConvexError('This pattern has already been promoted');
    }

    const featureId = await insertBodyFeature(ctx, {
      waterBodyId: row.waterBodyId,
      type,
      geometryKind: row.geometryKind,
      geometry: row.geometry,
      ...(row.radiusMeters !== undefined ? { radiusMeters: row.radiusMeters } : {}),
      ...(row.bufferMeters !== undefined ? { bufferMeters: row.bufferMeters } : {}),
      ...(note !== undefined ? { note } : {}),
      addedByUserId: actor._id,
      // The medoid, so `demote` has a source hazard and it is the pin whose shape the feature carries.
      promotedFromHazardId: row.representativeHazardId,
    });

    // A backlink on every member, hiding nothing (D53 amendment). What it buys is provenance: opening
    // any of these pins says the spot is also marked as a known feature, so the sighting and the
    // standing statement read as one story rather than two warnings about the same ice.
    for (const memberId of row.memberHazardIds) {
      const member = await ctx.db.get(memberId);
      if (!member || member.promotedToFeatureId !== undefined) continue;
      await ctx.db.patch(memberId, { promotedToFeatureId: featureId });
    }
    await ctx.db.patch(recurrenceId, { promotedToFeatureId: featureId, publiclyVisible: false });
    await audit(ctx, actor._id, 'promote_recurrence', featureId, reason.trim(), {
      recurrenceId,
      seasonsObserved: row.seasonsObserved.length,
      windowSeasons: row.windowSeasons,
    });
    return featureId;
  },
});

/**
 * Recompute one lake now (§C4) — the button beside the card's provenance line.
 *
 * An operator who has just merged two lakes or hidden three bogus pins should not wait a year to see
 * what that did, and a stale answer that looks live is the failure mode of every precomputed surface.
 * Safe to press repeatedly because the pass is idempotent, which is a test.
 */
export const recomputeForBody = mutation({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    await requireContributorRole(ctx, 'moderator');
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) throw new ConvexError('Water body not found');
    await recomputeBody(ctx, body, seasonOf(Date.now()), Date.now());
  },
});

async function audit(
  ctx: MutationCtx,
  actorId: Id<'profiles'>,
  action: 'suppress_recurrence' | 'unsuppress_recurrence' | 'promote_recurrence',
  targetId: string,
  reason: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert('moderationActions', {
    actorId,
    action,
    // A recurrence row is a statement *about* a body feature's justification, so the audit targets the
    // `bodyFeature` on promotion and the cluster itself on suppression — each pointing at the thing a
    // moderator would go and look at.
    targetType: action === 'promote_recurrence' ? 'bodyFeature' : 'hazardRecurrence',
    targetId,
    reason,
    metadata,
    createdAt: Date.now(),
  });
}
