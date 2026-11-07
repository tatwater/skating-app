import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

const actions = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('convex/react', () => ({ ...convexReact, useAction: () => actions.create }));
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import { BountyPane, limitLine, limitRefusal } from './BountyPane';

const BAYS = [
  { _id: 'north', name: 'Mascoma North', removed: false },
  { _id: 'south', name: 'Mascoma South', removed: false },
  { _id: 'gone', name: 'Old bay', removed: true },
];

beforeEach(() => {
  resetFakes();
  actions.create = vi.fn().mockResolvedValue('b_new');
  fakes.queries.set('subAreas:listForBody', BAYS);
  fakes.queries.set('bounties:myBountyLimit', { limit: 3, used: 1, restricted: false });
});

function mount(subAreaId?: string) {
  const onClose = vi.fn();
  const onPosted = vi.fn();
  render(
    <BountyPane
      waterBodyId="mascoma"
      lakeName="Mascoma Lake"
      {...(subAreaId ? { subAreaId } : {})}
      onClose={onClose}
      onPosted={onPosted}
    />,
  );
  return { onClose, onPosted };
}

describe('which part (3.9/3.10)', () => {
  it('asks which part on a lake with bays, posts the choice, and hands the bounty back', async () => {
    const { onPosted } = mount();
    expect(
      screen.getByRole('dialog', { name: 'Post a bounty on Mascoma Lake' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Old bay')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Mascoma North' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post bounty' }));
    await waitFor(() => expect(onPosted).toHaveBeenCalledWith('b_new'));
    expect(actions.create).toHaveBeenCalledWith({ waterBodyId: 'mascoma', subAreaId: 'north' });
    expect(fakes.capture).toHaveBeenCalledWith('bounty_posted', { scoped_to_sub_area: true });
  });

  it('the whole lake is the default, and a framed bay starts the ask narrowed', async () => {
    const { onPosted } = mount('south');
    expect(screen.getByRole('radio', { name: 'Mascoma South' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Anywhere on Mascoma Lake' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post bounty' }));
    await waitFor(() => expect(onPosted).toHaveBeenCalled());
    expect(actions.create).toHaveBeenCalledWith({ waterBodyId: 'mascoma' });
    expect(fakes.capture).toHaveBeenCalledWith('bounty_posted', { scoped_to_sub_area: false });
  });

  it('a lake without bays doesn’t ask', () => {
    fakes.queries.set('subAreas:listForBody', undefined);
    mount();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});

describe('refused (3.11)', () => {
  it('the server’s reason shows as it says it, and a different part clears it', async () => {
    actions.create = vi
      .fn()
      .mockRejectedValue(
        new ConvexError('Mascoma South already has fresh eyes — no bounty needed'),
      );
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Mascoma South' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post bounty' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has fresh eyes');
    expect(screen.getByRole('button', { name: 'Post bounty' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Mascoma North' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a dropped connection reads as one', async () => {
    actions.create = vi.fn().mockRejectedValue(new Error('offline'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Post bounty' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Check your connection/);
  });

  it('at the limit, it says so before you press', () => {
    fakes.queries.set('bounties:myBountyLimit', { limit: 3, used: 3, restricted: false });
    mount();
    expect(screen.getByRole('alert')).toHaveTextContent(/You already have 3 open bounties/);
    expect(screen.getByRole('button', { name: 'Post bounty' })).toBeDisabled();
  });

  it('the rule lines follow the account’s own limit', () => {
    expect(limitLine(null)).toBe('You may have up to 3 open bounties at a time.');
    expect(limitLine({ limit: 1, used: 0, restricted: true })).toBe(
      'You may have up to 1 open bounty at a time (a moderator set this for your account).',
    );
    expect(limitRefusal(null)).toBeNull();
    expect(limitRefusal({ limit: 1, used: 1, restricted: true })).toMatch(
      /^You already have 1 open bounty,/,
    );
  });
});

describe('leaving', () => {
  it('Cancel and Esc both close (the dialog owns Esc)', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
