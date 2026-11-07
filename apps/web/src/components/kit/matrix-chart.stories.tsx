import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  MatrixChart,
  type MatrixColumn,
  MatrixLegend,
  type MatrixRow,
  TEMP_STEPS,
  temperatureStep,
} from './matrix-chart';
import {
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { must } from './storyKit';

const meta = {
  title: 'Kit/MatrixChart',
  component: MatrixChart,
  tags: ['autodocs'],
  decorators: [(Story) => <div className="w-full max-w-[40rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'The temperature matrix: a CSS grid, one cell a night for each place, in the temperature scale (cyan under freezing, neutral at it, orange above). Values flip to the dark ink on the bright cells; one hover plate; arrow keys move between cells.',
      },
    },
  },
} satisfies Meta<typeof MatrixChart>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Data: overnight lows (°F) at three sentinel lakes, 1–12 Oct ────────────────────────────────

const NIGHTS: MatrixColumn[] = Array.from({ length: 12 }, (_, i) => ({
  key: `n${i + 1}`,
  label: `${i + 1} Oct`,
}));

const SENTINELS: MatrixRow[] = [
  { key: 'clouds', label: 'Clouds', values: [34, 31, 27, 30, 24, 29, 19, 25, 28, 33, 30, 31] },
  { key: 'eagle', label: 'Eagle', values: [36, 33, 30, 31, 27, 31, 19, 26, 30, 35, 32, 33] },
  { key: 'kinsman', label: 'Kinsman', values: [40, 38, 35, 36, 33, 35, 27, 32, 34, 38, 36, 37] },
];

/** One row that runs the whole scale, coldest to warmest, and a night with no reading. */
const SCALE_ROW: MatrixRow[] = [
  {
    key: 'scale',
    label: 'Scale',
    values: [15, 22, 26, 30, 33, 35, 38, 42, null],
  },
];
const SCALE_COLS: MatrixColumn[] = SCALE_ROW[0]?.values.map((_, i) => ({
  key: `s${i}`,
  label: `${i + 1} Dec`,
})) as MatrixColumn[];

const cellsOf = (el: Element) => [...el.querySelectorAll<HTMLElement>('[role="gridcell"]')];
const near = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);

/**
 * Every cell's value must read as a mark on its own ground: 3:1 (WCAG's non-text contrast) or
 * better, measured as painted. A cell with no reading has no value to read.
 */
async function expectInksPass(scope: HTMLElement) {
  for (const cell of cellsOf(scope)) {
    const value = cell.querySelector('[data-slot="matrix-value"]');
    if (value === null) continue;
    const ratio = contrastBetween(
      scope,
      [getComputedStyle(cell).backgroundColor],
      [getComputedStyle(value).color],
    );
    await expect(
      ratio,
      `${cell.getAttribute('aria-label')} (${cell.dataset.step})`,
    ).toBeGreaterThanOrEqual(3);
  }
}

// ── Stories ──────────────────────────────────────────────────────────────────────────────────

/**
 * The Season board's matrix: three sentinels over twelve nights, the names in the kicker column,
 * the first and last night under the cells, the legend below.
 */
export const Season: Story = {
  args: {
    rows: SENTINELS,
    columns: NIGHTS,
    'aria-label': 'Overnight lows at the sentinels, 1–12 Oct',
  },
  render: (args) => (
    <div className="flex flex-col gap-(--space-2_5)">
      <MatrixChart {...args} />
      <MatrixLegend />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const grid = within(canvasElement).getByRole('grid', {
      name: 'Overnight lows at the sentinels, 1–12 Oct',
    });
    const cells = cellsOf(grid);
    await expect(cells).toHaveLength(36);
    // A cell is a kicker and a step tall; cells 4 px apart, rows 5 px apart.
    const h = resolvePx(grid, 'calc(var(--type-kick) + var(--space-0_5))');
    for (const c of cells) near(c.getBoundingClientRect().height, h);
    const r = (i: number) => must(cells[i]).getBoundingClientRect();
    near(r(1).left - r(0).right, resolvePx(grid, 'var(--space-1)'));
    near(r(12).top - r(0).bottom, resolvePx(grid, '0.3125rem'));
    // The kicker column: at least 3.75 rem (it fits the longest name), then `space-2_5`.
    const kicker = must(grid.querySelector<HTMLElement>('[data-slot="matrix-row-kicker"]'));
    const k = kicker.getBoundingClientRect();
    await expect(k.width).toBeGreaterThanOrEqual(
      resolvePx(grid, '3.75rem') - JUNCTION_TOLERANCE_PX,
    );
    near(r(0).left - k.right, resolvePx(grid, 'var(--space-2_5)'));
    // No name is cut: every kicker's text fits its box.
    for (const name of grid.querySelectorAll<HTMLElement>('[data-slot="matrix-row-kicker"]'))
      await expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    // Each cell wears its step's token: 7 Oct at Clouds (19 °F) is the coldest cyan.
    const coldest = must(cells[6]);
    await expect(coldest).toHaveAttribute('data-step', 'cold-4');
    await expect(getComputedStyle(coldest).backgroundColor).toEqual(
      sameColor(computedColor(grid, 'var(--temp-cold-4)')),
    );
    await expect(coldest).toHaveAccessibleName('Clouds, 7 Oct: 19 °F');
    // The bright cells take the dark ink (the void on the console's dark map).
    const dark = computedColor(grid, 'var(--bg)');
    await expect(getComputedStyle(must(coldest.firstElementChild)).color).toEqual(sameColor(dark));
    // Column kickers: the ends only.
    const kickers = [...grid.querySelectorAll('[data-slot="matrix-column-kicker"]')].map(
      (k) => k.textContent,
    );
    await expect(kickers.filter(Boolean)).toEqual(['1 Oct', '12 Oct']);
    await expectInksPass(grid);
    // The legend: eight steps and the unit.
    await expect(canvasElement.querySelectorAll('[data-slot="matrix-legend-swatch"]')).toHaveLength(
      8,
    );
  },
};

