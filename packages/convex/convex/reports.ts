/**
 * Report functions (the core read/write loop, D3/D13/D22–D25/D41).
 *
 * The validation + normalization contract lives in `@skating/core` `validateReportInput` and is
 * **re-enforced here** at the trust boundary (D37) — the client runs the same check before submit,
 * but the server never trusts it. **All reports are public (D13)** — there is no visibility field;
 * minors can't post at all (D41). Reads gate on moderation + blocks via `canViewReport`; the viewer
 * relationship carries only a block flag, self/none until blocks land (Phase 3).
 */

import {
  CONDITION_SOURCES,
  canViewReport,
  ICE_TYPES,
  isMinor,
  PRECIP_TYPES,
  type ReportInput,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  THICKNESS_METHODS,
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

/** Build the `@skating/core` validation input from mutation args (all reports are public, D13). */
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
): ReportInput {
  return {
    waterBodyId,
    skateTime: args.skateTime,
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
    ...reportContent,
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)
    const now = Date.now()

    // Idempotency short-circuit (F2/D30): if this key already produced a report, return it — the
    // flush is a retry, not a new post. Scoped to the author so a (UUID-collision-improbable) shared
    // key can never hand back someone else's report. Runs before validation/insert so a lost-ack
    // retry is cheap and never re-inserts.
    if (args.idempotencyKey !== undefined) {
      const existing = await ctx.db
        .query('reports')
        .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
        .unique()
      if (existing) {
        if (existing.authorId !== profile._id) throw new ConvexError('Idempotency key conflict')
        return existing._id
      }
    }

    // Minors are read-only (D41): reports are always public (D13), so we never let a minor broadcast.
    if (isMinor(profile.dateOfBirth, now)) {
      throw new ConvexError('Users under 18 cannot post reports')
    }

    const body = await resolveSurvivor(ctx, args.waterBodyId)
    if (!body || !isListed(body)) throw new ConvexError('Water body not found')

    const result = validateReportInput(toReportInput(args, args.waterBodyId), { now })
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
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      moderationStatus: 'visible',
      photoIds,
      hazardIdsCreated: [], // hazards are Phase 8 (D4 seam); always empty here
      createdAt: now,
      updatedAt: now,
    })
  },
})

/**
 * A water body's report feed — newest **skate time** first (D28). All reports are public (D13), so
 * the filter is moderation (excludes hidden/removed, D32) + blocks; the block seam is `canViewReport`.
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
        // TODO(Phase 3): replace NO_RELATIONSHIP with the viewer↔author block state. This is the
        // list-feed twin of the seam in `getViewableReport` (which covers `get` + `photos.getUrls`);
        // both sites must gain real block lookups together.
        canViewReport(viewerId, r.authorId, NO_RELATIONSHIP),
    )
  },
})

/** A single report for its detail view — moderation-checked (hidden/removed excluded, D32). */
export const get = query({
  args: { reportId: v.id('reports') },
  handler: (ctx, { reportId }) => getViewableReport(ctx, reportId),
})

/**
 * Author-only edit (D25): last-write-wins over the content fields + a fresh `updatedAt`. Re-runs the
 * full `@skating/core` contract. The target water body isn't editable here; an unprovided put-in pin
 * preserves the existing `point` rather than silently clearing it.
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
    const result = validateReportInput(toReportInput(args, existing.waterBodyId), { now })
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
      photoIds,
      updatedAt: now,
    })
    return args.reportId
  },
})
