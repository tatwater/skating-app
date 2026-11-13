import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor } from 'storybook/test';

import { Button } from '@/components/kit/button';
import { must } from '@/components/kit/storyKit';

import { InsetCard, InsetCardFoot } from './inset-card';

/** Kit candidate: the inset card over a pane (Review 14), in all four maps. */
const meta = {
  title: 'Admin/Body/Kit candidates/Inset card',
  component: InsetCard,
  globals: { surface: 'admin', mode: 'dark' },
  args: { back: 'Back to landmarks', onBack: fn() },
} satisfies Meta<typeof InsetCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OverAPane: Story = {
  parameters: { fourUp: true },
  render: (args) => (
    <div className="relative h-[24rem] w-(--size-inspector) bg-bg px-(--space-5) py-(--space-5)">
      <p className="text-row text-fg3 opacity-(--opacity-dim)">
        What the pane showed stays behind.
      </p>
      <InsetCard
        {...args}
        className="absolute inset-x-(--space-3) top-(--space-3) bottom-(--space-3)"
        foot={
          <InsetCardFoot end={<Button variant="danger">Remove</Button>}>
            <Button>Move</Button>
          </InsetCardFoot>
        }
      >
        <p className="text-row text-fg1">The task on one thing.</p>
      </InsetCard>
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const quad = must(canvasElement.querySelector('[data-theme-scope]'));
    const card = must(quad.querySelector<HTMLElement>('[data-slot="inset-card"]'));
    // A container: square.
    await expect(getComputedStyle(card).borderRadius).toBe('0px');
    const head = must(card.querySelector<HTMLElement>('[data-slot="inset-card-head"]'));
    await userEvent.click(head);
    await expect(args.onBack).toHaveBeenCalledTimes(1);
    // Esc anywhere in the card goes back too.
    must(card.querySelector<HTMLElement>('button[data-slot="button"]')).focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(args.onBack).toHaveBeenCalledTimes(2));
    // The destructive action is pushed to the foot's far end.
    const foot = must(card.querySelector<HTMLElement>('[data-slot="inset-card-foot"]'));
    const buttons = [...foot.querySelectorAll<HTMLElement>('[data-slot="button"]')];
    const right = must(buttons.at(-1)).getBoundingClientRect().right;
    await expect(Math.abs(foot.getBoundingClientRect().right - right)).toBeLessThan(20);
  },
};
