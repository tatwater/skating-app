import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import type { HazardTone } from './mapDerive';

/**
 * The public app's point marks (Review 2): 14–16 px, each with a 2 px halo in the map's ground color
 * (`--map-ground`), so it lifts off the basemap and the depth fill alike. Mock `chrome.js` `putIn`
 * and `hazardMark`. Drawn on a box centered on the point, so a parent places the point, not a corner.
 */

/** The box every mark draws in, centered on its point: room for the selection brackets. */
export const MARK_BOX = 34;
const H = MARK_BOX / 2;

type MarkSvgProps = Omit<ComponentProps<'svg'>, 'children' | 'viewBox'>;

/** A put-in: an ice square with a dot — 14 px, 16 px when it is the one being talked about. */
function PutInMark({ big = false, className, ...props }: MarkSvgProps & { big?: boolean }) {
  const r = big ? 8 : 7;
  return (
    <svg
      aria-hidden="true"
      data-slot="put-in-mark"
      width={MARK_BOX}
      height={MARK_BOX}
      viewBox={`${-H} ${-H} ${MARK_BOX} ${MARK_BOX}`}
      className={cn('block overflow-visible', className)}
      {...props}
    >
      <rect
        x={-r - 2}
        y={-r - 2}
        width={2 * r + 4}
        height={2 * r + 4}
        className="fill-(--map-ground)"
      />
      <rect x={-r} y={-r} width={2 * r} height={2 * r} className="fill-acc" />
      <circle r={r * 0.36} className="fill-bg" />
    </svg>
  );
}

const TONE_FILL: Record<HazardTone, string> = {
  danger: 'fill-bad',
  healing: 'fill-warn',
  passage: 'fill-acc',
};

/**
 * A hazard: a 16 px square with a triangle (a suggested crossing gets two bars instead — it is a
 * route somebody reported, not a warning). `selected` adds the brackets; `dim` recedes it behind a
 * hazard that is chosen — never below half, so a receded hazard still reads as one (D3).
 */
function HazardMark({
  tone = 'danger',
  selected = false,
  dim = false,
  className,
  ...props
}: MarkSvgProps & { tone?: HazardTone; selected?: boolean; dim?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      data-slot="hazard-mark"
      data-tone={tone}
      width={MARK_BOX}
      height={MARK_BOX}
      viewBox={`${-H} ${-H} ${MARK_BOX} ${MARK_BOX}`}
      className={cn('block overflow-visible', dim && 'opacity-55', className)}
      {...props}
    >
      <rect x={-10} y={-10} width={20} height={20} className="fill-(--map-ground)" />
      <rect x={-8} y={-8} width={16} height={16} className={TONE_FILL[tone]} />
      {tone === 'passage' ? (
        <path d="M-4.5 -2.5 H4.5 V-1 H-4.5 Z M-4.5 1 H4.5 V2.5 H-4.5 Z" className="fill-bg" />
      ) : (
        <path d="M0 -4.5 L4.5 3.5 H-4.5 Z" className="fill-bg" />
      )}
      {selected && (
        <path
          data-slot="hazard-mark-brackets"
          d="M-16 -9 v-7 h7 M9 -16 h7 v7 M16 9 v7 h-7 M-9 16 h-7 v-7"
          fill="none"
          strokeWidth={1.2}
          className="stroke-fg"
        />
      )}
    </svg>
  );
}

export { HazardMark, PutInMark };
