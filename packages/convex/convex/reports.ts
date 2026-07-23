/**
 * Report functions (the core read/write loop, D3/D13/D22–D25/D41).
 *
 * The validation + normalization contract lives in `@skating/core` `validateReportInput` and is
 * **re-enforced here** at the trust boundary (D37) — the client runs the same check before submit,
 * but the server never trusts it. **All reports are public (D13)** — there is no visibility field;
 * minors can't post at all (D41). Reads gate on **moderation only** — a block never hides a report
 * (D3, safety-first); the block set instead annotates a blocked author's line (a Phase-3 "Blocked"
 * chip, Workstream B/C) and hides comments/profiles, never a report.
 */

import {
  bandForCoord,
  CONDITION_SOURCES,
  CORROBORATION_MAX_PER_REPORT,
  CORROBORATION_WINDOW_MS,
  type DriveTimeBands,
  type FeedAuthor,
  type FeedCardData,
  hasMeasuredThickness,
  ICE_TYPES,
  isMinor,
  type LatLng,
  matchesFilters,
  PRECIP_TYPES,
  RECOMMENDED_MIN_PHOTOS,
  RECOMMENDED_RECENCY_HOURS,
  type RecommendableReport,
  type ReportInput,
  reportsAgree,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  sanitizeFeedFilters,
  selectRecommended,
  THICKNESS_METHODS,
  type TrustClass,
  validateReportInput,
} from '@skating/core';
import { paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
import { resolvePlaceForCoord } from './adminAreas';
import { attachReportToOpenBounties } from './bounties';
import {
  attachHazardsToReport,
  HAZARD_MAX_PER_REPORT,
  inReportHazardArgs,
  insertHazard,
} from './hazards';
import {
  assertCanPostHazards,
  assertCanPostReports,
  getCurrentProfile,
  requireProfile,
} from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { bumpContributionCount } from './lib/contributionCounts';
import { isListed } from './lib/listing';
import { assertOwnedPhotos } from './lib/photoAccess';
import { getViewableReport, loadBlockedAuthorIds } from './lib/reportVisibility';
import { awardPointEvent, checkAndAwardBadges, trustClassFor } from './lib/reputation';
import { latLng, literals } from './lib/validators';
import { enqueueReportNotifications } from './notifications';
import { loadFavoriteBodyIds } from './waterBodyFavorites';

/** Editable report content, shared by `create` and `update` args (the schema mirrors these). */
const reportContent = {
  // When the skater left the ice — the primary sort key everywhere (D28; Phase 5 rename).
  skateEndTime: v.number(),
  // Optional — when they got on the ice. Duration is derived (end − start), never stored (Phase 5).
  skateStartTime: v.optional(v.number()),
  iceTypes: v.optional(v.array(literals(ICE_TYPES))),
  surfaceTags: v.optional(v.array(literals(SURFACE_TAGS))),
  skateQuality: v.optional(literals(SKATE_QUALITIES)),
  iceThickness: v.optional(
    v.object({
      readings: v.array(
        v.object({
          valueCm: v.optional(v.number()),
          minCm: v.optional(v.number()),
          maxCm: v.optional(v.number()),
          method: literals(THICKNESS_METHODS),
          coord: v.optional(latLng),
          note: v.optional(v.string()),
        }),
      ),
    }),
  ),
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
  // Private-property opt-out (Phase 4, decision #7): false suppresses this report's derived put-in
  // marker (keeps the coarse `place` label). Default (undefined) shows it.
  showPutIn: v.optional(v.boolean()),
};

/** Build the `@skating/core` validation input from mutation args (all reports are public, D13). */
function toReportInput(
  args: {
    skateEndTime: number;
    skateStartTime?: number;
    iceTypes?: string[];
    surfaceTags?: string[];
    skateQuality?: string;
    iceThickness?: ReportInput['iceThickness'];
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
    iceTypes: args.iceTypes as ReportInput['iceTypes'],
    surfaceTags: args.surfaceTags as ReportInput['surfaceTags'],
    skateQuality: args.skateQuality as ReportInput['skateQuality'],
    iceThickness: args.iceThickness,
    snowCoverCm: args.snowCoverCm,
    conditions: args.conditions,
    notes: args.notes,
    point: args.point,
  };
}

/**
 * Create a report (D3/D13/D41). `requireProfile`; **reject minors** (all reports are public, so a
 * minor can't post — D41); re-validate via `@skating/core`; resolve a merged target body to its
 * survivor; set `point` from the put-in pin else the body centroid; server-stamp `reportTime`;
 * insert as a `native`, `visible` report.
 */
export const create = mutation({
  args: {
    waterBodyId: v.id('waterBodies'),
    // Mobile offline queue (F2/D30): a draft carries one client-generated key across every flush
    // retry, so a create whose ack was lost returns the same report instead of a duplicate. Convex
    // serializes a concurrent double-flush via OCC — the second call's index read conflicts with the
    // first's insert and retries, then finds the row below. Omitted by web/online callers.
    idempotencyKey: v.optional(v.string()),
    // Hazards drawn as part of this report (D51 in-report path). `waterBodyId` is taken from the
    // report, so a hazard can never be filed against a different lake than the report it belongs to.
    hazards: v.optional(v.array(v.object(inReportHazardArgs))),
    // The author's own standalone hazards to bundle into this report (D55). Ownership, body and
    // not-already-attached are all re-checked server-side.
    attachHazardIds: v.optional(v.array(v.id('hazards'))),
    ...reportContent,
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);
    const now = Date.now();

    // Idempotency short-circuit (F2/D30): if this key already produced a report, return it — the
    // flush is a retry, not a new post. Scoped to the author so a (UUID-collision-improbable) shared
    // key can never hand back someone else's report. Runs before validation/insert so a lost-ack
    // retry is cheap and never re-inserts.
    if (args.idempotencyKey !== undefined) {
      const existing = await ctx.db
        .query('reports')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
        .unique();
      if (existing) {
        if (existing.authorId !== profile._id) throw new ConvexError('Idempotency key conflict');
        return existing._id;
      }
    }

    // Minors are read-only (D41): reports are always public (D13), so we never let a minor broadcast.
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post reports');
    }

    // Granular posting permission (D57): a moderator can restrict this surface without a whole-app ban.
    assertCanPostReports(profile);
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

    const photoIds = args.photoIds ?? [];
    await assertOwnedPhotos(ctx, photoIds, profile._id);

    // Stamp the point-derived location label (Phase 5) from the resolved put-in point (else the
    // body centroid) against the `adminAreas` boundaries — so the feed reads `{town/county, state}`
    // directly with no per-read geocode. Absent when the point is outside the imported region.
    const point = n.point ?? body.centroid;
    const place = await resolvePlaceForCoord(ctx, point);

    const reportId = await ctx.db.insert('reports', {
      authorId: profile._id,
      waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
      point,
      skateEndTime: n.skateEndTime,
      ...(n.skateStartTime !== undefined ? { skateStartTime: n.skateStartTime } : {}),
      ...(place !== undefined ? { place } : {}),
      reportTime: now,
      source: 'native',
      iceTypes: n.iceTypes,
      surfaceTags: n.surfaceTags,
      ...(n.skateQuality !== undefined ? { skateQuality: n.skateQuality } : {}),
      ...(n.iceThickness !== undefined ? { iceThickness: n.iceThickness } : {}),
      ...(n.snowCoverCm !== undefined ? { snowCoverCm: n.snowCoverCm } : {}),
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

    // Hazards (Phase 9). Two sources, both landing in `hazardIdsCreated`:
    //  - `hazards`: drawn as part of this report (the in-report authoring path, D51).
    //  - `attachHazardIds`: the author's own standalone on-ice pins, bundled in after the fact (D55).
    // Created after the report so each hazard carries `originReportId` from birth — one write order,
    // no back-patching, and the two collections stay consistent inside a single transaction.
    const createdHazardIds: Id<'hazards'>[] = [];
    for (const hazard of args.hazards ?? []) {
      createdHazardIds.push(
        await insertHazard(ctx, { ...hazard, waterBodyId: body._id }, profile._id, now, reportId),
      );
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

    // Bump the author's denormalized report counter (born visible) so the profile shows a true total
    // without scanning their history (D13). Moderation transitions adjust it symmetrically.
    await bumpContributionCount(ctx, profile._id, 'reportCount', 1);

    // Reputation (D50): per-report author awards + retroactive corroboration (both authors, capped),
    // then a single badge recompute per affected author. Read the inserted doc once (photoIds /
    // iceThickness / iceTypes / skateQuality drive the awards + the "agrees" test).
    const inserted = await ctx.db.get(reportId);
    if (inserted) {
      await awardReportCreationPoints(ctx, inserted);
      const corroboratedAuthorIds = await runCorroboration(ctx, inserted);
      await checkAndAwardBadges(ctx, inserted.authorId);
      for (const authorId of corroboratedAuthorIds) await checkAndAwardBadges(ctx, authorId);

      // Auto-attach to any open bounty on this body (Phase 6, decision 10) — the requester's helpful
      // thumb later flips it to fulfilled.
      await attachReportToOpenBounties(ctx, inserted);

      // Fan out Phase-4 notification candidates (favorites / nearby digest / great nearby) into the
      // coalescing queue — the cron flushes them (decision #4).
      await enqueueReportNotifications(ctx, inserted);
    }

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

    return reportId;
  },
});

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
 * Purely additive in Phase 6 — the contradiction penalty needs weather-since and lands in Phase 10.
 *
 * Returns the distinct prior-author ids awarded, so the caller recomputes their badges once.
 * Alpha-scale scan (a lake gets a handful of reports per window); Phase 7 can cap/paginate if needed.
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
 * `report_rated` channel (a "report_rated-style" notice, decision 3), gated on `reportRated` prefs +
 * active status. In-app row; push stays deferred repo-wide.
 */
async function notifyCorroboration(
  ctx: MutationCtx,
  priorReport: Doc<'reports'>,
  byReport: Doc<'reports'>,
): Promise<void> {
  const author = await ctx.db.get(priorReport.authorId);
  if (!author) return;
  if (author.status !== 'active' || !author.notificationPrefs.reportRated) return;
  await ctx.db.insert('notifications', {
    userId: priorReport.authorId,
    type: 'report_rated',
    payload: { kind: 'corroboration', reportId: priorReport._id, byReportId: byReport._id },
    createdAt: Date.now(),
  });
}

/**
 * A water body's report feed — newest **skate-end time** first (D28), **paginated** for infinite
 * scroll so a popular lake's history never `.collect()`s an unbounded set. All reports are public
 * (D13) and a block never hides a report (D3), so the filter is moderation-only (excludes
 * hidden/removed, D32) — applied *in* the index (`moderationStatus: 'visible'`) so a page is never
 * emptied by the gate. The blocked-author "Blocked"-chip annotation is layered on in the client.
 */
export const listByWaterBody = query({
  args: { waterBodyId: v.id('waterBodies'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { waterBodyId, paginationOpts }) => {
    return ctx.db
      .query('reports')
      .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
        q.eq('waterBodyId', waterBodyId).eq('moderationStatus', 'visible'),
      )
      .order('desc')
      .paginate(paginationOpts);
  },
});

/** A single report for its detail view — moderation-checked (hidden/removed excluded, D32). */
export const get = query({
  args: { reportId: v.id('reports') },
  handler: (ctx, { reportId }) => getViewableReport(ctx, reportId),
});

/** A resolved survivor body's feed-relevant fields: display name + on-water centroid (for band calc). */
interface BodyInfo {
  name: string;
  centroid: LatLng;
}

/** Resolve a report's surviving water-body name + centroid, following `mergedIntoId` (D36); cached. */
async function bodyInfoFor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  cache: Map<string, BodyInfo>,
): Promise<BodyInfo> {
  const cached = cache.get(waterBodyId);
  if (cached !== undefined) return cached;
  let body = await ctx.db.get(waterBodyId);
  for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
    body = await ctx.db.get(body.mergedIntoId);
  }
  const info: BodyInfo = {
    name: body?.name ?? 'Unknown water body',
    // A resolvable body always has a centroid; the fallback keeps the type total for a dangling ref.
    centroid: body?.centroid ?? { lat: 0, lng: 0 },
  };
  cache.set(waterBodyId, info);
  return info;
}

