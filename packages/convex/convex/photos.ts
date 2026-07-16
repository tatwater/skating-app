/**
 * Photo functions (D31/D42). The client optimizes + **strips EXIF** before upload; these functions
 * are the server side of that pipeline. The privacy-critical rule (D42) is enforced here, not just
 * on the client: a photo's GPS `coord` is retained **only** when the uploader explicitly opts into
 * `placeOnMap`, so a client bug can never leak a location.
 */

import { isValidCoord } from '@skating/core'
import { ConvexError, v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { requireProfile } from './lib/auth'
import { getViewableReport } from './lib/reportVisibility'
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
    // Range-check before storing (the `latLng` validator checks types, not geographic bounds).
    if (coord !== undefined && !isValidCoord(coord)) {
      throw new ConvexError('Photo coordinate is out of range')
    }
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
 * Delete an uploaded photo the caller owns, plus its stored blobs — the cleanup path for a report
 * that never got created (the form uploads photos before `reports.create`; if that fails or the
 * user abandons the form, this reclaims the orphaned row + storage). Owner-gated; a missing row is
 * a no-op so a double-cleanup or a since-deleted photo can't throw. Not a moderation delete —
 * only the uploader may call it, and the client only calls it for still-unattached uploads.
 */
export const remove = mutation({
  args: { photoId: v.id('photos') },
  handler: async (ctx, { photoId }) => {
    const profile = await requireProfile(ctx)
    const photo = await ctx.db.get(photoId)
    if (!photo) return // already gone — idempotent
    if (photo.uploaderId !== profile._id) throw new ConvexError('Not your photo')
    // Tolerate an already-gone blob (e.g. a concurrent `removeBlob` during form teardown) so row
    // cleanup still completes — a throw here would otherwise strand the row.
    await Promise.all([
      ctx.storage.delete(photo.storageId as Id<'_storage'>).catch(() => {}),
      ctx.storage.delete(photo.thumbStorageId as Id<'_storage'>).catch(() => {}),
    ])
    await ctx.db.delete(photoId)
  },
})

/**
 * Delete a storage blob the client uploaded but never attached to a `photos` row — the cleanup path
 * for a partial upload (one of the full/thumb pair lands, its sibling or `create` fails) or a form
 * abandoned between `generateUploadUrl` and `create`. Auth-gated; a bare blob carries no owner row so
 * we can't owner-check it, but a storage id is only ever handed back to the uploader (from an upload
 * URL POST) and isn't enumerable. Idempotent — an already-gone / never-finalized id is a no-op.
 */
export const removeBlob = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    await requireProfile(ctx)
    try {
      await ctx.storage.delete(storageId)
    } catch {
      // Already deleted, or an upload URL that was never finalized — nothing to reclaim.
    }
  },
})

/**
 * Resolve serving URLs (full + thumb) for a report's photos — what the report detail UI renders.
 *
 * **Visibility (D13/D42):** URL/coord resolution is gated on the *same* decision as the report
 * query — we serve only the photos referenced by a report the current viewer may see. A caller who
 * once held a photo id therefore can't keep reading media (or its GPS coord) after losing report
 * access; an unviewable or missing report yields `[]`.
 *
 * A URL is `null` if its stored file is missing (deleted/never-finalized), so callers must guard it
 * (never assume a serving URL). Missing photo rows are skipped.
 */
export const getUrls = query({
  args: { reportId: v.id('reports') },
  handler: async (ctx, { reportId }) => {
    const report = await getViewableReport(ctx, reportId)
    if (!report) return []
    const results: {
      photoId: Id<'photos'>
      url: string | null
      thumbUrl: string | null
      caption?: string
      coord?: { lat: number; lng: number }
      placeOnMap: boolean
    }[] = []
    for (const photoId of report.photoIds) {
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
