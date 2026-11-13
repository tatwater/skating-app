import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Button } from '@/components/kit/button';

import { FilterChip, FilterChipRow, FilterCount } from './filter-chip';

/** Kit candidate: the applied-filter chips and the Filter button's count (Bodies 5.2). */
const meta = {
  title: 'Kit candidates/FilterChip',
  component: FilterChip,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { facet: 'Size', children: '1,000 ac and up', onRemove: fn() },
} satisfies Meta<typeof FilterChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One chip; its × takes the option off. */
export const Chip: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Remove Size: 1,000 ac and up' }),
    );
    await expect(args.onRemove).toHaveBeenCalledTimes(1);
  },
};

/** The row as a list draws it: the chips, then Clear; and the button that counts them. */
export const Row: Story = {
  render: (args) => (
    <div className="flex flex-col gap-(--space-3)">
      <Button size="sm">
        <FilterCount count={2} />
        Filter
      </Button>
      <FilterChipRow>
        <FilterChip {...args} />
        <FilterChip facet="Class" onRemove={args.onRemove}>
          Reservoir
        </FilterChip>
        <Button size="xs">Clear</Button>
      </FilterChipRow>
    </div>
  ),
};

/** The row in all four maps. */
export const FourUp: Story = { ...Row, parameters: { fourUp: true } };
