import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLocationDot } from '@fortawesome/sharp-light-svg-icons';
import { type BodyStanding, describeStanding, INACTIVE_BADGE } from '@skating/core';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { buttonVariants } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { Skeleton } from '@/components/kit/skeleton';
import { cn } from '@/lib/utils';

import { LakeSidebar, SidebarBody } from './LakeSidebar';

/**
 * The lake sidebar while it loads (board 2.8's pattern): the header's three runs — kicker, name,
 * the facts — then the body's blocks, each the size of what it holds so nothing jumps when the lake
 * lands. Announced once, by the region's `aria-busy`.
 */
export function LakeSidebarSkeleton() {
  return (
    <LakeSidebar
      label="Loading the lake"
      busy
      header={
        <div
          aria-hidden="true"
          data-slot="lake-header-skeleton"
          className="flex flex-col gap-(--space-3_5) border-0 border-b border-solid border-line px-gutter pt-(--space-5_5) pb-(--space-5)"
        >
          <Skeleton className="h-[0.6875rem] w-16" />
          <Skeleton className="h-[1.625rem] w-[62%]" />
          <Skeleton className="h-[0.875rem] w-[44%]" />
          <Skeleton className="h-btn w-full" />
        </div>
      }
      body={
        <SidebarBody>
          <div aria-hidden="true" className="flex flex-col gap-(--space-4)">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </SidebarBody>
      }
    />
  );
}

/**
 * A lake that isn't there: not found (a broken link), or taken off the map. Says which, plainly,
 * and offers the way back to the map — never a blank sidebar.
 */
export function LakeUnavailable({
  kind,
  explore,
}: {
  kind: 'not-found' | 'unavailable';
  explore: { href: string; onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void };
}) {
  const title = kind === 'not-found' ? 'Lake not found' : 'This lake isn’t available';
  const line =
    kind === 'not-found'
      ? 'We couldn’t find this lake. The link may be broken.'
      : 'It may have been removed from the map. Try another lake nearby.';
  return (
    <LakeSidebar
      label={title}
      body={
        <SidebarBody>
          <div
            data-slot="lake-unavailable"
            className="flex flex-col gap-(--space-3) pt-(--space-4)"
          >
            <FontAwesomeIcon
              icon={faLocationDot}
              aria-hidden="true"
              className="h-6 self-start text-fg3"
            />
            <h1 className="m-0 text-disp leading-none font-semibold tracking-disp text-fg uppercase">
              {title}
            </h1>
            <p className="m-0 text-row text-fg2">{line}</p>
            <a
              href={explore.href}
              onClick={explore.onClick}
              data-attr="lake-unavailable-explore"
              className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'self-start')}
            >
              Back to Explore
            </a>
          </div>
        </SidebarBody>
      }
    />
  );
}

/**
 * Why this lake isn't on the active map (board 1.13): the badge, the one sentence `describeStanding`
 * gives both clients, and the asks its standing admits. Nothing at all on an active lake.
 */
export function StandingNoticeView({
  standing,
  asks,
}: {
  standing: BodyStanding;
  asks?: ReactNode;
}) {
  const line = describeStanding(standing);
  if (line === null) return null;
  return (
    <Note data-slot="lake-standing" className="flex flex-col items-start gap-(--space-2_5)">
      <Badge variant="outline">
        {standing.standing === 'removed' ? 'Removed' : INACTIVE_BADGE}
      </Badge>
      <span className="text-row text-fg1 [text-wrap:pretty]">{line}</span>
      {asks}
    </Note>
  );
}
