import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Lanes } from '@/components/kit/lanes';

import { SearchLane } from './search-lane';

/**
 * The search lane (People, B01) — a search over the lanes' subject, drawn as the
 * first lane of the sidebar, on the input's own rule; its `/` cap shows at rest.
 */
const meta = {
  title: 'Kit/SearchLane',
  component: SearchLane,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { value: '', label: 'Search any account', onSearch: fn() },
  decorators: [
    (Story) => (
      <div className="w-(--size-lanes) border-0 border-r border-solid border-line pt-(--space-3_5)">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchLane>;

export default meta;
type Story = StoryObj<typeof meta>;

/** At rest, and typing: what was typed is sent once typing rests. */
export const Typing: Story = {
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByRole('searchbox', { name: 'Search any account' });
    await userEvent.type(input, 'rob');
    await waitFor(() => expect(args.onSearch).toHaveBeenCalledWith('rob'));
  },
};

/** Over the lanes, as People draws it: the search lane, then the lists. */
export const OverLanes: Story = {
  render: (args) => (
    <>
      <SearchLane {...args} />
      <Lanes
        label="People"
        className="pt-(--space-3)"
        selected="suspended"
        groups={[
          {
            label: 'Lists',
            lanes: [
              { id: 'everyone', label: 'Everyone', count: 38 },
              { id: 'staff', label: 'Staff', count: 3 },
              { id: 'suspended', label: 'Suspended', count: 1, countTone: 'warn' },
              { id: 'banned', label: 'Banned', count: 0, dim: true },
            ],
          },
        ]}
      />
    </>
  ),
};

/** Its states: at rest, holding a search, and off. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-(--space-4)">
      <SearchLane {...args} />
      <SearchLane {...args} value="tremblay" />
      <SearchLane {...args} disabled />
    </div>
  ),
};

/** The states in all four maps. */
export const FourUp: Story = { ...States, parameters: { fourUp: true } };
