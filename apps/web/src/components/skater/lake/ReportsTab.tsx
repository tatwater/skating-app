import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow, faChevronRight } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { FeedCardData } from '@skating/core';
import { usePaginatedQuery, useQuery } from 'convex/react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { Button } from '@/components/kit/button';
import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';
import { cn } from '@/lib/utils';

import { ReportCard } from '../cards/ReportCard';
import { HazardList } from './HazardList';
import { openBountiesLine } from './lakeModel';

/** An in-app link handler: the id, and the click (a modified click opens a tab on its own). */
export type OpenHandler = (id: string, event: ReactMouseEvent<HTMLAnchorElement>) => void;

/** The bounties line at the tab's foot: "3 open bounties", outline — never points (Review 2). */
export function BountiesLine({
  count,
  href,
  onOpen,
}: {
  count: number;
  href: string;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  if (count === 0) return null;
  return (
    <a
      href={href}
      onClick={onOpen}
      data-slot="bounties-line"
      data-attr="lake-bounties"
      className={cn(
        'flex items-center gap-(--space-3) rounded-control border border-solid border-line p-(--space-3) no-underline outline-none',
        'transition-colors duration-(--duration-fast) ease-standard lit:bg-lift-03 focus-visible:shadow-focus',
      )}
    >
      <FontAwesomeIcon icon={faBullseyeArrow} aria-hidden="true" className="h-[1rem] text-fg1" />
      <span className="flex-1 text-row text-fg">{openBountiesLine(count)}</span>
      <FontAwesomeIcon icon={faChevronRight} aria-hidden="true" className="h-[0.7rem] text-fg3" />
    </a>
  );
}

export interface ReportsListModel {
  status: 'loading' | 'ready';
  /** The page as cards (`reports.listCardsByWaterBody`). */
  cards: FeedCardData[];
  canLoadMore: boolean;
  loadingMore: boolean;
}

/**
 * The Reports section (board 1.2): a count, the rows, "Load more", and the empty line. Each row is
 * the shared `ReportCard`, so a report reads the same here as on Latest and a profile — saying the
 * bay rather than the lake, since the list is already this lake's.
 */
export function ReportsListView({
  model,
  onOpen,
  onLoadMore,
  emptyLine,
  now = Date.now(),
}: {
  model: ReportsListModel;
  onOpen: (reportId: string) => void;
  onLoadMore: () => void;
  emptyLine: string;
  /** The clock the rows' ages read from, one per list. */
  now?: number;
}) {
  if (model.status === 'loading') {
    return (
      <Section title="Reports" level={2} aria-busy="true">
        <Skeleton className="h-24 w-full" />
      </Section>
    );
  }
  return (
    <Section title="Reports" level={2} count={model.cards.length} className="ph-no-capture">
      {model.cards.length === 0 ? (
        <p className="m-0 text-row text-fg2">{emptyLine}</p>
      ) : (
        <div className="flex flex-col">
          {model.cards.map((card, i) => (
            <ReportCard
              key={card.reportId}
              report={card}
              now={now}
              href={`/report/${card.reportId}`}
              onOpen={() => onOpen(card.reportId)}
              hideBody
              {...(card.notesExcerpt !== undefined ? { excerpt: card.notesExcerpt } : {})}
              {...(card.helpfulCount !== undefined ? { helpfulCount: card.helpfulCount } : {})}
              {...(card.commentCount !== undefined ? { commentCount: card.commentCount } : {})}
              last={i === model.cards.length - 1}
            />
          ))}
        </div>
      )}
      {model.canLoadMore && (
        <Button
          size="sm"
          className="self-center"
          data-attr="lake-reports-more"
          loading={model.loadingMore}
          onClick={onLoadMore}
        >
          Load more
        </Button>
      )}
    </Section>
  );
}

const REPORTS_PAGE_SIZE = 20;

/** The tab's body: Known hazards, the reports, then the open bounties. */
export function ReportsTab({
  waterBodyId,
  subAreaId,
  onOpen,
  onOpenBounties,
}: {
  waterBodyId: string;
  subAreaId?: string;
  onOpen: { hazard: OpenHandler; report: (reportId: string) => void };
  /** The lake's open bounties — the first one's card, until a list of them has a home. */
  onOpenBounties: OpenHandler;
}) {
  const bodyId = waterBodyId as Id<'waterBodies'>;
  const bayId = subAreaId as Id<'waterBodySubAreas'> | undefined;
  const scope = { waterBodyId: bodyId, ...(bayId !== undefined ? { subAreaId: bayId } : {}) };
  const { results, status, loadMore } = usePaginatedQuery(api.reports.listCardsByWaterBody, scope, {
    initialNumItems: REPORTS_PAGE_SIZE,
  });
  const bounties = useQuery(api.bounties.listForBody, scope);

  const model: ReportsListModel = {
    status: status === 'LoadingFirstPage' ? 'loading' : 'ready',
    cards: results,
    canLoadMore: status === 'CanLoadMore' || status === 'LoadingMore',
    loadingMore: status === 'LoadingMore',
  };
  const firstBounty = bounties?.[0]?._id;

  return (
    <TabStack>
      <HazardList
        waterBodyId={waterBodyId}
        {...(subAreaId !== undefined ? { subAreaId } : {})}
        hrefFor={(id) => `/hazard/${id}`}
        onOpen={onOpen.hazard}
      />
      <ReportsListView
        model={model}
        onOpen={onOpen.report}
        onLoadMore={() => loadMore(REPORTS_PAGE_SIZE)}
        emptyLine={
          subAreaId !== undefined
            ? 'No reports from this bay yet this season.'
            : 'No reports yet this season — be the first.'
        }
      />
      {firstBounty !== undefined && (
        <BountiesLine
          count={bounties?.length ?? 0}
          href={`/bounty/${firstBounty}`}
          onOpen={(event) => onOpenBounties(firstBounty, event)}
        />
      )}
    </TabStack>
  );
}

/** A tab's sections, a gap apart (the boards' 28 px). */
export function TabStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-(--space-7)">{children}</div>;
}
