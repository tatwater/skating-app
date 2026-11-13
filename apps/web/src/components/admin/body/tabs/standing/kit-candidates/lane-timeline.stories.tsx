import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { faceLoaded, must } from '@/components/kit/storyKit';

import { LaneTimeline } from './lane-timeline';

/**
 * A kit candidate: the lane timeline, in all four maps. Generic data — lanes, spans and gridlines —
 * so a promotion into the kit is a file move.
 */
const meta = {
  title: 'Kit candidates/Lane timeline',
  component: LaneTimeline,
  parameters: { fourUp: true },
} satisfies Meta<typeof LaneTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

const Y = (n: number) => n * 100;

/** Two lanes that hold, one that ends on the third gridline. */
export const Lanes: Story = {
  args: {
    start: 0,
    end: Y(4),
    axisLabel: 'Rollovers',
    gridlines: [71, 171, 271, 371].map((at, i) => ({ at, label: String(2027 + i) })),
    lanes: [
      { key: 'a', label: 'Map boost', value: '0.3 · 19 Sep', end: null },
      { key: 'b', label: 'Favorites', value: '9 skaters', end: null },
      {
        key: 'c',
        label: 'On the water',
        value: '10 Oct · a report',
        end: 371,
        endLabel: 'Until 2030',
      },
    ],
    className: 'w-[21.25rem]',
  },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const q = must(quads[0]);
    await faceLoaded(must(q.querySelector('[data-slot="lane-axis-label"]')), '2027');
    await faceLoaded(must(q.querySelector('[data-slot="lane-label"] span')), 'Map boost');
    for (const quad of quads) {
      const lanes = [...quad.querySelectorAll<HTMLElement>('[data-slot="lane"]')];
      await expect(lanes).toHaveLength(3);
      // Open lanes run the whole track; the ending one stops at its gridline.
      const track = must(
        lanes[0]?.querySelector('[data-slot="lane-track"]'),
      ).getBoundingClientRect();
      const open = must(lanes[0]?.querySelector('[data-slot="lane-bar"]')).getBoundingClientRect();
      await expect(Math.abs(open.right - track.right)).toBeLessThanOrEqual(1);
      const ends = must(lanes[2]?.querySelector<HTMLElement>('[data-slot="lane-bar"]'));
      const r = ends.getBoundingClientRect();
      await expect(Math.abs(r.right - (track.left + track.width * 0.9275))).toBeLessThanOrEqual(1);
      // The bars are the bright ink, the gridlines the dotted hairline.
      await expect(getComputedStyle(ends).backgroundColor).toEqual(
        sameColor(computedColor(ends, 'var(--fg)')),
      );
      const grid = [...quad.querySelectorAll<HTMLElement>('[data-slot="lane-gridline"]')];
      await expect(grid.map((g) => getComputedStyle(g).borderLeftStyle)).toEqual([
        'solid',
        'dotted',
        'dotted',
        'dotted',
        'dotted',
      ]);
      // A reader hears where each ends.
      await expect(lanes.map((l) => l.textContent)).toEqual([
        'Map boost0.3 · 19 SepHolds',
        'Favorites9 skatersHolds',
        'On the water10 Oct · a reportUntil 2030',
      ]);
    }
  },
};
