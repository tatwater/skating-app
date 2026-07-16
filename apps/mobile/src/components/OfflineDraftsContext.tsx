/**
 * Offline draft queue provider (F2) — owns the flush triggers and exposes the queue to the UI.
 *
 * Flush fires on **NetInfo reconnect + app-foreground + a manual "Sync now"** (NetInfo transitions
 * can be missed, so we don't rely on one signal), all funneling through the re-entrancy-guarded
 * `flushDrafts`. After any flush (or edit/delete) the drafts list is refreshed from sqlite so the
 * drafts screen + the tab badge stay live. The D12 "you have N pending reports" prompt reads
 * `pendingCount`. Untested native glue; the queue logic it drives is tested in `@skating/core`.
 */

import NetInfo from '@react-native-community/netinfo'
import { isFlushable, type ReportDraft } from '@skating/core'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { AppState } from 'react-native'
import { deleteDraftPhotoFiles, draftPhotoUris } from '../lib/draftPhotos'
import { deleteDraft, getDraft, listDrafts } from '../lib/draftStore'
import { flushDrafts, isDraftFlushing } from '../lib/flushService'

interface OfflineDraftsValue {
  drafts: ReportDraft[]
  /** Count still awaiting send (excludes done + permanent-error) — the tab badge / D12 prompt. */
  pendingCount: number
  refresh: () => void
  flushNow: () => Promise<void>
  /** Delete a draft + its photo files. No-ops and returns `false` if the draft is mid-flush. */
  removeDraft: (id: string) => boolean
}

const OfflineDraftsContext = createContext<OfflineDraftsValue | null>(null)

export function OfflineDraftsProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<ReportDraft[]>([])

  const refresh = useCallback(() => {
    setDrafts(listDrafts())
  }, [])

  const flushNow = useCallback(async () => {
    await flushDrafts()
    refresh()
  }, [refresh])

  const removeDraft = useCallback(
    (id: string) => {
      // Refuse to delete an in-flight draft — a concurrent flush may still be reading its photo
      // files to upload. Deleting the files mid-upload makes the upload fail transiently, which
      // re-inserts the draft as `pending` (a stub that retries forever, files now gone) and orphans
      // any already-uploaded blobs. Same guard the edit form uses (see `flushService` `flushingIds`).
      if (isDraftFlushing(id)) return false
      const draft = getDraft(id)
      if (draft) deleteDraftPhotoFiles(draftPhotoUris(draft))
      deleteDraft(id)
      refresh()
      return true
    },
    [refresh],
  )

  // Load once, then flush on reconnect + foreground. `isInternetReachable` is `null` while unknown —
  // treat non-false as reachable so we don't stall on the initial null.
  useEffect(() => {
    refresh()
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) void flushNow()
    })
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void flushNow()
    })
    return () => {
      unsubscribeNet()
      appSub.remove()
    }
  }, [refresh, flushNow])

  const value = useMemo(
    () => ({
      drafts,
      pendingCount: drafts.filter(isFlushable).length,
      refresh,
      flushNow,
      removeDraft,
    }),
    [drafts, refresh, flushNow, removeDraft],
  )

  return <OfflineDraftsContext.Provider value={value}>{children}</OfflineDraftsContext.Provider>
}

export function useOfflineDrafts(): OfflineDraftsValue {
  const value = useContext(OfflineDraftsContext)
  if (!value) throw new Error('useOfflineDrafts must be used within an OfflineDraftsProvider')
  return value
}