/**
 * Resolve a report author's public attribution + cosmetic trust (D13/D50); cached per query. Carries the
 * `TrustAvatar` ring inputs — `profileImageUrl` + the derived `trustClass` (never the raw score) — so a
 * feed card can ring its author. `now` is the per-query clock threaded into the class derivation.
 */
async function authorFor(
  ctx: QueryCtx,
  authorId: Id<'profiles'>,
  cache: Map<string, FeedAuthor>,
  now: number,
): Promise<FeedAuthor> {
  const cached = cache.get(authorId);
  if (cached !== undefined) return cached;
  const profile = await ctx.db.get(authorId);
  const author: FeedAuthor = profile
    ? {
        displayName: profile.displayName,
        username: profile.username,
        ...(profile.profileImageUrl !== undefined
          ? { profileImageUrl: profile.profileImageUrl }
          : {}),
        trustClass: trustClassFor(profile, now),
      }
    : { displayName: 'Unknown', username: '', trustClass: null };
  cache.set(authorId, author);
  return author;
}

/** Per-query enrichment caches shared across a page of feed cards (body info + author attribution). */
interface FeedCardCaches {
  bodyInfo: Map<string, BodyInfo>;
  authors: Map<string, FeedAuthor>;
}

/**
 * Shape one visible report into a `FeedCardData` — the single source of truth for the feed-card
 * payload, shared by the global `listFeed` and the offline-cache `recentCardsForBodies` so the two
 * can never drift. `blocked` de-emphasizes a blocked author but never hides the report (D3); a block
 * is not moderation.
 */
