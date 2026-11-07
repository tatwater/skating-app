import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createColumnHelper,
  createSortedRowModel,
  metaHelper,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor, sameShadow } from './measure';
import { ScrollArea } from './scroll-area';
import { KICKER, must } from './storyKit';
import { DataTable, type DataTableProps, type TableColumnMeta } from './table';

type Job = {
  id: string;
  name: string;
  last: string;
  runs: number;
  failed: number;
};

const JOBS: Job[] = [
  { id: 'sweep', name: 'Weather sweep', last: '6 Nov 02:00', runs: 412, failed: 3 },
  { id: 'watch', name: 'Season watch', last: '6 Nov 06:00', runs: 38, failed: 0 },
  { id: 'poll', name: 'Imagery poll', last: '6 Nov 12:40', runs: 1521, failed: 12 },
  { id: 'pump', name: 'Imagery pump', last: '6 Nov 12:57', runs: 9840, failed: 41 },
  { id: 'email', name: 'Staff email', last: '5 Nov 06:00', runs: 34, failed: 0 },
  { id: 'rollover', name: 'Rollovers', last: '1 Nov 00:00', runs: 7, failed: 1 },
];

const LONG: Job[] = Array.from({ length: 24 }, (_, i) => ({
  id: `night-${i}`,
  name: `Weather batch ${i + 1} of 24`,
  last: `6 Nov 02:${String(i * 2).padStart(2, '0')}`,
  runs: 400 + i * 3,
  failed: i % 5 === 0 ? 1 : 0,
}));

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  columnMeta: metaHelper<TableColumnMeta>(),
});
const helper = createColumnHelper<typeof features, Job>();
const columns = helper.columns([
  helper.accessor('name', { header: 'Job', meta: { lead: true, skeleton: '9rem' } }),
  helper.accessor('last', {
    header: 'Last run',
    meta: { mono: true, width: '9rem', skeleton: '6rem' },
  }),
  helper.accessor('runs', {
    header: 'Runs',
    cell: (c) => c.getValue().toLocaleString('en-US'),
    meta: { align: 'end', mono: true, width: '5rem', skeleton: '3rem' },
  }),
  helper.accessor('failed', {
    header: 'Failed',
    enableSorting: false,
    meta: { align: 'end', mono: true, width: '5rem', skeleton: '2rem' },
  }),
]);

const NONE: Job[] = [];

type JobsProps = Omit<
  DataTableProps<typeof features, Job>,
  'table' | 'empty' | 'onRowClick' | 'isRowSelected'
> & {
  data?: Job[];
  /** Clickable rows that pick one job. */
  pick?: boolean;
  /** Called with the job a row press picked. */
  onPick?: (id: string) => void;
  initialPick?: string;
};

/** The kit table over the jobs, as a page would build it: the caller owns `useTable`. */
function Jobs({ data = JOBS, pick = false, onPick, initialPick, ...props }: JobsProps) {
  const table = useTable({ features, columns, data, getRowId: (row) => row.id });
  const [picked, setPicked] = useState<string | undefined>(initialPick);
  return (
    <DataTable
      table={table}
      empty="No jobs yet"
      end={`All ${data.length}`}
      isRowDim={(row) => row.original.runs < 10}
      onRowClick={
        pick
          ? (row) => {
              setPicked(row.id);
              onPick?.(row.id);
            }
          : undefined
      }
      isRowSelected={pick ? (row) => row.id === picked : undefined}
      {...props}
    />
  );
}

const meta = {
  title: 'Kit/Table',
  component: Jobs,
  tags: ['autodocs'],
  decorators: [(Story) => <div className="w-full max-w-[36rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'shadcn’s Table on TanStack Table v9: the caller builds the table (features, columns, state); the kit owns the skin and the accessibility. A solid rule under the heads, dotted rules under the rows, **unbroken across the row**; rows exactly the surface’s row height; the gutter in the outer cells; sort by clicking a heading. A row washes only when it’s clickable.',
      },
    },
  },
} satisfies Meta<typeof Jobs>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Measuring ────────────────────────────────────────────────────────────────────────────────

const q = <T extends Element = HTMLElement>(scope: ParentNode, sel: string) =>
  must(scope.querySelector<T & Element>(sel)) as T;
const qa = (scope: ParentNode, sel: string) => [...scope.querySelectorAll<HTMLElement>(sel)];
const bodyRows = (scope: ParentNode) => [
  ...scope.querySelectorAll<HTMLTableRowElement>('tbody > tr'),
];
const near = (a: number, b: number) => Math.abs(a - b) <= JUNCTION_TOLERANCE_PX;

