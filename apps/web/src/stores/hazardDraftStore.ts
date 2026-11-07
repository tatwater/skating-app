import type {
  HazardDraft as HazardShapeDraft,
  HazardType,
  LatLng,
  ShoreBandRefusal,
} from '@skating/core';
import { create } from 'zustand';
import { localStore, readJson, removeKey, writeJson } from './storage';

/**
 * The hazard flow's draft (§2.1) — what you saw → where (spot, line, area, shore) → size, photos
 * and note → confirm the nearby one (boards 3.1–3.8).
 *
 * Words and geometry persist to **owner-bound** localStorage so the draft survives a tab switch, a
 * reload, and the stack inside a report (board 5.10.1). Photos are `File` handles and cannot survive
 * a reload — they stay in memory, and the flow says so if a restore comes back wordy but photoless.
 *
 * Owner-binding follows `sheetStore`'s rule: a draft belongs to the account that wrote it, and a
 * different account on a shared browser must never see it restore. A draft also belongs to **one
 * lake**: opening the flow on another lake starts over rather than carrying a shape drawn on
 * Mascoma onto a pond in Maine.
 *
 * The geometry is `@skating/core`'s hazard draft, untouched — the same state machine mobile and the
 * old form use, so "what counts as a postable hazard" has one definition (`draftToShape`).
 */

/**
 * The flow is one screen that fills in as it goes (the boards' order): `what` until a type is
 * picked, `where` until something is placed, then `details`. `confirm` is the nearby-hazard nudge
 * (3.8), raised at Post when an open hazard of the same family already sits here.
 */
export type HazardFlowStep = 'what' | 'where' | 'details' | 'confirm';

/** How the skater is drawing it — the four "Draw it as" chips (3.2–3.6). */
export type HazardDrawKind = 'spot' | 'line' | 'area' | 'shore';

/**
 * The shore-following pick (3.6): up to two clicks near the shore, the band's half-width, and which
 * way round the lake ("Long way around" ↔ "Shortest distance"). The derived band itself lands in
 * `shape` as an ordinary polygon — snapping is an input convenience, not a stored relationship.
 */
export interface ShorePick {
  taps: LatLng[];
  halfWidthMeters: number;
  theOtherWay: boolean;
  /** Why the last derive was refused (an off-shore tap, two shorelines …), if it was. */
  refusal: ShoreBandRefusal | null;
  /** Meters of shoreline the band follows, once derived. */
  arcLengthMeters: number | null;
}

export interface HazardDraft {
  step: HazardFlowStep;
  /** The lake the draft was drawn on. A draft for another lake doesn't restore here. */
  waterBodyId: string | null;
  hazardType: HazardType | null;
  drawKind: HazardDrawKind | null;
  /** Core's draft geometry (`point_radius` · `line` · `polygon`), sizes included. */
  shape: HazardShapeDraft | null;
  /** Set only while `drawKind` is `shore`. */
  shore: ShorePick | null;
  /** True while the map is the input (a sub-mode; left by a click, never by Esc). */
  placing: boolean;
  note: string;
  /**
   * How many photos were attached when the draft was last written. The files themselves never
   * persist; the count is what lets a restored draft say how many didn't come back.
   */
  photoCount: number;
  /** The open hazard the nudge offered (3.8), while it's on screen. */
  nearbyHazardId: string | null;
  /**
   * The nearby hazard this skater said was a *different* one. Rides along to `hazards.create` so
   * auto-merge can't overrule a person who was looking at it (D80).
   */
  dismissedDuplicateOf: string | null;
  /** True when the flow is stacked inside the report sheet (board 5.10.1). */
  stackedInReport: boolean;
}

export const EMPTY_HAZARD_DRAFT: HazardDraft = {
  step: 'what',
  waterBodyId: null,
  hazardType: null,
  drawKind: null,
  shape: null,
  shore: null,
  placing: false,
  note: '',
  photoCount: 0,
  nearbyHazardId: null,
  dismissedDuplicateOf: null,
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
  /**
   * True once the skater layout has bound an owner (`useHazardDraftOwnerBinding`), signed out
   * included. The flow opens only after it, so it never opens — or restores — on a guess.
   */
  bound: boolean;
  /** `null` means no draft exists. */
  draft: HazardDraft | null;
  /**
   * True when `draft` came back from storage rather than being opened in this page's life — the
   * flow tells the skater their photos didn't come with it. Ends with the draft.
   */
  restored: boolean;
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
  if (!stored || stored.owner !== owner || !stored.draft || typeof stored.draft !== 'object') {
    return null;
  }
  // A restored draft is never mid-placement: the map it was listening to is gone, and coming back
  // to a map that silently eats the next click would be a trap. The nudge is asked again at Post.
  const draft = { ...EMPTY_HAZARD_DRAFT, ...stored.draft, placing: false, nearbyHazardId: null };
  return draft.step === 'confirm' ? { ...draft, step: 'details' } : draft;
}

export const useHazardDraftStore = create<HazardDraftState>()((set, get) => ({
  owner: null,
  bound: false,
  draft: null,
  restored: false,
  photoFiles: [],
  bindOwner: (owner) => {
    if (!get().bound) set({ bound: true });
    if (owner === get().owner) return;
    const restored = readPersistedDraft(localStore(), owner);
    if (restored === null && owner !== null) {
      // Someone else's stored draft (or a mangled one) must not outlive the account switch.
      const stored = readJson<PersistedHazardDraft>(localStore(), DRAFT_KEY);
      if (stored && stored.owner !== owner) removeKey(localStore(), DRAFT_KEY);
    }
    set({ owner, draft: restored, restored: restored !== null, photoFiles: [] });
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
  setPhotoFiles: (photoFiles) => {
    set({ photoFiles });
    get().updateDraft({ photoCount: photoFiles.length });
  },
  clearDraft: () => {
    set({ draft: null, restored: false, photoFiles: [] });
    removeKey(localStore(), DRAFT_KEY);
  },
}));
