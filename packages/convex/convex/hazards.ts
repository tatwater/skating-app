/**
 * Hazards — localized dangers on a water body (D51/D52/D54, Phase 9).
 *
 * Two authoring paths, both landing here: a **standalone** quick-flag (the on-ice path — two taps, no
 * report) and **in-report** creation. Both are GPS-anchored on mobile and map-drawn on web.
 *
 * Three things about this module are load-bearing for safety:
 *
 * 1. **Freshness is never stored.** It's derived from `type` + `lastConfirmedAt` at read time via
 *    `@skating/core`, so a hazard ages correctly even if nothing ever writes to it again.
 * 2. **Nothing here ever deletes a hazard.** Community consensus archives; a moderator hides. Those
 *    are separate fields precisely so the two can never be confused (D3).
 * 3. **Stale hazards are still returned by default** — the client fades them behind a "show older"
 *    toggle rather than the server dropping them, because "we stopped showing it" and "it went away"
 *    must not look the same to a caller.
 */

import {
  type ConsensusVote,
  clipFootprintToBody,
  clusterConsensus,
  clusterHazards,
  confirmThresholdFor,
  DUPLICATE_MATCH_METERS,
  DUPLICATE_MAX_CLUSTER_SPREAD_M,
  type deriveHazardFreshness,
  freshnessWithMultiplier,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_RADIUS_M,
  type HazardConsensus,
  type HazardShape,
  hazardBbox,
  hazardFootprint,
  initialLifecycleState,
  isInSeason,
  isMinor,
  isPassageExpired,
  isPassageMarker,
  isProvisional,
  isValidHazardShape,
  promotionTargetFor,
  rankPromotionCandidates,
  resolveSeason,
  type Season,
  seasonOf,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server';
import {
  assertCanPostHazards,
  getCurrentProfile,
  requireContributor,
  requireContributorRole,
  requireProfile,
} from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { HAZARD_GEOMETRY_KINDS, HAZARD_TYPES_VALIDATOR } from './lib/hazardValidators';
import { isListed } from './lib/listing';
import { assertOwnedPhotos } from './lib/photoAccess';
import { loadBlockedAuthorIds } from './lib/reportVisibility';
import { geoJson, literals } from './lib/validators';
import { resolveSubAreaForPoint } from './subAreas';

/**
 * The hazard body of an authoring call, minus the water body.
 *
 * `reports.create` embeds this and supplies `waterBodyId` from the report itself, so an in-report
 * hazard can never be filed against a different lake than the report that created it.
 */
export const inReportHazardArgs = {
  type: HAZARD_TYPES_VALIDATOR,
  geometryKind: literals(HAZARD_GEOMETRY_KINDS),
  geometry: geoJson,
  radiusMeters: v.optional(v.number()),
  bufferMeters: v.optional(v.number()),
  description: v.optional(v.string()),
  photoIds: v.optional(v.array(v.id('photos'))),
};

/**
 * Bounds on the free-text and fan-out surface of a hazard. `reports.notes` goes through
 * `validateReportInput`; a hazard's optional description has no such pass, so it's capped here. The
 * per-report count caps a single mutation's write fan-out — each hazard is several document writes, so
 * an unbounded array is a cheap way to make one call expensive.
 */
export const HAZARD_MAX_DESCRIPTION_LEN = 1_000;
export const HAZARD_MAX_PER_REPORT = 25;

/** The standalone quick-flag args (D51) — the same content, plus the body it attaches to. */
export const hazardCreateArgs = {
  waterBodyId: v.id('waterBodies'),
  /**
   * Offline-flush dedup (Phase 9 offline / F2/D30). A hazard captured on the ice is queued with one
   * client-generated key and keeps it across every retry, so a create whose ack was lost returns the
   * same hazard instead of dropping a second pin a few metres from the first. Duplicate pins are
   * worse here than duplicate reports: two overlapping footprints read as two hazards, and the
   * confirm loop then has to retire both. Omitted by web/online callers.
   */
  idempotencyKey: v.optional(v.string()),
  /**
   * On-ice capture time (Phase 9 offline / D55). A hazard flagged from the ice is stamped when it was
   * *captured*, not when its offline draft finally flushes — otherwise a hazard captured mid-skate but
   * flushed after the skater leaves the ice reads as "reported after the skate ended" and the D55
   * auto-bundle (`listBundleCandidates`, keyed on `firstReportedAt`) silently drops it. Clamped to the
   * server clock so a skewed device can't stamp a hazard in the future. Omitted by online callers, for
   * whom capture and create are the same instant.
   */
  capturedAt: v.optional(v.number()),
  ...inReportHazardArgs,
};

/**
 * Build the stored shape from mutation args, filling the type-aware default when the client omitted a
 * size. Defaulting server-side matters for the offline path: a draft captured on the ice by an old
 * client build still lands with a sane footprint rather than a zero-radius point nobody can see.
 */
function toShape(args: {
  type: Doc<'hazards'>['type'];
  geometryKind: Doc<'hazards'>['geometryKind'];
  geometry: unknown;
  radiusMeters?: number;
  bufferMeters?: number;
}): HazardShape {
  const geometry = args.geometry as HazardShape['geometry'];
  if (args.geometryKind === 'point_radius') {
    return {
      geometryKind: 'point_radius',
      geometry,
      radiusMeters: args.radiusMeters ?? HAZARD_DEFAULT_RADIUS_M[args.type],
    };
  }
  return {
    geometryKind: args.geometryKind,
    geometry,
    bufferMeters: args.bufferMeters ?? HAZARD_DEFAULT_BUFFER_M[args.type],
  };
}

/**
 * Insert a hazard. Shared by the public `create` mutation and `reports.create`'s in-report path, so
 * both produce byte-identical rows — an in-report hazard is not a second-class hazard.
 */
export async function insertHazard(
  ctx: MutationCtx,
  args: {
    waterBodyId: Id<'waterBodies'>;
    type: Doc<'hazards'>['type'];
    geometryKind: Doc<'hazards'>['geometryKind'];
    geometry: unknown;
    radiusMeters?: number;
    bufferMeters?: number;
    description?: string;
    photoIds?: Id<'photos'>[];
    idempotencyKey?: string;
    capturedAt?: number;
  },
  authorId: Id<'profiles'>,
  now: number,
  originReportId?: Id<'reports'>,
): Promise<Id<'hazards'>> {
  const body = await resolveSurvivor(ctx, args.waterBodyId);
  if (!body || !isListed(body)) throw new ConvexError('Water body not found');

  const shape = toShape(args);
  if (!isValidHazardShape(shape)) throw new ConvexError('Invalid hazard geometry');

  if (args.description !== undefined && args.description.length > HAZARD_MAX_DESCRIPTION_LEN) {
    throw new ConvexError('Hazard description is too long');
  }

  const photoIds = args.photoIds ?? [];
  await assertOwnedPhotos(ctx, photoIds, authorId);

  // Clip the footprint to the body once, at create (Phase 9.5). `clipFootprintToBody` returns null when
  // the footprint is already inside the body or the clip can't be done safely, so the common case stores
  // nothing and reads fall back to the live footprint. The bbox is derived from the *same* polygon that
  // gets stored, so the prefilter box, the drawn halo and the measured distance are one shape.
  const footprint = hazardFootprint(shape);
  const clippedFootprint = clipFootprintToBody(footprint, body.polygon as Polygon | MultiPolygon);

  const lifecycle = initialLifecycleState(now);
  const bbox = hazardBbox(shape, clippedFootprint);
  // The named sub-area the footprint sits in (N2/D60), measured at the footprint's bbox centre — the
  // same representative point `hazardCenter` gives the weather sampler, so "which bay is this hazard
  // in" and "which weather cell is it in" can't disagree about where the hazard is.
  const subArea = await resolveSubAreaForPoint(ctx, body._id, {
    lat: (bbox.minLat + bbox.maxLat) / 2,
    lng: (bbox.minLng + bbox.maxLng) / 2,
  });
  return ctx.db.insert('hazards', {
    waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
    type: args.type,
    geometryKind: shape.geometryKind,
    geometry: shape.geometry as Doc<'hazards'>['geometry'],
    ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
    ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
    bbox,
    ...(clippedFootprint ? { clippedFootprint } : {}),
    ...(subArea !== null ? subArea : {}),
    createdByUserId: authorId,
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(originReportId !== undefined ? { originReportId } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    photoIds,
    status: lifecycle.status,
    moderationStatus: 'visible',
    healingState: lifecycle.healingState,
    // Capture time for an offline-flushed hazard, else now — clamped to the server clock (mirrors the
    // `observedAt` handling for confirmations) so an offline draft that flushes after the skate ends is
    // still stamped inside the skate window for the D55 auto-bundle.
    firstReportedAt: Math.min(args.capturedAt ?? now, now),
    lastConfirmedAt: lifecycle.lastConfirmedAt,
    confirmCount: lifecycle.confirmCount,
    goneCount: lifecycle.goneCount,
    createdAt: now,
  });
}

/**
 * Flag a hazard standalone (the on-ice quick-flag path, D51).
 *
 * Minors are read-only (D41), same as reports: a hazard is public safety content, so we don't let a
 * minor broadcast one. `TODO(16+)`: this gate is the single place the eventual uniform 16+ legal pass
 * will touch.
 */
export const create = mutation({
  args: hazardCreateArgs,
  handler: async (ctx, args) => {
    const profile = await requireContributor(ctx);
    const now = Date.now();

    // Idempotency short-circuit: if this key already produced a hazard, return it — the flush is a
    // retry, not a new sighting. The index is global (keys are client-minted UUIDs, so cross-user
    // collision is vanishingly unlikely), but we still verify ownership before handing a pin back, so
    // a guessed or replayed key can never surface someone else's hazard. Runs before the minor gate
    // and the insert, so a lost-ack retry is cheap.
    if (args.idempotencyKey !== undefined) {
      const existing = await ctx.db
        .query('hazards')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
        .unique();
      if (existing) {
        if (existing.createdByUserId !== profile._id) {
          throw new ConvexError('Idempotency key conflict');
        }
        return existing._id;
      }
    }

    // TODO(16+): fold into the uniform 16+ pass with legal (D41).
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post hazards');
    }
    // Granular posting permission (D57): a moderator can restrict hazard posting alone (finer than a ban).
    assertCanPostHazards(profile);
    return insertHazard(ctx, args, profile._id, now);
  },
});

/** A hazard as the map and drawers consume it — with freshness/provisional derived server-side. */
export interface HazardView extends Doc<'hazards'> {
  freshness: ReturnType<typeof deriveHazardFreshness>;
  provisional: boolean;
  /**
   * A **suggested crossing** past its own window (D64) — expired, and so dropped from `listForBody`.
   * Always `false` for a hazard: absence of evidence keeps a danger alive, and only a passage marker
   * inverts that. Kept on the view so a permalink can say the marker aged out rather than 404.
   */
  expired: boolean;
  /**
   * The reporter's display name, for the drawer's "reported by <name>" line. Only the single-hazard
   * `get` resolves it (an extra profile read per hazard — not worth paying on the map's `listForBody`,
   * which never shows a name), so it's absent on the list path and **withheld when the author is
   * blocked** (a blocked author's name is suppressed the same way comments suppress it, D32). A block
   * never hides the hazard itself, though — a safety observation stays on the map regardless (D3).
   */
  reporterName?: string;
  /**
   * The `bodyFeatures` type this pin was promoted into, when it was and the feature is still active
   * (D53 amendment). Drives one drawer line — *"this spot is also marked as a recurring feature"* —
   * so a sighting and the standing statement it produced read as one story rather than as two
   * warnings about the same ice. Only the single-hazard `get` resolves it.
   */
  promotedFeatureType?: string;
  /**
   * Set only when this hazard shares a cluster with at least one other pin (D80). `confirmCount` on
   * this view is then the **pooled** number and these two say so, which is what lets the drawer print
   * "3 skaters have marked this, across 2 pins" instead of a count that silently disagrees with the
   * confirmer list below it. Absent for the singleton case, which is nearly every hazard.
   *
   * `clusterMemberIds` is every member including this one, earliest sighting first — the map unions
   * their footprints, and the drawer lists every reporter behind them.
   */
  clusterConfirmCount?: number;
  clusterMemberIds?: string[];
}

function toView(hazard: Doc<'hazards'>, now: number, consensus?: HazardConsensus): HazardView {
  // The gates read the **cluster**, not the row (D80). Absent consensus ⇒ the row's own values, which
  // is also exactly what a singleton cluster returns — so there is one code path and no special case.
  const confirmCount = consensus?.confirmCount ?? hazard.confirmCount;
  const lastConfirmedAt = consensus?.lastConfirmedAt ?? hazard.lastConfirmedAt;
  return {
    ...hazard,
    // Weather-adjusted freshness (D56): the decay cron (§6) stores a time-independent `decayMultiplier`;
    // this query recomputes the live bucket from it + the always-current elapsed. Absent ⇒ 1 (fail-open =
    // plain base decay). Freshness itself is still never stored — only the weather *input* is.
    //
    // The **multiplier** stays the row's own while the **clock** is the cluster's. That pairing is
    // deliberate: the multiplier describes weather over this pin's own window and means nothing applied
    // to somebody else's, whereas "when did anyone last stand here" is a fact about the ridge.
    freshness: freshnessWithMultiplier(
      hazard.type,
      lastConfirmedAt,
      now,
      hazard.decayMultiplier ?? 1,
    ),
    // A suggested crossing needs **two** independent confirmations to stop reading as one skater's
    // suggestion (D64) — double every hazard's bar, which is what "more corroboration" means for the
    // one pin type that says you can go this way. Crossings never cluster, so a passage marker's
    // consensus is always its own row: the one pin type where escalating too readily would be the
    // anti-conservative direction is structurally excluded from pooling.
    provisional: isProvisional(confirmCount, confirmThresholdFor(isPassageMarker(hazard.type))),
    /**
     * Past its own 72-hour window a passage marker is **expired**: it stops rendering (D64). Carried
     * on the view rather than filtered out here, so `hazards.get` can tell a permalink holder that
     * the crossing aged out instead of 404-ing a link that used to work — the same courtesy a past
     * season's report gets. `listForBody` is where the drop happens.
     */
    expired: isPassageExpired(hazard.type, lastConfirmedAt, now),
    ...(consensus && consensus.memberIds.length > 1
      ? { clusterConfirmCount: confirmCount, clusterMemberIds: [...consensus.memberIds] }
      : {}),
  };
}

/**
 * Cluster one body's hazards and pool what the gates read (D77/D80).
 *
 * **The cost, and why it is bounded.** `listForBody` is the map's live subscription and does no
 * geometry work of its own, so clustering has to stay off the expensive path: `clusterHazards`
 * prefilters on the stored `bbox` — four comparisons on numbers already on the row — and only computes
 * a footprint distance for pairs whose boxes actually come within the tolerance. The confirmation
 * fan-out then runs for **multi-member clusters only**, which on any real lake is a handful of pins or
 * none at all; a body of singletons costs one clustering pass and zero extra reads.
 */
/**
 * The rows one hazard could possibly cluster with: active, moderation-visible pins on the same body in
 * the same **season**.
 *
 * The season bound is not incidental. A ridge somebody marked last February is not corroboration for
 * one drawn this January — within-season clustering asks "is this the same ridge you already marked?",
 * and the question only means anything inside one winter (D63/D77). Whether the same feature comes back
 * across winters is the cross-season window's question, and it has a different tolerance and a
 * different answer.
 *
 * Archived rows are excluded by the index, which also means an **archived hazard is not in its own
 * scope** and therefore gets no pooled consensus — correctly. A pin the community voted healed must
 * not borrow freshness from a live neighbour; that would be pooling in the unsafe direction by the
 * back door.
 */
export async function clusterScopeFor(
  ctx: QueryCtx,
  hazard: Doc<'hazards'>,
): Promise<Doc<'hazards'>[]> {
  const siblings = await ctx.db
    .query('hazards')
    .withIndex('by_water_body_status', (q) =>
      q.eq('waterBodyId', hazard.waterBodyId).eq('status', 'active'),
    )
    .collect();
  const target = seasonOf(hazard.firstReportedAt);
  return siblings.filter(
    (h) => h.moderationStatus === 'visible' && isInSeason(h.firstReportedAt, target),
  );
}

export async function poolConsensus(
  ctx: QueryCtx,
  hazards: readonly Doc<'hazards'>[],
): Promise<Map<string, HazardConsensus>> {
  const clusters = clusterHazards(
    hazards.map((h) => ({
      id: h._id,
      type: h.type,
      geometryKind: h.geometryKind,
      geometry: h.geometry as HazardShape['geometry'],
      ...(h.radiusMeters !== undefined ? { radiusMeters: h.radiusMeters } : {}),
      ...(h.bufferMeters !== undefined ? { bufferMeters: h.bufferMeters } : {}),
      ...(h.clippedFootprint !== undefined
        ? { clippedFootprint: h.clippedFootprint as HazardShape['geometry'] }
        : {}),
      bbox: h.bbox,
      firstReportedAt: h.firstReportedAt,
      createdByUserId: h.createdByUserId,
      confirmCount: h.confirmCount,
      lastConfirmedAt: h.lastConfirmedAt,
    })),
    { matchMeters: DUPLICATE_MATCH_METERS, maxSpreadMeters: DUPLICATE_MAX_CLUSTER_SPREAD_M },
  );

  const pooled = new Map<string, HazardConsensus>();
  for (const cluster of clusters) {
    if (cluster.members.length <= 1) continue;
    const votes: ConsensusVote[] = [];
    for (const m of cluster.members) {
      const rows = await ctx.db
        .query('hazardConfirmations')
        .withIndex('by_hazard', (q) => q.eq('hazardId', m.id as Id<'hazards'>))
        .collect();
      for (const row of rows) {
        votes.push({
          hazardId: row.hazardId,
          userId: row.userId,
          verdict: row.verdict,
          at: row.createdAt,
        });
      }
    }
    for (const [id, consensus] of clusterConsensus(cluster.members, votes)) {
      pooled.set(id, consensus);
    }
  }
  return pooled;
}

/**
 * Active, moderation-visible hazards for one water body — the map layer's query, and the set the
 * mobile client caches for offline proximity evaluation (D54 Layer 0).
 *
 * Returns **stale hazards too**, annotated rather than filtered: the client fades them behind a "show
 * older" toggle. Dropping them here would make "nobody has confirmed this lately" indistinguishable
 * from "this is gone" at the API boundary, which is the exact confusion D3 forbids.
 *
 * Scoped per body by design (Phase 9 call 6) — there is no cross-viewport hazard query, so this can
 * never grow into a read-cap problem the way `listInViewport` did.
 */
export const listForBody = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    /** Include community-archived ("fully healed") hazards — off by default. */
    includeArchived: v.optional(v.boolean()),
    /**
     * Which season's hazards (D63) — absent ⇒ this one.
     *
     * **A hazard's season is its `firstReportedAt`** (kickoff decision 1), which is the *opposite*
     * field from the one everything else about a hazard reads. Freshness, the redaction sweep and the
     * confirm loop all use `lastConfirmedAt`, because they ask "is anyone still maintaining this?".
     * A season asks "when was this first seen?", and it has to be a clock **nobody can move**: aged on
     * `lastConfirmedAt`, one skater confirming a March ridge in November would carry it across the
     * boundary with no operator in the loop, quietly re-answering the question the pre-first-ice
     * promotion pass exists to ask. The boundary is hard on purpose; `bodyFeatures` promotion (D53) is
     * the way across, and it is a decision somebody makes.
     */
    season: v.optional(v.number()),
  },
  handler: async (ctx, { waterBodyId, includeArchived, season }) => {
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    const now = Date.now();
    // Narrow to active hazards *at the index* in the common case. Archived hazards are retained
    // forever (D15), so reading them on every map subscription tick — the mistake `listInViewport`
    // made (#10/#11) — would let this query's read count grow without bound on a well-used lake.
    // `includeArchived` is a rare, explicit request and takes the wider index.
    const rows = includeArchived
      ? await ctx.db
          .query('hazards')
          .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
          .collect()
      : await ctx.db
          .query('hazards')
          .withIndex('by_water_body_status', (q) =>
            q.eq('waterBodyId', body._id).eq('status', 'active'),
          )
          .collect();
    // Filtered in memory rather than in the index: the two hazard indexes are keyed by body and status,
    // and `firstReportedAt` isn't in either. That costs nothing here and is worth being explicit about,
    // because it's the opposite of the report path — this query is already bounded by *body* (Phase 9
    // call 6, deliberately never a viewport scan), so the read it would narrow is bounded already.
    const target: Season = resolveSeason(season, seasonOf(now));
    // **No supersession filter** (D53 amendment, N5c). A `bodyFeature` is a standing statement about
    // the lake; a hazard is a sighting by a person on a date. Promotion adds the first and must not
    // delete the second — filtering here rewrote February 2027 as a month in which nobody reported a
    // ridge, and under cluster promotion it would erase the whole evidence trail the pattern rests on,
    // one click after an operator agreed the pattern was real. The feature and the pin never race:
    // after the season boundary the sighting is hidden by the **season** axis (D63) and the feature
    // remains, which is the desired end state reached by machinery N5a already built.
    const inScope = rows
      .filter((h) => h.moderationStatus === 'visible')
      .filter((h) => isInSeason(h.firstReportedAt, target));
    // Pooled *before* the expiry drop and after the season filter, so a cluster is what one winter's
    // skaters actually reported on this lake — a pin from last February is not corroboration for one
    // drawn this January, and the season axis is what says so.
    const pooled = await poolConsensus(ctx, inScope);
    return (
      inScope
        .map((h) => toView(h, now, pooled.get(h._id)))
        // **The one place a pin leaves the map on time alone** (D64). A hazard fades to a floor and
        // never disappears, because assuming a danger is still there is the recoverable mistake. A
        // suggested crossing is the opposite: "reported crossable" with nobody having looked in three
        // days walks a skater onto ice no one has checked, and the recoverable mistake is the longer
        // walk. Dropped here rather than in the client so the map, the list and the on-ice proximity
        // evaluator — which all read this one query — cannot disagree about it.
        .filter((h) => !h.expired)
        .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt)
    );
  },
});

