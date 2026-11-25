import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **Access's map tasks through the real Body console route** (B01-6b): only the router, the role,
 * the Convex hooks, the undo shell's announce, the toast queue, the map's canvas and the map's
 * engine stood in — the engine's claim is captured, so a test plays the map's part (a click on the
 * shore, a click on a lot). A put-in's spot snaps to the outline; a lot is placed where it is
 * clicked; a link picks the nearest lot, or none; the D144 refusal is a toast and the task stays;
 * each save goes out once with Undo; Discard and Esc let the map go; a viewer without the lever is
 * offered none of it.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  params: { id: '' } as Record<string, string>,
  search: {} as Record<string, unknown>,
  denied: new Set<string>(),
  writes: [] as { name: string; args: Record<string, unknown> }[],
  answer: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  announce: vi.fn((_receipt: unknown) => Promise.resolve()),
  navigate: vi.fn(),
  claim: null as null | import('../../frame/mapTool').MapToolClaim,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  const answer = (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(ref);
    const key = `${name}|${JSON.stringify(args)}`;
    return mocks.results.has(key) ? mocks.results.get(key) : mocks.results.get(name);
  };
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      args === 'skip' ? undefined : answer(ref, args),
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, answer(q.query, q.args)])),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      return async (args: Record<string, unknown>) => {
        mocks.writes.push({ name, args });
        return mocks.answer[name]?.(args);
      };
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  useParams: () => mocks.params,
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { push: vi.fn() } }),
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => !mocks.denied.has(c), isLoading: false }),
}));
vi.mock('../../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
const toasts = vi.hoisted(() => [] as { title: string; description?: string }[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => toasts.push(t),
}));
vi.mock('../../map/useBodyMapCanvas', () => ({
  FIT_PADDING: { top: 0, right: 0, bottom: 0, left: 0 },
  useBodyMapCanvas: () => ({
    ground: <div data-testid="ground" />,
    surface: null,
    zoomIn: () => {},
    zoomOut: () => {},
    atMinZoom: false,
    atMaxZoom: false,
    liveMap: () => null,
  }),
}));
vi.mock('../../map/useMapToolEngine', () => ({
  useMapToolEngine: (_live: unknown, claim: typeof mocks.claim) => {
    mocks.claim = claim;
  },
}));

import { api } from '@skating/convex/api';
import { HIKE_IN_ASSERT_M } from '@skating/core';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { BodyConsoleRoute } from '../../frame/BodyConsoleRoute';
import { MASCOMA_EXTRAS, MASCOMA_ID, MASCOMA_RECORD } from '../../frame/bodyFixtures';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ListWritersProvider } from '../listWriter';

type Ref = Parameters<typeof getFunctionName>[0];
const set = (ref: Ref, value: unknown) => mocks.results.set(getFunctionName(ref), value);
const sent = (ref: Ref) => mocks.writes.filter((w) => w.name === getFunctionName(ref));

/** The boat launch's lot, a second lot beside it, and a trailhead lot two and a half km off. */
const LOT_RAMP = { id: 'lot-ramp', coord: { lat: 43.63029, lng: -72.15763 } };
const LOT_BESIDE = {
  id: 'lot-beside',
  coord: { lat: 43.63073, lng: -72.1573 },
  name: 'Beach lot',
};
const LOT_TRAILHEAD = {
  id: 'lot-trail',
  coord: { lat: 43.60929, lng: -72.13765 },
  name: 'Smith Pond Trailhead',
};
const OSM_LAUNCH = {
  id: 'pi-dam',
  coord: { lat: 43.6489, lng: -72.1793 },
  name: 'NW launch',
  source: 'osm',
};
const OFFICIAL = {
  id: 'pi-launch',
  coord: { lat: 43.6309, lng: -72.1576 },
  name: 'Mascoma Lake Boat Launch',
  source: 'official',
  parkingAreaId: LOT_RAMP.id,
  approachMeters: 32,
  approachRouted: true,
};

