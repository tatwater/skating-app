import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowDownLong, faArrowUpLong } from '@fortawesome/sharp-regular-svg-icons';
import {
  type Cell,
  FlexRender,
  type Header,
  type ReactTable,
  type Row,
  type RowData,
  type TableFeatures,
} from '@tanstack/react-table';
import {
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useState,
} from 'react';

import { cn } from '@/lib/utils';
import { ListEnd } from './list-end';
import { SkeletonText } from './skeleton';

/**
 * The kit's Table: shadcn's Table markup married to TanStack Table v9, which stays headless — the
 * caller builds the table (`useTable`, its features, its column defs, its state) and hands it over;
 * the kit owns only the skin and the accessibility.
 *
 * - **No forced overflow wrapper.** shadcn wraps every table in an `overflow-x-auto` div, which
 *   also breaks a sticky head. Here the table sits straight in whatever scrolls it (the kit
 *   `ScrollArea`), and the head sticks to that scroller's top.
 * - **Rules**: a solid `line2` hairline under the heads, a dotted `line` hairline under each row.
 *   The rules are the cells' own bottom borders, cells meet edge to edge (no border spacing), and
 *   the space between columns is padding, never margin — so **every rule runs unbroken across
 *   the row**. The last row's rule is transparent, so it keeps the row height and the list ends on
 *   the list-end tab, not a rule.
 * - **Rows are exactly the surface's row height** (`size-td`): a cell's vertical padding is what is
 *   left of `size-td` after one line box and the rule, so a one-line row is the token to the pixel
 *   on either surface, and the cells of a row share one text baseline (a mono count beside a
 *   title). A wrapped cell grows its row; nothing clips.
 * - **The outer cells are the gutter** (`gap-gutter`, 20 px on the console): the rules run the
 *   pane's full width and the text still lines up with the pane. `inset` instead indents the whole
 *   table by the gutter — rules included — for a sheet or the inspector, whose rules never run
 *   into the gutters.
 * - **A row washes only if it's clickable** (`onRowClick`). A clickable row lights on hover or
 *   keyboard focus (one look), darkens a step while pressed, and is one tab stop for the whole
 *   table (↑↓ move, Home/End jump, ⏎ or Space press it). **Selected** is the lit plate register:
 *   the chosen wash, the bright ink and the 2 px select rule at its left edge. A non-clickable
 *   table never washes and never looks selected. **Dim** rows (a finished, hidden or inert item)
 *   step down to the faint ink.
 * - **Sort by clicking a heading.** A sortable heading is a button in its `th`: lit while sorted,
 *   with its arrow. The arrow has a fixed slot on the heading's open side (after a left-aligned
 *   heading, before a right-aligned one), reserved whether or not the column is sorted, so a
 *   heading's text never shifts and always meets its column's edge. `th` carries `scope="col"` and,
 *   when sortable, `aria-sort`.
 * - **Type**: heads are kickers; cells are the row step; `meta.mono` sets counts, stamps and ids in
 *   the mono step with tabular figures; `meta.lead` sets the row's subject in the bright ink;
 *   `meta.align: 'end'` right-aligns a value column and its head together.
 * - **Loading** is kit Skeleton rows at the exact row height (the table is `aria-busy`); **empty**
 *   says what the list is, in the list-end tab right under the heads. Under the last row sits the
 *   list-end tab with its count ("All 12").
 */

// ── Column meta ──────────────────────────────────────────────────────────────────────────────

/**
 * What a column def's `meta` may tell the skin. Register it for typing with TanStack's
 * `metaHelper`: `tableFeatures({ columnMeta: metaHelper<TableColumnMeta>(), … })`.
 */
type TableColumnMeta = {
  /** `end` right-aligns a value column and its head (counts, amounts, times). */
  align?: 'start' | 'end';
  /** Mono with tabular figures: counts, stamps, ids, coordinates. */
  mono?: boolean;
  /** The row's subject (its name or title), in the bright ink. */
  lead?: boolean;
  /** The column's width, as a CSS length (rem). Unset columns share what's left. */
  width?: string;
  /** How wide the loading skeleton's run is in this column (`8ch`, `60%`). */
  skeleton?: string;
};

function metaOf(def: { meta?: unknown }): TableColumnMeta {
  return (def.meta ?? {}) as TableColumnMeta;
}

