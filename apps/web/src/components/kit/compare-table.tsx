import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Kit candidate: **the compare table** (the Inbox's 2.4, `.cmp`) — two things side by side, row by
 * row, so a reader sees at a glance where they agree: *the ask* against *The Narrows ·
 * OpenStreetMap*, by name, kind, point, other names and use.
 *
 * - **A real table**: a header row naming the two columns, a label (`th scope="row"`) leading each
 *   row, so a reader hears "Name, the ask, the Narrows".
 * - **The boards' measures**: a 26 px header on the line rule, 30 px rows on a dotted hairline, the
 *   label column the boards' 96 px (6 rem), the two columns sharing the rest.
 * - **Tones by meaning**: a column head may be lit (`fg`, the thing asked) or amber (`warn`, the
 *   lookalike that may be the same); a cell marked `same` is lit (`fg`) — the two agree there; a
 *   `mono` cell is a figure (a point's coordinates). Everything else is the list ink (`fg2`).
 * - **Narrow**: under 26 rem the label column narrows and a cell wraps rather than clip, so nothing
 *   is cut on a phone's page.
 *
 * Tokens only; every word is the caller's.
 */

type CompareTone = 'default' | 'lit' | 'warn';

type CompareCell = {
  value: ReactNode;
  /** The two agree here: drawn lit. */
  same?: boolean;
  /** A figure: the mono face. */
  mono?: boolean;
};

type CompareRow = {
  /** Stable, and the row's label ("Name"). */
  label: string;
  cells: readonly [CompareCell, CompareCell];
};

type CompareTableProps = Omit<ComponentProps<'table'>, 'children'> & {
  /** The two columns' heads. */
  columns: readonly [
    { label: ReactNode; tone?: CompareTone },
    { label: ReactNode; tone?: CompareTone },
  ];
  rows: readonly CompareRow[];
  /** The table's name for a reader ("Same place?"). */
  'aria-label'?: string;
};

const HEAD_TONE: Record<CompareTone, string> = {
  default: 'text-fg3',
  lit: 'text-fg',
  warn: 'text-warn',
};

// The boards' 26 px head and 30 px rows, as token sums (inline: a class's arbitrary value would
// read a token's `_` as a space).
const HEAD_HEIGHT = { height: 'calc(var(--space-6) + var(--space-0_5))' } as const;
const ROW_HEIGHT = { height: 'calc(var(--space-7) + var(--space-0_5))' } as const;

const KICK = 'text-kick leading-none font-semibold tracking-kick uppercase';

function CompareTable({ columns, rows, className, ...props }: CompareTableProps) {
  return (
    <div data-slot="compare-table" className={cn('@container min-w-0', className)}>
      <table className="w-full table-fixed border-collapse" {...props}>
        {/* The label column: the boards' 96 px, narrower on a phone's page. */}
        <colgroup>
          <col className="w-(--space-20) @[26rem]:w-[6rem]" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr className="border-0 border-b-(length:--stroke-hair) border-solid border-line2">
            <td />
            {columns.map((c, i) => (
              <th
                // Two fixed columns: the position is the key.
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is its position
                key={i}
                scope="col"
                data-slot="compare-head"
                data-tone={c.tone ?? 'default'}
                className={cn(
                  KICK,
                  'pe-(--space-3) text-start align-middle',
                  HEAD_TONE[c.tone ?? 'default'],
                )}
                style={HEAD_HEIGHT}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.label}
              data-slot="compare-row"
              className="border-0 border-b-(length:--stroke-hair) border-dotted border-line"
            >
              <th
                scope="row"
                className={cn(
                  KICK,
                  'pe-(--space-2) text-start align-middle text-fg3 @[26rem]:whitespace-nowrap',
                )}
                style={ROW_HEIGHT}
              >
                {r.label}
              </th>
              {r.cells.map((cell, i) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its column
                  key={i}
                  data-slot="compare-cell"
                  data-same={cell.same ? '' : undefined}
                  className={cn(
                    'py-(--space-1) pe-(--space-3) align-middle break-words',
                    cell.mono
                      ? 'font-(family-name:--family-mono) text-mono-sm leading-none tracking-value tabular-nums'
                      : 'text-row leading-list',
                    cell.same ? 'text-fg' : 'text-fg2',
                  )}
                  style={ROW_HEIGHT}
                >
                  {cell.value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export {
  type CompareCell,
  type CompareRow,
  CompareTable,
  type CompareTableProps,
  type CompareTone,
};