const Mounted = () => (
  <ListWritersProvider>
    <KeysProvider>
      <BodyConsoleRoute />
    </KeysProvider>
  </ListWritersProvider>
);

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  resetConsoleReads();
  mocks.results.clear();
  mocks.params = { id: MASCOMA_ID };
  mocks.search = { tab: 'access' };
  mocks.denied = new Set();
  mocks.writes = [];
  mocks.answer = {
    [getFunctionName(api.putIns.setOfficial)]: () => 'pi-new',
    [getFunctionName(api.accessPoints.setOfficialParking)]: () => 'lot-new',
    [getFunctionName(api.accessPoints.setPutInAccess)]: () => null,
  };
  mocks.announce.mockClear();
  mocks.navigate.mockClear();
  mocks.claim = null;
  toasts.length = 0;
  set(api.waterBodies.get, { available: true, body: { ...MASCOMA_RECORD, bbox: undefined } });
  set(api.subAreas.listForBody, []);
  set(api.bodyConsole.bayProvenance, []);
  set(api.landmarks.listForEditor, []);
  set(api.landmarks.listForBody, []);
  set(api.putIns.listForBody, []);
  set(api.accessPoints.accessForBody, {
    putIns: [OFFICIAL, OSM_LAUNCH],
    parking: [LOT_RAMP, LOT_BESIDE, LOT_TRAILHEAD],
    blockedIds: [],
    alerts: [],
  });
  set(api.corpusRequests.openBayRequestsForBody, { bays: [], more: false });
  set(api.corpusPlaceNames.openForBody, { names: [], more: false });
  set(api.corpusRequests.openLandmarkRequestsForBody, { proposals: [], more: false });
  set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, touchingBodyIds: [], touching: [] });
  set(api.bodyConsole.history, { entries: [], capped: false });
});

const task = () => screen.getByRole('group', { name: /New put-in|New lot|Link a lot/ });
const claim = () => {
  if (mocks.claim === null) throw new Error('no tool is held');
  return mocks.claim;
};
/** Plays the map's part: a click (or a drag's release) at `p`, as the point engine reports it. */
const pick = (p: { lat: number; lng: number }) =>
  act(() => {
    const e = claim().engine;
    if (e.kind !== 'point') throw new Error(`the map holds ${e.kind}, not a point`);
    e.onPick(p);
  });
const saveButton = () => within(task()).getByRole('button', { name: /Save/ });

describe('Access: a put-in placed on the map', () => {
  it('snaps to the outline while hovering; the save sends the spot and the name, with Undo', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Add a put-in/ }));
    expect(within(task()).getByText('New put-in')).toBeVisible();
    const engine = claim().engine;
    expect(engine).toMatchObject({ kind: 'point', snapTo: MASCOMA_RECORD.polygon });
    expect(claim()).toMatchObject({ mode: 'Put-in mode', step: 'Step 1 of 2' });
    // The entry points rest while the task is up.
    expect(screen.queryByRole('button', { name: /Add a lot/ })).toBeNull();
    expect(saveButton()).toBeDisabled();
    const name = within(task()).getByPlaceholderText('Optional, what skaters call it');
    expect(name).toHaveAttribute('maxLength', '60');
    await user.type(name, 'Town Beach');
    const spot = { lat: 43.6312, lng: -72.1571 };
    pick(spot);
    expect(claim()).toMatchObject({ step: 'Step 2 of 2' });
    await user.click(saveButton());
    await waitFor(() => expect(sent(api.putIns.setOfficial)).toHaveLength(1));
    expect(sent(api.putIns.setOfficial)[0]?.args).toEqual({
      waterBodyId: MASCOMA_ID,
      coord: spot,
      name: 'Town Beach',
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Put-in placed · Town Beach',
          target: { targetType: 'waterbody', targetId: MASCOMA_ID },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: 'New put-in' })).toBeNull());
    expect(mocks.claim).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ lit: 'putIn:pi-new' }) }),
    );
  });

  it('P starts it, a nameless put-in sends no name, and a refusal keeps the task', async () => {
    mocks.answer[getFunctionName(api.putIns.setOfficial)] = () => {
      throw new ConvexError('That point is 300 m from the water — too far to snap to the shore.');
    };
    const user = userEvent.setup();
    render(<Mounted />);
    await screen.findByRole('button', { name: /Add a put-in/ });
    await user.keyboard('p');
    pick({ lat: 43.64, lng: -72.16 });
    await user.click(saveButton());
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(sent(api.putIns.setOfficial)[0]?.args).not.toHaveProperty('name');
    expect(JSON.stringify(toasts)).toMatch(/too far to snap/);
    expect(task()).toBeVisible();
    expect(mocks.claim).not.toBeNull();
  });
});

describe('Access: a lot placed on the map', () => {
  it('places where it’s clicked (no snap), serving this lake; its receipt is on the lot', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Add a lot/ }));
    expect(claim().engine).not.toHaveProperty('snapTo');
    expect(claim().mode).toBe('Parking mode');
    const spot = { lat: 43.629, lng: -72.159 };
    pick(spot);
    await user.type(within(task()).getByPlaceholderText('Optional, as the sign says'), 'Town lot');
    await user.keyboard('{Meta>}s{/Meta}');
    await waitFor(() => expect(sent(api.accessPoints.setOfficialParking)).toHaveLength(1));
    expect(sent(api.accessPoints.setOfficialParking)[0]?.args).toEqual({
      coord: spot,
      name: 'Town lot',
      amenities: [],
      waterBodyIds: [MASCOMA_ID],
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Lot placed · Town lot',
          target: { targetType: 'parkingArea', targetId: 'lot-new' },
        }),
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ lit: 'lot:lot-new' }) }),
    );
  });

  it('Discard and Esc both leave the task and let go of the map', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Add a lot/ }));
    await user.click(within(task()).getByRole('button', { name: 'Discard' }));
    expect(mocks.claim).toBeNull();
    await user.click(screen.getByRole('button', { name: /Add a put-in/ }));
    expect(mocks.claim).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(mocks.claim).toBeNull();
    expect(mocks.writes).toEqual([]);
  });
});

