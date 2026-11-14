import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, waitFor, within } from 'storybook/test';

import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx, sameColor } from './measure';
import { CellLoader, cellLit, Meter, meterTone } from './meter';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Meter',
  component: Meter,
  tags: ['autodocs'],
  args: { value: 24, 'aria-label': 'R2 storage' },
  decorators: [(Story) => <div className="w-[16rem]">{Story()}</div>],
} satisfies Meta<typeof Meter>;

export default meta;
type Story = StoryObj<typeof meta>;

const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** A story's `beforeEach`: the page's script sees `prefers-reduced-motion: reduce`. */
function reduceMotion() {
  const real = window.matchMedia.bind(window);
  const spy = spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    const list = real(query);
    if (!query.includes('prefers-reduced-motion')) return list;
    return {
      matches: true,
      media: query,
      onchange: null,
      addEventListener: list.addEventListener.bind(list),
      removeEventListener: list.removeEventListener.bind(list),
      addListener: list.addListener.bind(list),
      removeListener: list.removeListener.bind(list),
      dispatchEvent: list.dispatchEvent.bind(list),
    } satisfies MediaQueryList;
  });
  return () => spy.mockRestore();
}

/**
 * The bare quota bar, under a value that already says what it is: 4 px, the hairline ground, the
 * list-body gray filling to the value. A measurement, so `role="meter"`.
 */
export const Bare: Story = {
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter', { name: 'R2 storage' });
    await expect(meter).toHaveAttribute('aria-valuenow', '24');
    const track = part(meter, 'meter-track');
    const fill = part(meter, 'meter-fill');
    // One height everywhere: the 4 px token.
    const height = track.getBoundingClientRect().height;
    await expect(height).toBeCloseTo(resolvePx(track, 'var(--stroke-now)'), 2);
    await expect(height).toBe(4);
    await expect(getComputedStyle(track).backgroundColor).toEqual(
      sameColor(computedColor(track, 'var(--line)')),
    );
    await expect(getComputedStyle(fill).backgroundColor).toEqual(
      sameColor(computedColor(fill, 'var(--fg2)')),
    );
    await expect(fill.getBoundingClientRect().width).toBeCloseTo(
      track.getBoundingClientRect().width * 0.24,
      1,
    );
    // Bare: no header.
    await expect(meter.querySelector('[data-slot="meter-header"]')).toBeNull();
  },
};

/**
 * Labeled: a kicker over the track, the mono readout at its right. The header sits `space-1_5`
 * over the track.
 */
export const Labeled: Story = {
  args: {
    'aria-label': undefined,
    label: 'Open-Meteo',
    value: 1940,
    max: 10000,
    showValue: (_, value) => `${value.toLocaleString('en-US')} of 10,000`,
  },
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter', { name: 'Open-Meteo' });
    const label = part(meter, 'meter-label');
    const value = part(meter, 'meter-value');
    await expect(getComputedStyle(label).textTransform).toBe('uppercase');
    await expect(value).toHaveTextContent(/^1,940 of 10,000$/);
    await expect(getComputedStyle(value).fontFamily).toMatch(/Martian Mono/);
    const header = part(meter, 'meter-header').getBoundingClientRect();
    const track = part(meter, 'meter-track').getBoundingClientRect();
    await expect(
      Math.abs(track.top - header.bottom - resolvePx(meter, 'var(--space-1_5)')),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // The readout ends at the track's right edge.
    await expect(Math.abs(value.getBoundingClientRect().right - track.right)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
  },
};

/** `showValue` alone: Base UI's formatted value, no label. */
export const ValueOnly: Story = {
  args: { value: 0.42, max: 1, showValue: true, format: { style: 'percent' } },
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter', { name: 'R2 storage' });
    await expect(part(meter, 'meter-value')).toHaveTextContent('42%');
    await expect(meter.querySelector('[data-slot="meter-label"]')).toBeNull();
  },
};

/** At the amber threshold the fill turns amber — it waits on a person. */
export const Warn: Story = {
  args: { value: 72, warnAt: 70, badAt: 90 },
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter');
    await expect(meter).toHaveAttribute('data-tone', 'warn');
    const fill = part(meter, 'meter-fill');
    await expect(getComputedStyle(fill).backgroundColor).toEqual(
      sameColor(computedColor(fill, 'var(--warn)')),
    );
  },
};

