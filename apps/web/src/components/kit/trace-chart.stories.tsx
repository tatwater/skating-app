import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { KICKER, must } from './storyKit';
import {
  LedStrip,
  paperColor,
  SparkbarSet,
  Sparkbars,
  StageBar,
  type Trace,
  type TraceBand,
  TraceChart,
  type TraceRule,
  themeOf,
} from './trace-chart';

const meta = {
  title: 'Kit/TraceChart',
  component: TraceChart,
  tags: ['autodocs'],
  // Stories that draw several pieces render their own; these are the component's defaults.
  args: { traces: [], 'aria-label': 'Traces' },
  decorators: [(Story) => <div className="w-full max-w-[36rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'Season traces in the sparkline register (hairlines, gridless, mono end labels, nothing clipped at the edge, a translucent band written as rgba() for Paper), plus the LED strip, the stage bar and sparkbars. Readings and counts only — never a verdict about the ice.',
      },
    },
  },
} satisfies Meta<typeof TraceChart>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Data: overnight lows (°F) at three sentinel lakes, 1–12 Oct, and the range of five winters ──

const LOWS: Trace[] = [
  { key: 'clouds', label: 'Clouds', values: [34, 31, 27, 30, 24, 29, 19, 25, 28, 33, 30, 31] },
  {
    key: 'eagle',
    label: 'Eagle',
    tone: 'muted',
    values: [36, 33, 30, 31, 27, 31, 19, 26, 30, 35, 32, 33],
  },
  {
    key: 'kinsman',
    label: 'Kinsman',
    tone: 'faint',
    values: [40, 38, 35, 36, 33, 35, 27, 32, 34, 38, 36, 37],
  },
];

/** The freezing line and the 20 °F line, as the Season board rules them. */
const RULES: TraceRule[] = [{ value: 32 }, { value: 20, tone: 'warn' }];

/** Clouds' lows over the last five winters, lowest and highest each night. */
const FIVE_WINTERS: TraceBand = {
  lo: [26, 24, 22, 23, 20, 21, 17, 19, 21, 24, 23, 22],
  hi: [41, 39, 37, 38, 35, 37, 33, 34, 36, 40, 38, 39],
};

const svgOf = (el: Element) =>
  must(el.querySelector<SVGSVGElement>('[data-slot="trace-chart"] svg'));

/**
 * Paper's rule, proved on the rendered SVG: no opacity attribute anywhere, no 8-digit hex, and
 * every translucent fill an `rgba()`.
 */
async function expectPaperSafe(svg: SVGSVGElement) {
  for (const el of svg.querySelectorAll('*'))
    for (const attr of ['fill-opacity', 'stroke-opacity', 'opacity'])
      await expect(el.hasAttribute(attr), `${el.tagName} has ${attr}`).toBe(false);
  await expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{8}\b/i);
  const band = svg.querySelector('[data-slot="trace-band"]');
  if (band) await expect(band.getAttribute('fill')).toMatch(/^rgba\(\d+, \d+, \d+, 0?\.\d+\)$/);
}

/** Nothing reaches past the drawing's edge: every mark (its stroke included) and label fits. */
function clipped(svg: SVGSVGElement): string[] {
  const box = svg.getBoundingClientRect();
  const tol = JUNCTION_TOLERANCE_PX;
  const out: string[] = [];
  for (const el of svg.querySelectorAll<SVGGraphicsElement>('polyline, line, path, text')) {
    const r = el.getBoundingClientRect();
    const half = el.tagName === 'text' ? 0 : Number(el.getAttribute('stroke-width') ?? 0) / 2;
    if (
      r.left - half < box.left - tol ||
      r.right + half > box.right + tol ||
      r.top - half < box.top - tol ||
      r.bottom + half > box.bottom + tol
    )
      out.push(`${el.getAttribute('data-slot')} ${el.getAttribute('data-trace') ?? ''}`);
  }
  return out;
}

/** Checked once the webfont is in: the label gutter is measured in it. */
async function expectNothingClips(svg: SVGSVGElement) {
  await document.fonts.ready;
  await waitFor(() => expect(clipped(svg)).toEqual([]));
}

