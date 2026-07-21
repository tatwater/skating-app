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
  deriveHazardFreshness,
  HAZARD_DEFAULT_BUFFER_M,
  HAZARD_DEFAULT_RADIUS_M,
  type HazardShape,
  hazardBbox,
  initialLifecycleState,
  isMinor,
  isProvisional,
  isValidHazardShape,
} from '@skating/core'
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import { requireProfile, requireRole } from './lib/auth'
import { resolveSurvivor } from './lib/bodies'
import { HAZARD_GEOMETRY_KINDS, HAZARD_TYPES_VALIDATOR } from './lib/hazardValidators'
import { isListed } from './lib/listing'
import { assertOwnedPhotos } from './lib/photoAccess'
import { geoJson, literals } from './lib/validators'

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
}

/** The standalone quick-flag args (D51) — the same content, plus the body it attaches to. */
export const hazardCreateArgs = {
  waterBodyId: v.id('waterBodies'),
  ...inReportHazardArgs,
}

/**
 * Build the stored shape from mutation args, filling the type-aware default when the client omitted a
 * size. Defaulting server-side matters for the offline path: a draft captured on the ice by an old
 * client build still lands with a sane footprint rather than a zero-radius point nobody can see.
 */
function toShape(args: {
  type: Doc<'hazards'>['type']
  geometryKind: Doc<'hazards'>['geometryKind']
  geometry: unknown
  radiusMeters?: number
  bufferMeters?: number
}): HazardShape {
  const geometry = args.geometry as HazardShape['geometry']
  if (args.geometryKind === 'point_radius') {
    return {
      geometryKind: 'point_radius',
      geometry,
      radiusMeters: args.radiusMeters ?? HAZARD_DEFAULT_RADIUS_M[args.type],
    }
  }
  return {
    geometryKind: args.geometryKind,
    geometry,
    bufferMeters: args.bufferMeters ?? HAZARD_DEFAULT_BUFFER_M[args.type],
  }
}

/**
 * Insert a hazard. Shared by the public `create` mutation and `reports.create`'s in-report path, so
 * both produce byte-identical rows — an in-report hazard is not a second-class hazard.
 */
export async function insertHazard(
  ctx: MutationCtx,
  args: {
    waterBodyId: Id<'waterBodies'>
    type: Doc<'hazards'>['type']
    geometryKind: Doc<'hazards'>['geometryKind']
    geometry: unknown
    radiusMeters?: number
    bufferMeters?: number
    description?: string
    photoIds?: Id<'photos'>[]
  },
  authorId: Id<'profiles'>,
  now: number,
  originReportId?: Id<'reports'>,
): Promise<Id<'hazards'>> {
  const body = await resolveSurvivor(ctx, args.waterBodyId)
  if (!body || !isListed(body)) throw new ConvexError('Water body not found')

  const shape = toShape(args)
  if (!isValidHazardShape(shape)) throw new ConvexError('Invalid hazard geometry')

  const photoIds = args.photoIds ?? []
  await assertOwnedPhotos(ctx, photoIds, authorId)

  const lifecycle = initialLifecycleState(now)
  return ctx.db.insert('hazards', {
    waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
    type: args.type,
    geometryKind: shape.geometryKind,
    geometry: shape.geometry as Doc<'hazards'>['geometry'],
    ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
    ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
    bbox: hazardBbox(shape),
    createdByUserId: authorId,
    ...(originReportId !== undefined ? { originReportId } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    photoIds,
    status: lifecycle.status,
    moderationStatus: 'visible',
    healingState: lifecycle.healingState,
    firstReportedAt: now,
    lastConfirmedAt: lifecycle.lastConfirmedAt,
    confirmCount: lifecycle.confirmCount,
    goneCount: lifecycle.goneCount,
    createdAt: now,
  })
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
    const profile = await requireProfile(ctx)
    const now = Date.now()
    // TODO(16+): fold into the uniform 16+ pass with legal (D41).
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post hazards')
    }
    return insertHazard(ctx, args, profile._id, now)
  },
})

/** A hazard as the map and drawers consume it — with freshness/provisional derived server-side. */
export interface HazardView extends Doc<'hazards'> {
  freshness: ReturnType<typeof deriveHazardFreshness>
  provisional: boolean
}

