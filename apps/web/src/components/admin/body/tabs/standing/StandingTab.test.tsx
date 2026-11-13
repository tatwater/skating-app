import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
      convex.results.get(getFunctionName(ref)),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      const existing = convex.mutations.get(name);
      if (existing) return existing;
      const created = vi.fn(async () => null);
      convex.mutations.set(name, created);
      return created;
    },
  };
});
const role = vi.hoisted(() => ({ caps: new Set<string>() }));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => role.caps.has(c) }),
}));
const undo = vi.hoisted(() => ({ announce: vi.fn(async () => {}) }));
vi.mock('@/components/admin/shell/undo', () => ({ useUndo: () => undo }));

import type { Id } from '@skating/convex/dataModel';
import { ConvexError } from 'convex/values';

import { StandingTab } from './StandingTab';

const BODY = 'k1' as Id<'waterBodies'>;

beforeEach(() => {
  convex.results.clear();
  convex.mutations.clear();
  undo.announce.mockClear();
  role.caps = new Set(['body.standing', 'body.remove']);
});

const body = (extra: object = {}) => ({
  available: true,
  body: { _id: BODY, dedupStatus: 'clean', activatedAt: Date.UTC(2026, 8, 17, 16), ...extra },
});

describe('StandingTab', () => {
  it('draws nothing until the body lands', () => {
    const { container } = render(<StandingTab bodyId={BODY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('an unavailable body has no standing to choose', () => {
    convex.results.set('waterBodies:get', { available: false });
    render(<StandingTab bodyId={BODY} />);
    expect(screen.getByText(/Not on the map/)).toBeVisible();
  });

  it('reads the standing, the boost and the saved put-ins; the rest is not recorded yet', () => {
    convex.results.set('waterBodies:get', body({ curatedBoost: 0.3 }));
    convex.results.set('putIns:listForBody', [
      { id: 'p1', source: 'official' },
      { id: 'p2', source: 'derived' },
      { source: 'derived' },
    ]);
    render(<StandingTab bodyId={BODY} />);
    expect(screen.getByRole('radio', { name: /^Active/ })).toBeChecked();
    expect(screen.getByText('2 put-ins')).toBeVisible();
    expect(screen.getByText('Map boost')).toBeVisible();
    expect(screen.getByText('Not recorded yet: favorites and the last report.')).toBeVisible();
  });

  it('sets dormant with the note, then announces it to Undo', async () => {
    convex.results.set('waterBodies:get', body());
    render(<StandingTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('radio', { name: /^Dormant/ }));
    await userEvent.type(screen.getByRole('textbox'), 'Dam work{Enter}');
    expect(convex.mutations.get('standing:setStanding')).toHaveBeenCalledWith({
      waterBodyId: BODY,
      standing: 'dormant',
      note: 'Dam work',
    });
    expect(undo.announce).toHaveBeenCalledWith({
      title: 'Set dormant',
      target: { targetType: 'waterbody', targetId: BODY },
    });
  });

  it('a refusal reads in the server’s words and announces nothing', async () => {
    convex.results.set('waterBodies:get', body());
    convex.mutations.set(
      'standing:setStanding',
      vi.fn(async () => {
        throw new ConvexError('Only an active body can be set dormant');
      }),
    );
    render(<StandingTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('radio', { name: /^Dormant/ }));
    await userEvent.click(screen.getByRole('button', { name: /Set dormant/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an active body can be set dormant',
    );
    expect(undo.announce).not.toHaveBeenCalled();
  });

  it('brings a hand-set dormancy back, and restores a removal', async () => {
    convex.results.set(
      'waterBodies:get',
      body({ dormant: { since: 1, reason: 'moderator', note: 'Dam' } }),
    );
    const { unmount } = render(<StandingTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('radio', { name: /^Active/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Bring back to the active map' }));
    expect(convex.mutations.get('standing:setStanding')).toHaveBeenCalledWith({
      waterBodyId: BODY,
      standing: 'active',
    });
    unmount();
    convex.results.set(
      'waterBodies:get',
      body({ removedAt: 1, removalReason: 'landowner_request' }),
    );
    render(<StandingTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('radio', { name: /^Active/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore to the map' }));
    expect(convex.mutations.get('waterBodies:restore')).toHaveBeenCalledWith({ waterBodyId: BODY });
    expect(undo.announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Restored to the map' }),
    );
  });

  it('removes with the chosen reason', async () => {
    convex.results.set('waterBodies:get', body());
    render(<StandingTab bodyId={BODY} />);
    await userEvent.click(screen.getByRole('radio', { name: /^Removed/ }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Reason' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Landowner request' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove from the map' }));
    expect(convex.mutations.get('waterBodies:remove')).toHaveBeenCalledWith({
      waterBodyId: BODY,
      reason: 'landowner_request',
    });
  });

  it('a moderator is offered neither Removed nor its writes', () => {
    role.caps = new Set(['body.standing']);
    convex.results.set('waterBodies:get', body());
    render(<StandingTab bodyId={BODY} />);
    expect(screen.queryByRole('radio', { name: /^Removed/ })).toBeNull();
  });
});
