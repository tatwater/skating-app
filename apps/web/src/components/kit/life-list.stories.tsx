import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { LifeList } from './life-list';
import { computedColor, sameColor } from './measure';
import { must } from './storyKit';

/** Its life, top to bottom (the record sheet on a phone, 8.9). */
const meta = {
  title: 'Kit/LifeList',
  component: LifeList,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    'aria-label': 'Its life',
    lines: [
      { line: 'heavy', label: 'Visible to skaters' },
      { line: 'thin', label: 'Out of sight' },
      { line: 'dashed', label: 'If overturned' },
    ],
    stations: [
      {
        when: 'Tue 22 Sep',
        title: 'Posted',
        sub: 'On Luc Pelletier’s report',
        mark: 'dot',
        next: 'heavy',
        lasted: '1 day',
      },
      {
        when: 'Wed 23 Sep',
        title: 'Hidden',
        sub: 'By Ana',
        mark: 'hollow',
        next: 'thin',
        lasted: '2 days',
      },
      {
        when: 'Fri 25 Sep',
        title: 'Deleted by Rob',
        sub: 'Kept as evidence',
        mark: 'warn',
        next: 'thin',
        lasted: '19 days',
      },
      {
        when: '14 Oct · today',
        title: 'On the record',
        sub: '21 days out of sight',
        mark: 'now',
        next: 'dashed',
      },
      {
        when: 'If overturned',
        title: 'Erased Sun 25 Oct',
        sub: '30 days after Rob deleted it',
        mark: 'end',
      },
    ],
  },
  decorators: [(Story) => <div className="w-[22rem]">{Story()}</div>],
} satisfies Meta<typeof LifeList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const stations = canvasElement.querySelectorAll('[data-slot="life-list-station"]');
    await expect(stations).toHaveLength(5);
    // Every station but the last draws its line down the rail; the last draws none.
    await expect(canvasElement.querySelectorAll('[data-slot="life-list-line"]')).toHaveLength(4);
    await expect(stations[4]?.querySelector('[data-slot="life-list-line"]')).toBeNull();
    // Each station sits under the one before it.
    const a = (stations[0] as HTMLElement).getBoundingClientRect();
    const b = (stations[1] as HTMLElement).getBoundingClientRect();
    await expect(b.top).toBeGreaterThanOrEqual(a.bottom - 1);
  },
};

/** All four surface × mode maps: an open mark is filled with its own ground, so no line shows through. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const end = must(q.querySelector<HTMLElement>('[data-mark="end"] [aria-hidden] > span'));
      await expect(getComputedStyle(end).backgroundColor).toEqual(
        sameColor(computedColor(q, 'var(--bg)')),
      );
    }
  },
};
