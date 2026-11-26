import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The bay task through the real Body console route** (B01-6a): only the router, the role, the
 * Convex hooks, the undo shell's announce, the toast queue, the map's canvas and the map's engine
 * stood in — the engine's claim is captured, so a test plays the map's part (a chord finished, a
 * ring traced). Each way of drawing a bay sends its own write with the fields the task holds; an
 * Inbox ask arrives filled and its save approves the ask and goes back to the Inbox; a landmark
 * arrives filled and its save retires it; a lit bay is redrawn or its mouth moved; a refusal keeps
 * the task; Discard and Esc leave it; a viewer who can't shape bays is offered none of it.
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
  push: vi.fn(),
  /** The map tool the tab holds, as the map's engine was handed it. */
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
  useRouter: () => ({ history: { push: mocks.push } }),
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
import type { SubAreaMouth } from '@skating/core';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { BodyConsoleRoute } from '../../frame/BodyConsoleRoute';
import {
  MASCOMA_BAY_PROVENANCE,
  MASCOMA_EXTRAS,
  MASCOMA_ID,
  MASCOMA_RECORD,
  MASCOMA_SUB_AREAS,
} from '../../frame/bodyFixtures';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ListWritersProvider } from '../listWriter';

type Ref = Parameters<typeof getFunctionName>[0];
const set = (ref: Ref, value: unknown) => mocks.results.set(getFunctionName(ref), value);
const sent = (ref: Ref) => mocks.writes.filter((w) => w.name === getFunctionName(ref));

const RING: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.16, 43.63],
      [-72.15, 43.63],
      [-72.15, 43.64],
      [-72.16, 43.63],
    ],
  ],
};
const MOUTH: SubAreaMouth = {
  a: { lat: 43.6312, lng: -72.1575 },
  b: { lat: 43.6329, lng: -72.1559 },
  side: { lat: 43.631, lng: -72.156 },
  sagittaM: 38,
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
  mocks.search = {};
  mocks.denied = new Set();
  mocks.writes = [];
  mocks.answer = {
    [getFunctionName(api.subAreas.createFromChord)]: () => ({ subAreaId: 'bay-new' }),
    [getFunctionName(api.subAreas.create)]: () => ({ subAreaId: 'bay-new' }),
  };
  mocks.announce.mockClear();
  mocks.navigate.mockClear();
  mocks.push.mockClear();
  mocks.claim = null;
  toasts.length = 0;
  set(api.waterBodies.get, { available: true, body: { ...MASCOMA_RECORD, bbox: undefined } });
  set(
    api.subAreas.listForBody,
    MASCOMA_SUB_AREAS.map((s, i) => ({
      ...s,
      polygon: i === 0 ? RING : MASCOMA_RECORD.polygon,
      bbox: { minLat: 43.63, minLng: -72.16, maxLat: 43.64, maxLng: -72.15 },
      ...(i === 1 ? { mouth: MOUTH } : {}),
    })),
  );
  set(api.bodyConsole.bayProvenance, MASCOMA_BAY_PROVENANCE);
  set(api.landmarks.listForEditor, []);
  set(api.putIns.listForBody, []);
  set(api.accessPoints.accessForBody, { putIns: [], parking: [], blockedIds: [], alerts: [] });
  set(api.corpusRequests.openBayRequestsForBody, { bays: [], more: false });
  set(api.corpusPlaceNames.openForBody, { names: [], more: false });
  set(api.corpusRequests.openLandmarkRequestsForBody, { proposals: [], more: false });
  set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, touchingBodyIds: [], touching: [] });
  set(api.bodyConsole.history, { entries: [], capped: false });
});

const task = () => screen.getByRole('group', { name: /bay|Redraw|mouth/i });
const claim = () => {
  if (mocks.claim === null) throw new Error('no tool is held');
  return mocks.claim;
};
/** Plays the map's part: the chord gesture finished, cutting `RING`. */
const finishChord = () =>
  act(() => {
    const e = claim().engine;
    if (e.kind !== 'chord') throw new Error(`the map holds ${e.kind}, not a chord`);
    e.onChange({ step: 'done', ...MOUTH }, MOUTH, {
      ok: true,
      polygon: RING,
    } as never);
  });
