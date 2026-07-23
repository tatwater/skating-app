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
  clipFootprintToBody,
  type deriveHazardFreshness,
  freshnessWithMultiplier,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_RADIUS_M,
  type HazardShape,
  hazardBbox,
  hazardFootprint,
  initialLifecycleState,
  isMinor,
  isProvisional,
  isValidHazardShape,
} from '@skating/core';
import { ConvexError, v } from 'convex/values';
import type { MultiPolygon, Polygon } from 'geojson';
import type { Doc, Id } from './_generated/dataModel';
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server';
import { assertCanPostHazards, getCurrentProfile, requireProfile } from './lib/auth';
import { resolveSurvivor } from './lib/bodies';
import { HAZARD_GEOMETRY_KINDS, HAZARD_TYPES_VALIDATOR } from './lib/hazardValidators';
import { isListed } from './lib/listing';
import { assertOwnedPhotos } from './lib/photoAccess';
import { loadBlockedAuthorIds } from './lib/reportVisibility';
import { geoJson, literals } from './lib/validators';

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
  return ctx.db.insert('hazards', {
    waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
    type: args.type,
    geometryKind: shape.geometryKind,
    geometry: shape.geometry as Doc<'hazards'>['geometry'],
    ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
    ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
    bbox: hazardBbox(shape, clippedFootprint),
    ...(clippedFootprint ? { clippedFootprint } : {}),
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
    const profile = await requireProfile(ctx);
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
   * The reporter's display name, for the drawer's "reported by <name>" line. Only the single-hazard
   * `get` resolves it (an extra profile read per hazard — not worth paying on the map's `listForBody`,
   * which never shows a name), so it's absent on the list path and **withheld when the author is
   * blocked** (a blocked author's name is suppressed the same way comments suppress it, D32). A block
   * never hides the hazard itself, though — a safety observation stays on the map regardless (D3).
   */
  reporterName?: string;
}

function toView(hazard: Doc<'hazards'>, now: number): HazardView {
  return {
    ...hazard,
    // Weather-adjusted freshness (D56): the decay cron (§6) stores a time-independent `decayMultiplier`;
    // this query recomputes the live bucket from it + the always-current elapsed. Absent ⇒ 1 (fail-open =
    // plain base decay). Freshness itself is still never stored — only the weather *input* is.
    freshness: freshnessWithMultiplier(
      hazard.type,
      hazard.lastConfirmedAt,
      now,
      hazard.decayMultiplier ?? 1,
    ),
    provisional: isProvisional(hazard.confirmCount),
  };
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
  },
  handler: async (ctx, { waterBodyId, includeArchived }) => {
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
    return (
      rows
        .filter((h) => h.moderationStatus === 'visible')
        // A hazard promoted to a persistent body feature (D53) is rendered by the feature now, not here.
        .filter((h) => h.promotedToFeatureId === undefined)
        .map((h) => toView(h, now))
        .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt)
    );
  },
});

/**
 * A hazard is visible to ordinary users when a moderator hasn't hidden it AND it hasn't been promoted
 * into a persistent body feature (which now carries the warning). The two are separate axes but both
 * take a hazard off every user-facing surface — a deep link to a promoted or hidden pin resolves to
 * nothing, and it can't be confirmed. `null`/missing rows are also not visible.
 */
function isUserVisibleHazard(hazard: Doc<'hazards'> | null): hazard is Doc<'hazards'> {
  return (
    hazard !== null &&
    hazard.moderationStatus === 'visible' &&
    hazard.promotedToFeatureId === undefined
  );
}

/** A single hazard for its detail drawer. `null` when missing, moderator-hidden, or promoted. */
export const get = query({
  args: { hazardId: v.id('hazards') },
  handler: async (ctx, { hazardId }): Promise<HazardView | null> => {
    const hazard = await ctx.db.get(hazardId);
    if (!isUserVisibleHazard(hazard)) return null;
    const view = toView(hazard, Date.now());

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
    return rows
      .filter((h) => h.originReportId === undefined)
      .filter((h) => h.moderationStatus === 'visible')
      .filter((h) => h.promotedToFeatureId === undefined)
      .filter((h) => h.firstReportedAt >= from && h.firstReportedAt <= skateEndTime)
      .map((h) => toView(h, now))
      .sort((a, b) => a.firstReportedAt - b.firstReportedAt);
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
    // A moderator-hidden or already-promoted pin must not be launderable back into visibility by
    // bundling it into a report (D3) — skip anything not currently user-visible.
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