/**
 * Every row is `size-td` tall, every rule runs the table's full width — each cell starts where the
 * last ended, the first at the table's left, the last at its right — and the cells' rules are one
 * style: solid `line2` under the heads, dotted `line` under the rows.
 */
async function expectRules(table: HTMLElement) {
  const box = table.getBoundingClientRect();
  const td = resolvePx(table, 'var(--size-td)');
  const line = computedColor(table, 'var(--line)');
  const line2 = computedColor(table, 'var(--line2)');
  const hair = resolvePx(table, 'var(--stroke-hair)');
  const check = async (cells: HTMLElement[], style: string, color: string) => {
    const rects = cells.map((c) => c.getBoundingClientRect());
    await expect(near(rects[0]?.left ?? -1, box.left)).toBe(true);
    await expect(near(rects.at(-1)?.right ?? -1, box.right)).toBe(true);
    for (let i = 1; i < rects.length; i++) {
      await expect(near(must(rects[i]).left, must(rects[i - 1]).right)).toBe(true);
    }
    for (const c of cells) {
      const s = getComputedStyle(c);
      await expect(s.borderBottomStyle).toBe(style);
      await expect(parseFloat(s.borderBottomWidth)).toBe(hair);
      if (color) await expect(s.borderBottomColor).toEqual(sameColor(color));
      await expect(parseFloat(s.marginLeft || '0')).toBe(0);
    }
  };
  await check(qa(table, 'thead th'), 'solid', line2);
  const rows = bodyRows(table);
  for (const [i, row] of rows.entries()) {
    await expect(Math.abs(row.getBoundingClientRect().height - td)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    // The last row's rule is there but transparent: it keeps the height, the tab ends the list.
    await check(qa(row, 'td'), 'dotted', i === rows.length - 1 ? '' : line);
  }
}

/** The outer cells' padding is the gutter, so text lines up with the pane. */
async function expectGutterCells(table: HTMLElement) {
  const gutter = resolvePx(table, 'var(--gap-gutter)');
  for (const row of qa(table, 'tr')) {
    const cells = qa(row, 'th, td');
    await expect(parseFloat(getComputedStyle(must(cells[0])).paddingLeft)).toBeCloseTo(gutter, 1);
    await expect(parseFloat(getComputedStyle(must(cells.at(-1))).paddingRight)).toBeCloseTo(
      gutter,
      1,
    );
  }
}

/** The y of a cell's first text baseline (a zero-size inline-block on the line). */
function baselineOf(cell: HTMLElement): number {
  const host = cell.querySelector<HTMLElement>('[data-slot="table-mono"]') ?? cell;
  const probe = document.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  host.prepend(probe);
  const y = probe.getBoundingClientRect().bottom;
  probe.remove();
  return y;
}

// ── Stories ──────────────────────────────────────────────────────────────────────────────────

/**
 * A read-only table: no row washes on hover (nothing happens on a click). Rules unbroken, rows at
 * the row height, the gutter in the outer cells, one baseline per row, and the list-end tab.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const table = q(canvasElement, 'table');
    await expectRules(table);
    await expectGutterCells(table);
    // One baseline across the row: the lead title and the mono stamp and counts.
    for (const row of bodyRows(table)) {
      const [first, ...rest] = qa(row, 'td').map(baselineOf);
      for (const y of rest) await expect(Math.abs(y - must(first))).toBeLessThanOrEqual(0.5);
    }
    // Not clickable: no pointer, no tab stop — and no wash even when focus lands on it. (Headless
    // Chromium doesn't hover, so the lit look is checked through focus, which shares it.)
    const row = must(bodyRows(table)[1]);
    const before = getComputedStyle(row).backgroundColor;
    await expect(getComputedStyle(row).cursor).not.toBe('pointer');
    await expect(row).not.toHaveAttribute('tabindex');
    row.tabIndex = -1;
    row.focus();
    await expect(getComputedStyle(row).backgroundColor).toEqual(sameColor(before));
    row.blur();
    row.removeAttribute('tabindex');
    // The list ends on its tab, not a rule.
    const end = q(canvasElement, '[data-slot="list-end"]');
    await expect(end).toHaveTextContent('All 6');
  },
};

/**
 * Sort by clicking a heading: it lights, its arrow appears in the slot it always kept, and the
 * heading's text doesn't move. `aria-sort` follows; a column that doesn't sort has none.
 */
export const Sorting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const job = must(canvas.getByRole('columnheader', { name: 'Job' }));
    const runs = must(canvas.getByRole('columnheader', { name: 'Runs' }));
    const failed = must(canvas.getByRole('columnheader', { name: 'Failed' }));
    for (const th of [job, runs, failed]) await expect(th).toHaveAttribute('scope', 'col');
    await expect(job).toHaveAttribute('aria-sort', 'none');
    await expect(failed).not.toHaveAttribute('aria-sort');
    await expect(failed.querySelector('button')).toBeNull();

    const label = (th: HTMLElement) => q(th, '[data-slot="table-head-label"]');
    const at = (th: HTMLElement) => label(th).getBoundingClientRect();
    const restJob = at(job);
    const restRuns = at(runs);
    const fg3 = computedColor(job, 'var(--fg3)');
    const fg = computedColor(job, 'var(--fg)');
    await expect(getComputedStyle(job).color).toEqual(sameColor(fg3));

    // A left-aligned heading: the arrow trails it, the text stays put.
    await userEvent.click(within(job).getByRole('button'));
    await waitFor(() => expect(job).toHaveAttribute('aria-sort', 'ascending'));
    await expect(job.querySelector('svg')).not.toBeNull();
    await expect(at(job).left).toBe(restJob.left);
    await expect(getComputedStyle(job).color).toEqual(sameColor(fg));
    const names = () => bodyRows(canvasElement).map((r) => r.cells[0]?.textContent);
    await expect(names()).toEqual([...JOBS.map((j) => j.name)].sort());
    await userEvent.click(within(job).getByRole('button'));
    await waitFor(() => expect(job).toHaveAttribute('aria-sort', 'descending'));
    await expect(at(job).left).toBe(restJob.left);

    // A right-aligned heading: the arrow leads it, so its text keeps meeting the column's edge.
    await userEvent.click(within(runs).getByRole('button'));
    await waitFor(() => expect(runs).not.toHaveAttribute('aria-sort', 'none'));
    await expect(job).toHaveAttribute('aria-sort', 'none');
    await expect(at(runs).right).toBe(restRuns.right);
    const counts = bodyRows(canvasElement).map((r) =>
      Number(r.cells[2]?.textContent?.replaceAll(',', '')),
    );
    const sorted = [...counts].sort((a, b) => a - b);
    await expect([sorted, [...sorted].reverse()]).toContainEqual(counts);
    // The arrow's slot and the text are inside the heading's padding: the head row didn't grow.
    await expectRules(q(canvasElement, 'table'));
    // Keyboard: a heading's button takes focus and Enter sorts.
    within(job).getByRole('button').focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(job).not.toHaveAttribute('aria-sort', 'none'));
  },
};