function toView(hazard: Doc<'hazards'>, now: number): HazardView {
  return {
    ...hazard,
    freshness: deriveHazardFreshness(hazard.type, hazard.lastConfirmedAt, now),
    provisional: isProvisional(hazard.confirmCount),
  }
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
    const body = await resolveSurvivor(ctx, waterBodyId)
    if (!body) return []
    const now = Date.now()
    const rows = await ctx.db
      .query('hazards')
      .withIndex('by_water_body', (q) => q.eq('waterBodyId', body._id))
      .collect()
    return rows
      .filter((h) => h.moderationStatus === 'visible')
      .filter((h) => includeArchived === true || h.status === 'active')
      .map((h) => toView(h, now))
      .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt)
  },
})

/** A single hazard for its detail drawer. `null` when missing or moderator-hidden. */
export const get = query({
  args: { hazardId: v.id('hazards') },
  handler: async (ctx, { hazardId }) => {
    const hazard = await ctx.db.get(hazardId)
    if (hazard?.moderationStatus !== 'visible') return null
    return toView(hazard, Date.now())
  },
})

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
    const profile = await requireProfile(ctx)
    const body = await resolveSurvivor(ctx, waterBodyId)
    if (!body) return []
    const from = skateStartTime ?? skateEndTime - (lookbackMs ?? DEFAULT_BUNDLE_LOOKBACK_MS)
    // A hazard flagged from the ice is stamped when it was *captured*, but an offline draft can flush
    // well after the skate ended — so the window is checked against `firstReportedAt`, not `createdAt`.
    const now = Date.now()
    const rows = await ctx.db
      .query('hazards')
      .withIndex('by_author_and_water_body', (q) =>
        q.eq('createdByUserId', profile._id).eq('waterBodyId', body._id),
      )
      .collect()
    return rows
      .filter((h) => h.originReportId === undefined)
      .filter((h) => h.moderationStatus === 'visible')
      .filter((h) => h.firstReportedAt >= from && h.firstReportedAt <= skateEndTime)
      .map((h) => toView(h, now))
      .sort((a, b) => a.firstReportedAt - b.firstReportedAt)
  },
})

/** Default auto-bundle lookback when a report gives no start time (D55) — tunable in Phase 7. */
export const DEFAULT_BUNDLE_LOOKBACK_MS = 24 * 60 * 60 * 1000

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
  const attached: Id<'hazards'>[] = []
  for (const hazardId of hazardIds) {
    const hazard = await ctx.db.get(hazardId)
    if (!hazard) continue
    if (hazard.createdByUserId !== authorId) continue
    if (hazard.waterBodyId !== waterBodyId) continue
    if (hazard.originReportId !== undefined) continue
    await ctx.db.patch(hazardId, { originReportId: reportId })
    attached.push(hazardId)
  }
  return attached
}

/**
 * Moderator hide/restore for a bad pin (D32/D37).
 *
 * Sets `moderationStatus` and leaves the lifecycle `status` untouched, on purpose: a hidden hazard is
 * not a healed hazard, and if a mod action moved the lifecycle we'd have laundered a moderation
 * decision into a safety claim (D3). Writes the usual audit row.
 */
export const setModeration = mutation({
  args: {
    hazardId: v.id('hazards'),
    status: literals(['visible', 'hidden', 'removed'] as const),
    reason: v.string(),
  },
  handler: async (ctx, { hazardId, status, reason }) => {
    const actor = await requireRole(ctx, 'moderator')
    if (reason.trim().length === 0) throw new ConvexError('A reason is required')
    const hazard = await ctx.db.get(hazardId)
    if (!hazard) throw new ConvexError('Hazard not found')

    const priorStatus = hazard.moderationStatus
    await ctx.db.patch(hazardId, { moderationStatus: status })
    await ctx.db.insert('moderationActions', {
      actorId: actor._id,
      action: status === 'visible' ? 'restore' : status === 'hidden' ? 'hide' : 'remove',
      targetType: 'hazard',
      targetId: hazardId,
      reason,
      metadata: { priorStatus, newStatus: status },
      createdAt: Date.now(),
    })
  },
})

/** Internal read used by the confirmation flow; keeps the moderation gate in one place. */
export async function loadVisibleHazard(
  ctx: QueryCtx,
  hazardId: Id<'hazards'>,
): Promise<Doc<'hazards'> | null> {
  const hazard = await ctx.db.get(hazardId)
  if (hazard?.moderationStatus !== 'visible') return null
  return hazard
}