/**
 * Hazards read per promotion pass. Far above any real lake's lifetime count — a busy body carries
 * tens — so its job is to make the read bounded rather than to be reached.
 */
const PROMOTION_SCAN_CAP = 500;

/**
 * **The pre-first-ice safety pass** (N5a): last season's hazards on one lake, ranked by how likely
 * they are to be back, for the operator surface at `/admin/water/$id`.
 *
 * This is the cover for the seasonal reset, and the reason it is a safety task rather than
 * housekeeping. Hiding last winter's hazards means the first skater in November sees a clean map where
 * there was a ridge; what makes that honest is somebody walking this list beforehand and promoting the
 * ones that come back every year into `bodyFeatures` (D53), which no reset touches.
 *
 * Ranked by `@skating/core`'s `rankPromotionCandidates` — decay tier first, because that is the only
 * input that is about physics rather than about attention. It is **not** a prediction that a hazard
 * will recur (D3); it is a queue for a human decision, and everything it drops is a type with nowhere
 * to be promoted *to*.
 *
 * Moderator-gated, like every other operator read: this is a management view of hidden content.
 */
export const listPromotionCandidates = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    /** Which season to look back at — absent ⇒ the one that just ended. */
    season: v.optional(v.number()),
  },
  handler: async (ctx, { waterBodyId, season }) => {
    await requireContributorRole(ctx, 'moderator');
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    const now = Date.now();
    const target: Season = resolveSeason(season, seasonOf(now) - 1);
    // **Bounded, unlike its first draft.** `by_water_body` has no status or time key, so a `.collect()`
    // here read every hazard the lake has ever held — on a table this phase's own design note points
    // out never ages out. Newest-created first, because last season's rows are the newest ones that
    // aren't this season's; an older row past the cap is a hazard from two winters ago, which the pass
    // isn't asking about. Logged when it bites so the cap can't be the silent kind.
    const rows = await ctx.db
      .query('hazards')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
      .order('desc')
      .take(PROMOTION_SCAN_CAP);
    if (rows.length >= PROMOTION_SCAN_CAP) {
      console.warn(
        `listPromotionCandidates: ${body._id} has at least ${PROMOTION_SCAN_CAP} hazards — ranking the newest ${PROMOTION_SCAN_CAP} only`,
      );
    }
    return rankPromotionCandidates(
      rows
        // Archived rows count. A ridge the community voted healed in March is *exactly* the kind that
        // comes back in December — "it healed" is a fact about last winter, not about this one.
        .filter((h) => h.moderationStatus === 'visible')
        // **The one reader that keeps filtering on supersession** (D53 amendment). Everywhere else
        // `promotedToFeatureId` is now pure provenance and hides nothing — but this list is a queue of
        // *decisions*, and an already-promoted hazard is genuinely finished as a suggestion. It is
        // still visible, still confirmable, still counted; it just has nothing left to ask an operator.
        .filter((h) => h.promotedToFeatureId === undefined)
        .filter((h) => isInSeason(h.firstReportedAt, target))
        .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt)
        .map((h) => ({
          hazardId: h._id,
          type: h.type,
          confirmCount: h.confirmCount,
          goneCount: h.goneCount,
          firstReportedAt: h.firstReportedAt,
          lastConfirmedAt: h.lastConfirmedAt,
          archived: h.status === 'archived',
          promotesTo: promotionTargetFor(h.type),
          ...(h.description !== undefined ? { description: h.description } : {}),
        })),
    );
  },
});

