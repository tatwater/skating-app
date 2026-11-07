import { create } from 'zustand';

/**
 * The shell's ephemeral chrome (§2.1): which top-bar overlay is open, the phone drawer's snap,
 * and the phone's Latest pane. Nothing persists — chrome state belongs to the moment.
 *
 * One overlay at a time is the invariant the shell builds Esc-handling on: Esc closes the
 * outermost open thing (§1's "one Esc per screen"), and "outermost" is only well-defined when
 * two overlays can't be open at once.
 */

export type ChromeOverlay = 'search' | 'notifications' | 'avatar';

export type PhoneDrawerSnap = 'half' | 'full';

/** The phone's Latest layout shows one column at a time (row 9). Agent L owns the final set. */
export type LatestPhonePane = 'feed' | 'filters' | 'wanted';

interface ChromeState {
  overlay: ChromeOverlay | null;
  phoneDrawerSnap: PhoneDrawerSnap;
  latestPhonePane: LatestPhonePane;
  /** Opens one overlay, closing whichever was open. `null` closes. */
  setOverlay: (overlay: ChromeOverlay | null) => void;
  /** The top-bar buttons toggle: pressing the open one closes it. */
  toggleOverlay: (overlay: ChromeOverlay) => void;
  setPhoneDrawerSnap: (snap: PhoneDrawerSnap) => void;
  setLatestPhonePane: (pane: LatestPhonePane) => void;
}

export const useChromeStore = create<ChromeState>()((set, get) => ({
  overlay: null,
  phoneDrawerSnap: 'half',
  latestPhonePane: 'feed',
  setOverlay: (overlay) => set({ overlay }),
  toggleOverlay: (overlay) => set({ overlay: get().overlay === overlay ? null : overlay }),
  setPhoneDrawerSnap: (phoneDrawerSnap) => set({ phoneDrawerSnap }),
  setLatestPhonePane: (latestPhonePane) => set({ latestPhonePane }),
}));