const traceRing = () =>
  act(() => {
    const e = claim().engine;
    if (e.kind !== 'ring') throw new Error(`the map holds ${e.kind}, not a ring`);
    e.onChange(RING);
  });

describe('the bay task — a new bay', () => {
  it('by chord: the map holds the chord, the save sends the mouth and the fields, the bay is lit', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Draw by chord/ }));
    expect(within(task()).getByText('New bay')).toBeVisible();
    expect(claim()).toMatchObject({ mode: 'Bay mode', step: 'Step 1 of 4' });
    // *Add a bay* rests while the task is up.
    expect(screen.queryByRole('button', { name: /Draw freehand/ })).toBeNull();
    const save = within(task()).getByRole('button', { name: /Save/ });
    expect(save).toBeDisabled();
    await user.type(within(task()).getByPlaceholderText('What skaters call it'), 'Shaker cove');
    await user.type(within(task()).getByPlaceholderText('Comma-separated'), 'The cove, Cove');
    finishChord();
    expect(claim().draft).toEqual(RING);
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.subAreas.createFromChord)).toHaveLength(1));
    expect(sent(api.subAreas.createFromChord)[0]?.args).toEqual({
      waterBodyId: MASCOMA_ID,
      name: 'Shaker cove',
      aliases: ['The cove', 'Cove'],
      mouth: MOUTH,
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Bay drawn · Shaker cove',
          target: { targetType: 'waterBodySubArea', targetId: 'bay-new' },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: 'New bay' })).toBeNull());
    expect(mocks.claim).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ lit: 'bay:bay-new' }) }),
    );
  });

  it('freehand: the traced ring is the shape sent', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Draw freehand/ }));
    expect(claim().engine.kind).toBe('ring');
    await user.type(within(task()).getByPlaceholderText('What skaters call it'), 'Fish bay');
    traceRing();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.subAreas.create)).toHaveLength(1));
    expect(sent(api.subAreas.create)[0]?.args).toEqual({
      waterBodyId: MASCOMA_ID,
      name: 'Fish bay',
      polygon: RING,
    });
  });

  it('a switch of way starts the drawing over on the map; a paste draws only its shape', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Draw by chord/ }));
    const before = claim().session;
    await user.click(within(task()).getByRole('button', { name: 'Paste' }));
    expect(claim().session).not.toBe(before);
    expect(claim().engine.kind).toBe('none');
    await user.type(within(task()).getByPlaceholderText('What skaters call it'), 'Fish bay');
    const box = within(task()).getByPlaceholderText(/A Polygon or MultiPolygon/);
    await user.click(box);
    await user.paste(JSON.stringify(RING));
    expect(claim().draft).toEqual(RING);
    await user.keyboard('{Meta>}s{/Meta}');
    await waitFor(() => expect(sent(api.subAreas.create)).toHaveLength(1));
  });

  it('keeps the task when the save is refused, and says why in a toast', async () => {
    mocks.answer[getFunctionName(api.subAreas.createFromChord)] = () => {
      throw new ConvexError('A bay called that is already drawn on Mascoma Lake');
    };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Draw by chord/ }));
    await user.type(within(task()).getByPlaceholderText('What skaters call it'), 'Mascoma North');
    finishChord();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(JSON.stringify(toasts)).toMatch(/already drawn/);
    expect(task()).toBeVisible();
    expect(mocks.claim).not.toBeNull();
  });

  it('Discard and Esc both leave the task and let go of the map', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Draw by chord/ }));
    await user.click(within(task()).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('group', { name: 'New bay' })).toBeNull();
    expect(mocks.claim).toBeNull();
    await user.click(screen.getByRole('button', { name: /Draw freehand/ }));
    expect(mocks.claim).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(mocks.claim).toBeNull();
    expect(mocks.writes).toEqual([]);
  });

  it('the claim carries the drawing as it stands, so a map re-created mid-task puts it back', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Draw by chord/ }));
    expect(claim().engine).not.toHaveProperty('mouth');
    finishChord();
    expect(claim().engine).toMatchObject({ kind: 'chord', mouth: MOUTH });
    await user.click(within(task()).getByRole('button', { name: 'Freehand' }));
    expect(claim().engine).not.toHaveProperty('polygon');
    traceRing();
    expect(claim().engine).toMatchObject({ kind: 'ring', polygon: RING });
  });

  it('a viewer who can’t shape bays is offered none of it', async () => {
    mocks.denied = new Set(['body.shape']);
    render(<Mounted />);
    expect(await screen.findByRole('button', { name: /Draw by chord/ })).toBeDisabled();
  });
});