async function toFeedCard(
  ctx: QueryCtx,
  r: Doc<'reports'>,
  caches: FeedCardCaches,
  sets: { blocked: Set<string>; favorites: Set<string> },
  now: number,
): Promise<FeedCardData> {
  const body = await bodyInfoFor(ctx, r.waterBodyId, caches.bodyInfo);
  return {
    reportId: r._id,
    waterBodyId: r.waterBodyId,
    bodyName: body.name,
    ...(r.place !== undefined ? { place: r.place } : {}),
    skateEndTime: r.skateEndTime,
    ...(r.skateStartTime !== undefined ? { skateStartTime: r.skateStartTime } : {}),
    iceTypes: r.iceTypes,
    surfaceTags: r.surfaceTags,
    ...(r.skateQuality !== undefined ? { skateQuality: r.skateQuality } : {}),
    photoThumbUrls: await thumbUrlsFor(ctx, r.photoIds),
    author: await authorFor(ctx, r.authorId, caches.authors, now),
    blocked: sets.blocked.has(r.authorId),
    isFavorite: sets.favorites.has(r.waterBodyId),
  };
}

/** Resolve a report's photo **thumbnail** serving URLs for the feed carousel; missing files skipped. */
async function thumbUrlsFor(
  ctx: QueryCtx,
  photoIds: Doc<'reports'>['photoIds'],
): Promise<string[]> {
  // Resolve every photo concurrently — a page of reports each carrying a few photos would otherwise
  // serialize into dozens of round-trips per `listFeed` call. Missing files resolve to null, dropped.
  const urls = await Promise.all(
    photoIds.map(async (photoId) => {
      const photo = await ctx.db.get(photoId);
      if (!photo) return null;
      return ctx.storage.getUrl(photo.thumbStorageId as Id<'_storage'>);
    }),
  );
  return urls.filter((url): url is string => url !== null);
}

