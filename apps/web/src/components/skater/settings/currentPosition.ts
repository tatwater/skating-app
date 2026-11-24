/**
 * How long a location read may take, start to end, before it is given up: the browser's own
 * `timeout` (20 s) only starts once permission is given, so a permission prompt nobody answers
 * (Firefox's doorhanger, clicked away from) would otherwise leave the read pending forever.
 */
export const CURRENT_POSITION_GIVE_UP_MS = 30_000;

/**
 * The browser's position, once (Settings' home and the onboarding's Home step). Rejects when
 * there's no geolocation, it's refused, or nothing has answered within
 * `CURRENT_POSITION_GIVE_UP_MS` — a fix that arrives after that is dropped. Used only to set a
 * home, never kept as a position.
 */
export function currentPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unavailable'));
      return;
    }
    const giveUp = setTimeout(() => reject(new Error('timeout')), CURRENT_POSITION_GIVE_UP_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(giveUp);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (error) => {
        clearTimeout(giveUp);
        reject(error);
      },
      { maximumAge: 60_000, timeout: 20_000 },
    );
  });
}
