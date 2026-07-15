/**
 * Report functions (the core read/write loop, D3/D13/D22–D25/D41).
 *
 * The validation + normalization contract lives in `@skating/core` `validateReportInput` and is
 * **re-enforced here** at the trust boundary (D37) — the client runs the same check before submit,
 * but the server never trusts it. Visibility is derived from age (D41) and clamped to the author's
 * ceiling so a minor account can't post `public`. Reads are visibility-filtered per viewer via
 * `canViewReport` (D13, no social graph — just_me/public); the viewer relationship carries only a
 * block flag, which is self/none until blocks land (Phase 3).
 */

import {
  CONDITION_SOURCES,
  canViewReport,
  deriveDefaultVisibility,
  ICE_TYPES,
  isMinor,
  maxVisibilityForProfile,
  PRECIP_TYPES,
  type ReportInput,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  VISIBILITY_LEVELS,
  validateReportInput,
} from '@skating/core'
import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { getCurrentProfile, requireProfile } from './lib/auth'
import { isListed } from './lib/listing'
import { getViewableReport, NO_RELATIONSHIP } from './lib/reportVisibility'
import { latLng, literals } from './lib/validators'

/** Editable report content, shared by `create` and `update` args (the schema mirrors these). */
const reportContent = {
  skateTime: v.number(),
  visibility: v.optional(literals(VISIBILITY_LEVELS)), // unset ⇒ derived default (D41)
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
}

/** Follow `mergedIntoId` to the surviving body (D36); bounded hops guard a pathological cycle. */
async function resolveSurvivor(
  ctx: Parameters<typeof requireProfile>[0],
  waterBodyId: Doc<'reports'>['waterBodyId'],
): Promise<Doc<'waterBodies'> | null> {
  let body = await ctx.db.get(waterBodyId)
  for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
    body = await ctx.db.get(body.mergedIntoId)
  }
  return body
}

/** Verify every photo id exists and belongs to the author (no attaching someone else's photo). */
async function assertOwnedPhotos(
  ctx: Parameters<typeof requireProfile>[0],
  photoIds: Doc<'reports'>['photoIds'],
  authorId: Doc<'profiles'>['_id'],
): Promise<void> {
  for (const photoId of photoIds) {
    const photo = await ctx.db.get(photoId)
    if (!photo || photo.uploaderId !== authorId) {
      throw new ConvexError('Photo not found or not owned by the author')
    }
  }
}

/** Build the `@skating/core` validation input from mutation args + the resolved visibility. */
function toReportInput(
  args: {
    skateTime: number
    iceTypes?: string[]
    surfaceTags?: string[]
    skateQuality?: string
    iceThickness?: ReportInput['iceThickness']
    snowCoverCm?: number
    conditions?: ReportInput['conditions']
    notes?: string
    point?: { lat: number; lng: number }
  },
  waterBodyId: string,
  visibility: ReportInput['visibility'],
): ReportInput {
  return {
    waterBodyId,
    skateTime: args.skateTime,
    visibility,
    iceTypes: args.iceTypes as ReportInput['iceTypes'],
    surfaceTags: args.surfaceTags as ReportInput['surfaceTags'],
    skateQuality: args.skateQuality as ReportInput['skateQuality'],
    iceThickness: args.iceThickness,
    snowCoverCm: args.snowCoverCm,
    conditions: args.conditions,
    notes: args.notes,
    point: args.point,
  }
}

/**
 * Create a report (D3/D41). `requireProfile`; derive the default visibility from the caller's
 * age (adult→public, minor→just_me) when unset and clamp it to their ceiling; re-validate via
 * `@skating/core`; resolve
 * a merged target body to its survivor; set `point` from the put-in pin else the body centroid;
 * server-stamp `reportTime`; insert as a `native`, `visible` report.
 */