/**
 * The global cross-body **newsfeed** (Phase 5, D28) — every visible report, newest **skate-end
 * time** first, paginated (`usePaginatedQuery`). All reports are public (D13) and a **block never
 * hides a report** (D3, safety-first), so the filter is moderation-only; a blocked author's report
 * is still returned, carrying `blocked: true` for author de-emphasis + the "Blocked" chip. Each page
 * item is enriched into a `FeedCardData` (survivor body name + point-derived place, author, photo
 * thumbnails) — bounded by page size. The feed ships global; Phase 4 layers an additive drive-time /
 * favorites narrow onto this same query.
 *
 * **Phase 4 (additive).** An optional `filters` blob narrows the page via the shared
 * `@skating/core` `matchesFilters` (include-unknown for optional attributes; distance is hard and
 * favorites are exempt), using the viewer's cached isochrone bands + favorite set. Favorites are
 * **boosted to the top of the page** (a stable per-page reorder) and carry `isFavorite: true` for the
 * badge. With no filters + no favorites the result is exactly the Phase 5 feed. Note: narrowing runs
 * *after* `paginate`, so a heavily filtered page can come back short (even empty) with `isDone: false`
 * — `usePaginatedQuery` keeps loading; the client requests the next page. (The moderation gate stays
 * in-index precisely because *it* could empty every page; user filters can't strand the same way since
 * the cursor still advances through visible reports.)
 */
