import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { LabelRows } from './label-rows';
import { computedColor, sameColor } from './measure';

/** Label rows (the record sheet's *If overturned*, 8.7). */
const meta = {
  title: 'Kit/LabelRows',
  component: LabelRows,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    rows: [
      { label: 'Record', value: 'The decision comes off Rob’s record' },
      { label: 'Comment', value: 'Stays deleted · it never comes back' },
      { label: 'Erased', value: 'Sun 25 Oct · 30 days after Rob deleted it' },
    ],
  },
  decorators: [(Story) => <div className="w-[36rem]">{Story()}</div>],
} satisfies Meta<typeof LabelRows>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const terms = within(canvasElement).getAllByRole('term');
    await expect(terms.map((t) => t.textContent)).toEqual(['Record', 'Comment', 'Erased']);
    // The labels share one column: every value starts at the same left edge.
    const values = within(canvasElement).getAllByRole('definition');
    const lefts = values.map((v) => Math.round(v.getBoundingClientRect().left));
    await expect(new Set(lefts).size).toBe(1);
  },
};

/** All four surface × mode maps: the label's ink and the value's follow each map's tokens. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const [term] = within(q).getAllByRole('term');
      const [value] = within(q).getAllByRole('definition');
      await expect(getComputedStyle(term as HTMLElement).color).toEqual(
        sameColor(computedColor(q, 'var(--fg3)')),
      );
      await expect(getComputedStyle(value as HTMLElement).color).toEqual(
        sameColor(computedColor(q, 'var(--fg2)')),
      );
    }
  },
};
