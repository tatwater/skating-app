import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { ReadFailed } from './read-failed';

/**
 * Kit candidate: a read that failed, said in its own place — the gray note naming what couldn't be
 * read, and *Try again*. Wants to join `Kit/Note`.
 */
const meta = {
  title: 'Admin/Body/Kit candidates/Read failed',
  component: ReadFailed,
  args: { children: 'The hazards on the lake couldn’t be read', onRetry: fn() },
  decorators: [(Story) => <div className="w-full max-w-[22rem]">{Story()}</div>],
} satisfies Meta<typeof ReadFailed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Gray, never red: a second try may bring the read back. Try again runs it. */
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const note = within(canvasElement).getByRole('note');
    await expect(getComputedStyle(note).borderLeftColor).toEqual(
      sameColor(computedColor(note, 'var(--fg3)')),
    );
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

/** With no way to read again (a crash caught below the tab), the words alone. */
export const NoRetry: Story = {
  args: { children: 'This tab couldn’t be drawn', onRetry: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button')).toBeNull();
  },
};

/** Both surfaces, both modes; square on the console, the skater surface's own radius there. */
export const FourUp: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const button = q.querySelector<HTMLElement>('[data-slot="read-failed-retry"]');
      await expect(button).not.toBeNull();
      if (q.dataset.surface === 'admin') {
        await expect(getComputedStyle(button as HTMLElement).borderRadius).toBe('0px');
      }
    }
  },
};
