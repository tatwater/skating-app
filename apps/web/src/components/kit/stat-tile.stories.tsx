import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { StatGrid, StatTile, Value } from './stat-tile';
import { must, rootPx } from './storyKit';

const meta = {
  title: 'Kit/Stat tile',
  component: StatTile,
  tags: ['autodocs'],
  args: { label: 'Reports', value: '14', unit: 'in 11 posts', sub: 'All from shore' },
  parameters: {
    docs: {
      description: {
        component:
          'A stat is a kicker, a big mono value with its unit, and a sub-line — never a card. The unit sits in the gray slot **7 px from the value, with no space character**, measured ink to ink. Stats sit on a grid whose dotted rules never break: dividers are padding, never margin. Loading holds the exact final box.',
      },
    },
  },
} satisfies Meta<typeof StatTile>;

export default meta;
type Story = StoryObj<typeof meta>;

const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** The mono face the value is set in, loaded — `ch` and digit advances are the loaded face's. */
async function monoLoaded(el: Element) {
  const { fontWeight, fontSize } = getComputedStyle(el);
  await document.fonts.load(`${fontWeight} ${fontSize} "Martian Mono"`, '0');
  await document.fonts.load(`300 ${fontSize} "Martian Mono"`, '0');
  await document.fonts.ready;
}

/** The value's ink ends where its box ends, less the tracking after the last digit. */
function figureInkRight(figure: HTMLElement): number {
  return figure.getBoundingClientRect().right - resolvePx(figure, 'var(--track-value)');
}

// ── The tile ─────────────────────────────────────────────────────────────────────────────────

/**
 * Kicker, value with unit, sub-line, `space-1` apart. The sub-line is trimmed to its letterforms,
 * so the gap over it meets ink, not half-leading.
 */
export const Tile: Story = {
  decorators: [(Story) => <div className="w-[12rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const tile = part(canvasElement, 'stat-tile');
    const label = part(tile, 'stat-label');
    const value = part(tile, 'value');
    const sub = part(tile, 'stat-sub');
    await expect(getComputedStyle(label).textTransform).toBe('uppercase');
    await expect(getComputedStyle(value).fontFamily).toMatch(/Martian Mono/);
    await expect(getComputedStyle(value).color).toBe(computedColor(value, 'var(--fg)'));
    await expect(getComputedStyle(sub).color).toBe(computedColor(sub, 'var(--fg3)'));
    // Not a card: no box, no fill.
    const style = getComputedStyle(tile);
    await expect(style.borderTopWidth).toBe('0px');
    await expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    // The gaps, content to content.
    const gap = resolvePx(tile, 'var(--space-1)');
    const [a, b, c] = [label, value, sub].map((el) => el.getBoundingClientRect());
    await expect(Math.abs(must(b).top - must(a).bottom - gap)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    await expect(Math.abs(must(c).top - must(b).bottom - gap)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    // The sub-line is trimmed: one line, a cap height tall, not a line box.
    await expect(must(c).height).toBeCloseTo(resolvePx(sub, '1cap'), 0);
    await expect(must(c).height).toBeLessThan(resolvePx(sub, '1lh') - 1);
  },
};

/**
 * The unit: light mono in the gray slot, 7 px from the last digit, and no space character between
 * them — the only space is a visually hidden one, for a screen reader.
 */
export const ValueWithUnit: Story = {
  render: () => <Value value="177,400" unit="weighted" />,
  play: async ({ canvasElement }) => {
    const value = part(canvasElement, 'value');
    const figure = part(value, 'value-figure');
    const unit = part(value, 'value-unit');
    await monoLoaded(figure);
    // 7 px at the 16 px base, ink to ink.
    const want = 7 * (rootPx() / 16);
    const gap = unit.getBoundingClientRect().left - figureInkRight(figure);
    await expect(Math.abs(gap - want)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // No space character in what's drawn.
    await expect(figure.textContent).toBe('177,400');
    await expect(unit.textContent).toBe('weighted');
    const hidden = must(value.querySelector('.sr-only'));
    await expect(hidden.textContent).toBe(' ');
    await expect(getComputedStyle(hidden).position).toBe('absolute');
    // …so a reader still hears two words.
    await expect(value.textContent).toBe('177,400 weighted');
    // The gray slot: light, smaller, fg3, same face.
    const u = getComputedStyle(unit);
    await expect(u.color).toBe(computedColor(unit, 'var(--fg3)'));
    await expect(u.fontWeight).toBe('300');
    await expect(u.fontFamily).toMatch(/Martian Mono/);
    await expect(parseFloat(u.fontSize)).toBeLessThan(
      parseFloat(getComputedStyle(figure).fontSize),
    );
    // One baseline: the unit's bottom edge sits on the figure's line, not centered under it.
    await expect(u.verticalAlign).toBe('baseline');
  },
};

/** A bare value (no unit) has no hidden space and no unit slot. */
export const ValueAlone: Story = {
  render: () => <Value value="$75.80" />,
  play: async ({ canvasElement }) => {
    const value = part(canvasElement, 'value');
    await expect(value.textContent).toBe('$75.80');
    await expect(value.querySelector('[data-slot="value-unit"]')).toBeNull();
    await expect(value.querySelector('.sr-only')).toBeNull();
  },
};

/** Tones by meaning only: amber waits on a person, red won't recover without one, dim doesn't count yet. */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <Value value="1" unit="failed" tone="bad" />
      <Value value="23" unit="queued" tone="warn" />
      <Value value="0" unit="landed" tone="dim" />
      <Value value="14" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const values = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="value"]')];
    const want = ['var(--bad)', 'var(--warn)', 'var(--fg3)', 'var(--fg)'];
    for (const [i, el] of values.entries()) {
      await expect(getComputedStyle(el).color).toBe(computedColor(el, must(want[i])));
    }
    // The unit keeps its gray whatever the value's tone.
    const unit = part(must(values[0]), 'value-unit');
    await expect(getComputedStyle(unit).color).toBe(computedColor(unit, 'var(--fg3)'));
  },
};

