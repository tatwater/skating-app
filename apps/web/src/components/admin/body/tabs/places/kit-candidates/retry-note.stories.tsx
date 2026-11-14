import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { RetryNote } from './retry-note';

/**
 * A kit candidate from the Body console's tabs: a read that failed, said in the kit `Note`, with
 * *Try again* under it. Promoted to the kit, it would sit beside `Note`.
 */
const meta = {
  title: 'Kit candidates/RetryNote',
  component: RetryNote,
  globals: { surface: 'admin', mode: 'dark' },
  args: { children: 'Couldn’t read the landmarks and who asked.', onRetry: fn() },
  decorators: [(Story) => <div className="w-full max-w-[22rem]">{Story()}</div>],
} satisfies Meta<typeof RetryNote>;

export default meta;
type Story = StoryObj<typeof meta>;

/** In all four maps: a gray rule, the words, *Try again* a heading gap under it. */
export const FourMaps: Story = {
  parameters: { fourUp: true },
  play: async ({ canvasElement, args }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const quad of quads) {
      const note = must(quad.querySelector<HTMLElement>('[data-slot="note"]'));
      await expect(note).toHaveAttribute('data-tone', 'default');
      const action = within(quad).getByRole('button', { name: 'Try again' });
      // The button starts where the note does, under it.
      await expect(
        Math.abs(action.getBoundingClientRect().left - note.getBoundingClientRect().left),
      ).toBeLessThanOrEqual(0.5);
      await expect(action.getBoundingClientRect().top).toBeGreaterThan(
        note.getBoundingClientRect().bottom,
      );
    }
    await userEvent.click(within(must(quads[0])).getByRole('button', { name: 'Try again' }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** A failure that waits on a person takes the amber rule. */
export const Warn: Story = {
  args: { tone: 'warn', children: 'Couldn’t read the access. The deployment is paused.' },
  play: async ({ canvasElement }) => {
    await expect(must(canvasElement.querySelector('[data-slot="note"]'))).toHaveAttribute(
      'data-tone',
      'warn',
    );
    await expect(within(canvasElement).getByRole('status')).toBeVisible();
  },
};
