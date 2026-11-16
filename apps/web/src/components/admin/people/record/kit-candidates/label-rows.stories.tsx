import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { LabelRows } from './label-rows';

/** Kit candidate: label rows (the record sheet's *If overturned*, 8.7). */
const meta = {
  title: 'Admin/People/Kit candidates/Label rows',
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