/**
 * A hazard is visible to ordinary users when a moderator hasn't hidden it. `null`/missing rows are
 * not visible.
 *
 * **Supersession used to be a second condition here, and its removal is the D53 amendment** (N5c). A
 * promoted hazard was unreachable by permalink and unconfirmable, which said the wrong thing twice:
 * confirming *"the ridge is here right now"* is a different statement from *"ridges form here"*, and
 * only the first is confirmable at all — so the pin is exactly the thing that should still take votes
 * once a feature exists beside it. Moderation stays the only visibility axis, which is what it always
 * should have been: one is a judgement about a *report*, the other is provenance about a *feature*.
 */
function isUserVisibleHazard(hazard: Doc<'hazards'> | null): hazard is Doc<'hazards'> {
  return hazard !== null && hazard.moderationStatus === 'visible';
}

/** A single hazard for its detail drawer. `null` when missing or moderator-hidden. */
export const get = query({
  args: { hazardId: v.id('hazards') },
  handler: async (ctx, { hazardId }): Promise<HazardView | null> => {
    const hazard = await ctx.db.get(hazardId);
    if (!isUserVisibleHazard(hazard)) return null;
    const now = Date.now();

    // **The drawer reads the same consensus the map does** (D80). Not an optimisation — a correctness
    // requirement: a pin drawn solid on the map because its cluster is confirmed, and then labelled
    // "Unconfirmed" the moment you open it, is the app disagreeing with itself about live ice. Costs
    // one body-bounded read on a single-hazard path, which is the same read `listForBody` already
    // makes, and the pooling itself short-circuits for the singleton case.
    const pooled = await poolConsensus(ctx, await clusterScopeFor(ctx, hazard));
    const view = toView(hazard, now, pooled.get(hazard._id));

    // The drawer's one-line reconciliation (D53 amendment): a pin the operator has already promoted
    // renders beside a permanent feature of the same shape, and without this the two read as a
    // duplicate warning rather than as one story. Resolved only on the single-hazard path — the map's
    // `listForBody` never shows it, and it must not pay a feature read per pin for a line it won't draw.
    if (hazard.promotedToFeatureId !== undefined) {
      const feature = await ctx.db.get(hazard.promotedToFeatureId);
      if (feature?.active) view.promotedFeatureType = feature.type;
    }

    // Resolve "reported by <name>", withheld when the viewer and the author have blocked each other
    // (D32) — the drawer just omits the line then, exactly as a blocked comment's author is withheld.
    // The hazard stays fully visible either way; a block never pulls a safety observation off the map.
    const viewer = await getCurrentProfile(ctx);
    const blocked = await loadBlockedAuthorIds(ctx, viewer?._id ?? '');
    if (!blocked.has(hazard.createdByUserId)) {
      const author = await ctx.db.get(hazard.createdByUserId);
      if (author) view.reporterName = author.displayName;
    }
    return view;
  },
});

