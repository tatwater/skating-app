import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBullseyeArrow, faChevronRight, faImage } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { usePaginatedQuery, useQuery } from 'convex/react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { Avatar } from '@/components/kit/avatar';
import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';
import { cn } from '@/lib/utils';

import { HazardList } from './HazardList';
import {
  openBountiesLine,
  type ReportRowInput,
  type ReportRowModel,
  reportRowModel,
} from './lakeModel';

/** An in-app link handler: the id, and the click (a modified click opens a tab on its own). */
export type OpenHandler = (id: string, event: ReactMouseEvent<HTMLAnchorElement>) => void;

/**
 * One report on a lake's Reports tab (board 1.2) — a light row, not the full card (the report card
 * is its own composition, opened from here as an inset card): the person (a circle), when they
 * skated, where, their own claims as badges, their words, the ice types, and how many photos. The
 * whole row is the link to `/report/$id`.
 */
export function ReportRow({
  row,
  author,
  href,
  onOpen,
}: {
  row: ReportRowModel;
  author: { name: string; imageUrl?: string } | null;
  href: string;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  const name = author?.name ?? 'A skater';
  return (
    <a
      href={href}
      onClick={onOpen}
      data-slot="report-row"
      data-attr="lake-report"
      className={cn(
        'flex min-w-0 flex-col gap-(--space-2_5) rounded-control py-(--space-4) no-underline outline-none',
        'border-0 border-b border-dotted border-line2 first:pt-(--space-1) last:border-b-0',
        'transition-colors duration-(--duration-fast) ease-standard lit:bg-lift-03',
        'focus-visible:shadow-focus',
      )}
    >
      <span className="flex min-w-0 items-center gap-(--space-2_5)">
        <Avatar
          name={name}
          size="sm"
          {...(author?.imageUrl ? { src: author.imageUrl } : {})}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-row font-medium text-fg">{name}</span>
        <span className="ms-auto shrink-0 font-(family-name:--family-mono) text-assist whitespace-nowrap text-fg2">
          {row.when}
        </span>
      </span>
      {row.where && <span className="text-assist text-fg2">{row.where}</span>}
      {row.badges.length > 0 && (
        <span className="flex flex-wrap gap-(--space-1_5)">
          {row.badges.map((b) => (
            <Badge key={b.label} variant="outline" tone={b.tone === 'bad' ? 'bad' : 'default'}>
              {b.label}
            </Badge>
          ))}
        </span>
      )}
      {row.notes && (
        <span className="line-clamp-4 text-row leading-body text-fg1 [text-wrap:pretty]">
          {row.notes}
        </span>
      )}
      {(row.iceTypes.length > 0 || row.photoCount > 0) && (
        <span className="flex flex-wrap items-center gap-(--space-1_5)">
          {row.iceTypes.map((t) => (
            <Badge key={t} variant="outline" tone="dim">
              {t}
            </Badge>
          ))}
          {row.photoCount > 0 && (
            <span className="ms-auto flex items-center gap-(--space-1_5) text-assist text-fg3">
              <FontAwesomeIcon icon={faImage} aria-hidden="true" className="h-[0.85em]" />
              {row.photoCount} {row.photoCount === 1 ? 'photo' : 'photos'}
            </span>
          )}
        </span>
      )}
    </a>
  );
}

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
  rows: { row: ReportRowModel; author: { name: string; imageUrl?: string } | null }[];
  canLoadMore: boolean;
  loadingMore: boolean;
}

/** The Reports section: a count, the rows, "Load more", and the empty line. */
export function ReportsListView({
  model,
  onOpen,
  onLoadMore,
  emptyLine,
}: {
  model: ReportsListModel;
  onOpen: OpenHandler;
  onLoadMore: () => void;
  emptyLine: string;
}) {
  if (model.status === 'loading') {
    return (
      <Section title="Reports" level={2} aria-busy="true">
        <Skeleton className="h-24 w-full" />
      </Section>
    );
  }
  return (
    <Section title="Reports" level={2} count={model.rows.length} className="ph-no-capture">
      {model.rows.length === 0 ? (
        <p className="m-0 text-row text-fg2">{emptyLine}</p>
      ) : (
        <div className="flex flex-col">
          {model.rows.map(({ row, author }) => (
            <ReportRow
              key={row.id}
              row={row}
              author={author}
              href={`/report/${row.id}`}
              onOpen={(event) => onOpen(row.id, event)}
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
  onOpen: { hazard: OpenHandler; report: OpenHandler };
  /** The lake's open bounties — the first one's card, until a list of them has a home. */
  onOpenBounties: OpenHandler;
}) {
  const bodyId = waterBodyId as Id<'waterBodies'>;
  const bayId = subAreaId as Id<'waterBodySubAreas'> | undefined;
  const scope = { waterBodyId: bodyId, ...(bayId !== undefined ? { subAreaId: bayId } : {}) };
  const { results, status, loadMore } = usePaginatedQuery(api.reports.listByWaterBody, scope, {
    initialNumItems: REPORTS_PAGE_SIZE,
  });
  const authorIds = [...new Set(results.map((r) => r.authorId))];
  const authors = useQuery(
    api.profiles.publicByIds,
    authorIds.length > 0 ? { profileIds: authorIds } : 'skip',
  );
  const bounties = useQuery(api.bounties.listForBody, scope);

  const now = Date.now();
  const model: ReportsListModel = {
    status: status === 'LoadingFirstPage' ? 'loading' : 'ready',
    rows: results.map((r) => {
      const a = authors?.[r.authorId];
      return {
        row: reportRowModel(r as unknown as ReportRowInput, now),
        author: a
          ? { name: a.displayName, ...(a.profileImageUrl ? { imageUrl: a.profileImageUrl } : {}) }
          : null,
      };
    }),
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