/**
 * Clickable rows: the wash on hover or focus, a darker step while pressed, the chosen row in the
 * lit plate register (the chosen wash, the bright ink, the select rule). One tab stop: ↑↓ move,
 * Enter presses. The dim row (fewer than ten runs) steps down to the faint ink.
 */
export const Clickable: Story = {
  args: { pick: true, initialPick: 'poll', onPick: fn() },
  play: async ({ canvasElement, args }) => {
    const table = q(canvasElement, 'table');
    const rows = bodyRows(table);
    const chosen = must(rows[2]);
    const lift05 = computedColor(table, 'var(--lift-05)');
    const lift08 = computedColor(table, 'var(--lift-08)');
    const fg = computedColor(table, 'var(--fg)');
    const fg3 = computedColor(table, 'var(--fg3)');
    await expectRules(table);

    // The chosen row.
    await expect(chosen).toHaveAttribute('aria-current', 'true');
    await expect(getComputedStyle(chosen).backgroundColor).toEqual(sameColor(lift08));
    await expect(getComputedStyle(chosen).color).toEqual(sameColor(fg));
    const rule = getComputedStyle(must(chosen.cells[0])).boxShadow;
    await expect(rule).toEqual(sameShadow({ lengths: [2, 0, 0, 0], inset: true }));
    await expect(getComputedStyle(must(chosen.cells[1])).boxShadow).toBe('none');

    // One tab stop for the table: the chosen row, until focus moves.
    await expect(rows.filter((r) => r.tabIndex === 0)).toEqual([chosen]);

    // A clickable row lights (hover and keyboard focus share the look; headless Chromium doesn't
    // hover, so focus shows it) and takes a pointer.
    const other = must(rows[0]);
    await expect(getComputedStyle(other).cursor).toBe('pointer');
    other.focus();
    await waitFor(() => expect(getComputedStyle(other).backgroundColor).toEqual(sameColor(lift05)));
    await expect(getComputedStyle(other).outlineStyle).toBe('solid');
    other.blur();

    // The dim row.
    const dim = must(rows[5]);
    await expect(dim).toHaveAttribute('data-dim');
    await expect(getComputedStyle(must(dim.cells[0])).color).toEqual(sameColor(fg3));

    // The arrows move along the rows, and the tab stop follows focus.
    chosen.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(document.activeElement).toBe(rows[3]);
    await waitFor(() =>
      expect(getComputedStyle(must(rows[3])).backgroundColor).toEqual(sameColor(lift05)),
    );
    await expect(rows.filter((r) => r.tabIndex === 0)).toEqual([rows[3]]);
    await userEvent.keyboard('{End}');
    await expect(document.activeElement).toBe(rows[5]);
    await userEvent.keyboard('{ArrowDown}');
    await expect(document.activeElement).toBe(rows[5]);
    await userEvent.keyboard('{Home}');
    await expect(document.activeElement).toBe(rows[0]);
    await userEvent.keyboard('{ArrowUp}');
    await expect(document.activeElement).toBe(rows[0]);
    await userEvent.keyboard('{Enter}');
    await expect(args.onPick).toHaveBeenLastCalledWith('sweep');
    await waitFor(() => expect(rows[0]).toHaveAttribute('aria-current', 'true'));
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(' ');
    await expect(args.onPick).toHaveBeenLastCalledWith('watch');
    // A click picks too; other keys do nothing.
    await userEvent.keyboard('a');
    await userEvent.click(must(rows[4]).cells[0] as HTMLElement);
    await expect(args.onPick).toHaveBeenLastCalledWith('email');
    await expect(args.onPick).toHaveBeenCalledTimes(3);
    (document.activeElement as HTMLElement | null)?.blur();
  },
};

