import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { ClampedText } from './clamped-text';

/**
 * Kit candidate: clamped text — a person's words bounded by the lines they take on screen, *Show
 * all* offered exactly when they are cut. The same short paragraph (well under three hundred
 * characters, one line break of its own) at a phone's column, where it wraps past four lines and is
 * cut, and at the boards' detail column, where it fits and offers nothing.
 */

const WORDS =
  'The second report was right: the ice by the north launch had been cut for the derby the day before, and it had only skimmed over since.\nI was there that morning with the club and we turned people back from the edge.';

const meta = {
  title: 'Admin/People/Kit candidates/Clamped text',
  component: ClampedText,
  globals: { surface: 'admin', mode: 'dark' },
  args: { lines: 4, showAll: 'Show all', showLess: 'Show less', children: `“${WORDS}”` },
  // The column it sits in: a phone's feed column unless a story says otherwise.
  parameters: { column: '12.5rem' },
  decorators: [
    (Story, { parameters }) => (
      <div
        className="bg-bg p-(--space-3) text-row leading-list text-fg2"
        style={{ width: parameters.column as string }}
      >
        {Story()}
      </div>
    ),
  ],
} satisfies Meta<typeof ClampedText>;

export default meta;
type Story = StoryObj<typeof meta>;

const body = (root: HTMLElement) =>
  must(root.querySelector<HTMLElement>('[data-slot="clamped-text-body"]'));
/** The text's line height and its rendered height, in px, read together and never held. */
const sizes = (root: HTMLElement) => {
  const el = body(root);
  return {
    line: Number.parseFloat(getComputedStyle(el).lineHeight),
    height: el.getBoundingClientRect().height,
  };
};

/** At a phone's column: cut to four lines, then whole on a press, then cut again. */
export const AtPhoneWidth: Story = {
  play: async ({ canvasElement }) => {
    await document.fonts.ready;
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Show all' })).toBeVisible());
    const clamped = sizes(canvasElement);
    await expect(clamped.height).toBeLessThanOrEqual(clamped.line * 4 + 1);
    await expect(getComputedStyle(body(canvasElement)).whiteSpace).toBe('pre-line');
    await userEvent.click(canvas.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Show less' })).toHaveFocus());
    const whole = sizes(canvasElement);
    await expect(whole.height).toBeGreaterThan(whole.line * 4 + 1);
    await expect(body(canvasElement).textContent).toContain('\n');
    await userEvent.click(canvas.getByRole('button', { name: 'Show less' }));
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Show all' })).toHaveAttribute(
        'aria-expanded',
        'false',
      ),
    );
    const again = sizes(canvasElement);
    await expect(again.height).toBeLessThanOrEqual(again.line * 4 + 1);
  },
};

/** At the boards' detail column the same words fit: nothing is cut, and nothing is offered. */
export const AtDetailWidth: Story = {
  parameters: { column: '47.5rem' },
  play: async ({ canvasElement }) => {
    await document.fonts.ready;
    const { line, height } = sizes(canvasElement);
    await expect(height).toBeLessThanOrEqual(line * 4 + 1);
    await expect(within(canvasElement).queryByRole('button')).toBeNull();
  },
};
