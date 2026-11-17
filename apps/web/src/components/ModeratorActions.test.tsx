import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refuse: (() => {}) as (e: Error) => void,
  land: () => {},
  canModerate: true,
  toasts: [] as { title: string; description?: string }[],
}));
vi.mock('convex/react', () => ({
  useQuery: () => undefined,
  useMutation: () => () =>
    new Promise((resolve, reject) => {
      mocks.refuse = reject;
      mocks.land = () => resolve(null);
    }),
}));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ canModerate: mocks.canModerate }) }));
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => mocks.toasts.push(t),
}));

import { ConvexError } from 'convex/values';
import { HazardModeratorControls } from './admin/HazardModeratorControls';
import { ModeratorActions } from './ModeratorActions';

beforeEach(() => {
  mocks.canModerate = true;
  mocks.toasts.length = 0;
});

/**
 * **A takedown's refusal is a toast, always** (D268): the dialog holds open while the write is out —
 * Esc and Cancel alike — and, refused, stays open over its reason with nothing printed in it.
 */
describe('ModeratorActions', () => {
  it('holds open while its takedown is out; refused, one toast and the reason kept', async () => {
    render(<ModeratorActions targetType="comment" targetId="c1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Moderate' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(screen.getByRole('textbox', { name: 'Reason' }), 'Spam');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();
    await act(async () => mocks.refuse(new ConvexError('Already hidden')));
    await waitFor(() =>
      expect(mocks.toasts).toEqual([
        expect.objectContaining({ title: 'Not saved', description: 'Already hidden', tone: 'bad' }),
      ]),
    );
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveValue('Spam');
    expect(screen.queryByText('Already hidden')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('landed, it closes, its reason with it — never left armed for a second takedown', async () => {
    render(<ModeratorActions targetType="comment" targetId="c1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Moderate' }));
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), 'Spam');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    await act(async () => mocks.land());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.toasts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Moderate' }));
    expect(await screen.findByRole('textbox', { name: 'Reason' })).toHaveValue('');
  });

  it('the permission lost while its takedown is out: no dialog is drawn, so the refusal is a toast, once', async () => {
    const view = render(<ModeratorActions targetType="comment" targetId="c1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Moderate' }));
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), 'Spam');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    // The viewer's role reloads without the permission: the control draws nothing, still mounted.
    mocks.canModerate = false;
    view.rerender(<ModeratorActions targetType="comment" targetId="c1" />);
    await act(async () => mocks.refuse(new ConvexError('Not allowed')));
    await waitFor(() =>
      expect(mocks.toasts).toEqual([expect.objectContaining({ description: 'Not allowed' })]),
    );
  });
});

describe('HazardModeratorControls', () => {
  it('the permission lost while a promotion is out: its dialog isn’t drawn, so the refusal is a toast, once', async () => {
    const view = render(<HazardModeratorControls hazardId={'h1' as never} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Promote to known feature' }));
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), 'A standing ridge');
    await user.click(screen.getByRole('button', { name: 'Promote' }));
    mocks.canModerate = false;
    view.rerender(<HazardModeratorControls hazardId={'h1' as never} />);
    await act(async () => mocks.refuse(new ConvexError('Not allowed')));
    await waitFor(() =>
      expect(mocks.toasts).toEqual([expect.objectContaining({ description: 'Not allowed' })]),
    );
  });
});
