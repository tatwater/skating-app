import { RegionBackdrop } from './RegionBackdrop';
import { BACKDROP_FILL, OfflinePlate, OfflineView } from './SystemScreens';

/**
 * The offline states (boards 8.12, 8.13 and 8.17). `OfflineScreen` is the first load that never
 * reached the server; `OfflinePlate` is the plate over a page that was working a moment ago (the
 * page stays). Both render from `useConnection` through `OfflineBoundary`; neither reports anything.
 */
export function OfflineScreen({
  lastTriedAt,
  onRetry,
}: {
  lastTriedAt: number | null;
  onRetry: () => void;
}) {
  return (
    <OfflineView
      backdrop={<RegionBackdrop className={BACKDROP_FILL} />}
      lastTriedAt={lastTriedAt}
      onRetry={onRetry}
    />
  );
}

export { OfflinePlate };
