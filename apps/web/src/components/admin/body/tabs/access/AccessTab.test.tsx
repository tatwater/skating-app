import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body › Access as the console mounts it: four reads (mocked at the Convex hooks), the ruling and
 * the put-in writes behind their capabilities and announced for undo; a reason asked only when
 * access is taken away; each read's state said in its place.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  queryArgs: new Map<string, unknown>(),
  calls: [] as Array<[string, unknown]>,
  can: new Set<string>(),
  roleLoading: false,
  announce: vi.fn(async () => {}),
  /** The server's own effect of a write on the reads, applied when the write is called. */
  server: null as ((name: string, args: Record<string, unknown>) => void) | null,
  /** A write held on its way until the test lets it land. */
  hold: null as Promise<void> | null,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          mocks.queryArgs.set(getFunctionName(query), args);
          return [key, mocks.results.get(getFunctionName(query))];
        }),
      ),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => async (args: unknown) => {
      mocks.calls.push([getFunctionName(ref), args]);
      if (mocks.hold !== null) await mocks.hold;
      mocks.server?.(getFunctionName(ref), args as Record<string, unknown>);
    },
  };
});
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => mocks.can.has(c), isLoading: mocks.roleLoading }),
}));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { BodyTabHost } from '../../frame/BodyConsoleRoute';
import { stubJsdomAnimations } from '../jsdomStubs';
import { AccessTab } from './AccessTab';

beforeAll(stubJsdomAnimations);

const RULED = Date.now() - 3 * 86_400_000;

beforeEach(() => {
  // The read layer's registry (paused reads, retries, reports) is module state: start each test clean.
  resetConsoleReads();
  mocks.results.clear();
  mocks.queryArgs.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(['access.rule', 'body.access', 'audit.read']);
  mocks.roleLoading = false;
  mocks.announce.mockClear();
  mocks.server = null;
  mocks.hold = null;
  const set = (ref: Parameters<typeof getFunctionName>[0], value: unknown) =>
    mocks.results.set(getFunctionName(ref), value);
  set(api.waterBodies.get, {
    available: true,
    body: {
      _id: 'wb1',
      name: 'Mascoma Lake',
      publicAccess: { verdict: 'open', decidedAt: RULED, decidedByUserId: 'p1' },
    },
  });
  set(api.accessPoints.accessForBody, {
    putIns: [
      { id: 'pi1', coord: { lat: 43.6489, lng: -72.1793 }, name: 'NW launch', source: 'osm' },
    ],
    parking: [],
    blockedIds: [],
    alerts: [],
  });
  set(api.landmarks.listForBody, []);
  set(api.bodyConsole.history, {
    entries: [
      {
        id: 'ma1',
        action: 'set_public_access',
        targetType: 'waterbody',
        targetId: 'wb1',
        reason: 'Ruled',
        createdAt: RULED,
        actor: { userId: 'p1', displayName: 'Teagan', username: 'teagan' },
        metadata: { prev: { publicAccess: null } },
      },
    ],
    capped: false,
  });
});

const historyFn = getFunctionName(api.bodyConsole.history);