/**
 * Hover and keyboard bring the one plate: the row and night as its title, the value in mono. The
 * grid is one tab stop; arrows move, Home and End go to a row's ends; leaving takes the plate.
 */
export const HoverAndKeys: Story = {
  args: { rows: SENTINELS, columns: NIGHTS, 'aria-label': 'Overnight lows' },
  play: async ({ canvasElement }) => {
    const grid = within(canvasElement).getByRole('grid');
    const cells = cellsOf(grid);
    const plate = () => grid.querySelectorAll('[data-slot="matrix-plate"]');
    await userEvent.hover(must(cells[6]));
    await waitFor(() => expect(plate()).toHaveLength(1));
    await expect(must(plate()[0]).textContent).toBe('Clouds · 7 Oct19 °F');
    // The plate stands over its cell, centered.
    const p = must(plate()[0]).getBoundingClientRect();
    const c = must(cells[6]).getBoundingClientRect();
    near(p.left + p.width / 2, c.left + c.width / 2);
    await expect(p.bottom).toBeLessThan(c.top);
    await userEvent.unhover(grid);
    await waitFor(() => expect(plate()).toHaveLength(0));
    // Keyboard: one tab stop, then the arrows.
    await expect(cells.filter((el) => el.tabIndex === 0)).toHaveLength(1);
    await userEvent.tab();
    await expect(cells[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}');
    await expect(cells[14]).toHaveFocus();
    await waitFor(() => expect(must(plate()[0]).textContent).toBe('Eagle · 3 Oct30 °F'));
    await userEvent.keyboard('{End}');
    await expect(cells[23]).toHaveFocus();
    await userEvent.keyboard('{Home}{ArrowUp}{ArrowUp}{ArrowLeft}');
    await expect(cells[0]).toHaveFocus();
    await expect(must(cells[0]).tabIndex).toBe(0);
    must(cells[0]).blur();
    await waitFor(() => expect(plate()).toHaveLength(0));
  },
};

/** A matrix whose data shrinks on a press, for the tab stop's sake. */
function Shrinking(props: ComponentProps<typeof MatrixChart>) {
  const [small, setSmall] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a test harness hears S bubble up from a cell
    <div
      className="flex flex-col gap-(--space-2_5)"
      onKeyDown={(event) => {
        if (event.key === 's') setSmall(true);
      }}
    >
      <MatrixChart
        {...props}
        rows={small ? props.rows.slice(0, 2) : props.rows}
        columns={small ? props.columns.slice(0, 2) : props.columns}
      />
      <button type="button" onClick={() => setSmall(true)}>
        Shrink
      </button>
    </div>
  );
}

/** The one tab stop survives the data shrinking under it: the cursor keeps to the cells left. */
export const ShrinkKeepsTabStop: Story = {
  args: { rows: SENTINELS, columns: NIGHTS, 'aria-label': 'Overnight lows' },
  render: (args) => <Shrinking {...args} />,
  play: async ({ canvasElement }) => {
    const grid = within(canvasElement).getByRole('grid');
    await userEvent.tab();
    await userEvent.keyboard('{End}{ArrowDown}{ArrowDown}');
    await expect(must(cellsOf(grid)[35])).toHaveFocus();
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Shrink' }));
    await waitFor(() => expect(cellsOf(grid)).toHaveLength(4));
    const cells = cellsOf(grid);
    await expect(cells.filter((el) => el.tabIndex === 0)).toEqual([cells[3]]);
    // Focus went to the button, and the shrink leaves it there.
    await expect(within(canvasElement).getByRole('button', { name: 'Shrink' })).toHaveFocus();
  },
};

