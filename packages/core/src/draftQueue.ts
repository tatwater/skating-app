/**
 * Offline draft-queue logic (F2/D30) — the pure, testable heart of the mobile offline report queue.
 *
 * The mobile app persists a **list** of captured-but-unsent report drafts (a day of offline
 * lake-hopping) in `expo-sqlite`, with photo files in `expo-file-system`, and flushes them on
 * reconnect. All the *I/O* is native + impure (sqlite, file reads, `fetch` uploads, Convex
 * mutations); everything *decision-shaped* lives here so it's unit-testable in isolation and shares
 * one contract with the eventual Phase 9 hazard-capture queue:
 *   - the draft record shape + status machine (`pending → uploading → creating → done | error`),
 *   - **idempotent, checkpointed** flush orchestration (`flushDraft`) — each photo's `storageId` /
 *     `photoId` is persisted the instant it lands, so a lost-ack retry *resumes* (reusing uploaded
 *     objects, sending the same `photoIds`) instead of re-uploading and orphaning blobs; the report
 *     itself dedupes on `idempotencyKey` server-side,
 *   - transient-vs-permanent failure classification, so a dropped connection auto-retries while a
 *     server rejection (validation, a removed lake, a coord that matches no lake) parks the draft in
 *     `error` for the user instead of looping forever.
 *
 * All external effects are injected (`DraftFlushEffects`), so tests drive the whole orchestration
 * with fakes. Ids are opaque strings here (framework-free); the mobile layer casts to Convex `Id`s.
 */

import type { LatLng } from './geometry'
import { photoUploadCoord } from './photo'
import { type ReportInput, validateReportInput } from './report'
import { buildReportInput, type ReportFormState } from './reportForm'

/**
 * A captured photo inside a draft. `fullUri`/`thumbUri` are **persistent** file-system paths (the
 * already-optimized + EXIF-stripped output copied out of the picker cache at capture, so it survives
 * OS eviction over the days a draft may sit). The `*StorageId` / `photoId` fields are **flush
 * checkpoints** — written back as each upload / row-create lands so a retry never repeats them.
 */
export interface DraftPhoto {
  id: string
  fullUri: string
  thumbUri: string
  /** EXIF GPS if the original carried it — only ever *sent* on the `placeOnMap` opt-in (D42). */
  coord?: LatLng
  placeOnMap: boolean
  fullStorageId?: string
  thumbStorageId?: string
  photoId?: string
}

/**
 * Persisted status. `uploading`/`creating` are in-flight markers; a draft found in one at launch
 * (app killed mid-flush) is treated as resumable (`isFlushable`) — its checkpoints make the resume
 * cheap. `error` is a *permanent* failure needing the user; a transient failure resets to `pending`.
 */
export type DraftStatus = 'pending' | 'uploading' | 'creating' | 'done' | 'error'

/** A queued offline report draft. Fully serialized + reopenable, so the report form can hydrate it
 *  for offline editing and the flush can rebuild the report input — one source of truth for both. */
export interface ReportDraft {
  id: string
  /** Client-generated at capture, carried across every flush retry (server dedup, F2/D30). */
  idempotencyKey: string
  status: DraftStatus
  /** Set when `status === 'error'` — the permanent reason, surfaced in the drafts list. */
  errorMessage?: string
  /** Resolved locally at capture (Layer-2 body cache); absent ⇒ coord-only, resolved at flush. */
  waterBodyId?: string
  /** For the drafts-list label when the lake is known. */
  bodyName?: string
  /** Device GPS at capture — resolves the lake at flush when `waterBodyId` is absent. */
  coord?: LatLng
  /** Optional put-in pin (offline this defaults to the capture location, D42/S1). */
  putInPin?: LatLng
  form: ReportFormState
  photos: DraftPhoto[]
  createdAt: number
  updatedAt: number
}

/** Build a fresh draft. `id` + `idempotencyKey` are injected (the mobile layer mints UUIDs). */
export function createDraft(args: {
  id: string
  idempotencyKey: string
  now: number
  form: ReportFormState
  waterBodyId?: string
  bodyName?: string
  coord?: LatLng
  putInPin?: LatLng
  photos?: DraftPhoto[]
}): ReportDraft {
  return {
    id: args.id,
    idempotencyKey: args.idempotencyKey,
    status: 'pending',
    waterBodyId: args.waterBodyId,
    bodyName: args.bodyName,
    coord: args.coord,
    putInPin: args.putInPin,
    form: args.form,
    photos: args.photos ?? [],
    createdAt: args.now,
    updatedAt: args.now,
  }
}

/** A draft still needs sending unless it's already `done` or parked in a permanent `error`. */
export function isFlushable(draft: ReportDraft): boolean {
  return draft.status !== 'done' && draft.status !== 'error'
}

/** The flushable subset of a queue, oldest first (capture order) — the reconnect-flush work list. */
export function flushableDrafts(drafts: readonly ReportDraft[]): ReportDraft[] {
  return drafts.filter(isFlushable).sort((a, b) => a.createdAt - b.createdAt)
}

export type FlushErrorKind = 'transient' | 'permanent'

/**
 * Marker for a failure the queue must NOT auto-retry (it won't self-resolve).
 *
 * Exported so the hazard queue raises the *same* marker rather than a parallel one — a second class
 * would be classified `transient` by `classifyFlushError` and retried forever.
 */
export class PermanentFlushError extends Error {
  readonly permanent = true
  constructor(message: string) {
    super(message)
    this.name = 'PermanentFlushError'
  }
}