export const listFeed = query({
  args: { paginationOpts: paginationOptsValidator, filters: v.optional(v.any()) },
  handler: async (ctx, { paginationOpts, filters: rawFilters }) => {
    const viewer = await getCurrentProfile(ctx);
    const viewerId = viewer?._id ?? '';
    const [blocked, favorites] = await Promise.all([
      loadBlockedAuthorIds(ctx, viewerId),
      loadFavoriteBodyIds(ctx, viewerId),
    ]);
    const filters = sanitizeFeedFilters(rawFilters);
    // Stored bands validate as the broad GeoJSON union, but ORS only ever writes Polygon/MultiPolygon;
    // cast to the band shape `bandForCoord` consumes (same pattern as `adminAreas` polygon reads).
    const bands = {
      band30: viewer?.cachedIsochrones?.band30,
      band60: viewer?.cachedIsochrones?.band60,
      outerRadiusMeters: viewer?.outerRadiusMeters,
    } as DriveTimeBands;
    const home = viewer?.homeCoord;
    const now = Date.now();

    // Moderation-only gate (D32), applied *in* the index (`moderationStatus: 'visible'`) rather than
    // after `paginate`. A blocked author's report still comes through (D3), de-emphasized via `blocked`.
    const result = await ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) => q.eq('moderationStatus', 'visible'))
      .order('desc')
      .paginate(paginationOpts);

    const caches: FeedCardCaches = { bodyInfo: new Map(), authors: new Map() };
    const page: FeedCardData[] = [];
    for (const r of result.page) {
      const body = await bodyInfoFor(ctx, r.waterBodyId, caches.bodyInfo);
      const isFavorite = favorites.has(r.waterBodyId);
      const band = bandForCoord(body.centroid, bands, home);
      // The additive narrow — an empty `filters` matches everything (Phase 5 behavior preserved).
      if (
        !matchesFilters(
          {
            skateEndTime: r.skateEndTime,
            ...(r.skateQuality !== undefined ? { skateQuality: r.skateQuality } : {}),
            iceTypes: r.iceTypes,
            surfaceTags: r.surfaceTags,
            ...(r.iceThickness !== undefined ? { iceThickness: r.iceThickness } : {}),
          },
          filters,
          { band, isFavorite, now },
        )
      ) {
        continue;
      }
      page.push(await toFeedCard(ctx, r, caches, { blocked, favorites }, now));
    }
    // Boost favorites to the top of THIS page (stable sort keeps skate-end order within each group).
    page.sort((a, b) => Number(b.isFavorite ?? false) - Number(a.isFavorite ?? false));
    return { ...result, page };
  },
});