// ── Traces ───────────────────────────────────────────────────────────────────────────────────

/**
 * The Season board's sentinels in the sparkline register: three hairlines in the grayscale steps,
 * the freezing line dashed and the 20 °F line in amber, five winters' range as a band behind,
 * each trace ending in its mono label.
 */
export const Sentinels: Story = {
  args: {
    traces: LOWS,
    rules: RULES,
    band: FIVE_WINTERS,
    format: (v) => `${v}`,
    className: 'h-[7.5rem]',
    'aria-label': 'Overnight lows at the sentinels, 1–12 Oct, with five winters’ range',
  },
  play: async ({ canvasElement }) => {
    const chart = within(canvasElement).getByRole('img', { name: /Overnight lows/ });
    await waitFor(() => expect(chart.querySelectorAll('[data-slot="trace-line"]')).toHaveLength(3));
    const svg = svgOf(canvasElement);
    // Stroke widths from the stroke tokens: every trace and rule a hairline.
    const hair = resolvePx(chart, 'var(--stroke-hair)');
    for (const el of svg.querySelectorAll('[data-slot="trace-line"], [data-slot="trace-rule"]'))
      await expect(Number(el.getAttribute('stroke-width'))).toBe(hair);
    // Gridless: the only lines are the two rules.
    await expect(svg.querySelectorAll('line')).toHaveLength(2);
    // Inks: the lead in the bright ink, the 20 °F rule in amber.
    await expect(getComputedStyle(must(svg.querySelector('[data-trace="clouds"]'))).stroke).toEqual(
      sameColor(computedColor(chart, 'var(--fg)')),
    );
    await expect(getComputedStyle(must(svg.querySelectorAll('line')[1])).stroke).toEqual(
      sameColor(computedColor(chart, 'var(--warn)')),
    );
    // End labels: mono, in caps, never overlapping.
    const labels = [...svg.querySelectorAll<SVGTextElement>('[data-slot="trace-end-label"]')];
    await expect(labels.map((l) => l.textContent)).toEqual(['Clouds 31', 'Eagle 33', 'Kinsman 37']);
    await expect(getComputedStyle(must(labels[0])).fontFamily).toMatch(/Martian Mono/);
    await expect(getComputedStyle(must(labels[0])).textTransform).toBe('uppercase');
    const rects = labels.map((l) => l.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    for (let i = 1; i < rects.length; i++)
      await expect(must(rects[i]).top).toBeGreaterThanOrEqual(must(rects[i - 1]).bottom - 1);
    await expectPaperSafe(svg);
    // The band is the lift token resolved for this drawing's own theme, as rgba().
    await expect(must(svg.querySelector('[data-slot="trace-band"]')).getAttribute('fill')).toBe(
      paperColor(themeOf(chart), 'lift-08'),
    );
    await expectNothingClips(svg);
  },
};

/**
 * A trace at the top of a fixed domain, ending on its maximum, drawn at the emphasized 2 px note
 * weight: the stroke, its end and its label all stay inside the drawing.
 */
export const MaxPoint: Story = {
  args: {
    traces: [
      {
        key: 'depth',
        label: 'Max depth',
        weight: 'note',
        values: [18, 20, 21, 22, 24],
      },
      { key: 'mean', label: 'Mean', tone: 'faint', values: [7.8, 8.4, 8.9, 9.1, 9.4] },
    ],
    domain: [0, 24],
    format: (v) => `${v} m`,
    className: 'h-(--space-10)',
    'aria-label': 'Depth soundings across five surveys',
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('[data-slot="trace-line"]')).toHaveLength(2),
    );
    const svg = svgOf(canvasElement);
    const lead = must(svg.querySelector('[data-trace="depth"]'));
    await expect(Number(lead.getAttribute('stroke-width'))).toBe(
      resolvePx(canvasElement, 'var(--stroke-note)'),
    );
    // The maximum sits exactly at the plot's top inset: a stroke's half or a label's half.
    const top = Number(must(lead.getAttribute('points')).split(' ').at(-1)?.split(',')[1]);
    await expect(top).toBeGreaterThan(0);
    await expectNothingClips(svg);
    await expectPaperSafe(svg);
  },
};

