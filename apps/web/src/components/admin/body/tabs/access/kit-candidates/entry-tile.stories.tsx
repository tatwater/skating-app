import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { EntryTile } from './entry-tile';

/** Kit candidate: the way-in tile — a gesture drawn on a button, its name, its key. */
const meta = {
  title: 'Admin/Body/Kit candidates/Entry tile',
  component: EntryTile,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    glyph: (
      <svg viewBox="0 0 88 40" fill="none" aria-hidden="true">
        <path d="M4 8 C 18 8, 22 34, 44 34 S 70 8, 84 8" stroke="var(--fg2)" />
        <path d="M20 17 Q 44 22 68 17" stroke="var(--fg)" strokeDasharray="2 3" />
      </svg>
    ),
    title: 'Draw by chord',
    description: 'Two shore points and a side',
    kbd: 'C',
    onClick: fn(),
  },
} satisfies Meta<typeof EntryTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tiles: Story = {
  parameters: { fourUp: true },
  render: (args) => (
    <div className="flex w-(--size-inspector) flex-col gap-(--space-2)">
      <EntryTile {...args} />
      <EntryTile
        {...args}
        title="Add what a sign says"
        description="For the ice only, a put-in or lot gets its own"
        kbd="R"
        what="Writing what a sign says comes with the posted-rules editor."
      />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const quad = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const [working, notYet] = [
      ...quad.querySelectorAll<HTMLElement>('[data-slot="entry-tile"]'),
    ].map(must);
    // A pressable thing, so the control radius: square on the console.
    await expect(getComputedStyle(must(working)).borderRadius).toBe('0px');
    await userEvent.click(must(working));
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    // The one that isn't built rests the same, says so, and never acts.
    await expect(notYet).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(must(notYet));
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.hover(must(notYet));
    await waitFor(() =>
      expect(within(document.body).getByText('Not available yet')).toBeInTheDocument(),
    );
    await userEvent.unhover(must(notYet));
  },
};
