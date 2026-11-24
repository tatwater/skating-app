/**
 * **One location read for a home, on either app** (B03 §9.6): the web's *Use my current location*
 * (the Home step and Settings' home) and the phone's Home step run their reads through this, so the
 * two can't differ in when a fix is taken or dropped.
 *
 * - **Each read is counted.** A fix (or a failure) is taken only by the newest read nobody has
 *   superseded: the skater typed an address, picked one, saved, skipped, moved on (`supersede`,
 *   `dispose`), or started another read. A late fix never replaces a home chosen since.
 * - **The busy state is bounded, the read is not.** After `LOCATE_GIVE_UP_MS` with no answer the
 *   button stops looking busy (`idle`), so it can always be pressed again — a permission prompt
 *   nobody answers would otherwise hold it for good. The read itself stays live: a prompt answered
 *   slowly still delivers its fix, as long as nothing superseded it in the meantime — except on a
 *   screen that asks for `dropAtGiveUp` (the phone's You tab, mounted all session, where a fix
 *   landing long after, with nothing on screen, could replace the home from somewhere else). There
 *   the give-up drops the read and says it `failed`, so the tab shows its couldn't-locate line.
 *
 * Plain timers over an injected read, so the rule is tested without a browser or a device.
 */

/** Where a location read stands, as the button shows it. */
export type LocateReadState = 'idle' | 'locating' | 'failed';

/**
 * How long a read may look busy before the button comes back: the browser's own `timeout` only
 * starts once permission is given, and a permission prompt (Firefox's doorhanger clicked away from,
 * a dialog left open) can wait forever.
 */
export const LOCATE_GIVE_UP_MS = 30_000;

export interface LocateReadDeps<T> {
  /** Reads the position once; rejects when there is none (refused, unavailable). */
  read: () => Promise<T>;
  onState: (state: LocateReadState) => void;
  /** The newest unsuperseded read's fix. */
  onFix: (fix: T) => void;
  giveUpMs?: number;
  /**
   * The give-up drops the read too, not just the busy state: it ends `failed`, and no fix or
   * failure is taken after it.
   */
  dropAtGiveUp?: boolean;
}

export interface LocateRead {
  /** A press of *Use my current location*: a new read, superseding any still out. */
  start(): void;
  /** The skater chose otherwise (typed, picked, saved, skipped): a read still out is dropped. */
  supersede(): void;
  /** The screen is gone: nothing is taken or said after this. */
  dispose(): void;
}

export function createLocateRead<T>({
  read,
  onState,
  onFix,
  giveUpMs = LOCATE_GIVE_UP_MS,
  dropAtGiveUp = false,
}: LocateReadDeps<T>): LocateRead {
  let state: LocateReadState = 'idle';
  let token = 0;
  let giveUp: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const set = (next: LocateReadState) => {
    if (next === state || disposed) return;
    state = next;
    onState(next);
  };
  const stopWaiting = () => {
    if (giveUp !== null) clearTimeout(giveUp);
    giveUp = null;
  };

  return {
    start() {
      if (disposed) return;
      const mine = ++token;
      stopWaiting();
      set('locating');
      // The busy state gives up: the read stays live, and its fix still counts if it is newest —
      // unless the screen asked for `dropAtGiveUp`, where the read is dropped and said as failed.
      giveUp = setTimeout(() => {
        giveUp = null;
        if (mine !== token || state !== 'locating') return;
        if (dropAtGiveUp) {
          token++;
          set('failed');
        } else set('idle');
      }, giveUpMs);
      Promise.resolve()
        .then(read)
        .then(
          (fix) => {
            if (mine !== token || disposed) return;
            stopWaiting();
            set('idle');
            onFix(fix);
          },
          () => {
            if (mine !== token || disposed) return;
            stopWaiting();
            set('failed');
          },
        );
    },
    supersede() {
      token++;
      stopWaiting();
      // A failure already said stays said; a read in progress just stops.
      if (state === 'locating') set('idle');
    },
    dispose() {
      token++;
      stopWaiting();
      disposed = true;
    },
  };
}
