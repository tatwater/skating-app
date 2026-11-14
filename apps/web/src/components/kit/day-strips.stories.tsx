import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { DayStrips } from './day-strips';
import { computedColor, sameColor } from './measure';

/**
 * Day strips: a day's known count as the solid bar, and an entry whose span isn't recorded as one
 * brighter mark on the day it was first reported — with the caption that says a mark isn't an end.
 */

const DAYS = 60;
/** A winter's shape: open hazards' spans, and archived ones' first reports, whose ends aren't stored. */
const known = Array.from({ length: DAYS }, (_, i) => (i < 8 ? 0 : i < 30 ? 1 + (i % 3) : 2));
const marks = Array.from({ length: DAYS }, (_, i) => (i === 12 || i === 33 ? 1 : i === 41 ? 2 : 0));
const CAPTION =
  'A bright mark is the day a hazard with no recorded end was first reported. How long it stayed on the lake isn’t recorded; the days after it are not a reading of the ice.';

const meta = {
  title: 'Kit/Day strips',
  component: DayStrips,
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
        marks,
        summary: '52 days with hazard reports, 4 first reports with no recorded end',
        dayTitle: (i: number) =>
          (marks[i] ?? 0) > 0
            ? `${(known[i] ?? 0) + (marks[i] ?? 0)} reported on the lake, ${marks[i]} first reported this day`
            : `${known[i]} reported on the lake`,
      },
    ],
    months: [
      { at: 0, label: 'OCT' },
      { at: 31, label: 'NOV' },
    ],
    days: DAYS,
    caption: CAPTION,
  },
  decorators: [(Story) => <div className="w-full max-w-[21.25rem]">{Story()}</div>],
} satisfies Meta<typeof DayStrips>;

export default meta;
type Story = StoryObj<typeof meta>;

/** This winter so far, bare, over last winter's record with its first-report marks. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const svg = within(canvasElement).getByRole('img');
    await expect(svg).toHaveAccessibleName(/2025–26: 52 days with hazard reports, 4 first reports/);
    const block = canvasElement.querySelector<SVGRectElement>('[data-slot="day-strip-mark"]');
    const bar = canvasElement.querySelector<SVGRectElement>('[data-slot="day-strip-bar"]');
    await expect(block).not.toBeNull();
    await expect(bar).not.toBeNull();
    // A mark is the brighter ink, and never stands without its caption.
    await expect(
      within(canvasElement).getByText(/How long it stayed on the lake isn’t recorded/),
    ).toBeVisible();
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
 * a day's marks are one bar that counts them.
 */
export const TallDay: Story = {
  args: {
    strips: [
      { key: 'a', label: '2026–27', values: [1, 0, 0, 0], current: true },
      { key: 'b', label: '2025–26', values: [2, 4, 1, 0], marks: [0, 14, 3, 1] },
    ],
    months: [],
    days: 4,
  },
  play: async ({ canvasElement }) => {
    const tall = canvasElement.querySelector('[data-day="1"]');
    const marks = [
      ...(tall?.querySelectorAll<SVGRectElement>('[data-slot="day-strip-mark"]') ?? []),
    ];
    // Every mark is counted in the day's bar of marks, never dropped by the smaller step.
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
      await expect(q.querySelectorAll('[data-slot="day-strip-mark"]').length).toBeGreaterThan(0);
    }
  },
};
