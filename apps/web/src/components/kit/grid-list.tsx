import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's grid lists: the boards' small tables drawn as CSS grids — the key/value block, history
 * with Undo, invoice rows. One mechanism under all three:
 *
 * - **Every row is a subgrid** spanning the list's columns, so cells align down the list and the
 *   row — not a cell — carries the rule. **A rule is therefore unbroken across the column gaps**
 *   (R8): it is the row's own edge, and the gaps are inside the row.
 * - **Dividers are padding, never margin** (R9): a ruled row's spacing is its own vertical padding,
 *   and rows meet edge to edge, so the rules are evenly spaced and nothing leaks between them.
 * - **A list ends on its spacing, never a rule**: the last row has none. There is no rule over the
 *   first row either — whatever heads the list (a section slug) brings its own.
 * - **One baseline per row**: a row's cells align on their first text baseline (title, mono value
 *   and time read as one line); a button in a row centers instead.
 * - Rows are not interactive: no hover wash (a row looks hovered only if clicking it does
 *   something). An action in a row is its own button.
 */

type GridListProps = ComponentProps<'ul'> & {
  /** The column template (`grid-template-columns`), in rem or fractions. */
  columns: string;
  /** Rows divided by dotted rules (with their padding), or set on the list's row gap alone. */
  ruled?: boolean;
};

/** The grid every row subgrids into. Unruled lists space rows on the row gap (`space-1_5`). */
function GridList({ columns, ruled = true, className, style, ...props }: GridListProps) {
  return (
    <ul
      data-slot="grid-list"
      data-ruled={ruled ? '' : undefined}
      className={cn(
        'grid min-w-0 gap-x-(--space-2_5)',
        ruled ? 'gap-y-0' : 'gap-y-(--space-1_5)',
        className,
      )}
      style={{ gridTemplateColumns: columns, ...style } as CSSProperties}
      {...props}
    />
  );
}

/**
 * A row: spans every column as a subgrid; in a ruled list, padded above and below with a dotted
 * hairline under it (not under the last).
 */
function GridListRow({ className, ...props }: ComponentProps<'li'>) {
  return (
    <li
      data-slot="grid-list-row"
      className={cn(
        'col-span-full grid grid-cols-subgrid items-baseline',
        'in-data-ruled:border-b-(length:--stroke-hair) in-data-ruled:border-dotted in-data-ruled:border-line',
        'in-data-ruled:py-(--space-2) in-data-ruled:last:border-b-0',
        className,
      )}
      {...props}
    />
  );
}

// ── Key / value ──────────────────────────────────────────────────────────────────────────────

/** A key/value block. The key column is the boards' 84 px (5.25rem), unless `keyWidth` says. */
function KeyValueList({
  keyWidth = '5.25rem',
  ruled = false,
  ...props
}: Omit<GridListProps, 'columns'> & { keyWidth?: string }) {
  return (
    <GridList
      data-variant="key-value"
      columns={`${keyWidth} minmax(0, 1fr)`}
      ruled={ruled}
      {...props}
    />
  );
}

type KeyValueRowProps = Omit<ComponentProps<'li'>, 'children'> & {
  /** The key, written capitalized ("Source"); set as a kicker. */
  label: ReactNode;
  children: ReactNode;
  /** Mono value (an id, a coordinate, a count). */
  mono?: boolean;
};

/** One key and its value, on one baseline. */
function KeyValueRow({ label, mono = false, children, className, ...props }: KeyValueRowProps) {
  return (
    <GridListRow data-slot="key-value-row" className={className} {...props}>
      <span
        data-slot="key"
        className="text-kick leading-list font-medium tracking-head text-fg3 uppercase"
      >
        {label}
      </span>
      <span
        data-slot="value"
        className={cn(
          'min-w-0 text-row leading-list text-fg1',
          mono && 'font-(family-name:--family-mono) text-assist tracking-value',
        )}
      >
        {children}
      </span>
    </GridListRow>
  );
}

// ── History with Undo ────────────────────────────────────────────────────────────────────────

/** History: when · what (and who, under it) · the row's way back. */
function HistoryList(props: Omit<GridListProps, 'columns' | 'ruled'>) {
  return (
    <GridList
      data-variant="history"
      // The time column is the boards' 54 px (3.375rem); the action hugs its button.
      columns="3.375rem minmax(0, 1fr) auto"
      {...props}
    />
  );
}

