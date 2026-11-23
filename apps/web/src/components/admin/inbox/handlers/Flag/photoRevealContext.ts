import { createContext } from 'react';

/**
 * **The full photo, fetched only on *Show the photo*** (board 2.7, B01-5e). The item serves the
 * thumbnail alone; the full image's address comes from `inbox.photoReveal` (staff-only: `inbox.read`
 * and `content.read`), asked only once the moderator chooses to look — so before then it is in
 * neither the page's markup nor its data.
 *
 * The reveal is a hook handed down by context: the handler's tree reads it live (`LivePhotoReveal`,
 * `photoReveal.tsx`); a story hands a fixture's ({@link fixtureReveal}); with neither, the stage
 * reveals nothing past the thumbnail. This module takes no Convex, so fixtures can import it.
 */

export type RevealState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; url: string | null }
  | { kind: 'failed'; retry: () => void; pending: boolean };

/** Asks for `photoId`'s full image while `asked`; idle otherwise. Called as a hook. */
export type UsePhotoReveal = (photoId: string, asked: boolean) => RevealState;

const useNoReveal: UsePhotoReveal = (_photoId, asked) =>
  asked ? { kind: 'ready', url: null } : { kind: 'idle' };

export const PhotoRevealContext = createContext<UsePhotoReveal>(useNoReveal);

/** A story's or a test's reveal: each photo's full address from `urls`, answered at once. */
export function fixtureReveal(urls: Readonly<Record<string, string>>): UsePhotoReveal {
  return (photoId, asked) =>
    asked ? { kind: 'ready', url: urls[photoId] ?? null } : { kind: 'idle' };
}
