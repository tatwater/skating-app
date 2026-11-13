import { createColumnHelper, metaHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { type ComponentProps, type ReactNode, useMemo } from 'react';

import { ScrollArea } from '@/components/kit/scroll-area';
import { Section } from '@/components/kit/section-slug';
import { DataTable, type TableColumnMeta } from '@/components/kit/table';
import { cn } from '@/lib/utils';

import type { FeedRow, FeedTarget } from './overviewData';
import { feedWhen } from './overviewModel';

/**
 * The audit feed: every action newest first — when, who, what, and to what. It fills whatever
 * height Home leaves it and scrolls inside; its section ends in the live mark.
 *
 * - **The machine is named too**: a row with no person is *system*, set in mono and the quiet ink,
 *   so a cron's work never reads as a colleague's.
 * - **A row opens its target** (`onOpenTarget`): the page that holds that thing's history. Without
 *   a handler, rows are plain text and never wash.
 */

const features = tableFeatures({ columnMeta: metaHelper<TableColumnMeta>() });
const helper = createColumnHelper<typeof features, FeedRow>();

/** One line, cut with an ellipsis where it runs out of room. */
const Cut = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn('block truncate', className)}>{children}</span>
);

function columnsFor(now: number) {
  return helper.columns([
    helper.accessor('at', {
      header: 'When',
      cell: (c) => <Cut>{feedWhen(c.getValue(), now)}</Cut>,
      meta: { mono: true, width: '6.25rem', skeleton: '3rem' },
    }),
    helper.accessor('actor', {
      header: 'Actor',
      cell: (c) => {
        const actor = c.getValue();
        return actor === null ? (
          <Cut className="font-(family-name:--family-mono) text-mono-sm text-fg3">system</Cut>
        ) : (
          <Cut>{actor}</Cut>
        );
      },
      meta: { width: '5.625rem', skeleton: '3.5rem' },
    }),
    helper.accessor('action', {
      header: 'Action',
      cell: (c) => <Cut>{c.getValue()}</Cut>,
      meta: { lead: true, width: '40%', skeleton: '8rem' },
    }),
    helper.accessor('target', {
      header: 'Target',
      cell: (c) => <Cut>{c.getValue().label}</Cut>,
      meta: { skeleton: '9rem' },
    }),
  ]);
}

type AuditFeedProps = Omit<ComponentProps<'section'>, 'title' | 'children'> & {
  /** Newest first; `undefined` while it loads. */
  rows: readonly FeedRow[] | undefined;
  now: number;
  /** The live mark at the section's end. */
  live?: ReactNode;
  /** Opens a row's target; without it, rows don't wash. */
  onOpenTarget?: (target: FeedTarget) => void;
};

export function AuditFeed({ rows, now, live, onOpenTarget, className, ...props }: AuditFeedProps) {
  // Rebuilt only when the clock moves: the feed re-renders on every live update and hover.
  const columns = useMemo(() => columnsFor(now), [now]);
  const table = useTable({
    features,
    columns,
    data: (rows ?? []) as FeedRow[],
    getRowId: (row) => row.id,
  });
  return (
    <Section
      title="Audit feed"
      end={live}
      data-slot="audit-feed"
      className={cn('min-h-0', className)}
      {...props}
    >
      <ScrollArea className="min-h-0 flex-1" gutter={false}>
        <DataTable
          table={table}
          empty="Nothing done yet"
          loading={rows === undefined ? 8 : false}
          onRowClick={onOpenTarget ? (row) => onOpenTarget(row.original.target) : undefined}
          // The feed lines up with its section: no gutter cells.
          className="[&_td:first-child]:ps-0 [&_td:last-child]:pe-0 [&_th:first-child]:ps-0 [&_th:last-child]:pe-0"
          style={{ tableLayout: 'fixed' }}
        />
      </ScrollArea>
    </Section>
  );
}
