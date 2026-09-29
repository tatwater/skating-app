/**
 * What the phone's photo library lets the sheet do (A10-8 §8.4, D207): pure, given the permission
 * the platform reports. The sheet reads the permission's state **without asking**, and a prompt
 * only ever comes from a tap — opening a report must never stop on "which photos may Gli see?".
 *
 * Android reads no library at all (Google Play's media policy): its door is the system photo
 * picker, which needs no permission and already shows the person's Google Photos. So there the
 * answer is always `none`, whatever a stale grant from an older build says.
 */

/** The permission as `expo-media-library` reports it — only the fields the answer reads. */
export interface LibraryPermission {
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
  /** iOS 14+ (and Android 14+): the whole library, or only the photos the person chose. */
  accessPrivileges?: 'all' | 'limited' | 'none';
}

/**
 * - `all` / `limited` — the reel and the grid can read; `limited` also offers *Choose more*.
 * - `ask` — not asked yet (or asked, declined, and askable again): a button whose tap is the prompt.
 * - `settings` — declined for good; only the system's Settings can change it.
 * - `none` — this platform never reads the library.
 */
export type LibraryAccess = 'all' | 'limited' | 'ask' | 'settings' | 'none';

/** The platforms whose library the sheet reads (D207). */
export function readsPhotoLibrary(platform: string): boolean {
  return platform === 'ios';
}

export function libraryAccess(platform: string, permission: LibraryPermission): LibraryAccess {
  if (!readsPhotoLibrary(platform)) return 'none';
  if (permission.status === 'granted') {
    return permission.accessPrivileges === 'limited' ? 'limited' : 'all';
  }
  if (permission.status === 'undetermined' || permission.canAskAgain) return 'ask';
  return 'settings';
}

/** Can the library be read right now, without a prompt? */
export function canReadLibrary(access: LibraryAccess): boolean {
  return access === 'all' || access === 'limited';
}
