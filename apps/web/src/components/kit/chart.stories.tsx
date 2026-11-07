import type { Meta, StoryObj } from '@storybook/react-vite';
import { AreaChart, BarChart, LineChart } from 'recharts';
import { expect, waitFor } from 'storybook/test';

import {
  ChartArea,
  ChartBar,
  type ChartConfig,
  ChartContainer,
  ChartGrid,
  ChartLine,
  ChartRule,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from './chart';
import { computedColor, resolvePx, sameColor } from './measure';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Chart',
  component: ChartContainer,
  tags: ['autodocs'],
  decorators: [(Story) => <div className="w-full max-w-[40rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'Recharts v3 in the console’s chart register. A series names a **tone** (lead, muted, faint, warn, bad, water — water only for water and transient modes); the container maps tones to the theme. Hover is a vertical hairline and a square plate; gridlines run unbroken; nothing clips at the plot’s edge; nothing animates under reduced motion.',
      },
    },
  },
} satisfies Meta<typeof ChartContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Data ─────────────────────────────────────────────────────────────────────────────────────

const NIGHTS = [34, 31, 27, 30, 24, 29, 19, 25, 28, 33, 30, 31].map((now, i) => ({
  night: `${i + 1} Oct`,
  now,
  last: [40, 38, 35, 36, 33, 35, 30, 34, 36, 38, 36, 37][i] as number,
}));

const LOWS: ChartConfig = {
  now: { label: 'This winter', tone: 'lead', unit: ' °F' },
  last: { label: 'Last winter', tone: 'muted', pattern: 'dotted', unit: ' °F' },
};

const SPEND = [
  { month: 'Jun', spend: 18.4 },
  { month: 'Jul', spend: 21.1 },
  { month: 'Aug', spend: 19.7 },
  { month: 'Sep', spend: 25 },
  { month: 'Oct', spend: 31.6 },
  { month: 'Nov', spend: 12.2 },
];

const DOLLARS: ChartConfig = {
  spend: { label: 'Spend', tone: 'lead', format: (v) => `$${v.toFixed(2)}` },
};

const WATER = [41, 40, 40, 39, 38, 38, 37, 36, 36, 35, 35, 34].map((temp, i) => ({
  day: `${i + 1} Nov`,
  temp,
}));

const WATER_TEMP: ChartConfig = {
  temp: { label: 'Surface water', tone: 'water', unit: ' °F' },
};

// ── The charts ───────────────────────────────────────────────────────────────────────────────

/** The sentinel's overnight lows, the Season page's trace. */
function SeasonTrace({ className }: { className?: string }) {
  return (
    <ChartContainer config={LOWS} className={className}>
      <LineChart data={NIGHTS} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <ChartGrid />
        <ChartXAxis dataKey="night" interval={3} />
        <ChartYAxis domain={[10, 44]} ticks={[10, 20, 30, 40]} />
        <ChartRule y={32} label="32 °F" tone="faint" />
        <ChartRule y={20} label="20 °F" tone="warn" />
        <ChartRule x="3 Oct" label="Watch opened" />
        <ChartLine dataKey="last" />
        <ChartLine dataKey="now" />
        <ChartTooltip labelFormatter={(night) => `Night of ${night}`} />
      </LineChart>
    </ChartContainer>
  );
}

function Spend({ className }: { className?: string }) {
  return (
    <ChartContainer config={DOLLARS} className={className}>
      <BarChart data={SPEND} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <ChartGrid />
        <ChartXAxis dataKey="month" />
        <ChartYAxis tickFormatter={(v: number) => `$${v}`} />
        <ChartRule y={25} />
        <ChartBar dataKey="spend" />
        <ChartTooltip />
      </BarChart>
    </ChartContainer>
  );
}

function Water({ className }: { className?: string }) {
  return (
    <ChartContainer config={WATER_TEMP} className={className}>
      <AreaChart data={WATER} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <ChartGrid vertical />
        <ChartXAxis dataKey="day" interval={2} />
        <ChartYAxis domain={['dataMin', 'dataMax']} />
        <ChartArea dataKey="temp" />
        <ChartTooltip />
      </AreaChart>
    </ChartContainer>
  );
}

// ── Measuring ────────────────────────────────────────────────────────────────────────────────

const q = (scope: ParentNode, sel: string) => must(scope.querySelector<SVGElement>(sel));
const qa = (scope: ParentNode, sel: string) => [...scope.querySelectorAll<SVGElement>(sel)];
const attr = (el: Element, name: string) => Number(el.getAttribute(name));

/** The chart has drawn (ResponsiveContainer measures first, then the series). */
async function drawn(scope: HTMLElement, series: string) {
  await waitFor(() => expect(scope.querySelector(series)).not.toBeNull());
}