type HistoryRowProps = Omit<ComponentProps<'li'>, 'children'> & {
  /** When ("14:41", "Sat", "3 Oct") — mono, the row's first baseline. */
  when: ReactNode;
  /** What happened, from the operator's side ("Rate updated", "Hidden · reason kept"). */
  children: ReactNode;
  /** Who did it — on its own line under what, never after a "·". */
  who?: ReactNode;
  /**
   * The row's way back (a kit `Button`, `size="xs"`: *Undo*, *Restore*, *Unmerge*). Omit it when
   * the row can't be undone; the column keeps its place.
   */
  action?: ReactNode;
};

/** One entry: time and what share a baseline; the action centers on the row. */
function HistoryRow({ when, who, action, children, className, ...props }: HistoryRowProps) {
  return (
    <GridListRow
      data-slot="history-row"
      className={cn('min-h-td in-data-ruled:py-(--space-1_5)', className)}
      {...props}
    >
      <span
        data-slot="history-when"
        className="font-(family-name:--family-mono) text-mono-sm leading-list text-fg3 tabular-nums"
      >
        {when}
      </span>
      <span data-slot="history-what" className="flex min-w-0 flex-col gap-(--space-0_5)">
        <span className="text-row leading-list text-fg1">{children}</span>
        {who != null && (
          <span data-slot="history-who" className="text-assist leading-list text-fg3">
            {who}
          </span>
        )}
      </span>
      <span data-slot="history-action" className="flex self-center justify-self-end">
        {action}
      </span>
    </GridListRow>
  );
}

// ── Invoices ─────────────────────────────────────────────────────────────────────────────────

/** Invoice rows: vendor and period · amount, with a note across the row under them. */
function InvoiceList(props: Omit<GridListProps, 'columns' | 'ruled'>) {
  return <GridList data-variant="invoice" columns="minmax(0, 1fr) auto" {...props} />;
}

type InvoiceRowProps = Omit<ComponentProps<'li'>, 'children'> & {
  /** Who billed ("Convex"). */
  vendor: ReactNode;
  /** The billing period ("Sep 2026"). */
  period?: ReactNode;
  /** The amount, with its "$" ("$25.00"). Mono, right-aligned. */
  amount: ReactNode;
  /** The note under the row ("Pro plan · 1 seat"). */
  children?: ReactNode;
  /** At the note's end: the bill's link (a kit `Button` `variant="link"`, `size="xs"`). */
  action?: ReactNode;
};

/** One invoice: vendor, period and amount on one baseline; the note spans the row under them. */
function InvoiceRow({
  vendor,
  period,
  amount,
  action,
  children,
  className,
  ...props
}: InvoiceRowProps) {
  return (
    <GridListRow
      data-slot="invoice-row"
      className={cn('gap-y-(--space-1_5) in-data-ruled:py-(--space-3)', className)}
      {...props}
    >
      <span data-slot="invoice-vendor" className="min-w-0 truncate text-body leading-list text-fg">
        {vendor}
        {period != null && (
          <span data-slot="invoice-period" className="ms-(--space-2) text-assist text-fg3">
            {period}
          </span>
        )}
      </span>
      <span
        data-slot="invoice-amount"
        className="text-right font-(family-name:--family-mono) text-row leading-list font-medium tracking-value text-fg tabular-nums"
      >
        {amount}
      </span>
      {(children != null || action != null) && (
        <span
          data-slot="invoice-note"
          className="col-span-full flex min-w-0 items-center gap-(--space-2_5) text-assist leading-list text-fg2"
        >
          <span className="min-w-0 truncate">{children}</span>
          {action != null && <span className="ms-auto flex shrink-0">{action}</span>}
        </span>
      )}
    </GridListRow>
  );
}

export {
  GridList,
  type GridListProps,
  GridListRow,
  HistoryList,
  HistoryRow,
  type HistoryRowProps,
  InvoiceList,
  InvoiceRow,
  type InvoiceRowProps,
  KeyValueList,
  KeyValueRow,
  type KeyValueRowProps,
};
