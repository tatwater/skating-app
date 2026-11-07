import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { DEPTH_BAND_EDGES_FT } from './mapPalette';

/**
 * The depth legend (mock `chrome.js` `depthLegend`): the seven bands' swatches, each with its contour
 * color as an inset rim, over their lower edges in ft — the unit sits with the last figure
 * (Review 3). A depth band is data about the water, never a reading of the ice (D3, D82): the
 * legend says "Depth" and the numbers, and nothing else.
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

function DepthLegend({ className, ...props }: Omit<ComponentProps<'div'>, 'children'>) {
  const last = DEPTH_BAND_EDGES_FT.length - 1;
  return (
    <div
      role="img"
      aria-label={`Depth bands from ${DEPTH_BAND_EDGES_FT[0]} to ${DEPTH_BAND_EDGES_FT[last]} feet and deeper`}
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
        {BAND_CLASS.map((cls) => (
          <b key={cls} className={cn('h-[9px] w-[26px]', cls)} />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex gap-0.5 font-(family-name:--family-mono) text-[0.59375rem] leading-none font-medium text-fg2"
      >
        {DEPTH_BAND_EDGES_FT.map((edge, i) => (
          <span key={edge} className={i === last ? 'w-auto' : 'w-[26px]'}>
            {edge}
            {i === last && <span className="ml-[3px] text-fg3">ft</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

export { DepthLegend };
