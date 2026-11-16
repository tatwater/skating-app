import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Button } from '../ui/button';
import { ReasonDialog } from './ReasonDialog';
import { Refused } from './said';

/**
 * **A refusal is never said in the dialog** (D268): the dialog holds open while its write is out —
 * Esc as well as Cancel — and, refused (the net has said it in a toast), stays open over the kept
 * reason with nothing printed. Only its own check — a reason left empty — is said in place.
 */
describe('ReasonDialog', () => {
  it('holds open while its write is out; refused, it stays open over its reason and prints nothing', async () => {
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
    await act(async () => refuse(new Refused()));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Hide' }).at(-1)).not.toBeDisabled(),
    );
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveValue('Spam');
    expect(dialog.querySelector('p.text-destructive')).toBeNull();
    // Settled: Esc closes it again.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('landed, it closes', async () => {
    render(
      <ReasonDialog
        trigger={<Button>Hide</Button>}
        title="Hide this?"
        confirmLabel="Hide"
        requireReason={false}
        onConfirm={async () => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await user.click(screen.getAllByRole('button', { name: 'Hide' }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
