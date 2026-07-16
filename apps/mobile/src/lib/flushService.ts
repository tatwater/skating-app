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
  type ReportInput,
} from '@skating/core'
import { uploadToStorage } from '../components/photoPipeline'
import { convex } from './convex'
import { deleteDraftPhotoFiles, draftPhotoUris } from './draftPhotos'
import { deleteDraft, listDrafts, saveDraft } from './draftStore'

/** Map the core report input to `reports.create` args (branded Convex ids reapplied). */
function toCreateArgs(input: ReportInput & { idempotencyKey: string; photoIds: string[] }) {
  return {
    waterBodyId: input.waterBodyId as Id<'waterBodies'>,
    idempotencyKey: input.idempotencyKey,
    skateTime: input.skateTime,
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

/**
 * Flush every pending draft once, oldest first. Each draft that succeeds has its photo files deleted
 * and its row removed; a transient failure leaves it `pending` (retried next flush), a permanent one
 * parks it in `error` for the user — both persisted by `flushDraft` itself. Re-entrant calls no-op.
 */
export async function flushDrafts(now: number = Date.now()): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const eff = effects()
    for (const draft of flushableDrafts(listDrafts())) {
      const result = await flushDraft(draft, eff, now)
      if (result.ok) {
        deleteDraftPhotoFiles(draftPhotoUris(result.draft))
        deleteDraft(result.draft.id)
      }
    }
  } finally {
    flushing = false
  }
}