describe('AccessTab', () => {
  it('reads the ruling’s own audit rows, and draws who ruled', () => {
    render(<AccessTab bodyId="wb1" />);
    expect(mocks.queryArgs.get(historyFn)).toEqual({
      waterBodyId: 'wb1',
      action: 'set_public_access',
      limit: 20,
    });
    expect(screen.getByText('Teagan')).toBeTruthy();
    expect(screen.getByText('3 days')).toBeTruthy();
  });

  it('clears the ruling without asking, and announces it', async () => {
    render(<AccessTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear the ruling' }));
    expect(mocks.calls).toEqual([
      ['waterBodies:setPublicAccess', { waterBodyId: 'wb1', verdict: null }],
    ]);
    expect(mocks.announce).toHaveBeenCalledWith(
      {
        title: 'Cleared the ruling',
        target: { targetType: 'waterbody', targetId: 'wb1' },
      },
      expect.any(Function),
    );
  });

  it('asks the reason before ruling no public access, and sends it', async () => {
    render(<AccessTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Rule no public access' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Posted all round');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Rule no public access/ }));
    expect(mocks.calls).toEqual([
      [
        'waterBodies:setPublicAccess',
        { waterBodyId: 'wb1', verdict: 'none', reason: 'Posted all round' },
      ],
    ]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('draws Make official as not available yet, and never inserts a second put-in beside the launch', async () => {
    // `putIns.setOfficial` inserts a new official row at the point (no parking, no walk) and
    // leaves the launch visible, so a press would show it twice; there is no promote in place.
    render(<AccessTab bodyId="wb1" />);
    const lever = screen.getByRole('button', { name: 'Make official' });
    expect(lever).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(lever);
    await userEvent.click(lever);
    expect(mocks.calls).toEqual([]);
  });

  it('hides a launch with its reason', async () => {
    render(<AccessTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'A private dock');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
    expect(mocks.calls).toEqual([
      [
        'putIns:hide',
        { waterBodyId: 'wb1', coord: { lat: 43.6489, lng: -72.1793 }, reason: 'A private dock' },
      ],
    ]);
  });

  it('draws no lever and skips the audit read for a viewer without the capabilities', () => {
    mocks.can = new Set();
    render(<AccessTab bodyId="wb1" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.queryArgs.has(historyFn)).toBe(false);
    // Who ruled isn't known without the audit: absent, never guessed.
    expect(screen.queryByText('Teagan')).toBeNull();
  });

  it('holds its place until the record and the access read land', () => {
    mocks.results.delete(getFunctionName(api.accessPoints.accessForBody));
    const { container } = render(<AccessTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('holds the strip’s place while who ruled is on its way', () => {
    mocks.results.delete(historyFn);
    const { container } = render(<AccessTab bodyId="wb1" />);
    expect(container.querySelector('[data-slot="ruling-strip-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="ruling-strip"]')).toBeNull();
  });

  it('holds the strip’s place while the viewer’s role is on its way — not withheld yet', () => {
    mocks.can = new Set();
    mocks.roleLoading = true;
    const { container } = render(<AccessTab bodyId="wb1" />);
    expect(mocks.queryArgs.has(historyFn)).toBe(false);
    expect(container.querySelector('[data-slot="ruling-strip-loading"]')).not.toBeNull();
  });

  it('says who ruled isn’t recorded when the row that made the ruling names no one', () => {
    mocks.results.set(historyFn, {
      entries: [
        {
          id: 'ma1',
          action: 'set_public_access',
          targetType: 'waterbody',
          targetId: 'wb1',
          reason: 'Ruled',
          createdAt: RULED,
          actor: null,
          metadata: { prev: { publicAccess: null } },
        },
      ],
      capped: false,
    });
    const { container } = render(<AccessTab bodyId="wb1" />);
    const strip = container.querySelector('[data-slot="ruling-strip"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(within(strip).getByText('Who ruled: Not recorded yet')).toBeTruthy();
  });

  it('says who ruled isn’t recorded when the history holds no row that made the ruling', () => {
    // The newest row is a day older than the record's ruling: not the one that made it.
    const older = (capped: boolean) => ({
      entries: [
        {
          id: 'ma0',
          action: 'set_public_access',
          targetType: 'waterbody',
          targetId: 'wb1',
          reason: 'Ruled',
          createdAt: RULED - 86_400_000,
          actor: null,
          metadata: { prev: { publicAccess: null } },
        },
      ],
      capped,
    });
    mocks.results.set(historyFn, older(false));
    const { container, rerender } = render(<AccessTab bodyId="wb1" />);
    expect(container.querySelector('[data-slot="ruling-strip"]')).toBeNull();
    expect(screen.getByText('Who ruled and what stood before: Not recorded yet')).toBeTruthy();
    expect(screen.getByText('1 earlier ruling')).toBeTruthy();
    // A read that stopped short may hold it further back: past the read, not unrecorded.
    mocks.results.set(historyFn, older(true));
    rerender(<AccessTab bodyId="wb1" />);
    expect(
      screen.getByText('Who ruled and what stood before are past what this read shows'),
    ).toBeTruthy();
  });

  it('says how many rulings came before, and never draws a capped history as whole', () => {
    const entry = (createdAt: number) => ({
      id: `ma${createdAt}`,
      action: 'set_public_access',
      targetType: 'waterbody',
      targetId: 'wb1',
      reason: 'Ruled',
      createdAt,
      actor: null,
      metadata: { prev: { publicAccess: null } },
    });
    mocks.results.set(historyFn, {
      entries: [entry(RULED), entry(RULED - 86_400_000), entry(RULED - 2 * 86_400_000)],
      capped: true,
    });
    render(<AccessTab bodyId="wb1" />);
    expect(screen.getByText('2+ earlier rulings')).toBeTruthy();
  });

  it('says what failed, in place and in the note, and keeps the rest of the tab', () => {
    mocks.results.set(historyFn, new Error('down'));
    mocks.results.set(getFunctionName(api.landmarks.listForBody), new Error('down'));
    render(<AccessTab bodyId="wb1" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t read who ruled and where each launch is.',
    );
    expect(screen.getByText('Who ruled and what stood before couldn’t be read')).toBeTruthy();
    expect(screen.getByText('Couldn’t be read')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make official' })).toBeTruthy();
  });

  it('says the tab couldn’t be read when the record or access failed, with Try again', () => {
    mocks.results.set(getFunctionName(api.accessPoints.accessForBody), new Error('down'));
    render(<AccessTab bodyId="wb1" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t read this body’s record or its access.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  /**
   * Each write control, once the read returns what the server answers for that write (built from
   * the mutation's own source, `waterBodies.setPublicAccess` and `putIns.hide`): the lever is gone
   * or inert, and a second press writes nothing.
   */
  describe('after the server answers, a write control is gone and a second press writes nothing', () => {
    const body = getFunctionName(api.waterBodies.get);
    const access = getFunctionName(api.accessPoints.accessForBody);
    const ruled = (verdict: 'open' | 'none' | null) => {
      const prior = mocks.results.get(body) as { body: Record<string, unknown> };
      const next = { ...prior.body };
      // `setPublicAccess` patches the body's ruling (absent when cleared), stamped now.
      if (verdict === null) delete next.publicAccess;
      else next.publicAccess = { verdict, decidedAt: Date.now(), decidedByUserId: 'p1' };
      mocks.results.set(body, { available: true, body: next });
    };
    beforeEach(() => {
      mocks.server = (name, args) => {
        if (name === 'waterBodies:setPublicAccess') ruled(args.verdict as 'open' | 'none' | null);
        if (name === 'putIns:hide') {
          // `hide` inserts a hidden row at the point; `accessForBody` drops every visible launch
          // within 150 m of it (`visibleAfterHides`).
          const prior = mocks.results.get(access) as { putIns: { coord: { lat: number } }[] };
          mocks.results.set(access, {
            ...prior,
            putIns: prior.putIns.filter(
              (p) => Math.abs(p.coord.lat - (args.coord as { lat: number }).lat) > 0.0014,
            ),
          });
        }
      };
    });

    it('Rule no public access', async () => {
      const { rerender } = render(<AccessTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Rule no public access' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'Posted all round');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Rule no public access' }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<AccessTab bodyId="wb1" />);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Rule no public access' })).toBeNull(),
      );
      expect(screen.getByRole('button', { name: 'Rule accessible' })).toBeTruthy();
      expect(mocks.calls).toHaveLength(1);
    });

    it('Rule accessible', async () => {
      ruled('none');
      const { rerender } = render(<AccessTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Rule accessible' }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<AccessTab bodyId="wb1" />);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Rule accessible' })).toBeNull(),
      );
      expect(mocks.calls).toHaveLength(1);
    });

    it('Clear the ruling', async () => {
      const { rerender } = render(<AccessTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Clear the ruling' }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<AccessTab bodyId="wb1" />);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Clear the ruling' })).toBeNull(),
      );
      expect(mocks.calls).toEqual([
        ['waterBodies:setPublicAccess', { waterBodyId: 'wb1', verdict: null }],
      ]);
    });

    it('Hide', async () => {
      const { rerender } = render(<AccessTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'A private dock');
      await userEvent.click(within(dialog).getByRole('button', { name: /^Hide/ }));
      await waitFor(() => expect(mocks.calls).toHaveLength(1));
      rerender(<AccessTab bodyId="wb1" />);
      // The launch is gone, and its Hide with it.
      await waitFor(() => expect(screen.queryByText('NW launch')).toBeNull());
      expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull();
      expect(mocks.calls).toHaveLength(1);
    });

    it('Make official writes nothing at all (not available yet)', async () => {
      render(<AccessTab bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Make official' }));
      expect(mocks.calls).toEqual([]);
    });
  });

  describe('a switch to another body that is already read', () => {
    const toOther = () => {
      const prior = mocks.results.get(getFunctionName(api.waterBodies.get)) as {
        body: Record<string, unknown>;
      };
      mocks.results.set(getFunctionName(api.waterBodies.get), {
        available: true,
        body: { ...prior.body, _id: 'wb2', name: 'Crystal Lake' },
      });
    };

    it('drops every open dialog and its typed reason; nothing typed for one body is sent for the other', async () => {
      const { rerender } = render(<BodyTabHost Wiring={AccessTab} bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
      const dialog = await screen.findByRole('alertdialog');
      await userEvent.type(within(dialog).getByRole('textbox'), 'A private dock');
      toOther();
      rerender(<BodyTabHost Wiring={AccessTab} bodyId="wb2" />);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByDisplayValue('A private dock')).toBeNull();
      // The ruling's reason dialog, opened on the next body, starts clean.
      await userEvent.click(screen.getByRole('button', { name: 'Rule no public access' }));
      expect(within(await screen.findByRole('alertdialog')).getByRole('textbox')).toHaveValue('');
      expect(mocks.calls).toEqual([]);
    });

    it('a ruling started on one body that lands after the switch puts up no receipt over the next', async () => {
      let land: () => void = () => {};
      mocks.hold = new Promise<void>((r) => {
        land = r;
      });
      const { rerender } = render(<BodyTabHost Wiring={AccessTab} bodyId="wb1" />);
      await userEvent.click(screen.getByRole('button', { name: 'Clear the ruling' }));
      toOther();
      rerender(<BodyTabHost Wiring={AccessTab} bodyId="wb2" />);
      land();
      await new Promise((r) => setTimeout(r, 0));
      expect(mocks.announce).not.toHaveBeenCalled();
      expect(mocks.calls).toEqual([
        ['waterBodies:setPublicAccess', { waterBodyId: 'wb1', verdict: null }],
      ]);
    });
  });
});
