import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/kit/button';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ReasonAsk } from './ReasonAsk';

/** The reason dialog: closes when the write lands, keeps the reason over a refusal — or a throw. */

beforeAll(stubJsdomAnimations);

function Ask({ onConfirm }: { onConfirm: (reason: string) => Promise<string | null> }) {
  return (
    <ReasonAsk
      trigger={<Button>Hide</Button>}
      title="Hide the launch"
      confirm="Hide"
      onConfirm={onConfirm}
    />
  );
}

describe('ReasonAsk', () => {
  it('says a sender that threw, keeps the reason, and lets it be sent again — never stuck waiting', async () => {
    const onConfirm = vi
      .fn<(reason: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('Lost the connection'))
      .mockResolvedValueOnce(null);
    render(<Ask onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'A private dock');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
    expect(await within(dialog).findByText(/Something went wrong/)).toBeTruthy();
    expect(within(dialog).getByRole('textbox')).toHaveValue('A private dock');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
    expect(onConfirm).toHaveBeenLastCalledWith('A private dock');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