describe('the bay task — arrivals', () => {
  it('an Inbox ask arrives filled; its save approves the ask and goes back to the Inbox', async () => {
    mocks.search = { task: 'rq2', from: '/admin/inbox?lane=places&item=rq2' };
    set(api.corpusRequests.openBayRequestsForBody, {
      bays: [
        {
          requestId: 'rq1',
          requestIds: ['rq1', 'rq2', 'rq3'],
          name: 'Shaker cove',
          aliases: ['The cove at Shaker Bridge'],
          coord: { lat: 43.632, lng: -72.157 },
          notes: [],
          askers: 3,
          createdAt: 1,
        },
      ],
      more: false,
    });
    const user = userEvent.setup();
    render(<Mounted />);
    const box = await screen.findByRole('group', { name: 'Bay request · from the Inbox' });
    expect(within(box).getByText('Saving answers all 3 asks for this bay.')).toBeVisible();
    expect(within(box).getByPlaceholderText('What skaters call it')).toHaveValue('Shaker cove');
    expect(within(box).getByPlaceholderText('Comma-separated')).toHaveValue(
      'The cove at Shaker Bridge',
    );
    expect(claim().focus).toEqual({ point: { lat: 43.632, lng: -72.157 } });
    // Taken once: the address drops it.
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
    finishChord();
    await user.click(within(box).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.subAreas.createFromChord)).toHaveLength(1));
    expect(sent(api.subAreas.createFromChord)[0]?.args).toMatchObject({ requestId: 'rq2' });
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith('/admin/inbox?lane=places&item=rq2'),
    );
  });

  it.each([
    ['already_decided', 'That ask was already closed, so this didn’t answer it.'],
    [
      'answered_others',
      'That ask was already closed, but this answered the others who asked for it.',
    ],
  ])(
    'an ask closed while the bay was traced (%s): the receipt says what the save did',
    async (request, said) => {
      mocks.search = { task: 'rq1' };
      mocks.answer[getFunctionName(api.subAreas.create)] = () => ({
        subAreaId: 'bay-new',
        request,
      });
      set(api.corpusRequests.openBayRequestsForBody, {
        bays: [
          {
            requestId: 'rq1',
            requestIds: ['rq1'],
            name: 'Shaker cove',
            aliases: [],
            coord: { lat: 43.632, lng: -72.157 },
            notes: [],
            askers: 1,
            createdAt: 1,
          },
        ],
        more: false,
      });
      const user = userEvent.setup();
      render(<Mounted />);
      const box = await screen.findByRole('group', { name: 'Bay request · from the Inbox' });
      await user.click(within(box).getByRole('button', { name: 'Freehand' }));
      traceRing();
      await user.click(within(box).getByRole('button', { name: /Save/ }));
      await waitFor(() => expect(sent(api.subAreas.create)).toHaveLength(1));
      expect(sent(api.subAreas.create)[0]?.args).toMatchObject({ requestId: 'rq1' });
      await waitFor(() =>
        expect(mocks.announce).toHaveBeenCalledWith(
          expect.objectContaining({
            description: said,
            target: { targetType: 'waterBodySubArea', targetId: 'bay-new' },
          }),
        ),
      );
    },
  );

  it('an ask that is no longer open says so, and arms nothing', async () => {
    mocks.search = { task: 'rq9' };
    render(<Mounted />);
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Nothing to draw'));
    expect(toasts[0]?.description).toBe('That ask isn’t open any more.');
    expect(mocks.claim).toBeNull();
  });

  it('a save that settles after the console was left still lands, and sends no one back', async () => {
    mocks.search = { task: 'rq2', from: '/admin/inbox?lane=places&item=rq2' };
    set(api.corpusRequests.openBayRequestsForBody, {
      bays: [
        {
          requestId: 'rq2',
          requestIds: ['rq2'],
          name: 'Shaker cove',
          aliases: [],
          notes: [],
          askers: 1,
          createdAt: 1,
        },
      ],
      more: false,
    });
    let settle: (answer: { subAreaId: string }) => void = () => {};
    mocks.answer[getFunctionName(api.subAreas.createFromChord)] = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    const user = userEvent.setup();
    const view = render(<Mounted />);
    const box = await screen.findByRole('group', { name: 'Bay request · from the Inbox' });
    finishChord();
    await user.click(within(box).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.subAreas.createFromChord)).toHaveLength(1));
    // The moderator goes elsewhere while the write is out.
    view.unmount();
    await act(async () => settle({ subAreaId: 'bay-new' }));
    await waitFor(() => expect(mocks.announce).toHaveBeenCalled());
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('asks for the ask it arrived for by its id, so one past the read’s bound still opens', async () => {
    mocks.search = { task: 'rq9' };
    mocks.results.set(
      `${getFunctionName(api.corpusRequests.openBayRequestsForBody)}|${JSON.stringify({
        waterBodyId: MASCOMA_ID,
        including: 'rq9',
      })}`,
      {
        bays: [
          {
            requestId: 'rq9',
            requestIds: ['rq9'],
            name: 'Late cove',
            aliases: [],
            notes: [],
            askers: 1,
            createdAt: 1,
          },
        ],
        more: true,
      },
    );
    render(<Mounted />);
    await waitFor(() => expect(mocks.claim).not.toBeNull());
    expect(within(task()).getByDisplayValue('Late cove')).toBeVisible();
    expect(toasts).toEqual([]);
  });

  it('a read that fails says so and lets the arrival go, rather than sit armed and silent', async () => {
    mocks.search = { task: 'rq2' };
    set(api.corpusRequests.openBayRequestsForBody, new Error('read failed'));
    render(<Mounted />);
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Nothing to draw'));
    expect(toasts[0]?.description).toMatch(/couldn’t be read/);
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
    expect(mocks.claim).toBeNull();
  });

  it('a landmark arrives filled; its save retires it, and stays on the console', async () => {
    mocks.search = { promote: 'lm1' };
    set(api.landmarks.listForEditor, [
      {
        _id: 'lm1',
        name: 'Black Point cove',
        aliases: ['Blackpoint'],
        point: { lat: 43.64, lng: -72.15 },
        kind: 'cove',
      },
    ]);
    const user = userEvent.setup();
    render(<Mounted />);
    const box = await screen.findByRole('group', { name: 'A landmark drawn as a bay' });
    expect(within(box).getByText(/Black Point cove is removed when the bay saves/)).toBeVisible();
    expect(within(box).getByPlaceholderText('What skaters call it')).toHaveValue(
      'Black Point cove',
    );
    await user.click(within(box).getByRole('button', { name: 'Freehand' }));
    traceRing();
    await user.click(within(box).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.subAreas.create)).toHaveLength(1));
    expect(sent(api.subAreas.create)[0]?.args).toMatchObject({
      name: 'Black Point cove',
      aliases: ['Blackpoint'],
      promoteLandmarkId: 'lm1',
    });
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe('the bay task — a lit bay', () => {
  it('Redraw hands its ring to the vertex editor and sends the new outline', async () => {
    mocks.search = { lit: 'bay:bay-north' };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /^Redraw/ }));
    expect(within(task()).getByText('Redraw · Mascoma North')).toBeVisible();
    expect(claim().engine).toMatchObject({ kind: 'ring', polygon: RING });
    expect(claim().focus).toMatchObject({ bbox: expect.any(Object) });
    traceRing();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.subAreas.redraw)).toHaveLength(1));
    expect(sent(api.subAreas.redraw)[0]?.args).toEqual({ subAreaId: 'bay-north', polygon: RING });
  });

  it('the mouth: re-opens a stored one to move, and sends the moved mouth', async () => {
    mocks.search = { lit: 'bay:bay-south' };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Move the mouth/ }));
    expect(claim().engine).toMatchObject({ kind: 'chord', mouth: MOUTH });
    finishChord();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.subAreas.updateChord)).toHaveLength(1));
    expect(sent(api.subAreas.updateChord)[0]?.args).toEqual({
      subAreaId: 'bay-south',
      mouth: MOUTH,
    });
  });

  it('a bay with no mouth offers to draw one', async () => {
    mocks.search = { lit: 'bay:bay-north' };
    render(<Mounted />);
    expect(await screen.findByRole('button', { name: /Draw the mouth/ })).toBeVisible();
  });
});
