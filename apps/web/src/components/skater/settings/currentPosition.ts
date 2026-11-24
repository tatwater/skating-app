/**
 * The browser's position, once (Settings' home and the onboarding's Home step). Rejects when
 * there's no geolocation or it's refused. Used only to set a home, never kept as a position.
 */
export function currentPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      { maximumAge: 60_000, timeout: 20_000 },
    );
  });
}
