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
  canViewReport,
  type DriveTimeBands,
  type FeedCardData,
  ICE_TYPES,
  isMinor,
  type LatLng,
  matchesFilters,
  PRECIP_TYPES,
  type ReportInput,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  sanitizeFeedFilters,
  THICKNESS_METHODS,
  validateReportInput,
} from '@skating/core'
import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, mutation, type QueryCtx, query } from './_generated/server'
import { resolvePlaceForCoord } from './adminAreas'
import { getCurrentProfile, requireProfile } from './lib/auth'
import { isListed } from './lib/listing'
import { getViewableReport, loadBlockedAuthorIds } from './lib/reportVisibility'
import { latLng, literals } from './lib/validators'
import { loadFavoriteBodyIds } from './waterBodyFavorites'

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
    skateEndTime: number
    skateStartTime?: number
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

    // Stamp the point-derived location label (Phase 5) from the resolved put-in point (else the
    // body centroid) against the `adminAreas` boundaries — so the feed reads `{town/county, state}`
    // directly with no per-read geocode. Absent when the point is outside the imported region.
    const point = n.point ?? body.centroid
    const place = await resolvePlaceForCoord(ctx, point)

    return ctx.db.insert('reports', {
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
      hazardIdsCreated: [], // hazards are Phase 8 (D4 seam); always empty here
      createdAt: now,
      updatedAt: now,
    })
  },
})

/**
 * A water body's report feed — newest **skate time** first (D28). All reports are public (D13) and a
 * block never hides a report (D3), so the filter is moderation-only (excludes hidden/removed, D32).
 * The blocked-author "Blocked"-chip annotation is layered on in Workstream B.
 */
export const listByWaterBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const reports = await ctx.db
      .query('reports')
      .withIndex('by_water_body_skate_end_time', (q) => q.eq('waterBodyId', waterBodyId))
      .order('desc')
      .collect()
    return reports.filter((r) => canViewReport(r.moderationStatus))
  },
})

/** A single report for its detail view — moderation-checked (hidden/removed excluded, D32). */
export const get = query({
  args: { reportId: v.id('reports') },
  handler: (ctx, { reportId }) => getViewableReport(ctx, reportId),
})

/** A resolved survivor body's feed-relevant fields: display name + on-water centroid (for band calc). */
interface BodyInfo {
  name: string
  centroid: LatLng
}

/** Resolve a report's surviving water-body name + centroid, following `mergedIntoId` (D36); cached. */
async function bodyInfoFor(
  ctx: QueryCtx,
  waterBodyId: Id<'waterBodies'>,
  cache: Map<string, BodyInfo>,
): Promise<BodyInfo> {
  const cached = cache.get(waterBodyId)
  if (cached !== undefined) return cached
  let body = await ctx.db.get(waterBodyId)
  for (let hops = 0; body?.mergedIntoId !== undefined && hops < 8; hops++) {
    body = await ctx.db.get(body.mergedIntoId)
  }
  const info: BodyInfo = {
    name: body?.name ?? 'Unknown water body',
    // A resolvable body always has a centroid; the fallback keeps the type total for a dangling ref.
    centroid: body?.centroid ?? { lat: 0, lng: 0 },
  }
  cache.set(waterBodyId, info)
  return info
}

