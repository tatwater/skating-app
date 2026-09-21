/**
 * The report write path (D3/D13/D22–D25/D41, reshaped around Posts in A10 / D186).
 *
 * Every Report is written through `createReportRow`, and every Report is born inside a Post
 * through `createPost` — the transactional create that takes its Reports inline, so a Post-less
 * Report can never exist and "a Post requires a Report" holds by construction. `posts.create`
 * exposes it whole; `reports.create` is the one-Report convenience over the same path (both old
 * forms and the offline queue's pre-A10 drafts), kept until the sheet replaces the last form.
 *
 * The validation + normalization contract lives in `@skating/core` `validateReportInput` and is
 * **re-enforced here** at the trust boundary (D37) — the client runs the same check before
 * submit, but the server never trusts it. Two rules are **create-only** and live only here, never
 * in `reports.update`, so nothing already posted becomes uneditable: the minimum set (D189,
 * `minimumSetGaps`) and the freshness window (D199, `freshnessRefusal`).
 *
 * Under `lib/` because both `reports.ts` and `posts.ts` export a mutation over it and neither
 * should import the other.
 */

import {
  CONDITION_SOURCES,
  CORROBORATION_MAX_PER_REPORT,
  CORROBORATION_WINDOW_MS,
  freshnessRefusal,
  hasMeasuredThickness,
  ICE_TYPES,
  isMinor,
  locatedSubAreaIds,
  memberSubAreaIds,
  minimumSetGaps,
  OBSERVED_FROM,
  POST_MAX_REPORTS,
  PRECIP_TYPES,
  postPhotoIds,
  type ReportInput,
  reportsAgree,
  SIGHTINGS,
  SKATE_END_PRECISIONS,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SUITABILITIES,
  SURFACE_TAGS,
  validatePostInput,
  validateReportInput,
} from '@skating/core';
import { ConvexError, type Infer, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { resolvePlaceForCoord } from '../adminAreas';
import { attachReportToOpenBounties } from '../bounties';
import { linkActivityToReport } from '../gpsActivities';
import {
  attachHazardsToReport,
  HAZARD_MAX_PER_REPORT,
  inReportHazardArgs,
  insertHazard,
} from '../hazards';
import { enqueueReportNotifications } from '../notifications';
import { resolveReportSubAreas, stampCandidates } from '../subAreas';
import { assertCanPostHazards, assertCanPostReports, requireContributor } from './auth';
import { resolveSurvivor } from './bodies';
import { recomputeBodySummary } from './bodySummary';
import { bumpContributionCount } from './contributionCounts';
import { tryAutoMerge } from './hazardMerge';
import { isListed } from './listing';
import { enqueueActorNotification } from './notificationQueue';
import { assertOwnedPhotos, syncReportPhotoLinks } from './photoAccess';
import { syncReportSubAreas } from './reportSubAreas';
import { awardPointEvent, checkAndAwardBadges } from './reputation';
import { activateOnEvidence } from './standing';
import { chipInput, iceThickness, latLng, literals, snow } from './validators';

/** Editable report content, shared by `create` and `update` args (the schema mirrors these). */
export const reportContent = {
  // When the skater left the ice — the primary sort key everywhere (D28; Phase 05 rename).
  skateEndTime: v.number(),
  // Optional — when they got on the ice. Duration is derived (end − start), never stored (Phase 05).
  skateStartTime: v.optional(v.number()),
  // How exact the end time is (A10 / D192). Absent from a client that predates the sheet.
  skateEndPrecision: v.optional(literals(SKATE_END_PRECISIONS)),
  // How the author saw it (A10 / D191); what a shore observer saw (D189). Absent means unstated.
  observedFrom: v.optional(literals(OBSERVED_FROM)),
  sighting: v.optional(literals(SIGHTINGS)),
  // Chips arrive as the bare key (an un-updated phone, a queued draft, the quick-tap path) or the
  // located object (A10 / D193); the core validator lifts every one to the object the schema stores.
  iceTypes: v.optional(v.array(chipInput(ICE_TYPES))),
  surfaceTags: v.optional(v.array(chipInput(SURFACE_TAGS))),
  skateQuality: v.optional(literals(SKATE_QUALITIES)),
  suitability: v.optional(literals(SUITABILITIES)),
  iceThickness: v.optional(iceThickness),
  // Snow as the D194 object, or the pre-A10 number — the validator folds the number into
  // `snow.depthCm` and refuses two depths that disagree. Both stay accepted forever (see `iceTypes`).
  snow: v.optional(snow),
  snowCoverCm: v.optional(v.number()),
  conditions: v.optional(
    v.object({
      airTempC: v.optional(v.number()),
      windSpeedKph: v.optional(v.number()),
      windDir: v.optional(v.string()),
      sky: v.optional(literals(SKY_CONDITIONS)),
      precip: v.optional(literals(PRECIP_TYPES)),
      source: v.optional(literals(CONDITION_SOURCES)),
    }),
  ),
  notes: v.optional(v.string()),
  point: v.optional(latLng), // optional put-in pin; falls back to the body centroid
  photoIds: v.optional(v.array(v.id('photos'))),
  // Private-property opt-out (Phase 04, decision #7): false suppresses this report's derived put-in
  // marker (keeps the coarse `place` label). Default (undefined) shows it.
  showPutIn: v.optional(v.boolean()),
};

/** Build the `@skating/core` validation input from mutation args (all reports are public, D13). */
export function toReportInput(
  args: {
    skateEndTime: number;
    skateStartTime?: number;
    skateEndPrecision?: ReportInput['skateEndPrecision'];
    observedFrom?: ReportInput['observedFrom'];
    sighting?: ReportInput['sighting'];
    iceTypes?: ReportInput['iceTypes'];
    surfaceTags?: ReportInput['surfaceTags'];
    skateQuality?: ReportInput['skateQuality'];
    suitability?: ReportInput['suitability'];
    iceThickness?: ReportInput['iceThickness'];
    snow?: ReportInput['snow'];
    snowCoverCm?: number;
    conditions?: ReportInput['conditions'];
    notes?: string;
    point?: { lat: number; lng: number };
  },
  waterBodyId: string,
): ReportInput {
  return {
    waterBodyId,
    skateEndTime: args.skateEndTime,
    skateStartTime: args.skateStartTime,
    skateEndPrecision: args.skateEndPrecision,
    observedFrom: args.observedFrom,
    sighting: args.sighting,
    iceTypes: args.iceTypes,
    surfaceTags: args.surfaceTags,
    skateQuality: args.skateQuality,
    suitability: args.suitability,
    iceThickness: args.iceThickness,
    snow: args.snow,
    snowCoverCm: args.snowCoverCm,
    conditions: args.conditions,
    notes: args.notes,
    point: args.point,
  };
}

/**
 * A `where` may name a bay by id (D193). `validateWhere` checks the shape; this is the check made
 * with the body in hand: every bay a chip or a reading names must be one of *this* body's live bays
 * — never another lake's, never a removed one, never a string that is not a bay at all. Raised in
 * the validator's own error shape so the sheet shows it beside the chip.
 */
export function assertLocatedSubAreas(
  normalized: Parameters<typeof locatedSubAreaIds>[0],
  candidates: readonly { ref: Doc<'waterBodySubAreas'> }[],
): void {
  const live = new Set<string>(candidates.map((c) => c.ref._id));
  const unknown = locatedSubAreaIds(normalized).filter((id) => !live.has(id));
  if (unknown.length > 0) {
    throw new ConvexError({
      code: 'invalid_report',
      errors: unknown.map((id) => `where.subAreaId: ${id} is not a bay of this water body`),
    });
  }
}

/**
 * One Report as `posts.create` takes it inline, and as `reports.create` takes it flat: the body,
 * the queue's per-Report key, the hazards drawn or bundled with it, the track it describes, and
 * the content.
 */
export const inlineReportArgs = {
  waterBodyId: v.id('waterBodies'),
  // Mobile offline queue (Phase 02a §6.2/D30): a draft carries one client-generated key across every flush
  // retry. Under a Post the **Post's** key is what dedups the flush (`posts.create`); the Report's
  // own key is stored beside it and a reuse is refused, so a key can never name two Reports.
  idempotencyKey: v.optional(v.string()),
  // Hazards drawn as part of this report (D51 in-report path). `waterBodyId` is taken from the
  // report, so a hazard can never be filed against a different lake than the report it belongs to.
  hazards: v.optional(v.array(v.object(inReportHazardArgs))),
  // The author's own standalone hazards to bundle into this report (D55). Ownership, body and
  // not-already-attached are all re-checked server-side.
  attachHazardIds: v.optional(v.array(v.id('hazards'))),
  // The recorded skate this report describes (Phase 08). Optional by design: a report NEVER requires
  // a path (D24) — the path is enrichment, the observation is the safety artifact. When present it
  // flips `source` to `activity` and back-links the activity, in this transaction.
  activityId: v.optional(v.id('gpsActivities')),
  ...reportContent,
};
const inlineReportValidator = v.object(inlineReportArgs);
export type InlineReportArgs = Infer<typeof inlineReportValidator>;

/** The Post-level args: the queue's key, the author's title and prose, and the Reports in order. */
export const postArgs = {
  idempotencyKey: v.optional(v.string()),
  title: v.optional(v.string()),
  body: v.optional(v.string()),
  reports: v.array(inlineReportValidator),
};
const postValidator = v.object(postArgs);
export type PostArgs = Infer<typeof postValidator>;

/**
 * Write one Report for `profile` (D3/D13/D41): re-validate via `@skating/core`; resolve a merged
 * target body to its survivor; set `point` from the put-in pin else the body centroid;
 * server-stamp `reportTime`; insert as a `native` / `activity`, `visible` report; file its hazards,
 * photos, bay membership and track link in the same transaction; then the per-report side effects
 * (counters, the body card, standing, reputation, bounties, notifications, the weather autofill and
 * the contradiction settle). The caller has already gated the author (contributor, not a minor,
 * may post) and checks the create-only rules on what this returns.
 *
 * Born with its `postId`: `createPost` inserts the Post first and fills its members in afterward,
 * so every side effect that reads the inserted row (notifications coalesce on the Post) sees it.
 */
export async function createReportRow(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  args: InlineReportArgs,
  now: number,
  postId: Id<'posts'>,
): Promise<{ reportId: Id<'reports'>; hazardCount: number; inserted: Doc<'reports'> }> {
  // A per-Report key names one Report, ever (Phase 02a §6.2/D30). A retry of a whole Post is caught
  // by the Post's key before this runs; a Report key that already exists here is a second Post
  // trying to claim a Report the first one wrote, and is refused rather than shared.
  if (args.idempotencyKey !== undefined) {
    const existing = await ctx.db
      .query('reports')
      .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
      .unique();
    if (existing) throw new ConvexError('Idempotency key conflict');
  }

  // Posting a hazard (drawn in-report or bundled) requires the hazard permission too, so the report
  // path can't be a way around a hazard-posting restriction.
  if ((args.hazards?.length ?? 0) + (args.attachHazardIds?.length ?? 0) > 0) {
    assertCanPostHazards(profile);
  }

  // Bound the hazard fan-out: each in-report hazard is several document writes, so an unbounded
  // array makes one create arbitrarily expensive. A real skate produces a handful, not dozens.
  if ((args.hazards?.length ?? 0) + (args.attachHazardIds?.length ?? 0) > HAZARD_MAX_PER_REPORT) {
    throw new ConvexError('Too many hazards for one report');
  }

  const body = await resolveSurvivor(ctx, args.waterBodyId);
  if (!body || !isListed(body)) throw new ConvexError('Water body not found');

  const result = validateReportInput(toReportInput(args, args.waterBodyId), { now });
  if (!result.ok) {
    throw new ConvexError({
      code: 'invalid_report',
      errors: result.errors.map((e) => `${e.field}: ${e.message}`),
    });
  }
  const n = result.normalized;

  // A new report's id is not known yet, so the claim is "no report": a photo already documenting
  // one is refused rather than shared (A10 / D186 — one photo, one report).
  const photoIds = [...new Set(args.photoIds ?? [])];
  await assertOwnedPhotos(ctx, photoIds, profile._id, { reportId: null });

  // Stamp the point-derived location label (Phase 05) from the resolved put-in point (else the
  // body centroid) against the `adminAreas` boundaries — so the feed reads `{town/county, state}`
  // directly with no per-read geocode. Absent when the point is outside the imported region.
  const point = n.point ?? body.centroid;
  const place = await resolvePlaceForCoord(ctx, point);
  // And the named bays, if this lake has any (A02/D60, widened in A09/D175) — the same
  // maintain-on-write shape as `place`. A pin-only report takes the smallest bay containing its
  // point; an activity-sourced one takes **every bay its track crossed**, majority first, because
  // its `point` is the GPS start (the put-in) and stamping it with the bay you launched from,
  // whatever you skated, was the bug this fixes. Costs one `by_parent` read on a body already in
  // hand, and returns immediately for the ~25k bodies with no sub-areas.
  const candidates = await stampCandidates(ctx, body._id);
  assertLocatedSubAreas(n, candidates);
  const subAreas = await resolveReportSubAreas(
    ctx,
    {
      waterBodyId: body._id,
      point,
      ...(args.activityId !== undefined ? { activityId: args.activityId } : {}),
    },
    candidates,
    body.polygon as unknown as Polygon | MultiPolygon,
  );

  const reportId = await ctx.db.insert('reports', {
    authorId: profile._id,
    waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
    point,
    skateEndTime: n.skateEndTime,
    ...(n.skateStartTime !== undefined ? { skateStartTime: n.skateStartTime } : {}),
    ...(place !== undefined ? { place } : {}),
    ...(subAreas.subAreaId !== undefined ? { subAreaId: subAreas.subAreaId } : {}),
    ...(subAreas.subAreaName !== undefined ? { subAreaName: subAreas.subAreaName } : {}),
    ...(subAreas.subAreaIds !== undefined ? { subAreaIds: subAreas.subAreaIds } : {}),
    ...(subAreas.subAreaNames !== undefined ? { subAreaNames: subAreas.subAreaNames } : {}),
    reportTime: now,
    source: args.activityId !== undefined ? 'activity' : 'native',
    ...(args.activityId !== undefined ? { activityId: args.activityId } : {}),
    postId,
    ...(n.skateEndPrecision !== undefined ? { skateEndPrecision: n.skateEndPrecision } : {}),
    ...(n.observedFrom !== undefined ? { observedFrom: n.observedFrom } : {}),
    ...(n.sighting !== undefined ? { sighting: n.sighting } : {}),
    iceTypes: n.iceTypes,
    surfaceTags: n.surfaceTags,
    ...(n.skateQuality !== undefined ? { skateQuality: n.skateQuality } : {}),
    ...(n.suitability !== undefined ? { suitability: n.suitability } : {}),
    ...(n.iceThickness !== undefined ? { iceThickness: n.iceThickness } : {}),
    ...(n.snow !== undefined ? { snow: n.snow } : {}),
    ...(n.conditions !== undefined ? { conditions: n.conditions } : {}),
    ...(n.notes !== undefined ? { notes: n.notes } : {}),
    ...(args.showPutIn !== undefined ? { showPutIn: args.showPutIn } : {}),
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    moderationStatus: 'visible',
    photoIds,
    hazardIdsCreated: [], // filled in below once the hazards know their report id
    createdAt: now,
    updatedAt: now,
  });

  // Hazards (Phase 09a). Two sources, both landing in `hazardIdsCreated`:
  //  - `hazards`: drawn as part of this report (the in-report authoring path, D51).
  //  - `attachHazardIds`: the author's own standalone on-ice pins, bundled in after the fact (D55).
  // Created after the report so each hazard carries `originReportId` from birth — one write order,
  // no back-patching, and the two collections stay consistent inside a single transaction.
  // Auto-merge runs here too (A05c / D80), for the same reason it runs inside `hazards.create`: a
  // hazard drawn in a report is a sighting like any other, and the state this mechanism exists to
  // remove — two pins on the map for one ridge — does not care which form produced them. Leaving it
  // out would have made the *report* path the way to file a duplicate that never collapses.
  //
  // The **survivor** is recorded rather than the row just written, so `hazardIdsCreated` never points
  // at a tombstone; and it is deduped, because two hazards drawn in one report can be judged the same
  // thing, in which case the report created one hazard and should say so.
  const createdHazardIds: Id<'hazards'>[] = [];
  for (const hazard of args.hazards ?? []) {
    const hazardId = await insertHazard(
      ctx,
      { ...hazard, waterBodyId: body._id },
      profile._id,
      now,
      reportId,
    );
    const { survivorId } = await tryAutoMerge(ctx, hazardId);
    if (!createdHazardIds.includes(survivorId)) createdHazardIds.push(survivorId);
  }
  const bundledHazardIds = await attachHazardsToReport(
    ctx,
    args.attachHazardIds ?? [],
    reportId,
    profile._id,
    body._id,
  );
  const hazardIdsCreated = [...createdHazardIds, ...bundledHazardIds];
  if (hazardIdsCreated.length > 0) await ctx.db.patch(reportId, { hazardIdsCreated });

  // The photos' back-link (A10 / D186), written beside the list it mirrors.
  await syncReportPhotoLinks(ctx, reportId, [], photoIds);

  // The membership's indexable copy (A09) — one join row per bay, so the bay feed and the bay
  // bounty gate can find a spanning report under its second bay too.
  await syncReportSubAreas(
    ctx,
    {
      _id: reportId,
      waterBodyId: body._id,
      moderationStatus: 'visible',
      skateEndTime: n.skateEndTime,
    },
    memberSubAreaIds(subAreas),
  );

  // Back-link the recorded skate (Phase 08). Both sides are written in this one transaction so a
  // half-linked pair can't exist: the report side drives the detail-view render, and the *activity*
  // side (`linkedReportId`) is what the D58 aggregate layer's publish-is-consent predicate reads —
  // a missing back-link would silently drop the track from the lake map. Ownership is re-checked
  // inside, so a client can't attach someone else's skate to their report.
  if (args.activityId !== undefined) {
    await linkActivityToReport(ctx, args.activityId, reportId, profile._id);
  }

  // Bump the author's denormalized report counter (born visible) so the profile shows a true total
  // without scanning their history (D13). Moderation transitions adjust it symmetrically.
  await bumpContributionCount(ctx, profile._id, 'reportCount', 1);

  // And the body's map summary card (A06c §5). Recomputed rather than incremented — see
  // `lib/bodySummary.ts`: the count is window- and season-scoped, so a ±1 would drift the moment a
  // report aged out, and the D86 quality mean cannot be maintained incrementally at all.
  // **`body._id`, not `args.waterBodyId`** — the same distinction the insert above already makes,
  // for the same reason. An offline draft can carry a body id that was merged away before the
  // queue flushed (D36, Phase 02a §6.2), and `resolveSurvivor` sends the report to the canonical lake.
  // Recomputing the requested id would refresh the *loser's* card — a row nothing renders, since a
  // merged body is unlisted — and leave the survivor, the card a skater is actually looking at,
  // stale until the six-hourly sweep.
  await recomputeBodySummary(ctx, body._id);

  // Standing (A07b): a report is evidence of use, and a dormant body yields to it — before the
  // notification fan-out below, which only pushes an *active* body. A `none` ruling or a removal
  // does not yield (the resident of a private lake skating it is not evidence the public may).
  await activateOnEvidence(ctx, body._id, 'report');

  // Reputation (D50): per-report author awards + retroactive corroboration (both authors, capped),
  // then a single badge recompute per affected author. Read the inserted doc once (photoIds /
  // iceThickness / iceTypes / skateQuality drive the awards + the "agrees" test).
  const inserted = await ctx.db.get(reportId);
  if (!inserted) throw new Error('report vanished inside its own transaction');
  await awardReportCreationPoints(ctx, inserted);
  const corroboratedAuthorIds = await runCorroboration(ctx, inserted);
  await checkAndAwardBadges(ctx, inserted.authorId);
  for (const authorId of corroboratedAuthorIds) await checkAndAwardBadges(ctx, authorId);

  // Auto-attach to any open bounty on this body (Phase 06, decision 10) — the requester's helpful
  // thumb later flips it to fulfilled.
  await attachReportToOpenBounties(ctx, inserted);

  // Fan out Phase-04 notification candidates (favorites / nearby digest / great nearby) into the
  // coalescing queue — the cron flushes them (decision #4).
  await enqueueReportNotifications(ctx, inserted);

  // Conditions auto-fill (Phase 10 / §7a): when the reporter left conditions blank, schedule a
  // post-insert action to pull the weather AT the skate time (a mutation can't fetch). A user-entered
  // value always wins, so we only schedule when none was provided. Eventually-consistent by design.
  if (n.conditions === undefined) {
    await ctx.scheduler.runAfter(0, internal.conditions.autofillConditions, { reportId });
  }

  // Contradiction signal (Phase 10 / §7b): a report can only contradict on `skateQuality`, so only
  // schedule the (weather-fetching) settle when one is present. Runs after this mutation commits, so
  // `runCorroboration`'s awards are already in the ledger and the settle sees current corroboration. It
  // discloses conflicts + escalates the un-corroborated minority to moderation — never a trust penalty
  // (D50/D3), and self-corrects as corroboration accrues.
  if (n.skateQuality !== undefined) {
    await ctx.scheduler.runAfter(0, internal.contradictions.settleContradictions, { reportId });
  }

  return { reportId, hazardCount: hazardIdsCreated.length, inserted };
}

/**
 * The create-only rules (A10 §2.4), checked per Report once its hazards are filed and before the
 * Post is written — a throw here rolls the whole transaction back, so nothing partial lands.
 *
 * - **D199, the freshness window:** an end time more than seven days old, or in the future beyond
 *   the skew tolerance, is refused with a plain message — at flush too, so a phone that comes back
 *   online after a week does not post a stale report. Editing an existing Report is always allowed.
 * - **D189, the minimum set:** a body, an end time, *How was it?*, and one observation. `update`
 *   never runs this, so a pre-A10 notes-only report stays editable.
 */
export function assertMayPost(report: Doc<'reports'>, hazardCount: number, now: number): void {
  const refusal = freshnessRefusal(report.skateEndTime, now);
  if (refusal === 'too_old') {
    throw new ConvexError({
      code: 'stale_report',
      message: 'Reports can be posted up to a week after you got off the ice.',
    });
  }
  if (refusal === 'in_future') {
    throw new ConvexError({ code: 'stale_report', message: 'That end time is in the future.' });
  }
  const gaps = minimumSetGaps(report, hazardCount);
  if (gaps.length > 0) {
    throw new ConvexError({
      code: 'minimum_set',
      message: 'A report needs how it was and one thing you saw before it can post.',
      gaps,
    });
  }
}

/**
 * The transactional Post create (A10 §2.4 / D186): gate the author once, dedup on the Post's key,
 * validate the title and prose, write every Report, hold each to the create-only rules, then the
 * Post — its `reportIds` in the author's order, `latestSkateEndTime` as the max, `photoIds` as
 * the ordered union — and patch `postId` back onto each member. One transaction: a throw
 * anywhere and nothing landed.
 */
export async function createPost(
  ctx: MutationCtx,
  args: PostArgs,
): Promise<{ postId: Id<'posts'>; reportIds: Id<'reports'>[] }> {
  const profile = await requireContributor(ctx);
  const now = Date.now();

  // Idempotency short-circuit (Phase 02a §6.2/D30, lifted to the Post): if this key already produced
  // a Post, return it — the flush is a retry, not a new post. Scoped to the author so a
  // (UUID-collision-improbable) shared key can never hand back someone else's Post. Runs before
  // validation/insert so a lost-ack retry is cheap and never re-inserts. Convex serializes a
  // concurrent double-flush via OCC — the second call's index read conflicts with the first's
  // insert and retries, then finds the row here.
  if (args.idempotencyKey !== undefined) {
    const existing = await ctx.db
      .query('posts')
      .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
      .unique();
    if (existing) {
      if (existing.authorId !== profile._id) throw new ConvexError('Idempotency key conflict');
      return { postId: existing._id, reportIds: existing.reportIds };
    }
  }

  // Minors are read-only (D41): reports are always public (D13), so we never let a minor broadcast.
  if (isMinor(profile.dateOfBirth, now)) {
    throw new ConvexError('Users under 18 cannot post reports');
  }
  // Granular posting permission (D57): a moderator can restrict this surface without a whole-app ban.
  assertCanPostReports(profile);

  // A Post requires a Report (D186), and is bounded — each Report is dozens of writes.
  if (args.reports.length === 0) throw new ConvexError('A post needs at least one report');
  if (args.reports.length > POST_MAX_REPORTS) {
    throw new ConvexError(`A post can carry at most ${POST_MAX_REPORTS} reports`);
  }

  const post = validatePostInput({ title: args.title, body: args.body });
  if (!post.ok) {
    throw new ConvexError({
      code: 'invalid_post',
      errors: post.errors.map((e) => `${e.field}: ${e.message}`),
    });
  }

  // The Post first, empty, so each Report is born with its `postId`; the members fill it in below,
  // inside the same transaction — a reader can never see the empty shell.
  const postId = await ctx.db.insert('posts', {
    authorId: profile._id,
    ...(post.normalized.title !== undefined ? { title: post.normalized.title } : {}),
    ...(post.normalized.body !== undefined ? { body: post.normalized.body } : {}),
    reportIds: [],
    photoIds: [],
    latestSkateEndTime: 0,
    moderationStatus: 'visible',
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    createdAt: now,
    updatedAt: now,
  });

  const reportIds: Id<'reports'>[] = [];
  const members: { photoIds: Id<'photos'>[]; skateEndTime: number }[] = [];
  for (const report of args.reports) {
    const { reportId, hazardCount, inserted } = await createReportRow(
      ctx,
      profile,
      report,
      now,
      postId,
    );
    assertMayPost(inserted, hazardCount, now);
    reportIds.push(reportId);
    members.push({ photoIds: inserted.photoIds, skateEndTime: inserted.skateEndTime });
  }
  await ctx.db.patch(postId, {
    reportIds,
    photoIds: postPhotoIds(members),
    latestSkateEndTime: Math.max(...members.map((m) => m.skateEndTime)),
  });
  return { postId, reportIds };
}

/**
 * Award a new report's author their per-report point events (D50 decision 2), each **once per report**:
 * `report_submitted` (baseline), `photo_evidence` (≥1 photo — self-verifying), and `measured_thickness`
 * (≥1 measured, not estimated, reading — rewards rigor). Weights are single-sourced in `@skating/core`.
 */
async function awardReportCreationPoints(ctx: MutationCtx, report: Doc<'reports'>): Promise<void> {
  await awardPointEvent(ctx, {
    userId: report.authorId,
    reason: 'report_submitted',
    refId: report._id,
  });
  if (report.photoIds.length > 0) {
    await awardPointEvent(ctx, {
      userId: report.authorId,
      reason: 'photo_evidence',
      refId: report._id,
    });
  }
  if (hasMeasuredThickness(report)) {
    await awardPointEvent(ctx, {
      userId: report.authorId,
      reason: 'measured_thickness',
      refId: report._id,
    });
  }
}

/**
 * Corroboration (D50 decision 3). Scan prior **visible** reports on the same body whose skate-end is
 * within `CORROBORATION_WINDOW` of the new one, and for each that **agrees** (`reportsAgree` — quality
 * within one step OR a shared ice type), award `report_corroborated` to **both** the new author and the
 * prior author (a new agreeing report retroactively corroborates the older one), and drop a
 * `report_rated`-style notice to the prior author.
 *
 * **Self-corroboration is excluded** (same author never corroborates themselves), and the count is
 * **capped at `CORROBORATION_MAX_PER_REPORT`** so a popular lake can't inflate one reporter (D50).
 * Purely additive in Phase 06 — the contradiction penalty needs weather-since and lands in Phase 10.
 *
 * Returns the distinct prior-author ids awarded, so the caller recomputes their badges once.
 * Alpha-scale scan (a lake gets a handful of reports per window); Phase 07 can cap/paginate if needed.
 */
async function runCorroboration(
  ctx: MutationCtx,
  report: Doc<'reports'>,
): Promise<Set<Id<'profiles'>>> {
  const lower = report.skateEndTime - CORROBORATION_WINDOW_MS;
  const upper = report.skateEndTime + CORROBORATION_WINDOW_MS;
  // Bound BOTH edges of the window in the index (`gte lower` … `lte upper`), not just the near edge.
  // A late-submitted report has an `upper` in the past, so a `gte`-only scan would drag in every later
  // report up to `now` only to reject them in JS; the `lte` keeps the scan to the actual ±window.
  const candidates = await ctx.db
    .query('reports')
    .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
      q
        .eq('waterBodyId', report.waterBodyId)
        .eq('moderationStatus', 'visible')
        .gte('skateEndTime', lower)
        .lte('skateEndTime', upper),
    )
    .order('desc') // newest-in-window first — the reports most likely to share the freeze cycle
    .collect();

  const priorAuthorIds = new Set<Id<'profiles'>>();
  let counted = 0;
  for (const prior of candidates) {
    if (counted >= CORROBORATION_MAX_PER_REPORT) break;
    if (prior._id === report._id) continue; // the just-inserted report itself (both edges now in-index)
    if (prior.authorId === report.authorId) continue; // self-corroboration excluded
    if (!reportsAgree(report, prior)) continue;

    counted++;
    priorAuthorIds.add(prior.authorId);
    await awardPointEvent(ctx, {
      userId: report.authorId,
      reason: 'report_corroborated',
      refId: report._id,
    });
    await awardPointEvent(ctx, {
      userId: prior.authorId,
      reason: 'report_corroborated',
      refId: prior._id,
    });
    await notifyCorroboration(ctx, prior, report);
  }
  return priorAuthorIds;
}

/**
 * Tell a prior report's author their report was independently corroborated by a fresh one — reuses the
 * `report_rated` channel (a "report_rated-style" notice, decision 3), via the settle queue (A08 / D169):
 * the flush re-checks that the corroborating report is still visible, and several inside one window
 * become one "N other skaters backed up your report".
 */
async function notifyCorroboration(
  ctx: MutationCtx,
  priorReport: Doc<'reports'>,
  byReport: Doc<'reports'>,
): Promise<void> {
  await enqueueActorNotification(ctx, {
    recipientId: priorReport.authorId,
    actorId: byReport.authorId,
    targetId: priorReport._id,
    trigger: { kind: 'corroboration', reportId: priorReport._id, byReportIds: [byReport._id] },
  });
}
