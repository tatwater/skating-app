import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Lanes } from '@/components/kit/lanes';
import { computedColor, sameColor } from '@/components/kit/measure';

import { LaneCount } from './lane-count';

/**
 * A kit candidate (People, B01): a lane's count that keeps its meaning's ink when its lane is
 * chosen — board 8.1's Suspended, open, its count still amber.
 */
const meta = {
  title: 'Kit candidates/LaneCount',
  component: LaneCount,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { tone: 'warn', children: '1' },
} satisfies Meta<typeof LaneCount>;

export default meta;
type Story = StoryObj<typeof meta>;

/** In the lanes: Suspended chosen, its count amber; a failed lane's count red beside it. */
export const InLanes: Story = {
  render: (args) => (
    <div className="w-(--size-lanes)">
      <Lanes
        label="People"
        selected="suspended"
        groups={[
          {
            label: 'Lists',
            lanes: [
              { id: 'everyone', label: 'Everyone', count: 38 },
              { id: 'suspended', label: 'Suspended', tail: <LaneCount {...args} /> },
              { id: 'failed', label: 'Failed runs', tail: <LaneCount tone="bad">2</LaneCount> },
            ],
          },
        ]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const chosen = within(canvasElement).getByRole('button', { name: /Suspended/ });
    await expect(chosen).toHaveAttribute('aria-current', 'true');
    const count = within(chosen).getByText('1');
    await expect(getComputedStyle(count).color).toEqual(
      sameColor(computedColor(count, 'var(--warn)')),
    );
  },
};

/** The lanes in all four maps. */
export const FourUp: Story = { ...InLanes, play: undefined, parameters: { fourUp: true } };
