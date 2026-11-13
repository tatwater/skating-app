import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Kit candidate** — a group divider inside a table: where the rows that follow are a different
 * kind (Bodies 5.3's *Dormant 4*, under the active matches; a run history's season divider). One
 * cell across every column: a kicker and its count in mono, over a `line2` rule that runs the
 * table's width — the rows under it read as a new group of the same table, not a new table.
 *
 * Not clickable and never washed; a reader hears it as a row header for the group.
 */

type TableGroupRowProps = Omit<ComponentProps<'tr'>, 'children'> & {
  /** How many columns the table has. */
  colSpan: number;
  /** The group's name, written capitalized ("Dormant"); set as a kicker. */
  label: string;
  /** How many rows the group holds, when known. */
  count?: number | string;
};

function TableGroupRow({ colSpan, label, count, className, ...props }: TableGroupRowProps) {
  return (
    <tr data-slot="table-group-row" className={className} {...props}>
      <th
        scope="colgroup"
        colSpan={colSpan}
        className={cn(
          'px-(--gap-gutter) pt-(--space-4) pb-(--space-2) text-left align-bottom',
          'border-0 border-b border-solid border-line2',
        )}
      >
        <span className="text-kick leading-none font-medium tracking-kick text-fg2 uppercase">
          {label}
        </span>
        {count !== undefined && (
          <span
            data-slot="table-group-count"
            className="ms-(--space-2_5) font-(family-name:--family-mono) text-kick leading-none text-fg3 tabular-nums"
          >
            {count}
          </span>
        )}
      </th>
    </tr>
  );
}

export { TableGroupRow, type TableGroupRowProps };