/** Offline read-cache bounds (decision #8): the freshest few reports per body, within a recent window. */
const OFFLINE_CACHE_MAX_PER_BODY = 5;
const OFFLINE_CACHE_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h

/**
 * Recent reports for a set of bodies as ready-to-cache `FeedCardData` (Phase 4, decision #8) — the
 * data the mobile offline read-cache stores so an **opened lake** and the viewer's **favorites** read
 * back on the ice with no signal. Per body: the freshest ≤5 visible reports within the last 72h
 * (whichever bound is smaller), enriched identically to the feed via `toFeedCard`. Empty ids → empty.
 */
export const recentCardsForBodies = query({
  args: { waterBodyIds: v.array(v.id('waterBodies')) },
  handler: async (ctx, { waterBodyIds }) => {
    const viewer = await getCurrentProfile(ctx);
    const viewerId = viewer?._id ?? '';
    const [blocked, favorites] = await Promise.all([
      loadBlockedAuthorIds(ctx, viewerId),
      loadFavoriteBodyIds(ctx, viewerId),
    ]);
    const now = Date.now();
    const cutoff = now - OFFLINE_CACHE_WINDOW_MS;
    const caches: FeedCardCaches = { bodyInfo: new Map(), authors: new Map() };
    const cards: FeedCardData[] = [];
    for (const waterBodyId of [...new Set(waterBodyIds)]) {
      const recent = await ctx.db
        .query('reports')
        .withIndex('by_water_body_moderation_and_skate_end_time', (q) =>
          q
            .eq('waterBodyId', waterBodyId)
            .eq('moderationStatus', 'visible')
            .gte('skateEndTime', cutoff),
        )
        .order('desc')
        .take(OFFLINE_CACHE_MAX_PER_BODY);
      for (const r of recent) {
        cards.push(await toFeedCard(ctx, r, caches, { blocked, favorites }, now));
      }
    }
    return cards;
  },
});

/**
 * Hard ceiling on the recommended candidate scan. The 48h recency floor already bounds the window in the
 * index; this caps the pathological busy-window case so the read stays well under Convex's per-query
 * limits (the `listInViewport` read-cap lesson, PRs #10/#11). Newest-first `.take()`, so a truncation only
 * ever drops the *oldest* in-window reports — the least likely to be the freshest exceptional ice.
 */
const RECOMMENDED_SCAN_CAP = 500;

/**
 * The **recommended** filter-breaking feed (decisions 13–15) — a *separate* query the client interleaves
 * near the top of `listFeed`, never spliced into the paginated stream (decision 13). Returns 0–2 visually
 * distinct cards of *exceptional, corroborated* ice that a viewer's own distance/quality/thickness filters
 * would hide — gated on trust + corroboration, never a lone great report (D3), so we never amplify one
 * unverified claim into a wasted trip.
 *
 * The pure bar + bundling/cap live in `@skating/core` (`selectRecommended`); this query only assembles the
 * candidate bag and hydrates the winners. Cheap doc-level gates (recency floor, `great`, black ice, ≥
 * `RECOMMENDED_MIN_PHOTOS` photos) filter first; only survivors pay for the author-trust lookup and the
 * corroboration tally (`report_corroborated` rows on the `by_ref` index). Blocks + moderation are honored
 * (never broken): non-visible reports are excluded in-index and a blocked author's report is dropped here.
 *
 * **Caps (decision 15):** stateless for Phase 6 — `selectRecommended` bundles the top reports per body and
 * caps at `RECOMMENDED_MAX_BODIES_PER_DAY` unique bodies *per fetch*. A qualifying report is vanishingly
 * rare (all gates at once), so a flood can't occur at alpha volume. The server-tracked cross-fetch/day
 * dedup + hard per-day cap (a per-user impressions store + an ack mutation) is a logged fast-follow —
 * built when the feature proves it fires often enough to need pacing.
 */
