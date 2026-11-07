import { type BBox, type LngLat, ringsToPath, silhouetteProjection } from '@skating/core';

import { cn } from '@/lib/utils';

/**
 * A lake's shape, small (the In view list, 44 × 32): the outline only — never anyone's track or
 * put-in. The same projection and path functions as the report card's `BodySilhouette`
 * (`@skating/core`'s `bodySilhouette`), re-skinned to the skater tokens: the raised ground for the
 * water, the second ink for the shore, gray for an inactive body (Review 2).
 */
export function LakeSilhouette({
  rings,
  bbox,
  inactive = false,
  width = 44,
  height = 32,
  className,
}: {
  rings: readonly LngLat[][];
  bbox: BBox;
  inactive?: boolean;
  width?: number;
  height?: number;
  className?: string;
}) {
  const p = silhouetteProjection(bbox, width, height, 2);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      data-slot="lake-silhouette"
      data-inactive={inactive ? '' : undefined}
      className={cn('shrink-0', className)}
    >
      <path
        d={ringsToPath(rings as LngLat[][], p)}
        fillRule="evenodd"
        className={inactive ? 'fill-lift-05 stroke-fg3' : 'fill-raise stroke-fg2'}
        strokeWidth={0.8}
      />
    </svg>
  );
}
