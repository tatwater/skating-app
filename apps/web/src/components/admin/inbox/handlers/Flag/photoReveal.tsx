import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { ReactNode } from 'react';

import { isFailed, read, useConsoleReadSet } from '../../../reads/consoleReads';
import { PhotoRevealContext, type UsePhotoReveal } from './photoRevealContext';

/** The live reveal: `inbox.photoReveal` through the console's read layer, skipped until asked. */
export const useLivePhotoReveal: UsePhotoReveal = (photoId, asked) => {
  const { reads, retry, pending } = useConsoleReadSet({
    full: asked ? read(api.inbox.photoReveal, { photoId: photoId as Id<'photos'> }) : null,
  });
  if (!asked) return { kind: 'idle' };
  const full = reads.full;
  if (full === undefined) return { kind: 'loading' };
  if (isFailed(full)) return { kind: 'failed', retry, pending };
  return { kind: 'ready', url: full.url };
};

/** The handler's tree reads a photo's full image live, only on Show. */
export function LivePhotoReveal({ children }: { children: ReactNode }) {
  return (
    <PhotoRevealContext.Provider value={useLivePhotoReveal}>{children}</PhotoRevealContext.Provider>
  );
}