/** Moves the pointer over the chart at a client x (mid-height of the plot), as a mouse would. */
function hoverAt(scope: HTMLElement, clientX: number) {
  const wrapper = q(scope, '.recharts-wrapper');
  const box = wrapper.getBoundingClientRect();
  const init = { bubbles: true, clientX, clientY: box.top + box.height / 2 };
  wrapper.dispatchEvent(new MouseEvent('mouseover', init));
  wrapper.dispatchEvent(new MouseEvent('mousemove', init));
}

/** The pointer leaves the chart: the plate and the hairline go. */
async function leave(scope: HTMLElement) {
  const wrapper = q(scope, '.recharts-wrapper');
  wrapper.dispatchEvent(
    new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
  );
  wrapper.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
  await waitFor(() => expect(scope.querySelector('[data-slot="chart-tooltip"]')).toBeNull());
}

const midX = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
};

/** The plate is the kit tooltip's: square, the plate ground, a `line2` edge; title, ~6 px, lines. */
async function expectPlate(scope: HTMLElement) {
  const plate = scope.querySelector<HTMLElement>('[data-slot="chart-tooltip"]');
  const p = must(plate);
  const s = getComputedStyle(p);
  await expect(s.borderTopLeftRadius).toBe('0px');
  await expect(s.backgroundColor).toEqual(sameColor(computedColor(p, 'var(--plate-solid)')));
  await expect(s.borderTopColor).toEqual(sameColor(computedColor(p, 'var(--line2)')));
  await expect(s.boxShadow).not.toBe('none');
  return p;
}

/**
 * Every gridline is one unbroken solid line, spanning the plot: horizontals from the plot's left
 * to its right, verticals from its top to its bottom. No dash pattern, the rule gray.
 */
async function expectGridlines(scope: HTMLElement) {
  const line = computedColor(scope, 'var(--line)');
  const horizontal = qa(scope, '.recharts-cartesian-grid-horizontal line');
  await expect(horizontal.length).toBeGreaterThan(1);
  const x1 = new Set(horizontal.map((l) => attr(l, 'x1')));
  const x2 = new Set(horizontal.map((l) => attr(l, 'x2')));
  await expect([x1.size, x2.size]).toEqual([1, 1]);
  const vertical = qa(scope, '.recharts-cartesian-grid-vertical line');
  for (const l of vertical) {
    const top = Math.min(...horizontal.map((h) => attr(h, 'y1')));
    const bottom = Math.max(...horizontal.map((h) => attr(h, 'y1')));
    await expect(attr(l, 'y1')).toBeLessThanOrEqual(top);
    await expect(attr(l, 'y2')).toBeGreaterThanOrEqual(bottom);
  }
  for (const l of [...horizontal, ...vertical]) {
    const s = getComputedStyle(l);
    await expect(s.strokeDasharray).toBe('none');
    await expect(s.stroke).toEqual(sameColor(line));
  }
  return { horizontal, vertical };
}

// ── Stories ──────────────────────────────────────────────────────────────────────────────────

/**
 * The Season page's trace: this winter's overnight lows bright, last winter dotted, the 32 °F rule
 * faint and the 20 °F rule in the warning tone, the watch's opening as an event rule. Hovering
 * draws the hairline at the hovered night and the plate: the night, then each winter's low.
 */
export const SeasonTraceStory: Story = {
  name: 'Season trace',
  args: { config: LOWS, children: null },
  render: () => <SeasonTrace />,
  play: async ({ canvasElement }) => {
    await drawn(canvasElement, '.recharts-line-curve');
    await expectGridlines(canvasElement);

    // Hover at an x-axis tick: the hairline, the active dot and the tick share one x.
    const ticks = qa(canvasElement, '.recharts-xAxis .recharts-cartesian-axis-tick-line');
    await expect(ticks.length).toBeGreaterThan(1);
    const tick = must(ticks[1]);
    const x = midX(tick);
    hoverAt(canvasElement, x);
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="chart-cursor"]')).not.toBeNull(),
    );
    const cursor = q(canvasElement, '[data-slot="chart-cursor"]');
    await expect(cursor.tagName.toLowerCase()).toBe('line');
    await expect(Math.abs(midX(cursor) - x)).toBeLessThanOrEqual(0.5);
    const dots = qa(canvasElement, '.recharts-active-dot circle');
    await expect(dots).toHaveLength(2);
    for (const dot of dots) await expect(Math.abs(midX(dot) - x)).toBeLessThanOrEqual(0.5);
    // The hairline runs the plot's full height (the gridlines' span).
    const grid = qa(canvasElement, '.recharts-cartesian-grid-horizontal line').map((l) =>
      attr(l, 'y1'),
    );
    await expect(attr(cursor, 'y1')).toBeLessThanOrEqual(Math.min(...grid));
    await expect(attr(cursor, 'y2')).toBeGreaterThanOrEqual(Math.max(...grid));
    await expect(getComputedStyle(cursor).strokeWidth).toBe('1px');

    const plate = await expectPlate(canvasElement);
    await expect(plate).toHaveTextContent('Night of 5 Oct');
    await expect(plate).toHaveTextContent('This winter24 °F');
    await expect(plate).toHaveTextContent('Last winter33 °F');
    const title = must(plate.querySelector('[data-slot="chart-tooltip-title"]'));
    const first = must(plate.querySelector('[data-slot="chart-tooltip-item"]'));
    const gap = first.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
    await expect(gap).toBeCloseTo(resolvePx(plate, 'var(--space-1_5)'), 0);
    const value = must(plate.querySelector('[data-slot="chart-tooltip-value"]'));
    await expect(getComputedStyle(value).fontFamily).toMatch(/Martian Mono/);

    await leave(canvasElement);
    await expect(canvasElement.querySelector('[data-slot="chart-cursor"]')).toBeNull();
  },
};

