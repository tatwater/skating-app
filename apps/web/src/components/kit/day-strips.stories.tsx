import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { DayStrips } from './day-strips';
import { computedColor, sameColor } from './measure';
import { must } from './storyKit';

/**
 * Day strips, in all four maps — a bare current strip (ten days so far, the rest
 * dotted) over a full one. Generic: series of per-day values on one axis.
 */
const meta = {
  title: 'Kit/DayStrips',
  component: DayStrips,
  parameters: { fourUp: true },
} satisfies Meta<typeof DayStrips>;

export default meta;
type Story = StoryObj<typeof meta>;

const DAYS = 60;
const now = 10;

export const TwoStrips: Story = {
  args: {
    days: DAYS,
    months: [
      { at: 0, label: 'OCT' },
      { at: 31, label: 'NOV' },
    ],
    strips: [
      {
        key: 'a',
        label: '2026–27',
        current: true,
        values: Array.from({ length: DAYS }, (_, i) => (i <= now ? 0 : null)),
        today: now,
        opens: 2,
        summary: 'Nothing yet',
      },
      {
        key: 'b',
        label: '2025–26',
        values: Array.from({ length: DAYS }, (_, i) => (i > 30 && i < 50 ? i % 4 : 0)),
      },
    ],
    className: 'w-[21.25rem]',
  },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const svg = must(q.querySelector('[data-slot="day-strips"]'));
      await expect(svg).toHaveAttribute('aria-label', '2026–27: Nothing yet; 2025–26: 28 in all');
      // The days not yet happened are a dotted line, never bars.
      const [current, previous] = [...q.querySelectorAll('[data-slot="day-strip"]')];
      await expect(current?.querySelectorAll('[data-slot="day-strip-bar"]')).toHaveLength(0);
      await expect(current?.querySelector('[data-slot="day-strip-ahead"]')).not.toBeNull();
      await expect(previous?.querySelector('[data-slot="day-strip-ahead"]')).toBeNull();
      // The record's bars are the quiet ink; today is the bright one.
      const bar = must(previous?.querySelector<SVGElement>('[data-slot="day-strip-bar"]'));
      await expect(getComputedStyle(bar).fill).toEqual(sameColor(computedColor(bar, 'var(--fg3)')));
    }
  },
};
