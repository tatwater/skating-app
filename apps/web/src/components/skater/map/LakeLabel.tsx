import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow } from '@fortawesome/sharp-light-svg-icons';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import type { ComponentProps, Ref } from 'react';
import {
  LABEL_DOT_RADIUS,
  LEADER_RUN,
  LOCKUP_INSET,
  LOCKUP_TOP_NAME_ONLY,
  LOCKUP_TOP_WITH_SLUG,
  openBountiesLabel,
} from '@/lib/lakeLabelLayout';
import { cn } from '@/lib/utils';

/**
 * A lake's label on the map (Review 2's lockup, Review 3's pinning, Review 4's star and badge):
 * a dot on the body's interior point, a fixed 16 px 45° leader up to the lockup, a solid slug (what
 * skaters reported, or "Inactive") over the name, then a favorite's gold star and an open bounty's
 * **outline** badge with its count. The text casts a shadow in the map's ground color — not for
 * depth, but to hide the map behind the words so the label reads.
 *
 * The root is a zero-size box on the anchor; the leader and the lockup hang off it at fixed offsets
 * (mock `chrome.js` `mapLabel`). `mirrored` flips both to the left of the anchor, the lockup
 * right-aligned to the leader's end — near the map's right edge (`placeLabel` decides).
 *
 * The label takes no pointer: a click goes through it to the water it names. The pane sets
 * `--map-ground` and `--lab-sh` (`mapMarkVars`).
 */
export interface LakeLabelProps extends Omit<ComponentProps<'div'>, 'children'> {
  name: string;
  /** "3 reports · today", "Inactive"; `null` draws the name alone (a lockup 19 px shorter). */
  slug: string | null;
  favorite?: boolean;
  openBounties?: number;
  inactive?: boolean;
  /** Receded behind a choice made elsewhere (a filter it doesn't match). */
  dim?: boolean;
  mirrored?: boolean;
  /** The lockup, for measuring its width (`placeLabel` needs it). */
  lockupRef?: Ref<HTMLDivElement>;
}

/** The leader's box: 40 × 24 with the anchor at (20, 20), so mirroring is a flip about its middle. */
const LEADER_BOX = { w: 40, h: 24, x: 20, y: 20 };

function LakeLabel({
  name,
  slug,
  favorite = false,
  openBounties = 0,
  inactive = false,
  dim = false,
  mirrored = false,
  lockupRef,
  className,
  ...props
}: LakeLabelProps) {
  const receded = dim || inactive;
  return (
    <div
      data-slot="lake-label"
      data-mirrored={mirrored ? '' : undefined}
      data-inactive={inactive ? '' : undefined}
      data-dim={dim ? '' : undefined}
      className={cn('group/label pointer-events-none absolute top-0 left-0 size-0', className)}
      {...props}
    >
      <svg
        aria-hidden="true"
        data-slot="lake-label-leader"
        width={LEADER_BOX.w}
        height={LEADER_BOX.h}
        viewBox={`${-LEADER_BOX.x} ${-LEADER_BOX.y} ${LEADER_BOX.w} ${LEADER_BOX.h}`}
        className="absolute block overflow-visible group-data-mirrored/label:-scale-x-100"
        style={{ left: -LEADER_BOX.x, top: -LEADER_BOX.y }}
      >
        <line
          x1={LABEL_DOT_RADIUS}
          y1={-LABEL_DOT_RADIUS}
          x2={LEADER_RUN}
          y2={-LEADER_RUN}
          strokeWidth={1}
          className={receded ? 'stroke-fg3' : 'stroke-fg2'}
        />
        {/* Review 4: the dot has no border. */}
        <circle r={LABEL_DOT_RADIUS} className={receded ? 'fill-fg2' : 'fill-fg'} />
      </svg>
      <div
        ref={lockupRef}
        data-slot="lake-label-lockup"
        className={cn('absolute flex w-max flex-col gap-1', mirrored ? 'items-end' : 'items-start')}
        style={{
          top: slug ? LOCKUP_TOP_WITH_SLUG : LOCKUP_TOP_NAME_ONLY,
          ...(mirrored ? { right: LOCKUP_INSET } : { left: LOCKUP_INSET }),
        }}
      >
        {slug && (
          <span
            data-slot="lake-label-slug"
            className={cn(
              'inline-flex h-[15px] items-center px-1.5 whitespace-nowrap text-bg',
              'text-[0.59375rem] leading-none font-semibold tracking-kick uppercase',
              'shadow-[0_0_10px_var(--lab-sh)]',
              inactive ? 'bg-fg3' : dim ? 'bg-fg2' : 'bg-fg1',
            )}
          >
            {slug}
          </span>
        )}
        <span
          data-slot="lake-label-name"
          className={cn(
            'flex h-[18px] items-center gap-[7px] whitespace-nowrap',
            'text-row leading-none font-semibold tracking-[0.02em]',
            '[text-shadow:0_0_2px_var(--lab-sh),0_0_5px_var(--lab-sh),0_0_10px_var(--lab-sh),0_0_16px_var(--lab-sh)]',
            receded ? 'text-fg2' : 'text-fg',
          )}
        >
          {name}
          {favorite && (
            <span role="img" aria-label="A favorite" className="inline-flex">
              <FontAwesomeIcon
                icon={faStar}
                className="size-3 text-star drop-shadow-[0_0_3px_var(--lab-sh)]"
              />
            </span>
          )}
          {openBounties > 0 && (
            // Review 4: an open bounty is an outline badge on a label, never a solid one — and its
            // count is bounties, never points (Review 2).
            <span
              role="img"
              aria-label={openBountiesLabel(openBounties)}
              data-slot="lake-label-bounties"
              className={cn(
                'inline-flex h-[17px] items-center gap-1 pr-[5px] pl-1',
                'border border-solid border-fg bg-(--lab-sh) text-fg',
                'font-(family-name:--family-mono) text-[0.6875rem] leading-none font-medium',
                'shadow-[0_0_10px_var(--lab-sh)] [text-shadow:none]',
              )}
            >
              <FontAwesomeIcon icon={faBullseyeArrow} className="size-[11px]" />
              {openBounties}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export { LakeLabel };