/**
 * Nothing clips at the plot's edge: a series whose maximum sits on the top of its domain keeps its
 * full stroke and its hover dot inside the chart's box.
 */
export const NothingClips: Story = {
  args: { config: WATER_TEMP, children: null },
  render: () => <Water />,
  play: async ({ canvasElement }) => {
    await drawn(canvasElement, '.recharts-area-curve');
    const box = q(canvasElement, '[data-slot="chart"]').getBoundingClientRect();
    const curve = q(canvasElement, '.recharts-area-curve').getBoundingClientRect();
    const svg = q(canvasElement, '.recharts-surface');
    await expect(getComputedStyle(svg).overflow).toBe('visible');
    await expect(curve.top).toBeGreaterThanOrEqual(box.top);
    // Hover the maximum (the first day, 41 °F, the domain's top).
    const ticks = qa(canvasElement, '.recharts-xAxis .recharts-cartesian-axis-tick-line');
    hoverAt(canvasElement, midX(must(ticks[0])));
    await waitFor(() =>
      expect(canvasElement.querySelector('.recharts-active-dot circle')).not.toBeNull(),
    );
    const dot = q(canvasElement, '.recharts-active-dot circle');
    const grid = qa(canvasElement, '.recharts-cartesian-grid-horizontal line').map((l) =>
      attr(l, 'y1'),
    );
    // The dot's center is on the plot's top edge, and its whole disc is inside the chart's box.
    await expect(attr(dot, 'cy')).toBeCloseTo(Math.min(...grid), 0);
    const disc = dot.getBoundingClientRect();
    await expect(disc.top).toBeGreaterThanOrEqual(box.top);
    await expect(disc.left).toBeGreaterThanOrEqual(box.left);
    const plate = await expectPlate(canvasElement);
    await expect(plate).toHaveTextContent('Surface water41 °F');
    // Water wears the ice accent — the one place it may.
    await expect(getComputedStyle(q(canvasElement, '.recharts-area-curve')).stroke).toEqual(
      sameColor(computedColor(canvasElement, 'var(--acc)')),
    );
    // Vertical gridlines run top to bottom too.
    const { vertical } = await expectGridlines(canvasElement);
    await expect(vertical.length).toBeGreaterThan(1);
    await leave(canvasElement);
  },
};

/**
 * Bars: square, in the lead tone; a neutral reference rule. The hover cursor is the same hairline
 * at the bar's middle — never Recharts' shaded band.
 */
export const Bars: Story = {
  args: { config: DOLLARS, children: null },
  render: () => <Spend />,
  play: async ({ canvasElement }) => {
    await drawn(canvasElement, '.recharts-bar-rectangle path');
    const bars = qa(canvasElement, '.recharts-bar-rectangle path');
    await expect(bars).toHaveLength(SPEND.length);
    const bar = must(bars[4]);
    await waitFor(() => expect(bar.getBoundingClientRect().height).toBeGreaterThan(0));
    await expect(getComputedStyle(bar).fill).toEqual(
      sameColor(computedColor(canvasElement, 'var(--fg)')),
    );
    // The band's middle in the chart's own coordinates (hover swaps the bar's element for the
    // active one, so read it first).
    const middle = attr(bar, 'x') + attr(bar, 'width') / 2;
    hoverAt(canvasElement, midX(bar));
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="chart-cursor"]')).not.toBeNull(),
    );
    const cursor = q(canvasElement, '[data-slot="chart-cursor"]');
    await expect(cursor.tagName.toLowerCase()).toBe('line');
    await expect(Math.abs(attr(cursor, 'x1') - middle)).toBeLessThanOrEqual(0.5);
    await expect(attr(cursor, 'x2')).toBe(attr(cursor, 'x1'));
    await expect(canvasElement.querySelector('.recharts-tooltip-cursor')).toBe(cursor);
    const plate = await expectPlate(canvasElement);
    await expect(plate).toHaveTextContent('Oct');
    await expect(plate).toHaveTextContent('Spend$31.60');
    // The reference rule: the rule gray, dashed.
    const rule = q(canvasElement, '.recharts-reference-line line');
    await expect(getComputedStyle(rule).stroke).toEqual(
      sameColor(computedColor(canvasElement, 'var(--line2)')),
    );
    await leave(canvasElement);
  },
};

