import { AUDIT_REASON_MAX } from '@skating/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/kit/button';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ReasonAsk } from './ReasonAsk';

/**
 * The reason dialog: closes when the write lands; refused (said in its toast, D268) or a sender that
 * threw, it stays open over the kept reason and prints nothing of the server's.
 */

beforeAll(stubJsdomAnimations);

function Ask({ onConfirm }: { onConfirm: (reason: string) => Promise<boolean> }) {
  return (
    <ReasonAsk
      trigger={<Button>Hide</Button>}
      title="Hide the launch"
      confirm="Hide"
      maxLength={AUDIT_REASON_MAX}
      onConfirm={onConfirm}
    />
  );
}

describe('ReasonAsk', () => {
  it('holds the reason to the cap it is given — its write’s, from the shared definition', async () => {
    render(<Ask onConfirm={vi.fn(async () => true)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('textbox')).toHaveAttribute(
      'maxLength',
      String(AUDIT_REASON_MAX),
    );
  });

  it.each([
    ['refused', (f: ReturnType<typeof vi.fn>) => f.mockResolvedValueOnce(false)],
    [
      'a sender that threw',
      (f: ReturnType<typeof vi.fn>) => f.mockRejectedValueOnce(new Error('x')),
    ],
  ])(
    '%s: keeps the reason, prints nothing, and lets it be sent again — never stuck waiting',
    async (_, first) => {
      const onConfirm = vi.fn<(reason: string) => Promise<boolean>>();
      first(onConfirm as never);
      onConfirm.mockResolvedValueOnce(true);
      render(<Ask onConfirm={onConfirm} />);
      await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'A private dock');
      await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(within(dialog).getByRole('textbox')).not.toHaveAttribute('readonly'),
      );
      expect(screen.getByRole('alertdialog')).toBeTruthy();
      expect(within(dialog).getByRole('textbox')).toHaveValue('A private dock');
      expect(within(dialog).queryByRole('alert')).toBeNull();
      await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
      expect(onConfirm).toHaveBeenLastCalledWith('A private dock');
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    },
  );

  it('a send on its way can’t be dismissed, so a late answer never closes a dialog opened since', async () => {
    let answer: (landed: boolean) => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    render(<Ask onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'A private dock');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
    // Esc and Cancel while it is on its way: the dialog stays, its reason whole.
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(within(dialog).getByRole('textbox')).toHaveValue('A private dock');
    // Its own answer closes it; reopened, it starts clean. (No later opening can exist while a send
    // is on its way — the dialog won't close — so there is no late answer to hand a new opening.)
    answer(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const again = await screen.findByRole('alertdialog');
    expect(within(again).getByRole('textbox')).toHaveValue('');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a sent reason is held while it is out — never typed into and then thrown away', async () => {
    let answer: (landed: boolean) => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    render(<Ask onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('alertdialog');
    const field = within(dialog).getByRole('textbox');
    await userEvent.type(field, 'A private dock');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
    expect(field).toHaveAttribute('readonly');
    await userEvent.type(field, ' since May');
    expect(field).toHaveValue('A private dock');
    // Refused: the field is the moderator's again, the reason whole.
    await act(async () => answer(false));
    expect(field).not.toHaveAttribute('readonly');
    await userEvent.type(field, ' since May');
    expect(field).toHaveValue('A private dock since May');
  });
});
