import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import { computedColor, sameColor } from '@/components/kit/measure';
import { must } from '@/components/kit/storyKit';

import { ReadFailed } from './read-failed';

/**
 * A kit candidate from the Body console: a read that failed, said in its own place — the gray note
 * and *Try again*. In all four maps.
 */
const meta = {
  title: 'Admin/Body/Kit candidates/Read failed',
  component: ReadFailed,
  parameters: { layout: 'padded' },
  args: { children: 'The history couldn’t be read', onRetry: fn() },
} satisfies Meta<typeof ReadFailed>;

export default meta;
type Story = StoryObj<typeof meta>;

const quadsOf = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-theme-scope]'),
];

export const InAColumn: Story = {
  name: 'In a column',
  render: (args) => (
    <div className="w-(--size-list)">
      <ReadFailed {...args} />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement, args }) => {
    const quads = quadsOf(canvasElement);
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const note = must(q.querySelector<HTMLElement>('[data-slot="note"]'));
      // Gray, never red at rest: the note's rule is the quiet ink, its text the secondary.
      await expect(getComputedStyle(note).borderLeftColor).toEqual(
        sameColor(computedColor(q, 'var(--fg3)')),
      );
      await expect(getComputedStyle(note).color).toEqual(sameColor(computedColor(q, 'var(--fg2)')));
      const button = must(q.querySelector<HTMLElement>('button'));
      await expect(button).toHaveTextContent('Try again');
      // A pressable thing on the console is square; the skater surface keeps its own radius.
      if (q.dataset.surface === 'admin') {
        await expect(getComputedStyle(button).borderRadius).toBe('0px');
      }
    }
    await userEvent.click(must(quads[0]?.querySelector<HTMLElement>('button')));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** In a narrow place the sentence wraps beside the button, which keeps its one line. */
export const Narrow: Story = {
  args: { children: 'The towns and the outline’s trust couldn’t be read' },
  render: (args) => (
    <div className="w-[12rem]">
      <ReadFailed {...args} />
    </div>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    for (const q of quadsOf(canvasElement)) {
      const note = must(q.querySelector<HTMLElement>('[data-slot="note"]')).getBoundingClientRect();
      const button = must(q.querySelector<HTMLElement>('button'));
      const box = button.getBoundingClientRect();
      await expect(box.left).toBeGreaterThanOrEqual(note.right);
      await expect(getComputedStyle(button).whiteSpace).toBe('nowrap');
      // The sentence took the lines, not the button.
      await expect(note.height).toBeGreaterThan(box.height);
    }
  },
};
