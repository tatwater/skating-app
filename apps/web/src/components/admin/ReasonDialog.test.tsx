import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Button } from '../ui/button';
import { ReasonDialog } from './ReasonDialog';

/**
 * **A sent reason's answer is said in its dialog** (D268): the dialog holds open while its write is
 * out — Esc as well as Cancel — so a refusal never lands in a dialog that has closed.
 */
describe('ReasonDialog', () => {
  it('holds open while its write is out, and says the refusal there', async () => {
    let refuse: (e: Error) => void = () => {};
    render(
      <ReasonDialog
        trigger={<Button>Hide</Button>}
        title="Hide this?"
        confirmLabel="Hide"
        onConfirm={() =>
          new Promise((_, reject) => {
            refuse = reject;
          })
        }
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Spam');
    await user.click(screen.getAllByRole('button', { name: 'Hide' }).at(-1) as HTMLElement);
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();
    await act(async () => refuse(new Error('Already hidden')));
    await waitFor(() => expect(screen.getByText('Already hidden')).toBeInTheDocument());
    // Settled: Esc closes it again.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