/**
 * Focus survives the data shrinking under it too: when the focused cell's row and column go, focus
 * lands on the nearest cell left (the new tab stop), and the arrows carry on from there.
 */
export const ShrinkKeepsFocus: Story = {
  args: {
    rows: SENTINELS,
    columns: NIGHTS,
    'aria-label': 'Overnight lows',
    onKeyDown: fn(),
    onBlur: fn(),
  },
  render: (args) => <Shrinking {...args} />,
  play: async ({ canvasElement, args }) => {
    const grid = within(canvasElement).getByRole('grid');
    await userEvent.tab();
    await userEvent.keyboard('{End}{ArrowDown}{ArrowDown}');
    await expect(must(cellsOf(grid)[35])).toHaveFocus();
    // S (heard outside the grid) shrinks the data while the cell holds focus.
    await userEvent.keyboard('s');
    await waitFor(() => expect(cellsOf(grid)).toHaveLength(4));
    await waitFor(() => expect(must(cellsOf(grid)[3])).toHaveFocus());
    await userEvent.keyboard('{ArrowLeft}');
    await expect(must(cellsOf(grid)[2])).toHaveFocus();
    // A caller's own handlers still hear the grid, beside the kit's.
    await expect(args.onKeyDown).toHaveBeenCalled();
    await expect(args.onBlur).toHaveBeenCalled();
  },
};

/** Names on the right, beside a chart's end labels, as the Season board pairs them; every night labeled. */
export const KickersRight: Story = {
  args: {
    rows: SENTINELS,
    columns: NIGHTS.slice(0, 6),
    kickerSide: 'right',
    columnKickers: 'all',
    'aria-label': 'Overnight lows, 1–6 Oct',
  },
  play: async ({ canvasElement }) => {
    const grid = within(canvasElement).getByRole('grid');
    const kicker = must(
      grid.querySelector('[data-slot="matrix-row-kicker"]'),
    ).getBoundingClientRect();
    const last = must(cellsOf(grid)[5]).getBoundingClientRect();
    near(kicker.left - last.right, resolvePx(grid, 'var(--space-2_5)'));
    const labels = [...grid.querySelectorAll('[data-slot="matrix-column-kicker"]')].map(
      (k) => k.textContent,
    );
    await expect(labels).toEqual(NIGHTS.slice(0, 6).map((n) => n.label));
  },
};

/** Color alone (a dense season), and no column kickers. */
export const ColorOnly: Story = {
  args: {
    rows: SENTINELS,
    columns: NIGHTS,
    showValues: false,
    columnKickers: 'none',
    'aria-label': 'Overnight lows',
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="matrix-value"]')).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="matrix-column-kicker"]')).toBeNull();
    // A reader still hears every value.
    await expect(must(cellsOf(canvasElement)[0])).toHaveAccessibleName('Clouds, 1 Oct: 34 °F');
  },
};

/**
 * The whole scale in one row, coldest to warmest, then a night with no reading — in all four maps.
 * The scale is the same in every map (a reading, not chrome); the inks follow each map, and every
 * value passes as a mark on its ground (3:1). Cells are a kicker and a step tall on each surface.
 */
export const FourUp: Story = {
  args: { rows: SCALE_ROW, columns: SCALE_COLS, 'aria-label': 'The temperature scale' },
  render: (args) => (
    <div className="flex flex-col gap-(--space-2_5)">
      <MatrixChart {...args} />
      <MatrixLegend />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const cells = cellsOf(q);
      await expect(cells.map((c) => c.dataset.step)).toEqual([...TEMP_STEPS, 'none']);
      const h = resolvePx(q, 'calc(var(--type-kick) + var(--space-0_5))');
      for (const c of cells) near(c.getBoundingClientRect().height, h);
      // The same eight grounds in every map.
      for (const [i, step] of TEMP_STEPS.entries())
        await expect(getComputedStyle(must(cells[i])).backgroundColor).toEqual(
          sameColor(computedColor(q, `var(--temp-${step})`)),
        );
      await expectInksPass(q);
      await expect(must(cells[8])).toHaveAccessibleName('Scale, 9 Dec: no reading');
      // Its plate says so; a key the grid doesn't use leaves focus where it is.
      must(cells[8]).focus();
      await waitFor(() =>
        expect(q.querySelector('[data-slot="matrix-plate-value"]')?.textContent).toBe('No reading'),
      );
      await userEvent.keyboard('x');
      await expect(cells[8]).toHaveFocus();
      must(cells[8]).blur();
    }
    // The steps' bounds are the boards' ramp.
    await expect([19.9, 20, 31.9, 32, 33.9, 34, 39.9, 40].map(temperatureStep)).toEqual([
      'cold-4',
      'cold-3',
      'cold-1',
      'freeze',
      'freeze',
      'warm-1',
      'warm-2',
      'warm-3',
    ]);
  },
};
