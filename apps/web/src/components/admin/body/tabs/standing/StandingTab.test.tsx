import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubJsdomAnimations } from '../jsdomStubs';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (
      queries: Record<string, { query: Parameters<typeof getFunctionName>[0]; args: unknown }>,
    ) =>
      Object.fromEntries(
        Object.entries(queries).map(([k, q]) => [k, convex.results.get(getFunctionName(q.query))]),
      ),
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

import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { STANDING_TAB, StandingTab } from './StandingTab';

const BODY = 'k1' as Id<'waterBodies'>;

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  resetConsoleReads();
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
  it('holds its place until the body lands, and says so when it can’t be read', () => {
    const { container, rerender } = render(<StandingTab bodyId={BODY} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    convex.results.set('waterBodies:get', new Error('boom'));
    rerender(<StandingTab bodyId={BODY} />);
    expect(screen.getByText('This body couldn’t be read')).toBeVisible();
  });

  it('an unavailable body has no standing to choose', () => {
    convex.results.set('waterBodies:get', { available: false });
    render(<StandingTab bodyId={BODY} />);
    expect(screen.getByText(/Not on the map/)).toBeVisible();
  });

  it('reads what keeps it active: the boost, favorites, saved put-ins and the newest use', () => {
    const at = Date.now() - 86_400_000;
    convex.results.set('waterBodies:get', body({ curatedBoost: 0.3 }));
    convex.results.set('standing:retentionForBody', {
      lastActivity: { at, kind: 'track' },
      curatedBoost: { value: 0.3, at: null },
      favorites: 4,
      favoritesCapped: false,
      savedPutIns: 2,
    });
    render(<StandingTab bodyId={BODY} />);
    expect(screen.getByRole('radio', { name: /^Active/ })).toBeChecked();
    expect(screen.getByText('2 put-ins')).toBeVisible();
    expect(screen.getByText('4 skaters')).toBeVisible();
    expect(screen.getByText('Map boost')).toBeVisible();
    expect(screen.getByText(/· a track$/)).toBeVisible();
    expect(screen.queryByText(/Not recorded yet/)).toBeNull();
  });

  it('a favorite count past the server’s is a floor; nothing at all says nothing keeps it', () => {
    convex.results.set('waterBodies:get', body());
    convex.results.set('standing:retentionForBody', {
      favorites: 1_000,
      favoritesCapped: true,
      savedPutIns: 0,
    });
    const { unmount } = render(<StandingTab bodyId={BODY} />);
    expect(screen.getByText('1,000+ skaters')).toBeVisible();
    unmount();
    convex.results.set('standing:retentionForBody', {
      favorites: 0,
      favoritesCapped: false,
      savedPutIns: 0,
    });
    render(<StandingTab bodyId={BODY} />);
    expect(
      screen.getByText(/^Nothing keeps it: the 1 Jul \d{4} rollover sets it dormant\.$/),
    ).toBeVisible();
  });

  it('a retention read that finds no body names every fact as not recorded, never as zero', () => {
    convex.results.set('waterBodies:get', body());
    convex.results.set('standing:retentionForBody', null);
    render(<StandingTab bodyId={BODY} />);
    expect(
      screen.getByText(
        'Not recorded yet: the map boost, favorites, saved put-ins and the last report.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Nothing keeps it/)).toBeNull();
  });

  it('while the retention read is on its way the lanes hold their place; a failure says so', async () => {
    convex.results.set('waterBodies:get', body());
    const { rerender } = render(<StandingTab bodyId={BODY} />);
    expect(screen.queryByText(/Nothing keeps it/)).toBeNull();
    expect(
      document.querySelector('[data-slot="standing-retention"][aria-busy="true"]'),
    ).not.toBeNull();
    convex.results.set('standing:retentionForBody', new Error('boom'));
    rerender(<StandingTab bodyId={BODY} />);
    expect(screen.getByText('What keeps it active couldn’t be read')).toBeVisible();
    convex.results.set('standing:retentionForBody', {
      favorites: 2,
      favoritesCapped: false,
      savedPutIns: 0,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2 skaters')).toBeVisible();
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

  it('registers its wiring and no map of its own', () => {
    expect(STANDING_TAB).toEqual({ Wiring: StandingTab });
  });
});