/** At the red threshold the fill turns red — it won't recover without a person. */
export const Bad: Story = {
  args: { value: 96, warnAt: 70, badAt: 90 },
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter');
    await expect(meter).toHaveAttribute('data-tone', 'bad');
    const fill = part(meter, 'meter-fill');
    await expect(getComputedStyle(fill).backgroundColor).toEqual(
      sameColor(computedColor(fill, 'var(--bad)')),
    );
  },
};

/** A tone can be forced past the thresholds (an overage the meter can't know about). */
export const ForcedTone: Story = {
  args: { value: 10, warnAt: 70, tone: 'warn' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('meter')).toHaveAttribute('data-tone', 'warn');
    // The rule itself.
    await expect(meterTone(50, {})).toBe('default');
    await expect(meterTone(69.9, { warnAt: 70, badAt: 90 })).toBe('default');
    await expect(meterTone(70, { warnAt: 70, badAt: 90 })).toBe('warn');
    await expect(meterTone(90, { warnAt: 70, badAt: 90 })).toBe('bad');
    await expect(meterTone(95, { badAt: 90 })).toBe('bad');
  },
};

/**
 * Machinery's threshold line: an amber hairline tick across the track, 3 px proud of it on each
 * side, at the threshold's place on the range.
 */
export const ThresholdMark: Story = {
  args: { value: 19.4, mark: 70 },
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter');
    const track = part(meter, 'meter-track').getBoundingClientRect();
    const mark = part(meter, 'meter-mark');
    const box = mark.getBoundingClientRect();
    await expect(box.left - track.left).toBeCloseTo(track.width * 0.7, 1);
    await expect(box.width).toBe(1);
    await expect(track.top - box.top).toBeCloseTo(3, 2);
    await expect(box.bottom - track.bottom).toBeCloseTo(3, 2);
    await expect(getComputedStyle(mark).backgroundColor).toEqual(
      sameColor(computedColor(mark, 'var(--warn)')),
    );
  },
};

/**
 * The imagery gate (Body console): a white tick standing 4 px over and under the track, centered on
 * the value the pass must reach. A pass short of its gate steps back to the dim fill.
 */
export const GateMark: Story = {
  args: { value: 42, mark: 60, markTone: 'lit', tone: 'dim', 'aria-label': 'Clear of cloud' },
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter');
    const track = part(meter, 'meter-track').getBoundingClientRect();
    const mark = part(meter, 'meter-mark');
    const box = mark.getBoundingClientRect();
    // Centered on 60 %: its middle, not its left edge, is the value.
    await expect(box.left + box.width / 2 - track.left).toBeCloseTo(track.width * 0.6, 1);
    await expect(box.width).toBe(1);
    await expect(track.top - box.top).toBeCloseTo(4, 2);
    await expect(box.bottom - track.bottom).toBeCloseTo(4, 2);
    await expect(getComputedStyle(mark).backgroundColor).toEqual(
      sameColor(computedColor(mark, 'var(--fg)')),
    );
    await expect(getComputedStyle(part(meter, 'meter-fill')).backgroundColor).toEqual(
      sameColor(computedColor(mark, 'var(--fg3)')),
    );
  },
};

/** The mark reads the range: on a 0–2,000 meter, 1,400 sits at 70 %. */
export const ThresholdMarkOnARange: Story = {
  args: { value: 14, min: 0, max: 2000, mark: 1400 },
  play: async ({ canvasElement }) => {
    const meter = within(canvasElement).getByRole('meter');
    const track = part(meter, 'meter-track').getBoundingClientRect();
    const box = part(meter, 'meter-mark').getBoundingClientRect();
    await expect(box.left - track.left).toBeCloseTo(track.width * 0.7, 1);
  },
};

// ── The cell loader ──────────────────────────────────────────────────────────────────────────

const litCells = (root: ParentNode) =>
  [...root.querySelectorAll('[data-slot="cell"]')].flatMap((c, i) =>
    c.hasAttribute('data-lit') ? [i + 1] : [],
  );

/**
 * Loading, length unknown: seven cells fill from the middle out — 4, then 3/5, then 2/6, then
 * 1/7 — and start again. An indeterminate progress bar (no value).
 */
