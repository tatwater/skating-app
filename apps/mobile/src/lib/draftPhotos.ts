/**
 * Persistent storage for offline draft photos (F2) — the `expo-file-system` glue. A captured photo
 * is processed (resized + EXIF-stripped) into the picker **cache**, which the OS can evict over the
 * days a draft may sit; so at capture we copy the stripped output into the app **document** dir and
 * store that persistent uri in the draft. Untested native glue (like `photoPipeline`).
 */

import type { DraftPhoto, ReportDraft } from '@skating/core'
import { Directory, File, Paths } from 'expo-file-system'

const DRAFTS_DIRNAME = 'report-drafts'

function draftsDir(): Directory {
  const dir = new Directory(Paths.document, DRAFTS_DIRNAME)
  if (!dir.exists) dir.create({ idempotent: true })
  return dir
}

/**
 * Copy a stripped photo out of the evictable cache into persistent draft storage; returns the new
 * `file://` uri. `filename` is caller-unique (draft + photo id + full/thumb) so two drafts never
 * collide. Overwrites an existing file so a re-save of the same draft photo is idempotent.
 */
export async function persistDraftPhoto(sourceUri: string, filename: string): Promise<string> {
  const dest = new File(draftsDir(), filename)
  if (dest.exists) dest.delete()
  await new File(sourceUri).copy(dest)
  return dest.uri
}

/** Every persistent photo file a draft owns (full + thumb per photo) — for cleanup on flush/delete. */
export function draftPhotoUris(draft: ReportDraft): string[] {
  return draft.photos.flatMap((p) => [p.fullUri, p.thumbUri])
}

/** Delete a draft's persisted photo files (best-effort — a stale file must never block the queue). */
export function deleteDraftPhotoFiles(uris: readonly string[]): void {
  for (const uri of uris) {
    try {
      const f = new File(uri)
      if (f.exists) f.delete()
    } catch {
      // best-effort
    }
  }
}

/** True once a draft photo's stripped files live in the persistent drafts dir (not the picker cache). */
export function isPersisted(photo: DraftPhoto): boolean {
  return photo.fullUri.includes(DRAFTS_DIRNAME)
}