// ── Primitives ───────────────────────────────────────────────────────────────────────────────

/** Every cell: edge to edge, the gutter at the table's outer edges (none when inset). */
const CELL = [
  'pr-(--space-2_5) text-left',
  'first:pl-(--gap-gutter) last:pr-(--gap-gutter)',
  'in-data-inset:first:pl-0 in-data-inset:last:pr-0',
  'data-[align=end]:text-right',
];

type TableProps = ComponentProps<'table'> & {
  /** Indent the table (rules too) by the gutter: for a sheet or the inspector. */
  inset?: boolean;
};

function Table({ inset = false, className, ...props }: TableProps) {
  return (
    <table
      data-slot="table"
      data-inset={inset ? '' : undefined}
      className={cn(
        'w-full border-separate border-spacing-0 text-row leading-list text-fg2',
        // The ground a sticky head paints over its rows; a table on another ground sets it.
        '[--table-ground:var(--bg)]',
        className,
      )}
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={className} {...props} />;
}

function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

type TableRowProps = ComponentProps<'tr'> & {
  /** Pressing the row does something: it washes when lit and takes a pointer. */
  clickable?: boolean;
  /** The chosen row (only a clickable row can be). */
  selected?: boolean;
  /** An inert or finished item, in the faint ink. */
  dim?: boolean;
};

function TableRow({
  clickable = false,
  selected = false,
  dim = false,
  className,
  ...props
}: TableRowProps) {
  const chosen = clickable && selected;
  return (
    <tr
      data-slot="table-row"
      data-clickable={clickable ? '' : undefined}
      data-selected={chosen ? '' : undefined}
      data-dim={dim ? '' : undefined}
      aria-current={chosen ? 'true' : undefined}
      className={cn(
        clickable && [
          'cursor-pointer outline-none',
          'transition-[background-color] duration-(--duration-fast) ease-standard',
          'lit:bg-lift-05 pressed:bg-lift-08',
          // Keyboard focus also draws an inset hairline: the row's edges are the pane's, so a ring
          // would clip.
          'focus-visible:outline-(length:--stroke-hair) focus-visible:-outline-offset-1 focus-visible:outline-fg focus-visible:outline-solid',
        ],
        chosen && 'bg-lift-08 text-fg lit:bg-lift-08 [&>td:first-child]:shadow-select-rule',
        dim && 'text-fg3',
        className,
      )}
      {...props}
    />
  );
}

type TableHeadProps = Omit<ComponentProps<'th'>, 'align'> & {
  align?: 'start' | 'end';
  /**
   * Makes the heading a sort button: its current direction (`false` when not sorted). Leave it
   * undefined for a heading that doesn't sort.
   */
  sort?: 'asc' | 'desc' | false;
  /** Pressing a sortable heading. */
  onSort?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Keep the head on the scroller's top (default). */
  sticky?: boolean;
};

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

function TableHead({
  align = 'start',
  sort,
  onSort,
  sticky = true,
  className,
  children,
  ...props
}: TableHeadProps) {
  const sortable = sort !== undefined;
  const label = (
    <span
      data-slot="table-head-label"
      // The kicker's tracking trails its last letter; a right-aligned head takes it back so its
      // last letter, not the tracking, meets the column's edge.
      className={cn(align === 'end' && 'mr-[calc(-1*var(--track-head))]')}
    >
      {children}
    </span>
  );
  const slot = sortable && (
    <span
      data-slot="table-sort"
      aria-hidden="true"
      className="inline-flex w-(--space-2) shrink-0 justify-center"
    >
      {sort !== false && (
        <FontAwesomeIcon
          icon={sort === 'asc' ? faArrowUpLong : faArrowDownLong}
          className="h-(--type-kick)"
        />
      )}
    </span>
  );
  return (
    <th
      data-slot="table-head"
      data-align={align}
      data-sorted={sort ? sort : undefined}
      scope="col"
      aria-sort={sortable ? (sort ? ARIA_SORT[sort] : 'none') : undefined}
      className={cn(
        CELL,
        'pt-(--space-1) pb-(--space-2) align-bottom whitespace-nowrap',
        'text-kick leading-none font-medium tracking-head text-fg3 uppercase',
        'border-0 border-b-(length:--stroke-hair) border-solid border-line2',
        'data-sorted:text-fg',
        sticky && 'sticky top-0 z-(--z-raised) bg-(--table-ground)',
        className,
      )}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          data-slot="table-sort-button"
          onClick={onSort}
          className={cn(
            'inline-flex cursor-pointer items-center gap-(--space-1_5) border-0 bg-transparent p-0',
            'font-[inherit] tracking-[inherit] text-inherit uppercase outline-none',
            'transition-[color] duration-(--duration-fast) ease-standard',
            'lit:text-fg1 focus-visible:shadow-focus in-data-sorted:lit:text-fg',
            align === 'end' && 'flex-row-reverse',
          )}
        >
          {label}
          {slot}
        </button>
      ) : (
        label
      )}
    </th>
  );
}

