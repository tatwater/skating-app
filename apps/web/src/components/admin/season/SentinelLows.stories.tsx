import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';

import { SentinelLows } from './SentinelLows';
import { LOWS_BOARD, LOWS_GAPPY, LOWS_WINTER } from './sentinelLowsFixtures';
import { type LowsState, lowsView } from './sentinelLowsModel';

/**
 * **Overnight Lows at the Sentinels** (B01-2b): the Seasons board's row, drawn on the Overview's Home
 * from `sentinelLows.forSeason`. Board 7.1's numbers; the row's four answers; a gap; a long season;
 * the phone.
 */
const meta = {
  title: 'Admin/Season/Sentinel lows',
  component: SentinelLows,
  globals: { surface: 'admin', mode: 'dark' },
  args: { state: { kind: 'value', view: lowsView(LOWS_BOARD) } as LowsState },
  decorators: [(Story) => <div className="w-[69.5rem] max-w-full">{Story()}</div>],
} satisfies Meta<typeof SentinelLows>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every read and its assertion in one retry: a node held across an await can be a detached one. */
const steady = (check: () => void) => waitFor(check, { timeout: 5_000 });
const all = (scope: Element, sel: string) => [...scope.querySelectorAll<HTMLElement>(sel)];
const texts = (scope: Element, sel: string) => all(scope, sel).map((el) => el.textContent ?? '');

/** Board 7.1's row: three lines, both lines, both marked nights, end labels, the matrix. */
export const Board: Story = {
  play: async ({ canvasElement }) => {
    await steady(() => {
      expect(all(canvasElement, '.recharts-line-curve')).toHaveLength(3);
      expect(texts(canvasElement, '[data-slot="lows-end-label"]')).toEqual([
        'Clouds 31',
        'Eagle 33',
        'Kinsman 37',
      ]);
      expect(texts(canvasElement, '[data-slot="lows-event-words"]')).toEqual([
        'Watch opened · 2 of 3',
        'Imagery line · 19 °F',
      ]);
      // A ⊗ on each sentinel the record named: two on the opening night, two on the imagery night.
      expect(all(canvasElement, '[data-slot="lows-event-mark"]')).toHaveLength(4);
    });
    await steady(() => {
      expect(texts(canvasElement, '[data-slot="chart-legend-item"]')).toEqual([
        'Clouds',
        'Eagle',
        'Kinsman',
        'the watch · 32 °F',
        'imagery · 20 °F',
      ]);
      expect(texts(canvasElement, '[data-slot="metrics-span"]')).toEqual(['°F · 1–12 Oct']);
      const dashes = all(canvasElement, '[data-pattern="dashed"]');
      expect(dashes).toHaveLength(2);
      // The imagery line wears the warning tone, as the board draws it.
      expect(getComputedStyle(dashes[1] as HTMLElement).borderTopColor).toEqual(
        sameColor(computedColor(dashes[1] as HTMLElement, 'var(--warn)')),
      );
    });
    // The matrix writes each night's low and says it with its sentinel and night.
    await steady(() => {
      const cells = all(canvasElement, '[role="gridcell"]');
      expect(cells).toHaveLength(36);
      expect(cells[6]).toHaveAttribute('aria-label', 'Clouds, 7 Oct: 19 °F');
      expect(texts(canvasElement, '[data-slot="matrix-value"]').slice(0, 3)).toEqual([
        '34',
        '31',
        '27',
      ]);
    });
    // The chart names what it draws.
    await expect(canvasElement.querySelector('[data-slot="chart"]')).toHaveAttribute(
      'aria-label',
      'Overnight lows at the sentinels, 1–12 Oct, °F',
    );
  },
};

/** The same row in light: the scale is the same reading, the inks follow the theme. */
export const Light: Story = { globals: { surface: 'admin', mode: 'light' } };

/** Gaps: no line across a missing night, an empty cell, an end label that says its own night. */
export const Gaps: Story = {
  args: { state: { kind: 'value', view: lowsView(LOWS_GAPPY) } },
  play: async ({ canvasElement }) => {
    await steady(() => {
      expect(texts(canvasElement, '[data-slot="lows-end-label"]')).toEqual([
        'Clouds 31',
        'Eagle 30 · 9 Oct',
      ]);
      // Clouds missed the opening night: only Eagle's ⊗ there; both on the imagery night.
      expect(all(canvasElement, '[data-slot="lows-event-mark"]')).toHaveLength(3);
      const cells = all(canvasElement, '[role="gridcell"]');
      expect(cells[2]).toHaveAttribute('data-step', 'none');
      expect(cells[2]).toHaveAttribute('aria-label', 'Clouds, 3 Oct: no reading');
      // Kinsman stored nothing: a row of empty cells, never a zero.
      expect(cells.slice(24).every((c) => c.dataset.step === 'none')).toBe(true);
      expect(cells.slice(24).every((c) => c.textContent === '')).toBe(true);
    });
  },
};