/** A bare sparkline (no end labels) with a missing night: the line breaks, it doesn't bridge. */
export const Sparkline: Story = {
  args: {
    traces: [{ key: 'reports', label: 'Reports', values: [2, 4, 3, null, 6, 5, 9, 7] }],
    endLabels: false,
    className: 'h-(--space-6) w-[8rem]',
    'aria-label': 'Reports a day, the last 8 days',
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('[data-slot="trace-line"]')).toHaveLength(2),
    );
    await expect(canvasElement.querySelector('[data-slot="trace-end-label"]')).toBeNull();
    await expectNothingClips(svgOf(canvasElement));
  },
};

/** At rest, the traces draw in left to right once, on the slow motion token. */
export const DrawIn: Story = {
  args: { ...Sentinels.args, traces: LOWS, 'aria-label': 'Overnight lows' },
  play: async ({ canvasElement }) => {
    const series = await waitFor(() =>
      must(canvasElement.querySelector('[data-slot="trace-series"]')),
    );
    await waitFor(() => expect(series).toHaveAttribute('data-drawn-in'));
  },
};

/** Reduced motion: no draw-in — the traces are whole on the first frame. */
export const ReducedMotion: Story = {
  args: { ...Sentinels.args, traces: LOWS, 'aria-label': 'Overnight lows' },
  beforeEach: () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => {
      const list = original.call(window, query);
      if (!query.includes('prefers-reduced-motion')) return list;
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
  play: async ({ canvasElement }) => {
    const series = await waitFor(() =>
      must(canvasElement.querySelector<SVGGElement>('[data-slot="trace-series"]')),
    );
    await expect(series).not.toHaveAttribute('data-drawn-in');
    await expect(series.getAnimations()).toHaveLength(0);
  },
};

// ── LED, stage, sparkbars ────────────────────────────────────────────────────────────────────

/**
 * The LED strip: the Body panel's completeness (9 of 10, spanning its column, lit) and a compact
 * count (7 of 12 passes, in the list-body gray). A meter to a reader.
 */
export const Led: Story = {
  render: () => (
    <div className="flex w-[18rem] flex-col gap-(--space-4)">
      <div className="flex flex-col gap-(--space-1_5)">
        <span className={KICKER}>Complete · 9 / 10</span>
        <LedStrip value={9} max={10} full aria-label="Complete" />
      </div>
      <LedStrip value={7} max={12} tone="on" aria-label="Passes reviewed" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const full = canvas.getByRole('meter', { name: 'Complete' });
    await expect(full).toHaveAttribute('aria-valuenow', '9');
    await expect(full).toHaveAttribute('aria-valuemax', '10');
    const segs = [...full.querySelectorAll<HTMLElement>('[data-slot="led-segment"]')];
    await expect(segs.filter((s) => s.hasAttribute('data-on'))).toHaveLength(9);
    // Spans its column, 3 px apart; a segment `space-2` tall.
    const r = segs.map((s) => s.getBoundingClientRect());
    await expect(must(r.at(-1)).right - must(r[0]).left).toBeCloseTo(
      full.getBoundingClientRect().width,
      0,
    );
    await expect(must(r[1]).left - must(r[0]).right).toBeCloseTo(3, 1);
    await expect(must(r[0]).height).toBeCloseTo(resolvePx(full, 'var(--space-2)'), 1);
    await expect(getComputedStyle(must(segs[0])).backgroundColor).toEqual(
      sameColor(computedColor(full, 'var(--fg)')),
    );
    await expect(getComputedStyle(must(segs[9])).backgroundColor).toEqual(
      sameColor(computedColor(full, 'var(--line)')),
    );
    // Compact: 7 × 8 px segments, `space-0_5` apart.
    const count = canvas.getByRole('meter', { name: 'Passes reviewed' });
    const c = [...count.querySelectorAll('[data-slot="led-segment"]')].map((s) =>
      s.getBoundingClientRect(),
    );
    await expect(must(c[0]).width).toBeCloseTo(resolvePx(count, '0.4375rem'), 1);
    await expect(must(c[1]).left - must(c[0]).right).toBeCloseTo(
      resolvePx(count, 'var(--space-0_5)'),
      1,
    );
  },
};

/**
 * The stage bar: a campaign's passes (2 done, 1 running, 4 waiting), a gap, the by-hand passes; then
 * a live strip that shares its width — late, stalled and failed.
 */
export const Stage: Story = {
  render: () => (
    <div className="flex w-[18rem] flex-col gap-(--space-3)">
      <StageBar
        stages={[
          'done',
          'done',
          'run',
          'waiting',
          'waiting',
          'waiting',
          'waiting',
          '|',
          'waiting',
          'waiting',
          'waiting',
        ]}
      />
      <StageBar fill stages={['done', 'done', 'late', 'waiting', 'waiting']} />
      <StageBar fill stages={['done', 'done', 'stalled', 'waiting', 'waiting']} />
      <StageBar fill stages={['done', 'done', 'failed', 'failed', 'failed']} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const bars = within(canvasElement).getAllByRole('img');
    await expect(bars[0]).toHaveAccessibleName('2 done, 1 running, 7 waiting');
    await expect(bars[2]).toHaveAccessibleName('2 done, 1 stalled, 2 waiting');
    const stage = (bar: HTMLElement, i: number) =>
      must(bar.querySelectorAll<HTMLElement>('[data-slot="stage"]')[i]);
    // Fixed segments: 16 px wide, 5 px tall, 2 px apart; the gap parts the two groups.
    const a = stage(must(bars[0]), 0).getBoundingClientRect();
    const b = stage(must(bars[0]), 1).getBoundingClientRect();
    await expect(a.width).toBeCloseTo(resolvePx(canvasElement, 'var(--space-4)'), 1);
    await expect(a.height).toBeCloseTo(resolvePx(canvasElement, '0.3125rem'), 1);
    await expect(b.left - a.right).toBeCloseTo(resolvePx(canvasElement, 'var(--space-0_5)'), 1);
    await expect(must(bars[0]).querySelectorAll('[data-slot="stage-gap"]')).toHaveLength(1);
    // A running pass is ice (a live run is transient); late amber; stalled red.
    const bg = (bar: number, i: number) =>
      getComputedStyle(stage(must(bars[bar]), i)).backgroundColor;
    await expect(bg(0, 2)).toEqual(sameColor(computedColor(canvasElement, 'var(--acc)')));
    await expect(bg(1, 2)).toEqual(sameColor(computedColor(canvasElement, 'var(--warn)')));
    await expect(bg(2, 2)).toEqual(sameColor(computedColor(canvasElement, 'var(--bad)')));
    await expect(bg(3, 2)).toEqual(sameColor(computedColor(canvasElement, 'var(--line2)')));
    // A filled strip shares its width.
    const fill = must(bars[1]).querySelectorAll('[data-slot="stage"]');
    await expect(must(fill[0]).getBoundingClientRect().width).toBeCloseTo(
      must(fill[4]).getBoundingClientRect().width,
      1,
    );
  },
};

/** Open flags over 14 days: today lit, the safety part red at each bar's foot, a zero a stub. */
export const Bars: Story = {
  render: () => (
    <Sparkbars
      className="w-[12rem]"
      aria-label="Open flags, the last 14 days"
      lightLatest
      rule={6}
      values={[
        2,
        3,
        0,
        4,
        { value: 5, bad: 1 },
        3,
        0,
        6,
        { value: 7, bad: 2 },
        4,
        3,
        5,
        2,
        { value: 8, bad: 1 },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const bars = within(canvasElement).getByRole('img', { name: 'Open flags, the last 14 days' });
    const all = [...bars.querySelectorAll<HTMLElement>('[data-slot="sparkbar"]')];
    await expect(all).toHaveLength(14);
    const h = bars.getBoundingClientRect().height;
    await expect(h).toBeCloseTo(resolvePx(bars, 'var(--space-8)'), 1);
    // The tallest bar (8) fills the height; a bar's parts add up to its value.
    const last = must(all.at(-1));
    const total = [...last.children].reduce((s, c) => s + c.getBoundingClientRect().height, 0);
    await expect(total).toBeCloseTo(h, 0);
    await expect(
      getComputedStyle(must(last.querySelector('[data-slot="sparkbar-fill"]'))).backgroundColor,
    ).toEqual(sameColor(computedColor(bars, 'var(--fg)')));
    await expect(
      getComputedStyle(must(last.querySelector('[data-slot="sparkbar-bad"]'))).backgroundColor,
    ).toEqual(sameColor(computedColor(bars, 'var(--bad)')));
    // A zero is a one-hair stub in the rule gray.
    const zero = must(all[2]?.querySelector('[data-slot="sparkbar-zero"]'));
    await expect(zero.getBoundingClientRect().height).toBeCloseTo(1, 1);
    // The threshold rule: amber, dashed, at 6 of 8.
    const rule = must(bars.querySelector<HTMLElement>('[data-slot="sparkbars-rule"]'));
    await expect(getComputedStyle(rule).borderTopStyle).toBe('dashed');
    // Its line stands at 6 of the scale's 8: three quarters up the bars.
    await expect(
      bars.getBoundingClientRect().bottom - rule.getBoundingClientRect().bottom,
    ).toBeCloseTo((h * 6) / 8, 0);
  },
};

// ── A set of strips ──────────────────────────────────────────────────────────────────────────

const PULSE = [
  { key: 'reports', label: 'Reports', values: [3, 5, 2, 0, 4, 6, 3, 2, 7, 5, 4, 3, 6, 8] },
  { key: 'photos', label: 'Photos', values: [6, 9, 3, 0, 8, 12, 5, 4, 11, 9, 7, 6, 10, 14] },
  { key: 'accounts', label: 'New accounts', values: [1, 0, 0, 1, 2, 0, 1, 0, 0, 1, 0, 2, 1, 1] },
] as const;

const PULSE_DAYS = PULSE[0].values.map((_, i) => `${i + 1} Oct`);

/** Metrics' *Each day*: a label, a strip and a total per row, one hover across the strips. */
function PulseSet({ defaultActive }: { defaultActive?: number }) {
  return (
    <SparkbarSet
      aria-label="Each day"
      length={PULSE_DAYS.length}
      title={(i) => PULSE_DAYS[i] ?? ''}
      rows={(i) => PULSE.map((p) => ({ label: p.label, value: p.values[i] ?? '—' }))}
      defaultActive={defaultActive}
      className="grid w-[36rem] grid-cols-[6.875rem_minmax(0,1fr)_2rem] items-end gap-x-(--space-3_5) gap-y-[0.5625rem]"
    >
      {PULSE.map((p) => (
        <div key={p.key} className="contents">
          <span className={KICKER}>{p.label}</span>
          <Sparkbars
            aria-label={`${p.label}, each day`}
            tone="muted"
            lightLatest
            values={p.values}
            className="h-[1.875rem] border-0 border-b border-solid border-line2"
          />
          <span className="text-right font-(family-name:--family-mono) text-mono-sm text-fg">
            {p.values.reduce((a: number, b: number) => a + b, 0)}
          </span>
        </div>
      ))}
    </SparkbarSet>
  );
}

const centerOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
};

/**
 * One hairline and one plate across the set: hover the fourth day on any strip and every strip
 * lights its fourth bar, the hairline runs from just over the first strip to the last one's foot,
 * and one plate says each strip's value. The keyboard reaches the same states.
 */
export const SharedHover: Story = {
  render: () => <PulseSet />,
  play: async ({ canvasElement }) => {
    const set = must(canvasElement.querySelector<HTMLElement>('[data-slot="sparkbar-set"]'));
    const strips = () => [...set.querySelectorAll<HTMLElement>('[data-slot="sparkbars"]')];
    const barsOf = (strip: Element) => [
      ...strip.querySelectorAll<HTMLElement>('[data-slot="sparkbar"]'),
    ];
    const hairline = () => set.querySelector<HTMLElement>('[data-slot="sparkbar-set-hairline"]');
    const plates = () => set.querySelectorAll('[data-slot="sparkbar-set-plate"]');
    await expect(hairline()).toBeNull();

    // Hover the fourth day over the middle strip.
    const target = must(barsOf(must(strips()[1]))[3]);
    fireEvent.pointerMove(set, { clientX: centerOf(target) });
    await waitFor(() => expect(hairline()).not.toBeNull());
    // One of each, however many strips.
    await expect(set.querySelectorAll('[data-slot="sparkbar-set-hairline"]')).toHaveLength(1);
    await expect(plates()).toHaveLength(1);
    // Every strip lights the same day, in the bright ink — a zero lights to the muted ink.
    const fg = computedColor(set, 'var(--fg)');
    for (const strip of strips()) {
      const bars = barsOf(strip);
      await expect(bars.filter((b) => b.hasAttribute('data-hovered'))).toEqual([bars[3]]);
      const fill = bars[3]?.querySelector('[data-slot="sparkbar-fill"]');
      if (fill) await expect(getComputedStyle(fill).backgroundColor).toEqual(sameColor(fg));
    }
    const zero = must(barsOf(must(strips()[0]))[3]?.querySelector('[data-slot="sparkbar-zero"]'));
    await expect(getComputedStyle(zero).backgroundColor).toEqual(
      sameColor(computedColor(set, 'var(--fg2)')),
    );
    // The hairline: at the day's middle in every strip, from space-1 over the first strip to the
    // last one's foot. One fresh read of everything.
    const line = must(hairline()).getBoundingClientRect();
    const lineX = line.left + line.width / 2;
    for (const strip of strips()) {
      await expect(Math.abs(centerOf(must(barsOf(strip)[3])) - lineX)).toBeLessThanOrEqual(0.5);
    }
    const first = must(strips()[0]).getBoundingClientRect();
    const last = must(strips().at(-1)).getBoundingClientRect();
    await expect(
      Math.abs(first.top - line.top - resolvePx(set, 'var(--space-1)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(Math.abs(line.bottom - last.bottom)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    await expect(getComputedStyle(must(hairline())).backgroundColor).toEqual(
      sameColor(computedColor(set, 'var(--fg2)')),
    );
    // The plate: the day, then each strip's value, opening right of an early day.
    const plate = must(plates()[0]) as HTMLElement;
    await expect(plate).toHaveTextContent('4 Oct');
    await expect(
      [...plate.querySelectorAll('[data-slot="sparkbar-set-value"]')].map((v) => v.textContent),
    ).toEqual(['0', '0', '1']);
    await expect(plate.getBoundingClientRect().left).toBeGreaterThan(lineX);
    await expect(getComputedStyle(plate).borderRadius).toBe('0px');

    // Off the strips' ends, nothing; leaving, nothing.
    fireEvent.pointerMove(set, { clientX: set.getBoundingClientRect().left + 2 });
    await waitFor(() => expect(hairline()).toBeNull());

    // The keyboard: a slider over the days.
    set.focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(set).toHaveAttribute('aria-valuenow', '13'));
    await expect(set).toHaveAttribute('aria-valuetext', '14 Oct');
    await waitFor(() => expect(plates()).toHaveLength(1));
    // A late day's plate opens to the left.
    const late = must(plates()[0]).getBoundingClientRect();
    await expect(late.right).toBeLessThan(must(hairline()).getBoundingClientRect().left);
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(set).toHaveAttribute('aria-valuenow', '12'));
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(set).toHaveAttribute('aria-valuenow', '0'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(hairline()).toBeNull());
    fireEvent.pointerMove(set, { clientX: centerOf(target) });
    await waitFor(() => expect(hairline()).not.toBeNull());
    // React hears a leave from the pointer going out to something outside the set.
    fireEvent.pointerOut(set, { relatedTarget: document.body });
    await waitFor(() => expect(hairline()).toBeNull());
  },
};

/**
 * A day nothing recorded: the strip keeps the day's place and draws nothing there — no zero stub,
 * which is a measured zero — the scale reads only the recorded days, and the plate says so in words.
 * A strip whose record began partway shows its first days empty beside another strip's full ones.
 */
export const UnrecordedDays: Story = {
  render: () => (
    <SparkbarSet
      aria-label="Each day"
      length={5}
      title={(i) => `${i + 1} Oct`}
      rows={(i) => [
        { label: 'Reports', value: [2, 0, 4, 1, 3][i] ?? null },
        { label: 'Signed in', value: [null, null, 4, null, 2][i] ?? null },
      ]}
      className="grid w-[24rem] grid-cols-[6rem_minmax(0,1fr)] items-end gap-x-(--space-3_5) gap-y-[0.5625rem]"
    >
      <span className={KICKER}>Reports</span>
      <Sparkbars
        aria-label="Reports, each day"
        tone="muted"
        values={[2, 0, 4, 1, 3]}
        className="h-[1.875rem]"
      />
      <span className={KICKER}>Signed in</span>
      <Sparkbars
        aria-label="Signed in, each day"
        tone="muted"
        lightLatest
        values={[null, null, 4, null, 2]}
        className="h-[1.875rem]"
      />
    </SparkbarSet>
  ),
  play: async ({ canvasElement }) => {
    const set = must(canvasElement.querySelector<HTMLElement>('[data-slot="sparkbar-set"]'));
    // Re-queried on every read, so a retry reads the strips as they now are.
    const strip = (i: number) =>
      must([...set.querySelectorAll<HTMLElement>('[data-slot="sparkbars"]')][i]);
    const bars = (i: number) => [
      ...strip(i).querySelectorAll<HTMLElement>('[data-slot="sparkbar"]'),
    ];

    // Five slots on both strips: an unrecorded day keeps the axis whole and lines up with its day.
    await waitFor(() => expect(bars(1)).toHaveLength(5));
    for (let d = 0; d < 5; d++) {
      await expect(
        Math.abs(centerOf(must(bars(0)[d])) - centerOf(must(bars(1)[d]))),
      ).toBeLessThanOrEqual(0.5);
    }
    // It draws nothing: no fill, no zero stub — while a recorded zero keeps its stub.
    for (const d of [0, 1, 3]) {
      const slot = must(bars(1)[d]);
      await expect(slot).toHaveAttribute('data-unrecorded');
      await expect(
        slot.querySelector('[data-slot="sparkbar-fill"], [data-slot="sparkbar-zero"]'),
      ).toBeNull();
    }
    await expect(must(bars(0)[1]).querySelector('[data-slot="sparkbar-zero"]')).not.toBeNull();
    // The scale reads only what was recorded: the 4 stands the strip's full height.
    const h = strip(1).getBoundingClientRect().height;
    const tallest = must(must(bars(1)[2]).querySelector('[data-slot="sparkbar-fill"]'));
    await expect(tallest.getBoundingClientRect().height).toBeCloseTo(h, 0);
    // The latest day is lit as before.
    await expect(must(bars(1)[4])).toHaveAttribute('data-latest');

    // Hovering an unrecorded day: the plate says so for that strip, in words, never "0".
    fireEvent.pointerMove(set, { clientX: centerOf(must(bars(0)[1])) });
    const plate = () => set.querySelector<HTMLElement>('[data-slot="sparkbar-set-plate"]');
    await waitFor(() => expect(plate()).not.toBeNull());
    const values = () => [...must(plate()).querySelectorAll('[data-slot="sparkbar-set-value"]')];
    await waitFor(() =>
      expect(values().map((v) => v.textContent)).toEqual(['0', 'Not recorded yet']),
    );
    await expect(values()[1]).toHaveAttribute('data-unrecorded');
    await expect(getComputedStyle(must(values()[1])).color).toEqual(
      sameColor(computedColor(set, 'var(--fg3)')),
    );
    // The keyboard steps across unrecorded days like any other.
    set.focus();
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(set).toHaveAttribute('aria-valuenow', '0'));
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(set).toHaveAttribute('aria-valuenow', '3'));
    await waitFor(() =>
      expect(values().map((v) => v.textContent)).toEqual(['1', 'Not recorded yet']),
    );
  },
};