const noteColumns = helper.columns([
  helper.accessor('name', { header: 'Job', meta: { lead: true } }),
  helper.display({
    id: 'note',
    header: 'Note',
    cell: (c) => <input aria-label={`Note for ${c.row.original.name}`} defaultValue="" />,
  }),
]);

/** A clickable table with a field in each row. */
function JobsWithNotes({ onRowClick }: { onRowClick: () => void }) {
  const table = useTable({
    features,
    columns: noteColumns,
    data: JOBS,
    getRowId: (row) => row.id,
  });
  return <DataTable table={table} empty="No jobs yet" onRowClick={onRowClick} />;
}

/**
 * A control in a cell keeps its own presses and keys: a click into a row's field doesn't press the
 * row, typing a space or pressing Enter there types and presses nothing, and the arrows, Home and
 * End stay in the field — none of them is the row's. On the row itself, they are.
 */
export const ControlsInCells: Story = {
  args: { onPick: fn() },
  render: (args) => <JobsWithNotes onRowClick={args.onPick as () => void} />,
  play: async ({ canvasElement, args }) => {
    const field = within(canvasElement).getByRole('textbox', { name: 'Note for Season watch' });
    await userEvent.click(field);
    await userEvent.keyboard('Ice by the ramp{Enter}{Home}{End}{ArrowDown}{ArrowUp}');
    await expect(field).toHaveValue('Ice by the ramp');
    await expect(field).toHaveFocus();
    await expect(args.onPick).not.toHaveBeenCalled();
    // The row's own keys still work on the row.
    const row = must(field.closest('tr'));
    row.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onPick).toHaveBeenCalledTimes(1);
    await userEvent.click(must(row.cells[0]));
    await expect(args.onPick).toHaveBeenCalledTimes(2);
    await userEvent.keyboard('{ArrowDown}');
    await expect(document.activeElement).toBe(row.nextElementSibling);
    (document.activeElement as HTMLElement | null)?.blur();
  },
};

/** Loading: skeleton rows exactly the row height, under the real heads; the table is busy. */
export const Loading: Story = {
  args: { loading: 4 },
  play: async ({ canvasElement }) => {
    const table = q(canvasElement, 'table');
    await expect(table).toHaveAttribute('aria-busy', 'true');
    const rows = bodyRows(table);
    await expect(rows).toHaveLength(4);
    for (const r of rows) await expect(r).toHaveAttribute('aria-hidden', 'true');
    await expect(qa(table, '[data-slot="skeleton"]')).toHaveLength(16);
    await expectRules(table);
    // No tab while loading.
    await expect(canvasElement.querySelector('[data-slot="list-end"]')).toBeNull();
  },
};