type TableCellProps = Omit<ComponentProps<'td'>, 'align'> & {
  align?: 'start' | 'end';
  mono?: boolean;
  lead?: boolean;
};

function TableCell({
  align = 'start',
  mono = false,
  lead = false,
  className,
  children,
  ...props
}: TableCellProps) {
  return (
    <td
      data-slot="table-cell"
      data-align={align}
      className={cn(
        CELL,
        // What's left of the row height after one line box and the rule, split above and below.
        'py-[calc((var(--size-td)_-_1lh_-_var(--stroke-hair))/2)] align-baseline',
        'border-0 border-b-(length:--stroke-hair) border-dotted border-line',
        'in-[tr:last-child]:border-b-transparent',
        lead && 'text-fg in-data-dim:text-fg3',
        className,
      )}
      {...props}
    >
      {mono ? (
        <span
          data-slot="table-mono"
          // Leading none: a mono box set on the row's baseline never pushes past the row's line box.
          className="font-(family-name:--family-mono) text-mono-sm leading-none tracking-value tabular-nums"
        >
          {children}
        </span>
      ) : (
        children
      )}
    </td>
  );
}

// ── DataTable: a TanStack table, skinned ─────────────────────────────────────────────────────

/** The sort API a column has when the caller registered TanStack's `rowSortingFeature`. */
type SortableColumn = {
  getCanSort?: () => boolean;
  getIsSorted?: () => false | 'asc' | 'desc';
  getToggleSortingHandler?: () => ((event: unknown) => void) | undefined;
};

/** A row's cells, minus hidden columns when the caller registered column visibility. */
function cellsOf<TFeatures extends TableFeatures, TData extends RowData>(
  row: Row<TFeatures, TData>,
): Cell<TFeatures, TData>[] {
  const visible = (row as { getVisibleCells?: () => Cell<TFeatures, TData>[] }).getVisibleCells;
  return visible ? visible.call(row) : row.getAllCells();
}

/**
 * What the kit reads from the caller's table: its heads and its rows. Whatever state
 * the caller's `useTable` selector subscribes to is the caller's business.
 */
type KitTable<TFeatures extends TableFeatures, TData extends RowData> = Pick<
  ReactTable<TFeatures, TData>,
  'getHeaderGroups' | 'getRowModel'
>;

type DataTableProps<TFeatures extends TableFeatures, TData extends RowData> = Omit<
  TableProps,
  'children'
> & {
  /** The caller's TanStack table (`useTable({ features, columns, data, … })`). */
  table: KitTable<TFeatures, TData>;
  /** What the list is when it's empty ("No invoices yet") — said in the list-end tab. */
  empty: ReactNode;
  /** The list-end tab's label under the last row ("All 12"). Omit for no tab. */
  end?: ReactNode;
  /** Loading: skeleton rows in place of the body (`true` is three). */
  loading?: boolean | number;
  /** Makes every row clickable (the wash, a pointer, the keyboard). */
  onRowClick?: (row: Row<TFeatures, TData>) => void;
  /** The chosen row(s) of a clickable table. */
  isRowSelected?: (row: Row<TFeatures, TData>) => boolean;
  /** Rows set in the faint ink. */
  isRowDim?: (row: Row<TFeatures, TData>) => boolean;
  /** Keep the heads on the scroller's top (default). */
  stickyHeader?: boolean;
};

