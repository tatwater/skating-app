import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';
import { ItemTimeline } from './item-timeline';

/** The item timeline (the Inbox's 2.2): three marks by meaning, the line stopping at the last. */
const meta = {
  title: 'Kit/ItemTimeline',
  component: ItemTimeline,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ItemTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

const EVENTS = [
  {
    key: 'a',
    date: '13 Oct',
    mark: 'bad' as const,
    children: <span className="text-row text-fg2">A claim</span>,
  },
  {
    key: 'b',
    date: '12 Sep',
    mark: 'bright' as const,
    children: <span className="text-row text-fg">The ruling</span>,
  },
  {
    key: 'c',
    date: '6 Sep',
    mark: 'quiet' as const,
    children: <span className="text-row text-fg2">Past claims</span>,
  },
];

export const FourUp: Story = {
  args: { events: EVENTS },
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const mark = (m: string) =>
        getComputedStyle(
          must(q.querySelector(`[data-mark="${m}"] [data-slot="item-timeline-mark"]`)),
        ).backgroundColor;
      const [bad, fg] = [computedColor(q, 'var(--bad)'), computedColor(q, 'var(--fg)')];
      await expect(mark('bad')).toEqual(sameColor(bad));
      await expect(mark('bright')).toEqual(sameColor(fg));
      await expect(q.querySelectorAll('[data-slot="item-timeline-line"]')).toHaveLength(2);
    }
  },
};