/** Unrecorded days in all four maps: empty slots, the zero stubs and fills as ever. */
export const UnrecordedFourUp: Story = {
  render: () => (
    <Sparkbars
      aria-label="Signed in, each day"
      tone="muted"
      lightLatest
      values={[null, 0, 3, null, 2]}
      className="h-[1.875rem] w-[12rem]"
    />
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(q.querySelectorAll('[data-unrecorded]')).toHaveLength(2);
      await expect(q.querySelectorAll('[data-slot="sparkbar-zero"]')).toHaveLength(1);
      await expect(q.querySelectorAll('[data-slot="sparkbar-fill"]')).toHaveLength(2);
    }
  },
};

/** The board's drawn state: a day hovered from the start. */
export const SharedHoverDrawn: Story = {
  render: () => <PulseSet defaultActive={9} />,
  play: async ({ canvasElement }) => {
    const plate = await waitFor(() =>
      must(canvasElement.querySelector('[data-slot="sparkbar-set-plate"]')),
    );
    await expect(plate).toHaveTextContent('10 Oct');
  },
};

/**
 * All four maps: the inks follow each map, and the band's rgba() follows each map's own lift — the
 * drawing reads its nearest theme, not the page's.
 */
/**
 * The drawing follows its theme live: flip the mode around it and the band's rgba() follows (the
 * toolbar's flip, or a scoped preview's).
 */