export const recommended = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getCurrentProfile(ctx);
    // A personalized filter-breaker — no viewer, no "outside *your* usual range". Signed-out feed is plain.
    if (!viewer) return [];
    const now = Date.now();
    const cutoff = now - RECOMMENDED_RECENCY_HOURS * 60 * 60 * 1000;
    const blocked = await loadBlockedAuthorIds(ctx, viewer._id);

    // Recent visible reports, **newest first** and hard-capped — the recency floor bounds the window in
    // the index, but a busy 48h across every lake could still be large, so we `.take()` a ceiling rather
    // than an unbounded `.collect()` (the same read-cap discipline as `bounties.listOpen`; a qualifying
    // report is rare, so the freshest slice never omits a real candidate at alpha). Truncation is logged.
    const recent = await ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) =>
        q.eq('moderationStatus', 'visible').gte('skateEndTime', cutoff),
      )
      .order('desc')
      .take(RECOMMENDED_SCAN_CAP);
    if (recent.length === RECOMMENDED_SCAN_CAP) {
      console.warn(
        `reports.recommended hit the ${RECOMMENDED_SCAN_CAP}-row scan cap; older in-window candidates may be omitted.`,
      );
    }

    const recentById = new Map<string, Doc<'reports'>>();
    const candidates: RecommendableReport[] = [];
    const authorTrust = new Map<string, TrustClass | null>();
    for (const r of recent) {
      recentById.set(r._id, r);
      // Cheap mandatory gates first (each also re-checked by `isRecommendable`): never break blocks (D3),
      // then the exact quality / ice / photo bar — so we only pay for trust + corroboration on survivors.
      if (blocked.has(r.authorId)) continue;
      if (r.skateQuality !== 'great') continue;
      if (!r.iceTypes.includes('black_ice')) continue;
      if (r.photoIds.length < RECOMMENDED_MIN_PHOTOS) continue;

      let trust = authorTrust.get(r.authorId);
      if (trust === undefined) {
        const author = await ctx.db.get(r.authorId);
        trust = author ? trustClassFor(author, now) : null;
        authorTrust.set(r.authorId, trust);
      }

      // Corroborators for this report = `report_corroborated` ledger rows keyed to it (by_ref).
      const refEvents = await ctx.db
        .query('pointEvents')
        .withIndex('by_ref', (q) => q.eq('refId', r._id))
        .collect();
      const corroborationCount = refEvents.filter((e) => e.reason === 'report_corroborated').length;

      candidates.push({
        reportId: r._id,
        waterBodyId: r.waterBodyId,
        skateEndTime: r.skateEndTime,
        ...(r.skateQuality !== undefined ? { skateQuality: r.skateQuality } : {}),
        iceTypes: r.iceTypes,
        photoCount: r.photoIds.length,
        corroborationCount,
        authorTrust: trust,
      });
    }

    // Pure selection: filter to the exceptional bar, bundle top reports per body, cap unique bodies.
    const cards = selectRecommended(candidates, { now });

    // Hydrate each winning report into a full `FeedCardData` so the client renders it like a feed card
    // (author ring, chips, thumbnails) inside the distinct "Recommended" wrapper. Reuses `toFeedCard`.
    const caches: FeedCardCaches = { bodyInfo: new Map(), authors: new Map() };
    const noFavorites = new Set<string>(); // recommended breaks filters; favorite boost is irrelevant here
    const result: { waterBodyId: string; cards: FeedCardData[] }[] = [];
    for (const card of cards) {
      const cardData: FeedCardData[] = [];
      for (const reportId of card.reportIds) {
        const r = recentById.get(reportId);
        if (r)
          cardData.push(await toFeedCard(ctx, r, caches, { blocked, favorites: noFavorites }, now));
      }
      if (cardData.length > 0) result.push({ waterBodyId: card.waterBodyId, cards: cardData });
    }
    return result;
  },
});

/**
 * Author-only edit (D25): last-write-wins over the content fields + a fresh `updatedAt`. Re-runs the
 * full `@skating/core` contract. The target water body isn't editable here; an unprovided put-in pin
 * preserves the existing `point` rather than silently clearing it.
 */