function DataTable<TFeatures extends TableFeatures, TData extends RowData>({
  table,
  empty,
  end,
  loading = false,
  onRowClick,
  isRowSelected,
  isRowDim,
  stickyHeader = true,
  inset = false,
  className,
  ...props
}: DataTableProps<TFeatures, TData>) {
  const rows = table.getRowModel().rows;
  const clickable = onRowClick !== undefined;
  const [focused, setFocused] = useState<string | null>(null);
  const skeletons = loading === true ? 3 : loading === false ? 0 : loading;

  // One tab stop for the whole table: the row last focused, else the chosen one, else the first.
  const stop =
    rows.find((r) => r.id === focused)?.id ??
    rows.find((r) => isRowSelected?.(r))?.id ??
    rows[0]?.id;

  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, row: Row<TFeatures, TData>) => {
    const tr = event.currentTarget;
    const siblings = [
      ...(tr.parentElement?.querySelectorAll<HTMLElement>(':scope > [data-clickable]') ?? []),
    ];
    const at = siblings.indexOf(tr);
    const go = (i: number) => {
      event.preventDefault();
      siblings[Math.max(0, Math.min(siblings.length - 1, i))]?.focus();
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(siblings.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick?.(row);
    }
  };

  const headerGroups = table.getHeaderGroups();
  const leafHeaders = headerGroups.at(-1)?.headers ?? [];

  return (
    <div data-slot="data-table" className={cn('min-w-0', inset && 'px-(--gap-gutter)', className)}>
      <Table inset={inset} aria-busy={skeletons > 0 ? true : undefined} {...props}>
        <TableHeader>
          {headerGroups.map((group) => (
            <tr key={group.id} data-slot="table-head-row">
              {group.headers.map((header) => (
                <DataTableHead key={header.id} header={header} sticky={stickyHeader} />
              ))}
            </tr>
          ))}
        </TableHeader>
        <TableBody>
          {skeletons > 0
            ? Array.from({ length: skeletons }, (_, i) => (
                // Skeleton rows are positional and never reorder.
                // biome-ignore lint/suspicious/noArrayIndexKey: a placeholder is its index
                <TableRow key={i} aria-hidden="true" data-skeleton="">
                  {leafHeaders.map((header) => {
                    const meta = metaOf(header.column.columnDef);
                    return (
                      <TableCell key={header.id} align={meta.align}>
                        <SkeletonText
                          width={meta.skeleton ?? '60%'}
                          className={cn(meta.align === 'end' && 'ml-auto')}
                        />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            : rows.map((row) => (
                <TableRow
                  key={row.id}
                  clickable={clickable}
                  selected={isRowSelected?.(row) ?? false}
                  dim={isRowDim?.(row) ?? false}
                  {...(clickable && {
                    tabIndex: row.id === stop ? 0 : -1,
                    onClick: () => onRowClick(row),
                    onFocus: () => setFocused(row.id),
                    onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => onRowKey(event, row),
                  })}
                >
                  {cellsOf(row).map((cell) => {
                    const meta = metaOf(cell.column.columnDef);
                    return (
                      <TableCell key={cell.id} align={meta.align} mono={meta.mono} lead={meta.lead}>
                        <FlexRender cell={cell} />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
        </TableBody>
      </Table>
      {skeletons === 0 &&
        (rows.length === 0 ? <ListEnd>{empty}</ListEnd> : end != null && <ListEnd>{end}</ListEnd>)}
    </div>
  );
}

/** One heading: its label, and — when its column sorts — the sort button and `aria-sort`. */
function DataTableHead<TFeatures extends TableFeatures, TData extends RowData>({
  header,
  sticky,
}: {
  header: Header<TFeatures, TData>;
  sticky: boolean;
}) {
  const meta = metaOf(header.column.columnDef);
  const column = header.column as unknown as SortableColumn;
  const sortable = column.getCanSort?.() === true;
  const style: CSSProperties | undefined = meta.width ? { width: meta.width } : undefined;
  return (
    <TableHead
      colSpan={header.colSpan > 1 ? header.colSpan : undefined}
      align={meta.align}
      sticky={sticky}
      style={style}
      {...(sortable && {
        sort: column.getIsSorted?.() ?? false,
        onSort: (event) => column.getToggleSortingHandler?.()?.(event),
      })}
    >
      {header.isPlaceholder ? null : <FlexRender header={header} />}
    </TableHead>
  );
}

export {
  DataTable,
  type DataTableProps,
  Table,
  TableBody,
  TableCell,
  type TableCellProps,
  type TableColumnMeta,
  TableHead,
  TableHeader,
  type TableHeadProps,
  type TableProps,
  TableRow,
  type TableRowProps,
};
