import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { UncertainDayStrips } from './uncertain-day-strips';

/**
 * Kit candidate: the kit's day strips with an unknown part — a day's known count as the solid bar,
 * and what it may also have held as a broken stack on top, brighter, so a floor never reads as a
 * smaller count, as clear, or as ended. Wants to replace `Kit/Day strips`.
 */

const DAYS = 60;
/** A winter's shape: a few known days, then archived ones whose ends aren't stored. */
const known = Array.from({ length: DAYS }, (_, i) => (i < 8 ? 0 : i < 30 ? 1 + (i % 3) : 2));
const unknown = Array.from({ length: DAYS }, (_, i) => (i < 30 ? 0 : Math.min(6, (i - 28) >> 2)));

const meta = {
  title: 'Admin/Body/Kit candidates/Uncertain day strips',
  component: UncertainDayStrips,
  args: {
    strips: [
      {
        key: 'now',
        label: '2026–27',
        values: Array.from({ length: DAYS }, (_, i) => (i <= 13 ? 0 : null)),
        current: true,
        today: 13,
        opens: 2,
        summary: 'No hazard reports',
      },
      {
        key: 'last',
        label: '2025–26',
        values: known,
        unknown,
        summary: '52 days with hazard reports, 28 with some unknown',
        dayTitle: (i: number) =>
          (unknown[i] ?? 0) > 0
            ? `At least ${known[i]} reported on the lake, ${unknown[i]} unknown`
            : `${known[i]} reported on the lake`,
      },
    ],
    months: [
      { at: 0, label: 'OCT' },
      { at: 31, label: 'NOV' },
    ],
    days: DAYS,
  },
  decorators: [(Story) => <div className="w-full max-w-[21.25rem]">{Story()}</div>],
} satisfies Meta<typeof UncertainDayStrips>;

export default meta;
type Story = StoryObj<typeof meta>;

/** This winter so far, bare, over last winter's record with its unknown days stacked. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const svg = within(canvasElement).getByRole('img');
    await expect(svg).toHaveAccessibleName(/2025–26: 52 days with hazard reports, 28 with some/);
    const block = canvasElement.querySelector<SVGRectElement>('[data-slot="day-strip-unknown"]');
    const bar = canvasElement.querySelector<SVGRectElement>('[data-slot="day-strip-bar"]');
    await expect(block).not.toBeNull();
    await expect(bar).not.toBeNull();
    // The unknown part is the brighter ink: it never reads as less than the known bar.
    await expect(getComputedStyle(block as SVGRectElement).fill).toEqual(
      sameColor(computedColor(block as SVGRectElement, 'var(--fg1)')),
    );
    await expect(getComputedStyle(bar as SVGRectElement).fill).toEqual(
      sameColor(computedColor(bar as SVGRectElement, 'var(--fg3)')),
    );
  },
};

/**
 * A busy day shrinks its strip's step so it stays clear of the strip above; on a step that small
 * the unknown part is one bar a day.
 */
export const TallDay: Story = {
  args: {
    strips: [
      { key: 'a', label: '2026–27', values: [1, 0, 0, 0], current: true },
      { key: 'b', label: '2025–26', values: [2, 4, 1, 0], unknown: [0, 14, 3, 1] },
    ],
    months: [],
    days: 4,
  },
  play: async ({ canvasElement }) => {
    const tall = canvasElement.querySelector('[data-day="1"]');
    const marks = [
      ...(tall?.querySelectorAll<SVGRectElement>('[data-slot="day-strip-unknown"]') ?? []),
    ];
    // Every unknown is counted in the day's mark, never dropped by the smaller step.
    await expect(marks.reduce((n, m) => n + Number(m.dataset.count ?? 1), 0)).toBe(14);
  },
};

/** Both surfaces, both modes. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await expect(q.querySelectorAll('[data-slot="day-strip-unknown"]').length).toBeGreaterThan(0);
    }
  },
};
