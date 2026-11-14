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
    },
  };
});
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => mocks.can.has(c), isLoading: mocks.roleLoading }),
}));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { stubJsdomAnimations } from '../jsdomStubs';
import { AccessTab } from './AccessTab';

beforeAll(stubJsdomAnimations);

const RULED = Date.now() - 3 * 86_400_000;

beforeEach(() => {
  mocks.results.clear();
  mocks.queryArgs.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(['access.rule', 'body.access', 'audit.read']);
  mocks.roleLoading = false;
  mocks.announce.mockClear();
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
    expect(mocks.announce).toHaveBeenCalledWith({
      title: 'Cleared the ruling',
      target: { targetType: 'waterbody', targetId: 'wb1' },
    });
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

  it('makes a mapped launch official at its point, under its name', async () => {
    render(<AccessTab bodyId="wb1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Make official' }));
    expect(mocks.calls).toEqual([
      [
        'putIns:setOfficial',
        { waterBodyId: 'wb1', coord: { lat: 43.6489, lng: -72.1793 }, name: 'NW launch' },
      ],
    ]);
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
});
