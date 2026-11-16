import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { RetryNote } from './retry-note';

/** A read that failed, said in its own place, with Try again (Bodies, the Body console). */
const meta = {
  title: 'Kit/RetryNote',
  component: RetryNote,
  tags: ['autodocs'],
  globals: { surface: 'admin', mode: 'dark' },
  args: { children: 'The history couldn’t be read', onRetry: fn() },
} satisfies Meta<typeof RetryNote>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The note and its action; Try again runs the read again. */
export const Failed: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** Its states side by side: failed, pending after Try again, and one nothing can retry. */
export const States: Story = {
  render: (args) => (
    <div className="flex w-[22rem] flex-col gap-(--space-5)">
      <RetryNote {...args} />
      <RetryNote {...args} pending>
        Couldn’t read who asked
      </RetryNote>
      <RetryNote>The archive couldn’t be read</RetryNote>
    </div>
  ),
};

/** The states in all four maps. */
export const FourUp: Story = { ...States, parameters: { fourUp: true } };

/**
 * Empty, in a section: it takes none of the section's gap, so the heading sits exactly 12 px over
 * its content, as it would with no note there at all.
 */
export const EmptyInASection: Story = {
  args: { children: null },
  render: (args) => (
    <div className="flex w-[22rem] flex-col gap-heading" data-testid="section">
      <span data-testid="heading">Heading</span>
      <RetryNote {...args} />
      <p className="m-0" data-testid="content">
        Content
      </p>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = canvas.getByTestId('heading').getBoundingClientRect();
    const content = canvas.getByTestId('content').getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(canvas.getByTestId('section')).rowGap);
    await expect(Math.round(content.top - heading.bottom)).toBe(Math.round(gap));
  },
};
