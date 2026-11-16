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
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
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
      putInKeeps: true,
    });
    render(<StandingTab bodyId={BODY} />);
    expect(screen.getByRole('radio', { name: /^Active/ })).toBeChecked();
    expect(screen.getByText('2 put-ins')).toBeVisible();
    expect(screen.getByText('4 skaters')).toBeVisible();
    expect(screen.getByText('Map boost')).toBeVisible();
    expect(screen.getByText(/· a track$/)).toBeVisible();
    expect(screen.queryByText(/Not recorded yet/)).toBeNull();
  });

  it('shows put-ins as a reason only when the rollover says they keep it — never from the count', () => {
    convex.results.set('waterBodies:get', body());
    convex.results.set('standing:retentionForBody', {
      favorites: 0,
      favoritesCapped: false,
      savedPutIns: 2,
      putInKeeps: false,
    });
    render(<StandingTab bodyId={BODY} />);
    expect(screen.queryByText('2 put-ins')).toBeNull();
    expect(
      screen.getByText(
        /^None of these keeps it\. The 1 Jul \d{4} rollover decides by its own count\.$/,
      ),
    ).toBeVisible();
  });

  it('a saved put-ins count past the server’s read is a floor', () => {
    convex.results.set('waterBodies:get', body());
    convex.results.set('standing:retentionForBody', {
      favorites: 0,
      favoritesCapped: false,
      savedPutIns: 1_000,
      putInKeeps: true,
      savedPutInsCapped: true,
    });
    render(<StandingTab bodyId={BODY} />);
    expect(screen.getByText('1,000+ put-ins')).toBeVisible();
    expect(screen.queryByText('1,000 put-ins')).toBeNull();
  });

  it('a favorite count past the server’s is a floor; nothing at all says nothing keeps it', () => {
    convex.results.set('waterBodies:get', body());
    convex.results.set('standing:retentionForBody', {
      favorites: 1_000,
      favoritesCapped: true,
      savedPutIns: 0,
      putInKeeps: false,
    });
    const { unmount } = render(<StandingTab bodyId={BODY} />);
    expect(screen.getByText('1,000+ skaters')).toBeVisible();
    unmount();
    convex.results.set('standing:retentionForBody', {
      favorites: 0,
      favoritesCapped: false,
      savedPutIns: 0,
      putInKeeps: false,
    });
    render(<StandingTab bodyId={BODY} />);
    expect(
      screen.getByText(
        /^None of these keeps it\. The 1 Jul \d{4} rollover decides by its own count\.$/,
      ),
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
    expect(screen.queryByText(/None of these keeps it/)).toBeNull();
  });

  it('while the retention read is on its way the lanes hold their place; a failure says so', async () => {
    convex.results.set('waterBodies:get', body());
    const { rerender } = render(<StandingTab bodyId={BODY} />);
    expect(screen.queryByText(/None of these keeps it/)).toBeNull();
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
      putInKeeps: false,
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
    expect(undo.announce).toHaveBeenCalledWith(
      {
        title: 'Set dormant',
        target: { targetType: 'waterbody', targetId: BODY },
      },
      expect.any(Function),
    );
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
      expect.any(Function),
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

  /**
   * Greptile's P1 on #121: another body already read opened on this tab with the same standing,
   * and the view kept the first body's pick and note while its save now targeted the new body.
   * The frame keys the tab by body (`BodyTabHost`), and every write is bound to its body.
   */
  describe('a switch to another body that is already read', () => {
    const OTHER = 'k2' as Id<'waterBodies'>;
    const both = () => {
      convex.results.set('waterBodies:get', body());
      convex.results.set('standing:retentionForBody', null);
    };

    it('drops the pick and the note, and nothing typed for one body is sent for the other', async () => {
      both();
      const { rerender } = render(<BodyTabHost Wiring={StandingTab} bodyId={BODY} />);
      await userEvent.click(screen.getByRole('radio', { name: /^Dormant/ }));
      await userEvent.type(screen.getByRole('textbox'), 'Drawn down at Mascoma');
      // The other body, the same standing, read already: it opens at once.
      convex.results.set('waterBodies:get', body({ _id: OTHER }));
      rerender(<BodyTabHost Wiring={StandingTab} bodyId={OTHER} />);
      expect(screen.queryByDisplayValue('Drawn down at Mascoma')).toBeNull();
      expect(screen.getByRole('radio', { name: /^Active/ })).toBeChecked();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(convex.mutations.get('standing:setStanding')).not.toHaveBeenCalled();
    });

    it('a write started on one body that lands after the switch changes nothing on the next, and puts up no receipt', async () => {
      both();
      let land: () => void = () => {};
      convex.mutations.set(
        'standing:setStanding',
        vi.fn(
          () =>
            new Promise((resolve) => {
              land = () => resolve(null);
            }),
        ),
      );
      const { rerender } = render(<BodyTabHost Wiring={StandingTab} bodyId={BODY} />);
      await userEvent.click(screen.getByRole('radio', { name: /^Dormant/ }));
      await userEvent.type(screen.getByRole('textbox'), 'Dam work{Enter}');
      expect(convex.mutations.get('standing:setStanding')).toHaveBeenCalledTimes(1);
      convex.results.set('waterBodies:get', body({ _id: OTHER }));
      rerender(<BodyTabHost Wiring={StandingTab} bodyId={OTHER} />);
      land();
      await new Promise((r) => setTimeout(r, 0));
      expect(undo.announce).not.toHaveBeenCalled();
      expect(screen.getByRole('radio', { name: /^Active/ })).toBeChecked();
    });
  });

  /**
   * Each write control, once the record returns what the server answers (`setStanding` sets the
   * standing — dormant with its reason; `remove` stamps `removedAt` and its reason; `restore`
   * clears them): its lever is gone and a second press writes nothing.
   */
  describe('after the server answers, a write control is gone and a second press writes nothing', () => {
    it('Set dormant', async () => {
      convex.results.set('waterBodies:get', body());
      convex.mutations.set(
        'standing:setStanding',
        vi.fn(async () => {
          convex.results.set(
            'waterBodies:get',
            body({ dormant: { since: Date.now(), reason: 'moderator' } }),
          );
          return null;
        }),
      );
      const { rerender } = render(<StandingTab bodyId={BODY} />);
      await userEvent.click(screen.getByRole('radio', { name: /^Dormant/ }));
      await userEvent.type(screen.getByRole('textbox'), 'Dam work{Enter}');
      rerender(<StandingTab bodyId={BODY} />);
      await vi.waitFor(() => expect(screen.getByRole('radio', { name: /^Dormant/ })).toBeChecked());
      expect(screen.queryByRole('button', { name: /Set dormant/ })).toBeNull();
      expect(convex.mutations.get('standing:setStanding')).toHaveBeenCalledTimes(1);
    });

    it('Remove from the map, then Restore', async () => {
      convex.results.set('waterBodies:get', body());
      convex.mutations.set(
        'waterBodies:remove',
        vi.fn(async (args: { reason: string }) => {
          convex.results.set(
            'waterBodies:get',
            body({ removedAt: Date.now(), removalReason: args.reason }),
          );
          return null;
        }),
      );
      convex.mutations.set(
        'waterBodies:restore',
        vi.fn(async () => {
          convex.results.set('waterBodies:get', body());
          return null;
        }),
      );
      const { rerender } = render(<StandingTab bodyId={BODY} />);
      await userEvent.click(screen.getByRole('radio', { name: /^Removed/ }));
      await userEvent.click(screen.getByRole('combobox', { name: 'Reason' }));
      await userEvent.click((await screen.findAllByRole('option'))[0] as HTMLElement);
      await userEvent.click(screen.getByRole('button', { name: 'Remove from the map' }));
      rerender(<StandingTab bodyId={BODY} />);
      await vi.waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Remove from the map' })).toBeNull(),
      );
      expect(convex.mutations.get('waterBodies:remove')).toHaveBeenCalledTimes(1);
      // Restore is picked from Active, the one way back from a removal.
      await userEvent.click(screen.getByRole('radio', { name: /^Active/ }));
      await userEvent.click(screen.getByRole('button', { name: /Restore/ }));
      rerender(<StandingTab bodyId={BODY} />);
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull());
      expect(convex.mutations.get('waterBodies:restore')).toHaveBeenCalledTimes(1);
    });
  });
});
