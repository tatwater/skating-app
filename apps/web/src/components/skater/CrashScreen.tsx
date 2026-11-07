import { RegionBackdrop } from './RegionBackdrop';
import { BACKDROP_FILL, CrashView } from './SystemScreens';

/**
 * "Something broke" (board 8.11): the root `errorComponent` and the `Sentry.ErrorBoundary`
 * fallback. Takes the boundary's reset; the error itself was reported by the boundary and is never
 * shown (a message can carry anything). Renders no Convex or Clerk hook, so it works above them.
 */
export function CrashScreen({
  onRetry,
  onReload = () => window.location.reload(),
}: {
  onRetry: () => void;
  onReload?: () => void;
}) {
  return (
    <CrashView
      backdrop={<RegionBackdrop className={BACKDROP_FILL} />}
      onRetry={onRetry}
      onReload={onReload}
    />
  );
}
