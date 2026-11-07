import type { HazardGeometryKind, HazardType } from '@skating/core';
import { create } from 'zustand';
import { localStore, readJson, removeKey, writeJson } from './storage';

/**
 * The hazard flow's draft (§2.1) — what you saw → where (spot, line, area, shore) → size, photos
 * and note → confirm the nearby one. Owned by agent J (Explore actions) from T3; this skeleton
 * fixes the shape and the persistence contract.
 *
 * Words and geometry persist to **owner-bound** localStorage so the draft survives a tab switch
 * and the stack inside a report (board 5.10.1). Photos are `File` handles and cannot survive a
 * reload — they stay in memory, and the flow says so if a restore comes back wordy but photoless.
 *
 * Owner-binding follows `sheetStore`'s rule: a draft belongs to the account that wrote it, and a
 * different account on a shared browser must never see it restore.
 */

export type HazardFlowStep = 'what' | 'where' | 'details' | 'confirm';

export interface HazardDraft {
  step: HazardFlowStep;
  hazardType: HazardType | null;
  geometryKind: HazardGeometryKind | null;
  /**
   * The drawn geometry, in whatever model the drawing tools produce — agent J narrows this type
   * with the flow build. Persisted verbatim.
   */
  geometry: unknown;
  sizeMeters: number | null;
  note: string;
  /** The chosen nearby-hazard candidate ("confirm the existing one"), when the flow offered one. */
  nearbyHazardId: string | null;
  /** True when the flow is stacked inside the report sheet (board 5.10.1). */
  stackedInReport: boolean;
}

export const EMPTY_HAZARD_DRAFT: HazardDraft = {
  step: 'what',
  hazardType: null,
  geometryKind: null,
  geometry: null,
  sizeMeters: null,
  note: '',
  nearbyHazardId: null,
  stackedInReport: false,
};

const DRAFT_KEY = 'gli-hazard-draft';

interface PersistedHazardDraft {
  owner: string;
  draft: HazardDraft;
}

interface HazardDraftState {
  /** The Clerk userId the draft belongs to; `null` until bound (page load, signed out). */
  owner: string | null;
  /** `null` means no flow is open. */
  draft: HazardDraft | null;
  /** In-memory only — a reload keeps the words, never the files. */
  photoFiles: File[];
  /**
   * Binds the draft to the signed-in account. A stored draft belonging to someone else is
   * discarded, storage included.
   */
  bindOwner: (owner: string | null) => void;
  /** Opens (or replaces) the flow's draft and persists it for the bound owner. */
  setDraft: (draft: HazardDraft) => void;
  /** Merges a partial update into the open draft. No-op when no draft is open. */
  updateDraft: (patch: Partial<HazardDraft>) => void;
  setPhotoFiles: (files: File[]) => void;
  /** Ends the flow: clears memory, photos and storage. */
  clearDraft: () => void;
}

/** Exported for tests: the restore rule — only the bound owner's draft comes back. */
export function readPersistedDraft(
  storage: Storage | undefined,
  owner: string | null,
): HazardDraft | null {
  if (owner === null) return null;
  const stored = readJson<PersistedHazardDraft>(storage, DRAFT_KEY);
  if (!stored || stored.owner !== owner || !stored.draft) return null;
  return { ...EMPTY_HAZARD_DRAFT, ...stored.draft };
}

export const useHazardDraftStore = create<HazardDraftState>()((set, get) => ({
  owner: null,
  draft: null,
  photoFiles: [],
  bindOwner: (owner) => {
    if (owner === get().owner) return;
    const restored = readPersistedDraft(localStore(), owner);
    if (restored === null && owner !== null) {
      // Someone else's stored draft (or a mangled one) must not outlive the account switch.
      const stored = readJson<PersistedHazardDraft>(localStore(), DRAFT_KEY);
      if (stored && stored.owner !== owner) removeKey(localStore(), DRAFT_KEY);
    }
    set({ owner, draft: restored, photoFiles: [] });
  },
  setDraft: (draft) => {
    set({ draft });
    const owner = get().owner;
    if (owner !== null) {
      const persisted: PersistedHazardDraft = { owner, draft };
      writeJson(localStore(), DRAFT_KEY, persisted);
    }
  },
  updateDraft: (patch) => {
    const current = get().draft;
    if (current === null) return;
    get().setDraft({ ...current, ...patch });
  },
  setPhotoFiles: (photoFiles) => set({ photoFiles }),
  clearDraft: () => {
    set({ draft: null, photoFiles: [] });
    removeKey(localStore(), DRAFT_KEY);
  },
}));