/**
 * The author's own hazards on a body that aren't yet attached to any report — the D55 auto-bundle
 * candidates, offered (pre-checked, dismissible) when they write the report for that skate.
 *
 * Window: hazards flagged inside the skate window, or within `lookbackMs` of its end when no start
 * time was given. Only the author's own, and only unattached — bundling someone else's observation
 * would misattribute it, and mis-sourced safety content is a D3 problem.
 */
export const listBundleCandidates = query({
  args: {
    waterBodyId: v.id('waterBodies'),
    skateEndTime: v.number(),
    skateStartTime: v.optional(v.number()),
    lookbackMs: v.optional(v.number()),
  },
  handler: async (ctx, { waterBodyId, skateEndTime, skateStartTime, lookbackMs }) => {
    const profile = await requireProfile(ctx);
    const body = await resolveSurvivor(ctx, waterBodyId);
    if (!body) return [];
    const from = skateStartTime ?? skateEndTime - (lookbackMs ?? DEFAULT_BUNDLE_LOOKBACK_MS);
    // A hazard flagged from the ice is stamped when it was *captured*, but an offline draft can flush
    // well after the skate ended — so the window is checked against `firstReportedAt`, not `createdAt`.
    const now = Date.now();
    const rows = await ctx.db
      .query('hazards')
      .withIndex('by_author_and_water_body', (q) =>
        q.eq('createdByUserId', profile._id).eq('waterBodyId', body._id),
      )
      .collect();
    return (
      rows
        .filter((h) => h.originReportId === undefined)
        .filter((h) => h.moderationStatus === 'visible')
        // No supersession filter (D53 amendment): a promoted pin is still a sighting this author made on
        // this skate, and attaching it to the report they are writing about that skate is exactly right.
        .filter((h) => h.firstReportedAt >= from && h.firstReportedAt <= skateEndTime)
        .map((h) => toView(h, now))
        .sort((a, b) => a.firstReportedAt - b.firstReportedAt)
    );
  },
});