/** A whole winter: the cells too narrow for their numbers say them on hover and to a reader. */
export const LongSeason: Story = {
  args: { state: { kind: 'value', view: lowsView(LOWS_WINTER) } },
  play: async ({ canvasElement }) => {
    await steady(() => {
      expect(texts(canvasElement, '[data-slot="metrics-span"]')).toEqual(['°F · 1 Oct–31 Jan']);
      expect(all(canvasElement, '[data-slot="matrix-value"]')).toHaveLength(0);
      expect(all(canvasElement, '[role="gridcell"]')).toHaveLength(369);
      // About four dates on the axis, the first and the last among them.
      const labels = texts(canvasElement, '[data-slot="night-tick"] text');
      expect(labels[0]).toBe('1 Oct');
      expect(labels.at(-1)).toBe('31 Jan');
    });
  },
};

const frames: Array<[string, LowsState]> = [
  ['loading', { kind: 'loading' }],
  ['failed', { kind: 'failed', retry: () => {}, pending: false }],
  ['before', { kind: 'before', countsFrom: '2026-10-01' }],
  ['none', { kind: 'none' }],
  ['value', { kind: 'value', view: lowsView(LOWS_BOARD) }],
];

/** The four answers, each in the same box: on its way, failed, not recorded (two ways), the lows. */
export const Answers: Story = {
  render: () => (
    <div className="flex flex-col gap-(--space-8)">
      {frames.map(([key, state]) => (
        <SentinelLows key={key} state={state} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    await steady(() => {
      const rows = all(canvasElement, '[data-slot="sentinel-lows"]');
      expect(rows.map((r) => r.dataset.state)).toEqual([
        'loading',
        'failed',
        'before',
        'none',
        'value',
      ]);
      expect(rows[1]).toHaveTextContent('The sentinels’ overnight lows couldn’t be read');
      expect(rows[2]).toHaveTextContent('Record begins 1 Oct');
      expect(rows[3]).toHaveTextContent('Not recorded yet');
      // Never a zero where nothing is recorded.
      for (const row of rows.slice(0, 4)) expect(row.textContent).not.toMatch(/\b0\b/);
      // Every answer holds the lows' box, so the page under it doesn't move as the read lands.
      const heights = rows.map(
        (r) =>
          (
            r.querySelector('[data-slot="sentinel-lows-body"]') as HTMLElement
          ).getBoundingClientRect().height,
      );
      for (const h of heights.slice(0, 4))
        expect(Math.abs(h - (heights[4] as number))).toBeLessThanOrEqual(1);
    });
  },
};

/** Try again runs the read again. */
export const Failed: Story = {
  args: { state: { kind: 'failed', retry: fn(), pending: false } },
  play: async ({ canvasElement, args }) => {
    const button = await waitFor(() => {
      const b = canvasElement.querySelector('button');
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    await userEvent.click(button);
    await expect((args.state as { retry: () => void }).retry).toHaveBeenCalledOnce();
  },
};

/** At 360 px the end labels go, the names move left, and nothing scrolls sideways. */
export const Phone: Story = {
  decorators: [(Story) => <div className="w-[22.5rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    await steady(() => {
      const row = canvasElement.querySelector<HTMLElement>('[data-slot="sentinel-lows"]');
      expect(row).not.toBeNull();
      expect((row as HTMLElement).scrollWidth).toBeLessThanOrEqual(
        (row as HTMLElement).clientWidth,
      );
      expect(all(canvasElement, '[data-slot="lows-end-label"]')).toHaveLength(0);
      expect(all(canvasElement, '.recharts-line-curve')).toHaveLength(3);
      // The cells still speak their values.
      expect(all(canvasElement, '[role="gridcell"]')[0]).toHaveAttribute(
        'aria-label',
        'Clouds, 1 Oct: 34 °F',
      );
    });
  },
};
