/**
 * Offline draft queue provider (F2) — owns the flush triggers and exposes the queue to the UI.
 *
 * Flush fires on **NetInfo reconnect + app-foreground + a manual "Sync now"** (NetInfo transitions
 * can be missed, so we don't rely on one signal), all funneling through the re-entrancy-guarded
 * `flushDrafts`. After any flush (or edit/delete) the drafts list is refreshed from sqlite so the
 * drafts screen + the tab badge stay live. The D12 "you have N pending reports" prompt reads
 * `pendingCount`. Untested native glue; the queue logic it drives is tested in `@skating/core`.
 */

import NetInfo from '@react-native-community/netinfo';
import {
  type HazardQueueItem,
  isFlushable,
  isHazardItemFlushable,
  type ReportDraft,
} from '@skating/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { deleteDraftPhotoFiles, draftPhotoUris } from '../lib/draftPhotos';
import {
  deleteDraft,
  deleteHazardItem,
  getDraft,
  getHazardItem,
  listDrafts,
  listHazardItems,
} from '../lib/draftStore';
import { flushDrafts, isDraftFlushing } from '../lib/flushService';

interface OfflineDraftsValue {
  drafts: ReportDraft[];
  /**
   * Queued on-ice hazards + confirmations (Phase 9). Surfaced alongside report drafts so one that
   * hits a permanent rejection on flush is *visible and dismissible* rather than parked in `error`
   * forever, invisible, after the skater was told "it'll post when you're back in signal".
   */
  hazardItems: HazardQueueItem[];
  /** Count still awaiting send (excludes done + permanent-error) — the tab badge / D12 prompt. */
  pendingCount: number;
  refresh: () => void;
  flushNow: () => Promise<void>;
  /** Delete a draft + its photo files. No-ops and returns `false` if the draft is mid-flush. */
  removeDraft: (id: string) => boolean;
  /** Delete a queued hazard/confirmation + any of its photo files. */
  removeHazardItem: (id: string) => void;
}

const OfflineDraftsContext = createContext<OfflineDraftsValue | null>(null);

export function OfflineDraftsProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<ReportDraft[]>([]);
  const [hazardItems, setHazardItems] = useState<HazardQueueItem[]>([]);

  const refresh = useCallback(() => {
    setDrafts(listDrafts());
    setHazardItems(listHazardItems());
  }, []);

  const flushNow = useCallback(async () => {
    await flushDrafts();
    refresh();
  }, [refresh]);

  const removeDraft = useCallback(
    (id: string) => {
      // Refuse to delete an in-flight draft — a concurrent flush may still be reading its photo
      // files to upload. Deleting the files mid-upload makes the upload fail transiently, which
      // re-inserts the draft as `pending` (a stub that retries forever, files now gone) and orphans
      // any already-uploaded blobs. Same guard the edit form uses (see `flushService` `flushingIds`).
      if (isDraftFlushing(id)) return false;
      const draft = getDraft(id);
      if (draft) deleteDraftPhotoFiles(draftPhotoUris(draft));
      deleteDraft(id);
      refresh();
      return true;
    },
    [refresh],
  );

  const removeHazardItem = useCallback(
    (id: string) => {
      // Free the persisted full+thumb files a queued hazard holds before dropping the row — a
      // confirmation carries none. There's no in-flight guard as report drafts have: a queued hazard
      // is immutable once captured, and the flush re-reads each item fresh, so a manual dismiss here
      // just makes the next flush skip it.
      const item = getHazardItem(id);
      if (item?.kind === 'hazard') {
        deleteDraftPhotoFiles(item.photos.flatMap((p) => [p.fullUri, p.thumbUri]));
      }
      deleteHazardItem(id);
      refresh();
    },
    [refresh],
  );

  // Load once, then flush on reconnect + foreground. `isInternetReachable` is `null` while unknown —
  // treat non-false as reachable so we don't stall on the initial null.
  useEffect(() => {
    refresh();
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) void flushNow();
    });
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void flushNow();
    });
    return () => {
      unsubscribeNet();
      appSub.remove();
    };
  }, [refresh, flushNow]);

  const value = useMemo(
    () => ({
      drafts,
      hazardItems,
      pendingCount:
        drafts.filter(isFlushable).length + hazardItems.filter(isHazardItemFlushable).length,
      refresh,
      flushNow,
      removeDraft,
      removeHazardItem,
    }),
    [drafts, hazardItems, refresh, flushNow, removeDraft, removeHazardItem],
  );

  return <OfflineDraftsContext.Provider value={value}>{children}</OfflineDraftsContext.Provider>;
}

export function useOfflineDrafts(): OfflineDraftsValue {
  const value = useContext(OfflineDraftsContext);
  if (!value) throw new Error('useOfflineDrafts must be used within an OfflineDraftsProvider');
  return value;
}