/** Resolve a report author's public `{ displayName, username }` (D13); cached per query. */
async function authorFor(
  ctx: QueryCtx,
  authorId: Id<'profiles'>,
  cache: Map<string, { displayName: string; username: string }>,
): Promise<{ displayName: string; username: string }> {
  const cached = cache.get(authorId)
  if (cached !== undefined) return cached
  const profile = await ctx.db.get(authorId)
  const author = profile
    ? { displayName: profile.displayName, username: profile.username }
    : { displayName: 'Unknown', username: '' }
  cache.set(authorId, author)
  return author
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
      const photo = await ctx.db.get(photoId)
      if (!photo) return null
      return ctx.storage.getUrl(photo.thumbStorageId as Id<'_storage'>)
    }),
  )
  return urls.filter((url): url is string => url !== null)
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
    const viewer = await getCurrentProfile(ctx)
    const viewerId = viewer?._id ?? ''
    const [blocked, favorites] = await Promise.all([
      loadBlockedAuthorIds(ctx, viewerId),
      loadFavoriteBodyIds(ctx, viewerId),
    ])
    const filters = sanitizeFeedFilters(rawFilters)
    // Stored bands validate as the broad GeoJSON union, but ORS only ever writes Polygon/MultiPolygon;
    // cast to the band shape `bandForCoord` consumes (same pattern as `adminAreas` polygon reads).
    const bands = {
      band30: viewer?.cachedIsochrones?.band30,
      band60: viewer?.cachedIsochrones?.band60,
      outerRadiusMeters: viewer?.outerRadiusMeters,
    } as DriveTimeBands
    const home = viewer?.homeCoord
    const now = Date.now()

    // Moderation-only gate (D32), applied *in* the index (`moderationStatus: 'visible'`) rather than
    // after `paginate`. A blocked author's report still comes through (D3), de-emphasized via `blocked`.
    const result = await ctx.db
      .query('reports')
      .withIndex('by_moderation_and_skate_end_time', (q) => q.eq('moderationStatus', 'visible'))
      .order('desc')
      .paginate(paginationOpts)

    const bodyInfo = new Map<string, BodyInfo>()
    const authors = new Map<string, { displayName: string; username: string }>()
    const page: FeedCardData[] = []
    for (const r of result.page) {
      const body = await bodyInfoFor(ctx, r.waterBodyId, bodyInfo)
      const isFavorite = favorites.has(r.waterBodyId)
      const band = bandForCoord(body.centroid, bands, home)
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
        continue
      }
      page.push({
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
        author: await authorFor(ctx, r.authorId, authors),
        blocked: blocked.has(r.authorId),
        isFavorite,
      })
    }
    // Boost favorites to the top of THIS page (stable sort keeps skate-end order within each group).
    page.sort((a, b) => Number(b.isFavorite ?? false) - Number(a.isFavorite ?? false))
    return { ...result, page }
  },
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
    // Don't let an author keep editing content a moderator has taken down (hidden/removed, D32) —
    // the edit path doesn't touch `moderationStatus`, so re-appearing it would require re-moderation.
    if (existing.moderationStatus !== 'visible')
      throw new ConvexError('This report has been moderated and can no longer be edited')

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

    // Re-resolve the point-derived place (Phase 5) from the final point — an edited put-in pin moves
    // the location label with it. `place` is cleared to undefined when the new point resolves nowhere.
    const point = n.point ?? existing.point
    const place = await resolvePlaceForCoord(ctx, point)

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
    })
    return args.reportId
  },
})

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
    const reports = await ctx.db.query('reports').collect()
    let renamed = 0
    let placed = 0
    for (const r of reports) {
      // The legacy field is off the typed schema now, so read it through a narrow cast.
      const legacy = (r as { skateTime?: number }).skateTime
      const patch: Record<string, unknown> = {}
      if (r.skateEndTime === undefined && typeof legacy === 'number') {
        patch.skateEndTime = legacy
      }
      // Drop the dangling old field so strict validation passes once re-enabled.
      if (legacy !== undefined) patch.skateTime = undefined
      if (r.place === undefined) {
        const place = await resolvePlaceForCoord(ctx, r.point)
        if (place !== undefined) {
          patch.place = place
          placed++
        }
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(r._id, patch as Partial<Doc<'reports'>>)
        // Count only an actual copy — a cleanup-only patch (report already had `skateEndTime`, we
        // just drop a dangling legacy `skateTime`) isn't a rename and mustn't inflate the count.
        if ('skateEndTime' in patch) renamed++
      }
    }
    return { total: reports.length, renamed, placed }
  },
})
