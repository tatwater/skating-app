import { useRouter, useRouterState } from '@tanstack/react-router';

import { RegionBackdrop } from './RegionBackdrop';
import { BACKDROP_UNDER_TOP_BAR, NotFoundView } from './SystemScreens';

/**
 * The 404 (board 8.14), for the root route's `notFoundComponent`. Signed in, it renders inside the
 * skater shell — under the top bar, so every way out is where it always is — and the region runs
 * under the bar too, so the picture doesn't shift between screens. The address shown back is the
 * path alone: the query string can carry anything.
 */
export function NotFoundScreen() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <NotFoundView
      backdrop={<RegionBackdrop className={BACKDROP_UNDER_TOP_BAR} />}
      address={pathname}
      onBack={() => router.history.push('/')}
    />
  );
}
