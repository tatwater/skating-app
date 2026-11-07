import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBullseyeArrow,
  faDiamondTurnRight,
  faStar as faStarOutline,
  faTriangleExclamation,
} from '@fortawesome/sharp-light-svg-icons';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { Button, buttonVariants } from '@/components/kit/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { cn } from '@/lib/utils';

import { INK_PRIMARY } from '../styles';
import type { LakeFact } from './lakeModel';

/** The favorite star: gold when set, an outline when not (Review 4). */
export interface FavoriteState {
  on: boolean;
  /** The reactive read hasn't answered yet: the star waits rather than guess. */
  pending: boolean;
  onToggle: () => void;
}

/** An in-app link: a real `href`, and a plain click handed to the router. */
export interface HeaderLink {
  href: string;
  onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}

export interface LakeHeaderProps {
  /** "Reservoir · NH", "Bay · NH". */
  kicker: string;
  name: string;
  /** The bay view: the lake it's part of, as a link, with the lake's own star when it's a favorite. */
  partOf?: { name: string; link: HeaderLink; favorite: boolean } | null;
  facts: readonly LakeFact[];
  favorite: FavoriteState;
  /** Gray: an inactive body (Review 2). */
  inactive?: boolean;
  /** Why it isn't on the active map, and what can be asked — under the facts (Review 3). */
  standing?: ReactNode;
  newReport: HeaderLink | null;
  reportHazard: HeaderLink | null;
  /** Only on a lake we push: a bounty asks other people to go there (A07b). */
  postBounty: HeaderLink | null;
  /** Google or Apple Maps to the parking (or the put-in), in a new tab. Absent: no known way in. */
  directions?: { href: string; label: string; onOpen: () => void } | null;
}

/**
 * The lake sidebar's header (boards 1.2, 1.10, 1.13): the kicker, the name with its star (the star
 * rides the name, where it reads as the lake's own), the facts, and the actions — **one** primary,
 * *Add a report* (board 1.2's words; the top bar's own button says *New report*), with *Report a
 * hazard* and *Post a bounty* under it and Directions as an icon.
 */
export function LakeHeader({
  kicker,
  name,
  partOf = null,
  facts,
  favorite,
  inactive = false,
  standing,
  newReport,
  reportHazard,
  postBounty,
  directions = null,
}: LakeHeaderProps) {
  return (
    <header
      data-slot="lake-header"
      data-inactive={inactive ? '' : undefined}
      className="flex flex-col gap-(--space-3_5) border-0 border-b border-solid border-line px-gutter pt-(--space-5_5) pb-(--space-5)"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-kick font-medium tracking-kick text-fg3 uppercase">{kicker}</span>
        <div className="mt-(--space-2) flex min-w-0 items-center gap-(--space-1_5)">
          <h1
            className={cn(
              'm-0 min-w-0 text-disp-lg leading-[1.05] font-semibold tracking-disp uppercase [overflow-wrap:anywhere]',
              inactive ? 'text-fg1' : 'text-fg',
            )}
          >
            {name}
          </h1>
          <FavoriteStar state={favorite} scope={partOf ? 'bay' : 'lake'} />
        </div>
        {partOf && (
          <div className="mt-(--space-1_5) flex items-center gap-(--space-2) text-assist text-fg2">
            <span>
              Part of{' '}
              <a
                href={partOf.link.href}
                onClick={partOf.link.onClick}
                data-attr="lake-part-of"
                className="rounded-control text-fg1 underline decoration-line2 underline-offset-3 outline-none focus-visible:shadow-focus"
              >
                {partOf.name}
              </a>
            </span>
            {partOf.favorite && (
              <FontAwesomeIcon
                icon={faStar}
                aria-label={`${partOf.name} is a favorite`}
                className="h-[0.75rem] text-star"
              />
            )}
          </div>
        )}
      </div>

      {facts.length > 0 && (
        <dl data-slot="lake-facts" className="m-0 flex flex-wrap gap-y-(--space-3)">
          {facts.map((fact) => (
            <div
              key={fact.kicker}
              className="flex flex-col gap-(--space-1_5) border-0 border-r border-solid border-line pr-(--space-4) mr-(--space-4) last:mr-0 last:border-r-0 last:pr-0"
            >
              <dt className="text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase">
                {fact.kicker}
              </dt>
              <dd className="m-0 font-(family-name:--family-mono) text-row leading-none font-medium whitespace-nowrap text-fg">
                {fact.value}
                <small className="ms-(--space-1) text-assist font-normal text-fg2">
                  {fact.unit}
                </small>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {standing}

      <div data-slot="lake-actions" className="flex flex-col gap-(--space-2)">
        {newReport && (
          <a
            href={newReport.href}
            onClick={newReport.onClick}
            data-attr="lake-new-report"
            className={cn(buttonVariants({ variant: 'primary' }), INK_PRIMARY, 'w-full')}
          >
            <FontAwesomeIcon icon={faPlus} aria-hidden="true" className="h-[1.1em]" />
            Add a report
          </a>
        )}
        <div className="flex gap-(--space-2)">
          {reportHazard && (
            <a
              href={reportHazard.href}
              onClick={reportHazard.onClick}
              data-attr="lake-report-hazard"
              className={cn(buttonVariants({ size: 'sm' }), 'min-w-0 flex-1 basis-0')}
            >
              <FontAwesomeIcon
                icon={faTriangleExclamation}
                aria-hidden="true"
                className="h-[1.1em]"
              />
              Report a hazard
            </a>
          )}
          {postBounty && (
            <a
              href={postBounty.href}
              onClick={postBounty.onClick}
              data-attr="lake-post-bounty"
              className={cn(buttonVariants({ size: 'sm' }), 'min-w-0 flex-1 basis-0')}
            >
              <FontAwesomeIcon icon={faBullseyeArrow} aria-hidden="true" className="h-[1.1em]" />
              Post a bounty
            </a>
          )}
          {directions && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={directions.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={directions.label}
                    onClick={directions.onOpen}
                    data-attr="lake-directions"
                    className={cn(buttonVariants({ size: 'icon-sm' }), 'shrink-0')}
                  />
                }
              >
                <FontAwesomeIcon
                  icon={faDiamondTurnRight}
                  aria-hidden="true"
                  className="h-[1.05em]"
                />
              </TooltipTrigger>
              <TooltipContent>{directions.label} — opens in a new tab</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </header>
  );
}

/** The star beside the name: a toggle, gold when set. A bay's star is the bay's own (1.10). */
export function FavoriteStar({ state, scope }: { state: FavoriteState; scope: 'lake' | 'bay' }) {
  const label = state.on ? `Remove this ${scope} from favorites` : `Add this ${scope} to favorites`;
  return (
    <Button
      variant="bare"
      size="icon-sm"
      aria-pressed={state.on}
      aria-label={label}
      disabled={state.pending}
      onClick={state.onToggle}
      data-attr="lake-favorite"
      data-slot="lake-favorite"
      className={cn('shrink-0', state.on && 'text-star lit:text-star')}
    >
      <FontAwesomeIcon icon={state.on ? faStar : faStarOutline} aria-hidden="true" />
    </Button>
  );
}