/**
 * Classify a flush failure. A **permanent** failure won't fix itself on retry — our own
 * `PermanentFlushError` (invalid draft / unresolvable lake), or any `ConvexError` (server-side
 * validation, a removed lake, an idempotency-key conflict), duck-typed by name to avoid a
 * `convex/values` dependency in framework-free core. Everything else (network, `fetch`, timeout) is
 * **transient** — the reconnect flush will try again.
 */
export function classifyFlushError(error: unknown): FlushErrorKind {
  if (error instanceof PermanentFlushError) return 'permanent'
  if (error instanceof Error && error.name === 'ConvexError') return 'permanent'
  return 'transient'
}

/** External effects the flush needs, all injected so the orchestration is testable with fakes. */
export interface DraftFlushEffects {
  /** Resolve a coord-only draft to a lake (`waterBodies.resolveBodyForCoord`); null ⇒ no match. */
  resolveBody(coord: LatLng): Promise<string | null>
  /** Upload one local file to storage (`photos.generateUploadUrl` → POST); returns its storageId. */
  uploadPhoto(localUri: string): Promise<string>
  /** Create the photo row (`photos.create`); returns its photoId. */
  createPhotoRow(input: {
    storageId: string
    thumbStorageId: string
    placeOnMap: boolean
    coord?: LatLng
  }): Promise<string>
  /** Create the report (`reports.create`, idempotent on `idempotencyKey`); returns its reportId. */
  createReport(
    input: ReportInput & { waterBodyId: string; idempotencyKey: string; photoIds: string[] },
  ): Promise<string>
  /** Persist the (checkpointed) draft back to sqlite — called after every state advance. */
  persist(draft: ReportDraft): Promise<void>
}

export type FlushResult =
  | { ok: true; draft: ReportDraft; reportId: string }
  | { ok: false; draft: ReportDraft; kind: FlushErrorKind; message: string }

function replacePhoto(photos: readonly DraftPhoto[], updated: DraftPhoto): DraftPhoto[] {
  return photos.map((p) => (p.id === updated.id ? updated : p))
}

/**
 * Flush one draft: resolve its lake → validate → upload photos (checkpointing each id) → create the
 * report (idempotent). Persists after every advance, so an interruption anywhere leaves a resumable
 * draft — a re-flush skips already-uploaded photos and the server dedupes the report on its key.
 * Never throws: a failure is classified and the draft parked (`error` = permanent / `pending` =
 * transient-retry) via `persist`, and returned in the result.
 */
export async function flushDraft(
  draft: ReportDraft,
  effects: DraftFlushEffects,
  now: number,
): Promise<FlushResult> {
  let d = draft
  const save = async (patch: Partial<ReportDraft>): Promise<void> => {
    d = { ...d, ...patch, updatedAt: now }
    await effects.persist(d)
  }

  try {
    await save({ status: 'uploading', errorMessage: undefined })

    // 1. Resolve the lake — local id from capture, else the coord at flush time.
    let waterBodyId = d.waterBodyId
    if (waterBodyId === undefined) {
      if (d.coord === undefined) {
        throw new PermanentFlushError('This draft has no lake and no location to find one.')
      }
      const resolved = await effects.resolveBody(d.coord)
      if (resolved === null) {
        throw new PermanentFlushError(
          "Couldn't match your location to a known lake — open the draft to pick one.",
        )
      }
      waterBodyId = resolved
      await save({ waterBodyId })
    }

    // 2. Rebuild + re-validate the report input (a permanently-invalid draft fails before uploads).
    const input = buildReportInput(d.form, waterBodyId, d.putInPin)
    const validation = validateReportInput(input, { now })
    if (!validation.ok) {
      throw new PermanentFlushError(
        validation.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
      )
    }

    // 3. Upload photos, checkpointing each storageId / photoId the instant it lands (so a partial
    //    failure keeps what uploaded and a retry reuses it — the durable form of web's in-memory
    //    recording). A photo with a `photoId` is already fully done from a prior attempt.
    const photoIds: string[] = []
    for (const original of d.photos) {
      let p = original
      if (p.photoId === undefined) {
        let fullStorageId = p.fullStorageId
        if (fullStorageId === undefined) {
          fullStorageId = await effects.uploadPhoto(p.fullUri)
          p = { ...p, fullStorageId }
          await save({ photos: replacePhoto(d.photos, p) })
        }
        let thumbStorageId = p.thumbStorageId
        if (thumbStorageId === undefined) {
          thumbStorageId = await effects.uploadPhoto(p.thumbUri)
          p = { ...p, thumbStorageId }
          await save({ photos: replacePhoto(d.photos, p) })
        }
        const photoId = await effects.createPhotoRow({
          storageId: fullStorageId,
          thumbStorageId,
          placeOnMap: p.placeOnMap,
          coord: photoUploadCoord(p.placeOnMap, p.coord),
        })
        p = { ...p, photoId }
        await save({ photos: replacePhoto(d.photos, p) })
        photoIds.push(photoId)
      } else {
        photoIds.push(p.photoId)
      }
    }

    // 4. Create the report — idempotent on the draft's key, so a lost-ack retry returns the same one.
    await save({ status: 'creating' })
    const reportId = await effects.createReport({
      ...input,
      waterBodyId,
      idempotencyKey: d.idempotencyKey,
      photoIds,
    })
    await save({ status: 'done' })
    return { ok: true, draft: d, reportId }
  } catch (error) {
    const kind = classifyFlushError(error)
    const message = error instanceof Error ? error.message : String(error)
    // Permanent → park in `error` for the user; transient → back to `pending` for the next flush.
    await save({
      status: kind === 'permanent' ? 'error' : 'pending',
      errorMessage: kind === 'permanent' ? message : undefined,
    })
    return { ok: false, draft: d, kind, message }
  }
}
