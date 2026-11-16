import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refuse: (() => {}) as (e: Error) => void }));
vi.mock('convex/react', () => ({
  useQuery: () => undefined,
  useMutation: () => () =>
    new Promise((_, reject) => {
      mocks.refuse = reject;
    }),
}));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ canModerate: true }) }));

import { ModeratorActions } from './ModeratorActions';

/**
 * **A takedown's answer is said in its dialog** (D268): the dialog holds open while the write is
 * out — Esc and Cancel alike — so a refusal never lands in a dialog that has closed.
 */
describe('ModeratorActions', () => {
  it('holds open while its takedown is out, and says the refusal there', async () => {
    render(<ModeratorActions targetType="comment" targetId="c1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Moderate' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Spam');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();
    await act(async () => mocks.refuse(new Error('Not allowed')));
    await waitFor(() =>
      expect(screen.getByText('Could not apply the action. Please try again.')).toBeInTheDocument(),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