export const create = mutation({
  args: { waterBodyId: v.id('waterBodies'), ...reportContent },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)
    const now = Date.now()
    const minor = isMinor(profile.dateOfBirth, now) // report default/ceiling derive from age (D41)
    const maxVisibility = maxVisibilityForProfile({ isMinor: minor })
    const visibility = args.visibility ?? deriveDefaultVisibility({ isMinor: minor })

    const body = await resolveSurvivor(ctx, args.waterBodyId)
    if (!body || !isListed(body)) throw new ConvexError('Water body not found')

    const result = validateReportInput(toReportInput(args, args.waterBodyId, visibility), {
      now,
      maxVisibility,
    })
    if (!result.ok) {
      throw new ConvexError({
        code: 'invalid_report',
        errors: result.errors.map((e) => `${e.field}: ${e.message}`),
      })
    }
    const n = result.normalized

    const photoIds = args.photoIds ?? []
    await assertOwnedPhotos(ctx, photoIds, profile._id)

    return ctx.db.insert('reports', {
      authorId: profile._id,
      waterBodyId: body._id, // the resolved survivor, not the (possibly merged) requested id
      point: n.point ?? body.centroid,
      skateTime: n.skateTime,
      reportTime: now,
      source: 'native',
      iceTypes: n.iceTypes,
      surfaceTags: n.surfaceTags,
      ...(n.skateQuality !== undefined ? { skateQuality: n.skateQuality } : {}),
      ...(n.iceThickness !== undefined ? { iceThickness: n.iceThickness } : {}),
      ...(n.snowCoverCm !== undefined ? { snowCoverCm: n.snowCoverCm } : {}),
      ...(n.conditions !== undefined ? { conditions: n.conditions } : {}),
      ...(n.notes !== undefined ? { notes: n.notes } : {}),
      visibility: n.visibility,
      moderationStatus: 'visible',
      photoIds,
      hazardIdsCreated: [], // hazards are Phase 8 (D4 seam); always empty here
      createdAt: now,
      updatedAt: now,
    })
  },
})

/**
 * A water body's report feed — newest **skate time** first (D28), visibility-filtered per viewer
 * (D13) and excluding non-visible (hidden/removed) reports (D32).
 */
export const listByWaterBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const viewer = await getCurrentProfile(ctx)
    const viewerId = viewer?._id ?? ''
    const reports = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_time', (q) => q.eq('waterBodyId', waterBodyId))
      .order('desc')
      .collect()
    return reports.filter(
      (r) =>
        r.moderationStatus === 'visible' &&
        canViewReport(viewerId, r.authorId, r.visibility, NO_RELATIONSHIP),
    )
  },
})

/** A single report for its detail view — visibility-checked, hidden/removed excluded. */
export const get = query({
  args: { reportId: v.id('reports') },
  handler: (ctx, { reportId }) => getViewableReport(ctx, reportId),
})

/**
 * Author-only edit (D25): last-write-wins over the content fields + a fresh `updatedAt`. Re-runs the
 * full `@skating/core` contract (incl. the visibility ceiling). The target water body isn't editable
 * here; an unprovided put-in pin preserves the existing `point` rather than silently clearing it.
 */
export const update = mutation({
  args: { reportId: v.id('reports'), ...reportContent },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)
    const existing = await ctx.db.get(args.reportId)
    if (!existing) throw new ConvexError('Report not found')
    if (existing.authorId !== profile._id)
      throw new ConvexError('Only the author can edit a report')

    const now = Date.now()
    const maxVisibility = maxVisibilityForProfile({ isMinor: isMinor(profile.dateOfBirth, now) })
    const visibility = args.visibility ?? existing.visibility

    const result = validateReportInput(toReportInput(args, existing.waterBodyId, visibility), {
      now,
      maxVisibility,
    })
    if (!result.ok) {
      throw new ConvexError({
        code: 'invalid_report',
        errors: result.errors.map((e) => `${e.field}: ${e.message}`),
      })
    }
    const n = result.normalized

    const photoIds = args.photoIds ?? existing.photoIds
    await assertOwnedPhotos(ctx, photoIds, profile._id)

    await ctx.db.patch(args.reportId, {
      point: n.point ?? existing.point,
      skateTime: n.skateTime,
      iceTypes: n.iceTypes,
      surfaceTags: n.surfaceTags,
      skateQuality: n.skateQuality,
      iceThickness: n.iceThickness,
      snowCoverCm: n.snowCoverCm,
      conditions: n.conditions,
      notes: n.notes,
      visibility: n.visibility,
      photoIds,
      updatedAt: now,
    })
    return args.reportId
  },
})
