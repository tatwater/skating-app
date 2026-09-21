import {
  lineToPath,
  NEAR_SHORE_STROKE_PX,
  ringsToPath,
  ringToPath,
  type SilhouetteData,
  sectorHighlightPath,
  silhouetteProjection,
} from '@skating/core';
import { useId } from 'react';

/**
 * The lake as a still image (A10 §12.3) — the web half; `apps/mobile/src/components/BodySilhouette`
 * draws the same paths with `react-native-svg`. Outline in the border color over the muted
 * surface, the chips' `where` as a soft primary wash clipped to the water, the skate as a line,
 * the put-in as a dot. Not a map: no tiles, no zoom, no tap of its own. Colors come from the theme
 * variables so it follows light and dark like everything else.
 */
export function BodySilhouette({
  data,
  size = 64,
  className,
}: {
  data: SilhouetteData;
  size?: number;
  className?: string;
}) {
  const clipId = useId();
  const p = silhouetteProjection(data.bbox, size, size, 3);
  const outline = ringsToPath(data.rings, p);
  const highlight = data.sector ? sectorHighlightPath(data, data.sector, p) : null;
  const nearShore = data.sector === 'near_shore';
  const path = data.path ? lineToPath(data.path, p) : '';
  const putIn = data.putIn ? p.toXY([data.putIn.lng, data.putIn.lat]) : null;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Where on the lake"
      className={className}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={outline} clipRule="evenodd" />
        </clipPath>
      </defs>
      <path d={outline} fill="var(--surface-muted)" fillRule="evenodd" />
      <g clipPath={`url(#${clipId})`}>
        {data.bayRing ? (
          <path d={ringToPath(data.bayRing, p)} fill="var(--primary)" fillOpacity={0.14} />
        ) : null}
        {highlight ? <path d={highlight} fill="var(--primary)" fillOpacity={0.22} /> : null}
        {nearShore ? (
          <path
            d={outline}
            fill="none"
            stroke="var(--primary)"
            strokeOpacity={0.22}
            strokeWidth={NEAR_SHORE_STROKE_PX}
          />
        ) : null}
        {path ? (
          <path
            d={path}
            fill="none"
            stroke="var(--foreground)"
            strokeOpacity={0.55}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>
      <path d={outline} fill="none" stroke="var(--border-strong)" strokeWidth={1} />
      {putIn ? (
        <circle
          cx={putIn[0]}
          cy={putIn[1]}
          r={2.5}
          fill="var(--primary)"
          stroke="var(--surface)"
          strokeWidth={1}
        />
      ) : null}
    </svg>
  );
}
