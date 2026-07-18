/**
 * Reconnect flush for the offline draft queue (F2) — wires the pure `@skating/core` `flushDraft`
 * orchestration to the real effects (Convex mutations/queries + the storage upload + the sqlite
 * store). The hard logic (checkpointing, idempotency, transient-vs-permanent) lives in core; this is
 * the thin adapter. Untested native glue.
 */

import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  type DraftFlushEffects,
  flushableDrafts,
  flushDraft,
  isFlushable,
  type ReportInput,
} from '@skating/core'
import { uploadToStorage } from '../components/photoPipeline'
import { convex } from './convex'
import { deleteDraftPhotoFiles, draftPhotoUris } from './draftPhotos'
import { deleteDraft, getDraft, listDrafts, saveDraft } from './draftStore'

/** Map the core report input to `reports.create` args (branded Convex ids reapplied). */
function toCreateArgs(input: ReportInput & { idempotencyKey: string; photoIds: string[] }) {
  return {
    waterBodyId: input.waterBodyId as Id<'waterBodies'>,
    idempotencyKey: input.idempotencyKey,
    skateEndTime: input.skateEndTime,
    skateStartTime: input.skateStartTime,
    iceTypes: input.iceTypes,
    surfaceTags: input.surfaceTags,
    skateQuality: input.skateQuality,
    iceThickness: input.iceThickness,
    snowCoverCm: input.snowCoverCm,
    conditions: input.conditions,
    notes: input.notes,
    point: input.point,
    photoIds: input.photoIds as Id<'photos'>[],
  }
}

function effects(): DraftFlushEffects {
  return {
    resolveBody: async (coord) => {
      const res = await convex.query(api.waterBodies.resolveBodyForCoord, { coord })
      return res?.waterBodyId ?? null
    },
    uploadPhoto: async (uri) => {
      const url = await convex.mutation(api.photos.generateUploadUrl, {})
      return uploadToStorage(url, uri)
    },
    createPhotoRow: async ({ storageId, thumbStorageId, placeOnMap, coord }) =>
      convex.mutation(api.photos.create, {
        storageId: storageId as Id<'_storage'>,
        thumbStorageId: thumbStorageId as Id<'_storage'>,
        placeOnMap,
        coord,
      }),
    createReport: async (input) => convex.mutation(api.reports.create, toCreateArgs(input)),
    persist: async (draft) => {
      saveDraft(draft)
    },
  }
}

// A single in-flight flush at a time: reconnect + app-foreground + manual triggers can all fire, and
// the guard keeps them from double-sending (the report is idempotent, but this avoids wasted work).
let flushing = false

// Ids currently being flushed. The edit form checks this (`isDraftFlushing`) and refuses to save
// over an in-flight draft — otherwise an edit-during-flush would be clobbered by the flush's
// checkpoint writes and then deleted, silently losing the edit (idempotency would re-serve the
// pre-edit report). Set membership is mutated synchronously around each draft, so the check +
// synchronous `saveDraft` in `handleSaveDraft` can't interleave with a flush claiming the same id.
const flushingIds = new Set<string>()

/** Is this draft currently being flushed? The edit form blocks a save over an in-flight draft. */
export function isDraftFlushing(id: string | undefined): boolean {
  return id !== undefined && flushingIds.has(id)
}

/**
 * Flush every pending draft once, oldest first. Each draft that succeeds has its photo files deleted
 * and its row removed; a transient failure leaves it `pending` (retried next flush), a permanent one
 * parks it in `error` for the user — both persisted by `flushDraft` itself. Re-entrant calls no-op.
 *
 * Each draft is **re-read from sqlite immediately before flushing** (not taken from the initial batch
 * snapshot) and held under `flushingIds` for the duration, so an edit saved after the snapshot is
 * either picked up fresh here or blocked by `isDraftFlushing` in the form — never silently lost.
 */
export async function flushDrafts(now: number = Date.now()): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const eff = effects()
    for (const { id } of flushableDrafts(listDrafts())) {
      flushingIds.add(id)
      try {
        // Re-read the latest on-disk state — an edit between the snapshot and now must flush its
        // new content, not the stale snapshot.
        const fresh = getDraft(id)
        if (!fresh || !isFlushable(fresh)) continue
        const result = await flushDraft(fresh, eff, now)
        if (result.ok) {
          deleteDraftPhotoFiles(draftPhotoUris(result.draft))
          deleteDraft(result.draft.id)
        }
      } finally {
        flushingIds.delete(id)
      }
    }
  } finally {
    flushing = false
  }
}
