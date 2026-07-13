/**
 * Photo functions (D31/D42). The client optimizes + **strips EXIF** before upload; these functions
 * are the server side of that pipeline. The privacy-critical rule (D42) is enforced here, not just
 * on the client: a photo's GPS `coord` is retained **only** when the uploader explicitly opts into
 * `placeOnMap`, so a client bug can never leak a location.
 */

import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { requireProfile } from './lib/auth'
import { latLng } from './lib/validators'

/** Mint a one-time Convex storage upload URL for the optimized full image / thumb (auth'd). */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireProfile(ctx)
    return ctx.storage.generateUploadUrl()
  },
})

/**
 * Record a `photos` row after the client uploads the optimized full + thumb. **D42 enforcement:**
 * drop `coord` unless `placeOnMap === true` — the GPS coord is retained only on explicit opt-in.
 * `takenAt` is passed only when the user opts into the timestamp (client-gated; not location-sensitive).
 */
export const create = mutation({
  args: {
    storageId: v.id('_storage'),
    thumbStorageId: v.id('_storage'),
    caption: v.optional(v.string()),
    takenAt: v.optional(v.number()),
    coord: v.optional(latLng),
    placeOnMap: v.boolean(),
  },
  handler: async (ctx, args) => {
    const profile = await requireProfile(ctx)
    // D42: retain a coord ONLY on placeOnMap opt-in — server-side, so a client bug can't leak it.
    const coord = args.placeOnMap ? args.coord : undefined
    return ctx.db.insert('photos', {
      storageId: args.storageId,
      thumbStorageId: args.thumbStorageId,
      uploaderId: profile._id,
      ...(args.caption !== undefined ? { caption: args.caption } : {}),
      ...(args.takenAt !== undefined ? { takenAt: args.takenAt } : {}),
      ...(coord !== undefined ? { coord } : {}),
      placeOnMap: args.placeOnMap,
      createdAt: Date.now(),
    })
  },
})

/**
 * Resolve serving URLs (full + thumb) for a set of photo ids — what the report/detail UI renders.
 * A URL is `null` if its stored file is missing (deleted/never-finalized), so callers must guard it
 * (never assume a serving URL). Missing photo rows are skipped.
 */
export const getUrls = query({
  args: { photoIds: v.array(v.id('photos')) },
  handler: async (ctx, { photoIds }) => {
    const results: {
      photoId: Id<'photos'>
      url: string | null
      thumbUrl: string | null
      caption?: string
      coord?: { lat: number; lng: number }
      placeOnMap: boolean
    }[] = []
    for (const photoId of photoIds) {
      const photo = await ctx.db.get(photoId)
      if (!photo) continue
      // Stored as v.string() per the data model; they're storage ids, so cast for `getUrl`.
      const [url, thumbUrl] = await Promise.all([
        ctx.storage.getUrl(photo.storageId as Id<'_storage'>),
        ctx.storage.getUrl(photo.thumbStorageId as Id<'_storage'>),
      ])
      results.push({
        photoId,
        url,
        thumbUrl,
        ...(photo.caption !== undefined ? { caption: photo.caption } : {}),
        ...(photo.coord !== undefined ? { coord: photo.coord } : {}),
        placeOnMap: photo.placeOnMap,
      })
    }
    return results
  },
})
