import { STATE_NAMES } from '@skating/core';
import {
  type CellContext,
  createColumnHelper,
  metaHelper,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';

import { Section } from '@/components/kit/section-slug';
import { DataTable, type TableColumnMeta } from '@/components/kit/table';
import { cn } from '@/lib/utils';

import {
  type CoverageData,
  NOT_RECORDED,
  perThousand,
  type StateCoverageRow,
  stateInk,
} from './metricsModel';
import { SpanTag } from './metricsParts';

/**
 * Coverage by state, under both columns: the listed bodies as one composition bar, then a plain
 * table of each state's season. A column no write path records yet reads "—", never 0.
 */

const KICK = 'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase';

const features = tableFeatures({ columnMeta: metaHelper<TableColumnMeta>() });
const column = createColumnHelper<typeof features, StateCoverageRow>();

type CountKey = 'reports' | 'comments' | 'photos' | 'kudos' | 'contributors';

/** A season count: bright when there are some (reports), faint at zero, a dash when unrecorded. */
function countCell(bright = false) {
  return (c: CellContext<typeof features, StateCoverageRow, number | null>) => {
    const value = c.getValue();
    if (value === null) {
      return (
        <span data-unrecorded="" className="text-fg3">
          —
        </span>
      );
    }
    return (
      <span className={cn(value === 0 ? 'text-fg3' : bright && 'text-fg')}>
        {value.toLocaleString('en-US')}
      </span>
    );
  };
}

const countColumn = (key: CountKey, header: string, bright = false) =>
  column.accessor(key, {
    header,
    cell: countCell(bright),
    meta: { align: 'end', mono: true, width: '7.75rem' },
  });

const columns = column.columns([
  column.accessor('state', {
    header: 'State',
    cell: (c) => (
      <span className="inline-flex items-baseline gap-(--space-2_5)">
        <i
          aria-hidden="true"
          data-slot="state-swatch"
          className="inline-block size-[0.5625rem] shrink-0"
          style={{ background: stateInk(c.getValue()) }}
        />
        {STATE_NAMES[c.getValue()] ?? c.getValue()}
      </span>
    ),
    meta: { lead: true },
  }),
  column.accessor('bodies', {
    header: 'Bodies',
    cell: (c) => c.getValue().toLocaleString('en-US'),
    meta: { align: 'end', mono: true, width: '7.75rem' },
  }),
  countColumn('reports', 'Reports', true),
  countColumn('comments', 'Comments'),
  countColumn('photos', 'Photos'),
  countColumn('kudos', 'Kudos'),
  countColumn('contributors', 'Contributors'),
  column.accessor((row) => row.reports, {
    id: 'perThousand',
    header: 'Reports per 1,000 bodies',
    cell: (c) => {
      const reports = c.getValue();
      if (reports === null) return <span className="text-fg3">—</span>;
      const rate = perThousand(reports, c.row.original.bodies);
      return <span className={cn(rate === '0' && 'text-fg3')}>{rate}</span>;
    },
    meta: { align: 'end', mono: true, width: '13.125rem' },
  }),
]);

/** The listed bodies as one bar, each state its share, in the table's swatches. */
export function ListedBodiesBar({ data }: { data: CoverageData }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_4.375rem] items-center gap-x-(--space-4)">
      <span className={KICK}>Listed bodies</span>
      <div
        role="img"
        aria-label={
          data.listedBodies === null
            ? NOT_RECORDED
            : data.states
                .map(
                  (s) => `${STATE_NAMES[s.state] ?? s.state} ${s.bodies.toLocaleString('en-US')}`,
                )
                .join(', ')
        }
        className="flex h-(--space-4) gap-[0.125rem]"
      >
        {data.listedBodies === null && <i className="block flex-1 bg-line" />}
        {data.states
          .filter((s) => s.bodies > 0)
          .map((s) => (
            <i
              key={s.state}
              data-slot="state-share"
              data-state={s.state}
              className="block min-w-[0.1875rem]"
              style={{ flexGrow: s.bodies, flexBasis: 0, background: stateInk(s.state) }}
            />
          ))}
      </div>
      <span
        className={cn(
          'text-right font-(family-name:--family-mono) text-row leading-none font-medium tabular-nums',
          data.listedBodies === null ? 'text-fg3' : 'text-fg',
        )}
      >
        {data.listedBodies === null ? '—' : data.listedBodies.toLocaleString('en-US')}
      </span>
    </div>
  );
}

export function CoverageByState({ data }: { data: CoverageData }) {
  const table = useTable({ features, columns, data: data.states, getRowId: (row) => row.state });
  return (
    <Section title="Coverage by state" end={<SpanTag>This season</SpanTag>}>
      <div className="flex flex-col gap-(--space-4_5)">
        <ListedBodiesBar data={data} />
        <DataTable
          table={table}
          inset
          stickyHeader={false}
          className="px-0"
          empty={data.listedBodies === null ? NOT_RECORDED : 'No listed bodies'}
        />
      </div>
    </Section>
  );
}
