import { DEPTH_BAND_EDGES_FT } from '@skating/core';
import type { ComponentProps } from 'react';
import { bandRangeLabel, type LegendBand } from '@/lib/depthBands';
import { cn } from '@/lib/utils';

/**
 * The depth legend (mock `chrome.js` `depthLegend`): the seven bands' swatches, each with its contour
 * color as an inset rim, over their lower edges in ft — the unit sits with the last figure
 * (Review 3). A depth band is data about the water, never a reading of the ice (D3, D82): the
 * legend says "Depth" and the numbers, and nothing else.
 *
 * Over a lake with filled bands it shows that lake's bands and their real depths — the contours that
 * bound each band there, not the ramp's nominal edges (founder, 2026-11-07). A lake contoured every
 * 10 ft has no 5–10 ft band, so its swatches skip one and its shore band reads 0–10 ft. Each swatch
 * keeps its `bandIndex` color: the band is never colored deeper than its shallowest water.
 */

/** The token class per band — spelled out so Tailwind sees every one. */
const BAND_CLASS = [
  'bg-depth-0 shadow-[inset_0_0_0_1px_var(--depth-0-line)]',
  'bg-depth-1 shadow-[inset_0_0_0_1px_var(--depth-1-line)]',
  'bg-depth-2 shadow-[inset_0_0_0_1px_var(--depth-2-line)]',
  'bg-depth-3 shadow-[inset_0_0_0_1px_var(--depth-3-line)]',
  'bg-depth-4 shadow-[inset_0_0_0_1px_var(--depth-4-line)]',
  'bg-depth-5 shadow-[inset_0_0_0_1px_var(--depth-5-line)]',
  'bg-depth-6 shadow-[inset_0_0_0_1px_var(--depth-6-line)]',
] as const;

/** One swatch: its band's color, the depth printed under it, and its range in words. */
interface Swatch {
  band: number;
  figure: string;
  title?: string;
}

/** The ramp itself: the seven bands over their nominal lower edges (what the lines are colored by). */
const RAMP: readonly Swatch[] = DEPTH_BAND_EDGES_FT.map((edge, band) => ({
  band,
  figure: String(edge),
}));
const RAMP_LABEL = `Depth bands from ${DEPTH_BAND_EDGES_FT[0]} to ${DEPTH_BAND_EDGES_FT.at(-1)} feet and deeper`;

function lakeSwatches(bands: readonly LegendBand[]): Swatch[] {
  return bands.map((b) => ({
    band: Math.min(Math.max(b.bandIndex, 0), BAND_CLASS.length - 1),
    figure: b.maxDepthFt === undefined ? `${b.minDepthFt}+` : String(b.minDepthFt),
    title: bandRangeLabel(b),
  }));
}

function DepthLegend({
  bands = [],
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & { bands?: readonly LegendBand[] }) {
  const swatches = bands.length > 0 ? lakeSwatches(bands) : RAMP;
  const last = swatches.length - 1;
  const label =
    bands.length > 0 ? `Depth bands: ${bands.map(bandRangeLabel).join(', ')}` : RAMP_LABEL;
  return (
    <div
      role="img"
      aria-label={label}
      data-slot="depth-legend"
      className={cn(
        'flex w-max flex-col gap-[7px] border border-solid border-line bg-plate px-3 py-2.5',
        className,
      )}
      {...props}
    >
      <span className="text-[0.625rem] leading-none font-medium tracking-kick text-fg3 uppercase">
        Depth
      </span>
      <div aria-hidden="true" className="flex gap-0.5">
        {swatches.map((s) => (
          <b
            key={s.band}
            data-band={s.band}
            title={s.title}
            className={cn('h-[9px] w-[26px]', BAND_CLASS[s.band])}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex gap-0.5 font-(family-name:--family-mono) text-[0.59375rem] leading-none font-medium text-fg2"
      >
        {swatches.map((s, i) => (
          <span key={s.band} className={i === last ? 'w-auto' : 'w-[26px]'}>
            {s.figure}
            {i === last && <span className="ml-[3px] text-fg3">ft</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

export { DepthLegend };