export const update = mutation({
  args: { reportId: v.id('reports'), ...reportContent },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx);
    const existing = await ctx.db.get(args.reportId);
    if (!existing) throw new ConvexError('Report not found');
    if (existing.authorId !== profile._id)
      throw new ConvexError('Only the author can edit a report');
    // Don't let an author keep editing content a moderator has taken down (hidden/removed, D32) —
    // the edit path doesn't touch `moderationStatus`, so re-appearing it would require re-moderation.
    if (existing.moderationStatus !== 'visible')
      throw new ConvexError('This report has been moderated and can no longer be edited');

    const now = Date.now();
    const result = validateReportInput(toReportInput(args, existing.waterBodyId), { now });
    if (!result.ok) {
      throw new ConvexError({
        code: 'invalid_report',
        errors: result.errors.map((e) => `${e.field}: ${e.message}`),
      });
    }
    const n = result.normalized;

    const photoIds = args.photoIds ?? existing.photoIds;
    await assertOwnedPhotos(ctx, photoIds, profile._id);

    // Re-resolve the point-derived place (Phase 5) from the final point — an edited put-in pin moves
    // the location label with it. `place` is cleared to undefined when the new point resolves nowhere.
    const point = n.point ?? existing.point;
    const place = await resolvePlaceForCoord(ctx, point);

    await ctx.db.patch(args.reportId, {
      point,
      skateEndTime: n.skateEndTime,
      skateStartTime: n.skateStartTime,
      place,
      iceTypes: n.iceTypes,
      surfaceTags: n.surfaceTags,
      skateQuality: n.skateQuality,
      iceThickness: n.iceThickness,
      snowCoverCm: n.snowCoverCm,
      conditions: n.conditions,
      notes: n.notes,
      ...(args.showPutIn !== undefined ? { showPutIn: args.showPutIn } : {}),
      photoIds,
      updatedAt: now,
    });
    return args.reportId;
  },
});

/**
 * One-time migration (Phase 5): copy each report's legacy `skateTime` → `skateEndTime`, drop the old
 * field, and stamp the point-derived `place` (against the imported `adminAreas`). A field **rename**
 * isn't migration-free, so run this via the Phase-3 strict-schema dance on a deployment with data:
 * temporarily `schemaValidation: false` → push → `pnpm exec convex run reports:renameSkateTimeToSkateEndTime`
 * → revert → redeploy strict. Run it **after** the `adminAreas` import so `place` resolves. Idempotent:
 * a report already carrying `skateEndTime` keeps it, and re-running only backfills a still-missing
 * `place`. Dev has a handful of test reports; prod is uninitialized. `collect()` suits that scale — a
 * large corpus would need pagination.
 */
export const renameSkateTimeToSkateEndTime = internalMutation({
  args: {},
  handler: async (ctx) => {
    const reports = await ctx.db.query('reports').collect();
    let renamed = 0;
    let placed = 0;
    for (const r of reports) {
      // The legacy field is off the typed schema now, so read it through a narrow cast.
      const legacy = (r as { skateTime?: number }).skateTime;
      const patch: Record<string, unknown> = {};
      if (r.skateEndTime === undefined && typeof legacy === 'number') {
        patch.skateEndTime = legacy;
      }
      // Drop the dangling old field so strict validation passes once re-enabled.
      if (legacy !== undefined) patch.skateTime = undefined;
      if (r.place === undefined) {
        const place = await resolvePlaceForCoord(ctx, r.point);
        if (place !== undefined) {
          patch.place = place;
          placed++;
        }
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(r._id, patch as Partial<Doc<'reports'>>);
        // Count only an actual copy — a cleanup-only patch (report already had `skateEndTime`, we
        // just drop a dangling legacy `skateTime`) isn't a rename and mustn't inflate the count.
        if ('skateEndTime' in patch) renamed++;
      }
    }
    return { total: reports.length, renamed, placed };
  },
});