describe('Access: a lot linked to a put-in on the map', () => {
  it('a click picks the nearest lot, the mark moves onto it, and the save links it', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Link a lot' }));
    expect(within(task()).getByText('Link a lot · NW launch')).toBeVisible();
    expect(claim()).toMatchObject({ mode: 'Link mode', focus: { point: OSM_LAUNCH.coord } });
    expect(saveButton()).toBeDisabled();
    // A click beside no lot: said, and nothing picked.
    pick({ lat: 43.7, lng: -72.3 });
    expect(within(task()).getByText(/That click wasn’t on a lot/)).toBeVisible();
    const before = claim().session;
    // A click a few meters from the beach lot picks it, not the ramp's beside it.
    pick({ lat: 43.63075, lng: -72.15728 });
    expect(within(task()).getByText('Beach lot')).toBeVisible();
    expect(claim().session).not.toBe(before);
    expect(claim().engine).toMatchObject({ kind: 'point', point: LOT_BESIDE.coord });
    expect(claim().draft).toMatchObject({ type: 'MultiPoint' });
    expect(within(task()).getByText(/m from the put-in in a straight line/)).toBeVisible();
    await user.click(saveButton());
    await waitFor(() => expect(sent(api.accessPoints.setPutInAccess)).toHaveLength(1));
    expect(sent(api.accessPoints.setPutInAccess)[0]?.args).toEqual({
      putInId: OSM_LAUNCH.id,
      parkingAreaId: LOT_BESIDE.id,
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Linked Beach lot to NW launch',
          target: { targetType: 'putIn', targetId: OSM_LAUNCH.id },
        }),
      ),
    );
  });

  it('a long walk refused for want of the hike-in says so in a toast; checking it sends it', async () => {
    mocks.answer[getFunctionName(api.accessPoints.setPutInAccess)] = (args) => {
      if (args.approachKindOverride !== 'hike_in') {
        throw new ConvexError(
          `An approach this long must be asserted as hike-in (over ${HIKE_IN_ASSERT_M} m).`,
        );
      }
      return null;
    };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Link a lot' }));
    pick(LOT_TRAILHEAD.coord);
    expect(within(task()).getByText(/has to be marked a hike-in/)).toBeVisible();
    await user.click(saveButton());
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(JSON.stringify(toasts)).toMatch(/asserted as hike-in/);
    expect(task()).toBeVisible();
    await user.click(within(task()).getByRole('checkbox', { name: /It’s a hike-in/ }));
    await user.click(saveButton());
    await waitFor(() => expect(sent(api.accessPoints.setPutInAccess)).toHaveLength(2));
    expect(sent(api.accessPoints.setPutInAccess)[1]?.args).toEqual({
      putInId: OSM_LAUNCH.id,
      parkingAreaId: LOT_TRAILHEAD.id,
      approachKindOverride: 'hike_in',
    });
    await waitFor(() => expect(screen.queryByRole('group', { name: /Link a lot/ })).toBeNull());
  });

  it('an official put-in can be re-linked: its own lot again is refused, No parking clears it', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Change lot' }));
    expect(within(task()).getByText('Link a lot · Mascoma Lake Boat Launch')).toBeVisible();
    pick(LOT_RAMP.coord);
    expect(within(task()).getByText('That’s the lot it has already')).toBeVisible();
    expect(saveButton()).toBeDisabled();
    await user.click(within(task()).getByRole('button', { name: 'No parking' }));
    expect(within(task()).queryByRole('checkbox')).toBeNull();
    await user.click(saveButton());
    await waitFor(() => expect(sent(api.accessPoints.setPutInAccess)).toHaveLength(1));
    expect(sent(api.accessPoints.setPutInAccess)[0]?.args).toEqual({
      putInId: OFFICIAL.id,
      clearParking: true,
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'No parking for Mascoma Lake Boat Launch' }),
      ),
    );
  });
});

describe('Access: without the lever', () => {
  it('a viewer who can’t place access is offered none of it', async () => {
    mocks.denied = new Set(['body.access']);
    render(<Mounted />);
    await screen.findByText('Mascoma Lake Boat Launch');
    expect(screen.queryByRole('button', { name: /Add a put-in/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add a lot/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link a lot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change lot' })).toBeNull();
  });
});