export const ThemeFlip: Story = {
  render: () => (
    <div data-surface="admin" data-mode="dark" data-flip="">
      <TraceChart
        className="h-[4rem]"
        traces={LOWS.slice(0, 1)}
        band={FIVE_WINTERS}
        aria-label="Overnight lows"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const wrap = must(canvasElement.querySelector<HTMLElement>('[data-flip]'));
    const fill = () =>
      canvasElement.querySelector('[data-slot="trace-band"]')?.getAttribute('fill') ?? null;
    const dark = paperColor({ surface: 'admin', mode: 'dark' }, 'lift-08');
    const light = paperColor({ surface: 'admin', mode: 'light' }, 'lift-08');
    await waitFor(() => expect(fill()).toBe(dark));
    wrap.setAttribute('data-mode', 'light');
    await waitFor(() => expect(fill()).toBe(light));
    wrap.setAttribute('data-mode', 'dark');
    await waitFor(() => expect(fill()).toBe(dark));
  },
};

export const FourUp: Story = {
  render: () => (
    <div className="flex flex-col gap-(--space-4)">
      <TraceChart
        className="h-[6rem]"
        traces={LOWS}
        rules={RULES}
        band={FIVE_WINTERS}
        aria-label="Overnight lows"
      />
      <LedStrip value={9} max={10} full aria-label="Complete" />
      <StageBar stages={['done', 'done', 'run', 'waiting', 'waiting', '|', 'waiting']} />
      <Sparkbars aria-label="Flags" lightLatest values={[1, 2, 0, 3, { value: 4, bad: 1 }, 2, 5]} />
      <PulseSet defaultActive={3} />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const fills = new Set<string | null>();
    for (const q of quads) {
      const svg = await waitFor(() => svgOf(q));
      const band = must(svg.querySelector('[data-slot="trace-band"]'));
      const theme = themeOf(q);
      await expect(theme.surface).toBe(q.dataset.surface);
      await expect(theme.mode).toBe(q.dataset.mode);
      await expect(band.getAttribute('fill')).toBe(paperColor(theme, 'lift-08'));
      fills.add(band.getAttribute('fill'));
      await expectPaperSafe(svg);
      await expectNothingClips(svg);
      await expect(
        getComputedStyle(must(svg.querySelector('[data-trace="clouds"]'))).stroke,
      ).toEqual(sameColor(computedColor(q, 'var(--fg)')));
    }
    // White at an alpha over the dark maps, black over the light ones.
    await expect(fills.size).toBeGreaterThanOrEqual(2);
    await expect([...fills].every((f) => f?.startsWith('rgba('))).toBe(true);
    await expect(tokens.MODES).toContain(themeOf(must(quads[1])).mode);
  },
};
