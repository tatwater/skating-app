import { getShareExtensionKey } from 'expo-share-intent';

/**
 * iOS: the Share Extension (A10-8 §8.7) reopens the app at `skating://dataUrl=skatingShareKey`,
 * which is not a route. It goes to the root, and `ShareIntentHandler` reads the share from the
 * native module and asks where it lands. Every other link passes through untouched. (Android hands
 * a share over as an intent, not a link, and never comes through here.)
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/';
  } catch {
    // An unreadable scheme is not a share.
  }
  return path;
}
