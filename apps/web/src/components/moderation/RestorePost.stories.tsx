import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { closeWithEscape, faceLoaded, must, openWith } from '../kit/storyKit';
import { RestorePostView } from './RestorePost';
import { MIXED, NOTHING, PLAIN } from './restorePostFixtures';

/**
 * Restoring a Post that would come back with none of its Reports (founder call, 2026-11-13): the
 * chooser, from kit parts. Dates are the fixtures' fixed January 2027, never the clock.
 */
const meta = {
  title: 'Moderation/Restore post',
  component: RestorePostView,
  args: { onRestore: fn(async () => {}) },
} satisfies Meta<typeof RestorePostView>;

export default meta;
type Story = StoryObj<typeof meta>;

const popup = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]');

/** A plain restore brings a Report back: pressing Restore restores, and no chooser opens. */
export const PlainRestore: Story = {
  args: { choices: PLAIN },
  play: async ({ canvasElement, args }) => {
    await openWith(canvasElement, 'Restore post');
    await waitFor(() => expect(args.onRestore).toHaveBeenCalledWith([]));
    await expect(popup()).toBeNull();
  },
};

/** Every Report down on its own: the checklist, nothing pre-selected, the author's row locked. */
export const Chooser: Story = {
  args: { choices: MIXED },
  play: async ({ canvasElement, args }) => {
    await openWith(canvasElement, 'Restore post');
    const box = within(await waitFor(() => must(popup())));
    await faceLoaded(box.getByText('Lake Fairlee · Jan 13, 2027'));
    const checks = box.getAllByRole('checkbox');
    for (const c of checks) await expect(c).not.toBeChecked();
    await expect(checks[2]).toHaveAttribute('aria-disabled', 'true');
    await expect(box.getByRole('button', { name: 'Restore with 0 reports' })).toBeDisabled();
    await userEvent.click(must(checks[0]));
    await userEvent.click(must(checks[1]));
    await expect(box.getByRole('button', { name: 'Restore with 2 reports' })).toBeEnabled();
    await closeWithEscape(popup);
    await expect(args.onRestore).not.toHaveBeenCalled();
  },
};

/** Every Report deleted by its author: the dialog says so and offers nothing to confirm. */
export const NothingToChoose: Story = {
  args: { choices: NOTHING },
  play: async ({ canvasElement }) => {
    await openWith(canvasElement, 'Restore post');
    const box = within(await waitFor(() => must(popup())));
    // Present, not "visible": the plate may still be fading in (the story-flake class's fade read).
    await expect(box.getByText(/so the post can't be restored/)).toBeInTheDocument();
    await expect(box.queryByRole('button', { name: /Restore with/ })).toBeNull();
    await closeWithEscape(popup);
  },
};