export const Loader: Story = {
  render: () => <CellLoader label="Loading runs" />,
  play: async ({ canvasElement }) => {
    const loader = within(canvasElement).getByRole('progressbar', { name: 'Loading runs' });
    await expect(loader).not.toHaveAttribute('aria-valuenow');
    await expect(loader.querySelectorAll('[data-slot="cell"]')).toHaveLength(7);
    // Watch it run: every step of the fill shows, in order, with the right cells lit.
    const want: Record<string, number[]> = {
      '0': [],
      '1': [4],
      '2': [3, 4, 5],
      '3': [2, 3, 4, 5, 6],
      '4': [1, 2, 3, 4, 5, 6, 7],
    };
    const seen = new Map<string, number[]>();
    await waitFor(
      () => {
        const step = must(loader.getAttribute('data-step'));
        seen.set(step, litCells(loader));
        expect(seen.size).toBe(5);
      },
      { timeout: 4000, interval: 40 },
    );
    for (const [step, lit] of seen) await expect(lit, `step ${step}`).toEqual(want[step]);
    // The rule itself, for the record.
    await expect([0, 1, 2, 3, 4, 5, 6].filter((i) => cellLit(i, 2))).toEqual([2, 3, 4]);
  },
};

/** The cells are the LED segments' drawing: 0.7 × 0.8 kicker, 2 px apart; lit is the fill gray. */
export const LoaderCells: Story = {
  render: () => <CellLoader />,
  play: async ({ canvasElement }) => {
    const loader = within(canvasElement).getByRole('progressbar', { name: 'Loading' });
    const cells = [...loader.querySelectorAll<HTMLElement>('[data-slot="cell"]')];
    const kick = resolvePx(loader, 'var(--type-kick)');
    const first = must(cells[0]).getBoundingClientRect();
    await expect(first.width).toBeCloseTo(kick * 0.7, 1);
    await expect(first.height).toBeCloseTo(kick * 0.8, 1);
    const gap = must(cells[1]).getBoundingClientRect().left - first.right;
    await expect(Math.abs(gap - resolvePx(loader, 'var(--space-0_5)'))).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    const middle = must(cells[3]);
    await waitFor(() => expect(middle).toHaveAttribute('data-lit'));
    await expect(getComputedStyle(middle).backgroundColor).toEqual(
      sameColor(computedColor(middle, 'var(--fg2)')),
    );
  },
};

/** Under reduced motion it holds still on the middle cell — still working, no motion. */
export const LoaderReducedMotion: Story = {
  render: () => <CellLoader />,
  beforeEach: reduceMotion,
  play: async ({ canvasElement }) => {
    const loader = within(canvasElement).getByRole('progressbar');
    for (let i = 0; i < 4; i++) {
      await expect(loader).toHaveAttribute('data-step', '1');
      await expect(litCells(loader)).toEqual([4]);
      await new Promise((r) => setTimeout(r, 200));
    }
  },
};

// ── Board and four-up ────────────────────────────────────────────────────────────────────────

function Board() {
  return (
    <div className="flex w-full max-w-[18rem] flex-col gap-heading">
      <Meter label="R2 storage" value={2.4} max={10} showValue={(_, v) => `${v} of 10 GB`} />
      <Meter
        label="Open-Meteo calls today"
        value={7600}
        max={10000}
        warnAt={7000}
        badAt={9000}
        mark={7000}
        showValue={(_, v) => `${v.toLocaleString('en-US')} of 10,000`}
      />
      <Meter
        label="Resend this month"
        value={2950}
        max={3000}
        warnAt={2100}
        badAt={2700}
        showValue
      />
      <Meter aria-label="OpenRouteService today" value={18} max={2000} />
      <Meter aria-label="Lake in the pass" value={83} mark={50} markTone="lit" />
      <Meter aria-label="Clear of cloud" value={42} mark={60} markTone="lit" tone="dim" />
      <div className="flex items-center gap-(--space-3)">
        <span className={KICKER}>Loading</span>
        <CellLoader />
      </div>
    </div>
  );
}

/** Every form in all four maps: one 4 px height on every surface. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      for (const track of q.querySelectorAll('[data-slot="meter-track"]')) {
        await expect(track.getBoundingClientRect().height).toBe(4);
      }
      await expect(within(q).getAllByRole('meter')).toHaveLength(6);
      // A readout never wraps, however long its label: one line of its own type.
      for (const v of q.querySelectorAll<HTMLElement>('[data-slot="meter-value"]')) {
        const size = parseFloat(getComputedStyle(v).fontSize);
        await expect(v.getBoundingClientRect().height).toBeLessThan(size * 1.5);
      }
    }
  },
};
