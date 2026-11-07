import { create } from 'zustand';
import { localStore, readJson, removeKey, writeJson } from './storage';

/**
 * Global search (§2.1): open state (so `/` opens it from any page) and the recent picks. The
 * query text itself is component state and the results are Convex — neither belongs here.
 *
 * Recents persist **owner-bound**, like `sheetStore`: on a shared browser, one account's search
 * history (which lakes, which people) must never surface for the next account.
 */

export type RecentPickKind = 'water_body' | 'sub_area' | 'skater';

export interface RecentPick {
  kind: RecentPickKind;
  id: string;
}

export const MAX_RECENT_PICKS = 6;

const RECENTS_KEY = 'gli-search-recents';

interface PersistedRecents {
  owner: string;
  recents: RecentPick[];
}

interface SearchState {
  open: boolean;
  owner: string | null;
  recents: RecentPick[];
  setOpen: (open: boolean) => void;
  /** Binds recents to the signed-in account; someone else's stored recents are discarded. */
  bindOwner: (owner: string | null) => void;
  /** Records a pick: deduplicated, newest first, capped at {@link MAX_RECENT_PICKS}. */
  addRecent: (pick: RecentPick) => void;
  clearRecents: () => void;
}

/** Exported for tests: only the bound owner's recents restore. */
export function readPersistedRecents(
  storage: Storage | undefined,
  owner: string | null,
): RecentPick[] {
  if (owner === null) return [];
  const stored = readJson<PersistedRecents>(storage, RECENTS_KEY);
  if (!stored || stored.owner !== owner || !Array.isArray(stored.recents)) return [];
  return stored.recents.slice(0, MAX_RECENT_PICKS);
}

export const useSearchStore = create<SearchState>()((set, get) => ({
  open: false,
  owner: null,
  recents: [],
  setOpen: (open) => set({ open }),
  bindOwner: (owner) => {
    if (owner === get().owner) return;
    const restored = readPersistedRecents(localStore(), owner);
    if (restored.length === 0) {
      const stored = readJson<PersistedRecents>(localStore(), RECENTS_KEY);
      if (stored && stored.owner !== owner) removeKey(localStore(), RECENTS_KEY);
    }
    set({ owner, recents: restored });
  },
  addRecent: (pick) => {
    const without = get().recents.filter((r) => !(r.kind === pick.kind && r.id === pick.id));
    const recents = [pick, ...without].slice(0, MAX_RECENT_PICKS);
    set({ recents });
    const owner = get().owner;
    if (owner !== null) {
      const persisted: PersistedRecents = { owner, recents };
      writeJson(localStore(), RECENTS_KEY, persisted);
    }
  },
  clearRecents: () => {
    set({ recents: [] });
    removeKey(localStore(), RECENTS_KEY);
  },
}));