/** Default auto-bundle lookback when a report gives no start time (D55) — tunable in Phase 7. */
export const DEFAULT_BUNDLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Attach the author's own unattached hazards to their report (D55). Idempotent and ownership-gated:
 * re-running with the same ids is a no-op, and a hazard already bound to another report is skipped
 * rather than stolen.
 */
export async function attachHazardsToReport(
  ctx: MutationCtx,
  hazardIds: readonly Id<'hazards'>[],
  reportId: Id<'reports'>,
  authorId: Id<'profiles'>,
  waterBodyId: Id<'waterBodies'>,
): Promise<Id<'hazards'>[]> {
  const attached: Id<'hazards'>[] = [];
  for (const hazardId of hazardIds) {
    const hazard = await ctx.db.get(hazardId);
    if (!hazard) continue;
    if (hazard.createdByUserId !== authorId) continue;
    if (hazard.waterBodyId !== waterBodyId) continue;
    if (hazard.originReportId !== undefined) continue;
    // A moderator-hidden pin must not be launderable back into visibility by bundling it into a
    // report (D3) — skip anything not currently user-visible. Since the D53 amendment that gate is
    // moderation and nothing else, which is precisely what this guard was always for.
    if (!isUserVisibleHazard(hazard)) continue;
    await ctx.db.patch(hazardId, { originReportId: reportId });
    attached.push(hazardId);
  }
  return attached;
}

/**
 * Moderator hide/restore for a bad hazard pin goes through the shared `moderation.setModerationStatus`
 * (`targetType: 'hazard'`) — one takedown surface for reports, comments and hazards, so the Phase 7
 * queue has a single entry point. That mutation touches only `moderationStatus` and never the lifecycle
 * `status`, keeping a moderator hide distinct from a community all-clear (D3).
 */

/** Internal read used by the confirmation flow; keeps the visibility gate in one place. */
export async function loadVisibleHazard(
  ctx: QueryCtx,
  hazardId: Id<'hazards'>,
): Promise<Doc<'hazards'> | null> {
  const hazard = await ctx.db.get(hazardId);
  return isUserVisibleHazard(hazard) ? hazard : null;
}