// ── Loading: the exact final box ─────────────────────────────────────────────────────────────

/** Loading beside loaded: the tiles are one box, and the value skeleton is the figure's width. */
export const Loading: Story = {
  render: () => (
    <div className="grid w-[24rem] grid-cols-2 items-start gap-(--space-6)">
      <StatTile
        data-pair="loading"
        loading
        label="Cost"
        value="$75.80"
        sub="$70.00 of it invoiced"
      />
      <StatTile data-pair="real" label="Cost" value="$75.80" sub="$70.00 of it invoiced" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const loading = must(canvasElement.querySelector<HTMLElement>('[data-pair="loading"]'));
    const real = must(canvasElement.querySelector<HTMLElement>('[data-pair="real"]'));
    await monoLoaded(part(real, 'value-figure'));
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    await expect(real).not.toHaveAttribute('aria-busy');
    // The label is known; it stays.
    await expect(part(loading, 'stat-label')).toHaveTextContent('Cost');
    const skeletons = [...loading.querySelectorAll<HTMLElement>('[data-slot="skeleton"]')];
    await expect(skeletons).toHaveLength(2);
    const [valueSk, subSk] = skeletons.map((el) => el.getBoundingClientRect());
    const figure = part(real, 'value-figure').getBoundingClientRect();
    const value = part(real, 'value').getBoundingClientRect();
    const sub = part(real, 'stat-sub').getBoundingClientRect();
    await expect(Math.abs(must(valueSk).width - figure.width)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    await expect(Math.abs(must(valueSk).height - value.height)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    await expect(Math.abs(must(subSk).height - sub.height)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    // The whole tile: one height, so nothing under it moves.
    await expect(
      Math.abs(loading.getBoundingClientRect().height - real.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

/**
 * A value that isn't plain text (a formatted node) can't be counted: give the loading box its
 * `chars`, or it holds four characters' room.
 */
export const LoadingUncounted: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <StatTile data-case="default" loading label="Cost" value={<b>$75.80</b>} />
      <StatTile data-case="chars" loading label="Cost" value={<b>$75.80</b>} chars={6} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const sk = (c: string) =>
      must(canvasElement.querySelector<HTMLElement>(`[data-case="${c}"] [data-slot="skeleton"]`));
    await expect(sk('default').style.width).toBe('calc(4 * (1ch + var(--track-value)))');
    await expect(sk('chars').style.width).toBe('calc(6 * (1ch + var(--track-value)))');
    // No sub-line asked for, none held.
    await expect(canvasElement.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
  },
};

function Arrives() {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex flex-col gap-heading">
      <button type="button" onClick={() => setLoaded(true)}>
        Load
      </button>
      <StatTile
        loading={!loaded}
        chars={7}
        label="Weather calls"
        value="177,400"
        unit="weighted"
        sub="Since the watch opened"
      />
      <p data-after="" className="text-row leading-none text-fg2">
        Next block
      </p>
    </div>
  );
}

/** The numbers land: the tile's box and everything under it stay exactly where they were. */
export const NothingMoves: Story = {
  render: () => <Arrives />,
  play: async ({ canvasElement }) => {
    const tile = part(canvasElement, 'stat-tile');
    const after = must(canvasElement.querySelector<HTMLElement>('[data-after]'));
    await document.fonts.load(`500 1rem "Martian Mono"`, '0');
    await document.fonts.ready;
    const before = [tile.getBoundingClientRect().height, after.getBoundingClientRect().top];
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(tile.querySelector('[data-slot="value"]')).not.toBeNull());
    const now = [tile.getBoundingClientRect().height, after.getBoundingClientRect().top];
    for (const [i, v] of now.entries()) {
      await expect(Math.abs(v - must(before[i]))).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
  },
};

// ── The grid: rules that never break ─────────────────────────────────────────────────────────

const SEASON = [
  { label: 'Reports', value: '14', unit: 'in 11 posts', sub: 'All from shore' },
  { label: 'Contributors', value: '6', sub: '2 new · 4 returning' },
  { label: 'Bodies activated', value: '3', sub: '1 admitted · 1 removed' },
  { label: 'Places added', value: '9', sub: '2 put-ins · 1 lot · 6 landmarks' },
  { label: 'Hazards', value: '3', sub: '1 confirmed · 0 archived' },
  { label: 'Inbox · resolved', value: '24', sub: 'Median 1.5 days to resolve' },
  { label: 'Bounties', value: '1', unit: 'opened', sub: '0 fulfilled' },
  { label: 'Photos', value: '31', sub: '88 MB' },
  { label: 'Weather calls', value: '177,400', unit: 'weighted', sub: 'About 4,600 per day' },
  { label: 'Imagery', value: '0', unit: 'landed', sub: '23 queued · 1 failed', tone: 'dim' },
  { label: 'Notifications', value: '37', sub: '31 to skaters · 6 staff emails' },
  { label: 'Cost', value: '$75.80', sub: '$70.00 of it invoiced' },
] as const;

function SeasonGrid({ columns = 4 }: { columns?: number }) {
  return (
    <StatGrid columns={columns} className="w-full">
      {SEASON.map((s) => (
        <StatTile key={s.label} {...s} />
      ))}
    </StatGrid>
  );
}

const rowsOf = (cells: HTMLElement[], columns: number) =>
  Array.from({ length: Math.ceil(cells.length / columns) }, (_, r) =>
    cells.slice(r * columns, (r + 1) * columns),
  );

async function expectUnbrokenRules(grid: HTMLElement, columns: number) {
  const cells = [...grid.querySelectorAll<HTMLElement>(':scope > [data-slot="stat-cell"]')];
  const box = grid.getBoundingClientRect();
  const rows = rowsOf(cells, columns);
  for (const [r, row] of rows.entries()) {
    const last = r === rows.length - 1;
    const first = must(row[0]).getBoundingClientRect();
    const end = must(row[row.length - 1]).getBoundingClientRect();
    // The row spans the grid, edge to edge (a short last row starts at the edge)…
    await expect(Math.abs(first.left - box.left)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    if (row.length === columns) {
      await expect(Math.abs(end.right - box.right)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
    for (const [c, cell] of row.entries()) {
      const style = getComputedStyle(cell);
      const rect = cell.getBoundingClientRect();
      // …dividers are padding, never margin…
      await expect(style.marginLeft).toBe('0px');
      await expect(style.marginRight).toBe('0px');
      // …each cell meets the next with no gap, so the row rule is one line across the grid…
      const next = row[c + 1];
      if (next !== undefined) {
        await expect(Math.abs(next.getBoundingClientRect().left - rect.right)).toBeLessThanOrEqual(
          JUNCTION_TOLERANCE_PX,
        );
      }
      // A column rule follows every column but the last (in a short row too, beside the gap).
      if (c < columns - 1) {
        await expect(style.borderRightStyle).toBe('dotted');
        await expect(style.borderRightWidth).toBe('1px');
      } else {
        await expect(style.borderRightWidth).toBe('0px');
      }
      // …at one height…
      await expect(Math.abs(rect.bottom - first.bottom)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      // …dotted, in the hairline ground, and absent under the last row.
      if (last) await expect(style.borderBottomWidth).toBe('0px');
      else {
        await expect(style.borderBottomWidth).toBe('1px');
        await expect(style.borderBottomStyle).toBe('dotted');
        await expect(style.borderBottomColor).toBe(computedColor(cell, 'var(--line)'));
      }
      // The column rules run down the grid: no gap between rows either.
      const below = rows[r + 1]?.[c];
      if (below !== undefined) {
        await expect(Math.abs(below.getBoundingClientRect().top - rect.bottom)).toBeLessThanOrEqual(
          JUNCTION_TOLERANCE_PX,
        );
      }
      // The outer columns have no outer inset, so values line up with the section over them.
      if (c === 0) await expect(style.paddingLeft).toBe('0px');
      if (c === columns - 1) await expect(style.paddingRight).toBe('0px');
    }
  }
}

/** The boards' 4 × 3: every row rule and column rule unbroken; no rule over the first row or under the last. */
export const Grid: Story = {
  render: () => <SeasonGrid />,
  decorators: [(Story) => <div className="w-[48rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const grid = part(canvasElement, 'stat-grid');
    await expectUnbrokenRules(grid, 4);
    // Rule → content: a cell's padding is the junction (`space-2_5`) to its kicker.
    const cells = [...grid.querySelectorAll<HTMLElement>('[data-slot="stat-cell"]')];
    const second = must(cells[4]);
    const label = part(second, 'stat-label').getBoundingClientRect();
    const above = must(cells[0]).getBoundingClientRect();
    await expect(
      Math.abs(label.top - above.bottom - resolvePx(grid, 'var(--space-2_5)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // No rule over the first row (a stat strip under a section title has none).
    await expect(getComputedStyle(must(cells[0])).borderTopWidth).toBe('0px');
  },
};

/** Any column count: a 3-wide grid with a short last row keeps the same rules. */
export const GridThreeWide: Story = {
  render: () => (
    <StatGrid columns={3}>
      {SEASON.slice(0, 7).map((s) => (
        <StatTile key={s.label} {...s} />
      ))}
    </StatGrid>
  ),
  decorators: [(Story) => <div className="w-[36rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const grid = part(canvasElement, 'stat-grid');
    const cells = [...grid.querySelectorAll<HTMLElement>('[data-slot="stat-cell"]')];
    await expect(cells).toHaveLength(7);
    // The full rows' rules hold; the lone last cell has no rule under it and none after it.
    const last = getComputedStyle(must(cells[6]));
    await expect(last.borderBottomWidth).toBe('0px');
    await expect(last.paddingLeft).toBe('0px');
    await expectUnbrokenRules(grid, 3);
  },
};

// ── Four-up ──────────────────────────────────────────────────────────────────────────────────

/** A 2-wide grid with a tone and a loading tile, in all four maps. */
export const FourUp: Story = {
  render: () => (
    <StatGrid columns={2} className="w-full max-w-[24rem]">
      <StatTile label="Reports" value="14" unit="in 11 posts" sub="All from shore" />
      <StatTile label="Imagery" value="1" unit="failed" tone="bad" sub="23 queued since 9 Oct" />
      <StatTile label="Rollovers" value="2" unit="waiting" tone="warn" sub="Asks Matt" />
      <StatTile label="Cost" value="$75.80" loading sub="$70.00 of it invoiced" />
    </StatGrid>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const heights = new Set<number>();
    for (const q of quads) {
      await expectUnbrokenRules(part(q, 'stat-grid'), 2);
      const figure = part(q, 'value-figure');
      await monoLoaded(figure);
      const unit = part(q, 'value-unit');
      const gap = unit.getBoundingClientRect().left - figureInkRight(figure);
      await expect(Math.abs(gap - 7 * (rootPx() / 16))).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      heights.add(Math.round(figure.getBoundingClientRect().height * 100));
    }
    // The stat step is the surface's: smaller on the console.
    await expect(heights.size).toBe(2);
  },
};