/** Axes: x labels in kicker type, y tick numbers in mono, both in the faint ink; no axis line. */
export const Axes: Story = {
  args: { config: LOWS, children: null },
  render: () => <SeasonTrace />,
  play: async ({ canvasElement }) => {
    await drawn(canvasElement, '.recharts-line-curve');
    const fg3 = computedColor(canvasElement, 'var(--fg3)');
    const x = q(canvasElement, '.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value');
    const y = q(canvasElement, '.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value');
    const xs = getComputedStyle(x);
    const ys = getComputedStyle(y);
    await expect(xs.textTransform).toBe('uppercase');
    await expect(parseFloat(xs.fontSize)).toBeCloseTo(
      resolvePx(canvasElement, 'var(--type-kick)'),
      1,
    );
    await expect(xs.fill).toEqual(sameColor(fg3));
    await expect(ys.fontFamily).toMatch(/Martian Mono/);
    await expect(ys.fill).toEqual(sameColor(fg3));
    await expect(canvasElement.querySelector('.recharts-cartesian-axis-line')).toBeNull();
    // The event rule's label is a kicker.
    // (Recharts draws labels in a layer of their own, over the marks.)
    const labels = qa(canvasElement, '.recharts-label');
    const label = must(labels.find((l) => l.textContent === 'Watch opened'));
    await expect(getComputedStyle(label).textTransform).toBe('uppercase');
    await expect(getComputedStyle(label).fill).toEqual(sameColor(fg3));
    const warn = must(labels.find((l) => l.textContent === '20 °F'));
    await expect(getComputedStyle(warn).fill).toEqual(
      sameColor(computedColor(canvasElement, 'var(--warn)')),
    );
    // The warning rule wears the warning tone, its label too.
    const lines = qa(canvasElement, '.recharts-reference-line line');
    const strokes = lines.map((l) => getComputedStyle(l).stroke);
    await expect(strokes).toContainEqual(sameColor(computedColor(canvasElement, 'var(--warn)')));
  },
};

/**
 * Reduced motion: no series animates — the line is whole on its first frame (no growing dash), and
 * the bars stand at full height at once.
 */
export const ReducedMotion: Story = {
  args: { config: LOWS, children: null },
  beforeEach: () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => {
      const list = original.call(window, query);
      if (!query.includes('prefers-reduced-motion')) return list;
      // The reader asked for less motion: the query matches, and never changes.
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } satisfies MediaQueryList;
    };
    return () => {
      window.matchMedia = original;
    };
  },
  render: () => (
    <div className="flex flex-col gap-(--space-4)">
      <SeasonTrace />
      <Spend />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await drawn(canvasElement, '.recharts-line-curve');
    for (const curve of qa(canvasElement, '.recharts-line-curve')) {
      const dash = curve.getAttribute('stroke-dasharray');
      // A solid line has no dash at all; the dotted one has only its own pattern.
      await expect(dash === null || dash === '1.5 3').toBe(true);
    }
    const bars = qa(canvasElement, '.recharts-bar-rectangle path');
    await expect(bars).toHaveLength(SPEND.length);
    const tallest = must(bars[4]).getBoundingClientRect().height;
    await expect(tallest).toBeGreaterThan(0);
    // The heights are final on the first frame: nothing grows afterwards.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await expect(must(bars[4]).getBoundingClientRect().height).toBe(tallest);
  },
};

/**
 * All four maps: the tones resolve per map, the axis type follows each surface's scale (the
 * kicker is 10 px on the console, 11 px on skater), and the gridlines stay unbroken.
 */
export const FourUp: Story = {
  args: { config: LOWS, children: null },
  render: () => (
    <div className="flex flex-col gap-(--space-3) p-(--space-4)">
      <span className={KICKER}>Overnight lows</span>
      <SeasonTrace />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const kick = { admin: 10, skater: 11 } as const;
    for (const quad of quads) {
      await drawn(quad, '.recharts-line-curve');
      await expectGridlines(quad);
      const surface = quad.dataset.surface as keyof typeof kick;
      const x = q(quad, '.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value');
      await expect(parseFloat(getComputedStyle(x).fontSize)).toBe(kick[surface]);
      const now = qa(quad, '.recharts-line-curve').at(-1) as SVGElement;
      await expect(getComputedStyle(now).stroke).toEqual(
        sameColor(computedColor(quad, 'var(--fg)')),
      );
    }
  },
};