/** `loading` set to `true` holds three rows. */
export const LoadingDefault: Story = {
  name: 'Loading (default count)',
  args: { loading: true },
  play: async ({ canvasElement }) => {
    await expect(bodyRows(canvasElement)).toHaveLength(3);
  },
};

/** Empty: the heads, then the list-end tab saying what the list is, just under the head rule. */
export const Empty: Story = {
  args: { data: NONE },
  play: async ({ canvasElement }) => {
    await expect(bodyRows(canvasElement)).toHaveLength(0);
    const end = q(canvasElement, '[data-slot="list-end"]');
    await expect(end).toHaveTextContent('No jobs yet');
    const head = q(canvasElement, 'thead').getBoundingClientRect();
    const gap = end.getBoundingClientRect().top - head.bottom;
    await expect(gap).toBeCloseTo(resolvePx(end, 'var(--space-0_5)'), 1);
  },
};

/**
 * In the kit ScrollArea, the heads stick to the top of the pane as the rows scroll under them,
 * on the pane's ground.
 */
export const StickyHeader: Story = {
  args: { data: LONG },
  render: (args) => (
    <ScrollArea className="h-[16rem] border border-solid border-line">
      <Jobs {...args} />
    </ScrollArea>
  ),
  play: async ({ canvasElement }) => {
    const viewport = q(canvasElement, '[data-slot="scroll-area-viewport"]');
    const th = q(canvasElement, 'thead th');
    await expect(getComputedStyle(th).position).toBe('sticky');
    await expect(getComputedStyle(th).backgroundColor).toEqual(
      sameColor(computedColor(th, 'var(--bg)')),
    );
    viewport.scrollTop = 200;
    await waitFor(() =>
      expect(near(th.getBoundingClientRect().top, viewport.getBoundingClientRect().top)).toBe(true),
    );
    viewport.scrollTop = 0;
  },
};

/**
 * Inset, for a sheet or the inspector: the whole table — rules included — sits in by the gutter,
 * and the outer cells have no padding of their own.
 */
export const Inset: Story = {
  args: { inset: true },
  play: async ({ canvasElement }) => {
    const wrap = q(canvasElement, '[data-slot="data-table"]');
    const table = q(canvasElement, 'table');
    const gutter = resolvePx(table, 'var(--gap-gutter)');
    await expect(
      table.getBoundingClientRect().left - wrap.getBoundingClientRect().left,
    ).toBeCloseTo(gutter, 1);
    await expect(
      wrap.getBoundingClientRect().right - table.getBoundingClientRect().right,
    ).toBeCloseTo(gutter, 1);
    const first = q(table, 'tbody td');
    await expect(parseFloat(getComputedStyle(first).paddingLeft)).toBe(0);
    await expectRules(table);
  },
};

/** No end label: the table ends on its last row's spacing. */
export const NoEnd: Story = {
  args: { end: undefined, stickyHeader: false },
  render: (args) => {
    const { end: _end, ...rest } = args;
    return <JobsNoEnd {...rest} />;
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="list-end"]')).toBeNull();
    await expect(getComputedStyle(q(canvasElement, 'thead th')).position).toBe('static');
  },
};

function JobsNoEnd(props: JobsProps) {
  const table = useTable({ features, columns, data: JOBS, getRowId: (row) => row.id });
  return <DataTable table={table} empty="No jobs yet" {...props} />;
}

/**
 * All four maps. Each surface keeps its own row height (`size-td`: 32 px on the console, 36 px on
 * skater) and its gutter in the outer cells (20 px / 28 px); rules unbroken in all four.
 */
export const FourUp: Story = {
  args: { pick: true, initialPick: 'poll' },
  render: (args) => (
    <div className="flex flex-col gap-(--space-3) p-(--space-4)">
      <span className={KICKER}>Every job</span>
      <Jobs {...args} />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = qa(canvasElement, '[data-theme-scope]');
    await expect(quads).toHaveLength(4);
    const px = { admin: { td: 32, gutter: 20 }, skater: { td: 36, gutter: 28 } } as const;
    for (const quad of quads) {
      const surface = quad.dataset.surface as keyof typeof px;
      const table = q(quad, 'table');
      await expectRules(table);
      await expectGutterCells(table);
      const row = must(bodyRows(table)[0]);
      await expect(row.getBoundingClientRect().height).toBeCloseTo(px[surface].td, 1);
      await expect(parseFloat(getComputedStyle(must(row.cells[0])).paddingLeft)).toBeCloseTo(
        px[surface].gutter,
        1,
      );
    }
  },
};
