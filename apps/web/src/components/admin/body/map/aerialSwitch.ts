import { useCallback, useState } from 'react';

/**
 * **The summer aerial's switch, remembered per viewer** — this browser only, in local storage, so
 * a moderator who places marks over the photograph finds it on again on the next body, the next tab
 * and the next visit. Every console staff member has it: anyone who can open the Body console.
 *
 * Storage can be missing, full, blocked or cleared (a private window, a policy, a preview): every
 * read and write is wrapped, a failure reads as off, and a write that fails still switches the
 * map for this page — it just isn't remembered.
 */

export const AERIAL_KEY = 'gli.admin.map.summerAerial';

/** What was stored, as the switch: `'on'` is on; anything else, or nothing, is off. */
export function readAerial(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(AERIAL_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Remember the switch; a failed write is dropped. */
export function writeAerial(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(AERIAL_KEY, 'on');
    else window.localStorage.removeItem(AERIAL_KEY);
  } catch {
    // Storage full or blocked: the map still switches, it just isn't remembered.
  }
}

/** The switch, read once when the map mounts and written on every change. */
export function useAerialSwitch(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readAerial);
  const set = useCallback((next: boolean) => {
    setOn(next);
    writeAerial(next);
  }, []);
  return [on, set];
}
