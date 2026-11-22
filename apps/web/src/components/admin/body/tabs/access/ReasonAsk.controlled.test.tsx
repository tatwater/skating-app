import { AUDIT_REASON_MAX } from '@skating/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ReasonAsk } from './ReasonAsk';

/**
 * The reason dialog held by its caller (`open` / `onOpenChange`): opened by state — a bar button or
 * a key — with no trigger of its own; every opening starts with an empty reason; Esc and a landed
 * send ask the caller to close it; a refusal keeps it open over the reason.
 */

beforeAll(stubJsdomAnimations);

function Held({ onConfirm }: { onConfirm: (reason: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Ask
      </button>
      <output data-testid="open">{String(open)}</output>
      <ReasonAsk
        open={open}
        onOpenChange={setOpen}
        title="No public access · Tomhannock Reservoir"
        confirm="Rule it"
        maxLength={AUDIT_REASON_MAX}
        onConfirm={onConfirm}
      />
    </>
  );
}

describe('ReasonAsk, controlled', () => {
  it('opens by state, with no trigger of its own, and Esc asks the caller to close it', async () => {
    const user = userEvent.setup();
    render(<Held onConfirm={vi.fn(async () => true)} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('false'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('starts each opening with an empty reason', async () => {
    const user = userEvent.setup();
    render(<Held onConfirm={vi.fn(async () => true)} />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await user.type(within(await screen.findByRole('alertdialog')).getByRole('textbox'), 'Gated');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(within(await screen.findByRole('alertdialog')).getByRole('textbox')).toHaveValue('');
  });

  it('a landed send closes it through the caller; a refused one keeps it open over the reason', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<(reason: string) => Promise<boolean>>();
    onConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<Held onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted by the town');
    await user.click(within(dialog).getByRole('button', { name: /^Rule it/ }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox')).not.toHaveAttribute('readonly'),
    );
    expect(within(dialog).getByRole('textbox')).toHaveValue('Posted by the town');
    expect(screen.getByTestId('open')).toHaveTextContent('true');
    await user.click(within(dialog).getByRole('button', { name: /^Rule it/ }));
    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('false'));
    expect(onConfirm).toHaveBeenLastCalledWith('Posted by the town');
  });
});
