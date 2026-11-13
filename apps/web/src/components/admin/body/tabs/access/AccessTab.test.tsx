import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body › Access as the console mounts it: four reads, the ruling and the put-in writes behind their
 * capabilities and announced for undo; a reason asked only when access is taken away.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  queryArgs: new Map<string, unknown>(),
  calls: [] as Array<[string, unknown]>,
  can: new Set<string>(),
  announce: vi.fn(async () => {}),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      mocks.queryArgs.set(getFunctionName(ref), args);
      return args === 'skip' ? undefined : mocks.results.get(getFunctionName(ref));
    },
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => async (args: unknown) => {
      mocks.calls.push([getFunctionName(ref), args]);
    },
  };
});
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: (c: string) => mocks.can.has(c) }) }));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { stubJsdomAnimations } from '../names/jsdomStubs';
import { AccessTab } from './AccessTab';

beforeAll(stubJsdomAnimations);

const RULED = Date.now() - 3 * 86_400_000;

beforeEach(() => {
  mocks.results.clear();
  mocks.queryArgs.clear();
  mocks.calls.length = 0;
  mocks.can = new Set(['access.rule', 'body.access', 'audit.read']);
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
  set(api.moderation.listActions, [
    {
      createdAt: RULED,
      actor: { displayName: 'Teagan', username: 'teagan' },
      metadata: { prev: { publicAccess: null } },
    },
  ]);
});

describe('AccessTab', () => {
  it('reads the ruling’s own audit rows, and draws who ruled', () => {
    render(<AccessTab bodyId="wb1" />);
    expect(mocks.queryArgs.get(getFunctionName(api.moderation.listActions))).toEqual({
      targetType: 'waterbody',
      targetId: 'wb1',
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
    expect(mocks.queryArgs.get(getFunctionName(api.moderation.listActions))).toBe('skip');
    // Who ruled isn't known without the audit: absent, never guessed.
    expect(screen.queryByText('Teagan')).toBeNull();
  });

  it('holds its place until the record and the access read land', () => {
    mocks.results.delete(getFunctionName(api.accessPoints.accessForBody));
    const { container } = render(<AccessTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
