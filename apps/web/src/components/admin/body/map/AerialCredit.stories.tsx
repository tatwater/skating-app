import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { AerialCredit } from './AerialCredit';

/**
 * The summer aerial's credit with a service behind it (the boards' stills hold *Trying again…* for
 * ever — `Body console`'s stories draw every state at rest). Here *Try again* is answered, so the
 * one thing only a real browser can show is shown: the button goes while focus is on it, and focus
 * stays on the credit. Chromium blurs a focused node as it is removed, which jsdom doesn't.
 */
const meta = {
  title: 'Admin/Body/Aerial credit',
  globals: { surface: 'admin', mode: 'dark' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const CREDIT = 'Aerial · NAIP Jun 2023';

/** Part of the photograph didn't come; *Try again* is answered a moment after it is pressed. */
function Answered() {
  const [at, setAt] = useState<'partial' | 'asking' | 'in'>('partial');
  return (
    <div className="flex bg-bg p-(--space-5)">
      <AerialCredit
        credit={CREDIT}
        state={
          at === 'in'
            ? { load: 'loaded' }
            : {
                load: at === 'asking' ? 'loading' : 'partial',
                pending: at === 'asking',
                onRetry: () => {
                  setAt('asking');
                  setTimeout(() => setAt('in'), 60);
                },
              }
        }
      />
    </div>
  );
}

/** Pressed from the keys: *Trying again…* holds focus, then the credit takes it as the button goes. */
export const RetryAnswered: Story = {
  render: () => <Answered />,
  play: async ({ canvasElement }) => {
    const credit = must(
      canvasElement.querySelector<HTMLElement>('[data-slot="body-map-aerial-credit"]'),
    );
    const retry = within(canvasElement).getByRole('button', { name: 'Try again' });
    await userEvent.tab();
    await expect(retry).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(within(canvasElement).queryByRole('button')).toBeNull());
    await expect(credit).toHaveTextContent(CREDIT);
    await expect(credit).toHaveAttribute('data-state', 'loaded');
    // Never the page: a keyboard reader is left on the words that say it is in.
    await waitFor(() => expect(credit).toHaveFocus());
  },
};

/** Focus that was somewhere else when the button went is left where it was. */
export const RetryAnsweredFromElsewhere: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-(--space-3)">
      <button type="button">Elsewhere</button>
      <Answered />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const elsewhere = within(canvasElement).getByRole('button', { name: 'Elsewhere' });
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Try again' }));
    elsewhere.focus();
    await waitFor(() =>
      expect(within(canvasElement).queryByRole('button', { name: /again/i })).toBeNull(),
    );
    await expect(elsewhere).toHaveFocus();
  },
};
