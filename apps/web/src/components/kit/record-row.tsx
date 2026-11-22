import type { ComponentProps, ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { cn } from '@/lib/utils';

/**
 * **The record row** (the record sheet's list, 8.7–8.9; promoted for the Inbox): one thing on a person's
 * record, read across three lines — its chips (the kind, then its states), its words, where and
 * when, and why — with its age at the right.
 *
 * - **The row is one button** that opens the item in the pane beside (`aria-current` while open):
 *   the open row carries the selection wash and the white rule on its left edge; hover is the quiet
 *   lift. The list gives it its tab stop (one row tabbable, the arrows rove — `RecordRowList`).
 * - **An action of its own sits beside the button, never inside it** (`action`: a restore's
 *   *Undo*), under the age at the right, so a reader reaches it as its own control.
 * - **`back`** — a row whose state was just given back in this sitting: its words step down a tone
 *   (the restored row keeps its place until the sheet closes, 8.8).
 * - **Words that are gone** (`gone`) read in italics in the faint ink (*The words were erased*).
 * - Rows sit on dotted rules, the gutter in from each edge (rem, D233).
 */

export type RecordRowChip = { label: string; lit?: boolean };

type RecordRowProps = Omit<ComponentProps<'button'>, 'children' | 'title'> & {
  chips: readonly RecordRowChip[];
  title: ReactNode;
  /** The words are gone or were never written. */
  gone?: boolean;
  /** The lines under the title: where and when, then why. */
  lines: readonly ReactNode[];
  /** The right column, on the chips' line: an age, a time. */
  meta?: ReactNode;
  /** Open in the pane beside. */
  selected?: boolean;
  /** Given back in this sitting: its words a tone down. */
  back?: boolean;
  /** A control of the row's own (*Undo*), beside the row's button. */
  action?: ReactNode;
};

function RecordRow({
  chips,
  title,
  gone = false,
  lines,
  meta,
  selected = false,
  back = false,
  action,
  className,
  ...props
}: RecordRowProps) {
  return (
    <li
      data-slot="record-row"
      data-selected={selected ? '' : undefined}
      data-back={back ? '' : undefined}
      className="relative list-none border-0 border-b-(length:--stroke-hair) border-dotted border-line"
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? '' : undefined}
        data-slot="record-row-button"
        className={cn(
          'grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-(--space-3) border-0 bg-transparent px-gutter py-(--space-2_5) text-left',
          'transition-[background-color] duration-(--duration-fast) ease-standard',
          'outline-none focus-visible:shadow-select-rule focus-visible:bg-lift-05',
          '[@media(hover:hover)]:not-data-selected:hover:bg-lift-05',
          'data-selected:bg-lift-08 data-selected:shadow-select-rule',
          className,
        )}
        {...props}
      >
        {chips.length > 0 && (
          <span
            data-slot="record-row-chips"
            className="col-start-1 row-start-1 mb-(--space-1_5) flex min-w-0 flex-wrap items-center gap-(--space-1_5)"
          >
            {chips.map((chip) => (
              <Badge key={chip.label} variant="outline" tone={chip.lit ? 'lit' : 'default'}>
                {chip.label}
              </Badge>
            ))}
          </span>
        )}
        {meta != null && (
          <span
            data-slot="record-row-meta"
            className="col-start-2 row-start-1 font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg3"
          >
            {meta}
          </span>
        )}
        <span
          data-slot="record-row-title"
          className={cn(
            'col-span-2 col-start-1 row-start-2 min-w-0 truncate text-body leading-(--lead-snug) font-medium text-fg1',
            'in-data-selected:text-fg',
            back && 'text-fg2 in-data-selected:text-fg1',
            gone && 'font-normal text-fg3 italic in-data-selected:text-fg2',
          )}
        >
          {title}
        </span>
        {lines.map((line, i) => (
          <span
            // Lines are positional: the place, then the reason.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional
            key={i}
            data-slot="record-row-line"
            className={cn(
              'col-span-2 col-start-1 mt-(--space-0_5) min-w-0 truncate text-assist leading-list text-fg3 in-data-selected:text-fg2',
              back && 'text-fg3',
              // The row's own control sits at the right of its last lines: they stop short of it.
              action !== undefined && 'pe-[5rem]',
            )}
            style={{ gridRowStart: i + 3 }}
          >
            {line}
          </span>
        ))}
      </button>
      {action !== undefined && (
        <span
          data-slot="record-row-action"
          className="absolute end-gutter bottom-(--space-2_5) flex items-center"
        >
          {action}
        </span>
      )}
    </li>
  );
}

/** The reason in a row's line: the quoted words a tone up from the line. */
function RecordRowQuote({ children }: { children: ReactNode }) {
  return (
    <span data-slot="record-row-quote" className="text-fg1 in-data-selected:text-fg">
      “{children}”
    </span>
  );
}

export { RecordRow, type RecordRowProps, RecordRowQuote };
