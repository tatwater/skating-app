import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The known-feature task through the real Body console route** (B01-6b, D313): only the router,
 * the role, the Convex hooks, the undo shell's announce, the toast queue, the map's canvas and the
 * map's engine stood in — the engine's claim is captured, so a test plays the map's part (a point
 * placed, a line or a ring traced). A feature is drawn any of three ways and sent with the fields
 * the task holds; *Edit shape* opens the task on the feature's own shape and sends `updateShape`; a
 * refusal keeps the task; Discard and Esc leave it; a viewer without `corpus.preIce` is offered
 * none of it.
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
    const r = mocks.results.get(getFunctionName(ref));
    return typeof r === 'function' ? r(args) : r;
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
import { hazardFootprint } from '@skating/core';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { BodyConsoleRoute } from '../../frame/BodyConsoleRoute';
import { MASCOMA_EXTRAS, MASCOMA_ID, MASCOMA_RECORD } from '../../frame/bodyFixtures';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ListWritersProvider } from '../listWriter';
import { dailyFrom, MASCOMA_FEATURES } from './hazardsFixtures';

type Ref = Parameters<typeof getFunctionName>[0];
const set = (ref: Ref, value: unknown) => mocks.results.set(getFunctionName(ref), value);
const sent = (ref: Ref) => mocks.writes.filter((w) => w.name === getFunctionName(ref));

const AT = { lat: 43.6385, lng: -72.1502 };
const LINE: GeoJSON.LineString = {
  type: 'LineString',
  coordinates: [
    [-72.16, 43.63],
    [-72.15, 43.64],
  ],
};
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
const BOX = { minLat: 43.63, minLng: -72.16, maxLat: 43.64, maxLng: -72.15 };

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
  mocks.search = { tab: 'hazards' };
  mocks.denied = new Set();
  mocks.writes = [];
  mocks.answer = {
    [getFunctionName(api.bodyFeatures.create)]: () => 'f-new',
    [getFunctionName(api.bodyFeatures.updateShape)]: (a) => a.bodyFeatureId,
  };
  mocks.announce.mockClear();
  mocks.navigate.mockClear();
  mocks.claim = null;
  toasts.length = 0;
  set(api.waterBodies.get, { available: true, body: MASCOMA_RECORD });
  set(
    api.bodyFeatures.listForBody,
    MASCOMA_FEATURES.map((f) => ({ ...f, bbox: BOX })),
  );
  set(api.hazards.listForBody, []);
  set(api.bodyConsole.dailyHazards, (args: { season: number; now: number }) =>
    dailyFrom(args.season, [], args.now),
  );
  set(api.recurrence.waitingCountForBody, { count: 0, capped: false });
  set(api.subAreas.listForBody, []);
  set(api.landmarks.listForEditor, []);
  set(api.putIns.listForBody, []);
  set(api.accessPoints.accessForBody, { putIns: [], parking: [], blockedIds: [], alerts: [] });
  set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, touchingBodyIds: [], touching: [] });
  set(api.bodyConsole.history, { entries: [], capped: false });
});

const task = () => screen.getByRole('group', { name: /New known feature|Redraw/ });
const claim = () => {
  if (mocks.claim === null) throw new Error('no tool is held');
  return mocks.claim;
};
const pick = () =>
  act(() => {
    const e = claim().engine;
    if (e.kind !== 'point') throw new Error(`the map holds ${e.kind}, not a point`);
    e.onPick(AT);
  });
const trace = (shape: GeoJSON.LineString | GeoJSON.Polygon) =>
  act(() => {
    const e = claim().engine;
    if (e.kind === 'line' && shape.type === 'LineString') e.onChange(shape);
    else if (e.kind === 'ring' && shape.type === 'Polygon') e.onChange(shape);
    else throw new Error(`the map holds ${e.kind}`);
  });
const addFeature = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: /Add a feature/ }));

describe('the feature task — a new feature', () => {
  it('as a point: the map holds a point, the draft is its circle, the save sends it all', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await addFeature(user);
    expect(within(task()).getByText('New known feature')).toBeVisible();
    expect(claim()).toMatchObject({ mode: 'Feature mode', line: 'Click where it is.' });
    expect(claim().engine.kind).toBe('point');
    // *Add a feature* rests while the task is up.
    expect(screen.queryByRole('button', { name: /Add a feature/ })).toBeNull();
    expect(within(task()).getByRole('button', { name: /Save/ })).toBeDisabled();
    pick();
    const radius = within(task()).getByRole('spinbutton', { name: 'Radius in meters' });
    await user.clear(radius);
    await user.type(radius, '45');
    expect(claim().draft).toEqual(
      hazardFootprint({
        geometryKind: 'point_radius',
        geometry: { type: 'Point', coordinates: [AT.lng, AT.lat] },
        radiusMeters: 45,
      }),
    );
    await user.type(within(task()).getByRole('textbox', { name: 'Note' }), '  Outlet  ');
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.bodyFeatures.create)).toHaveLength(1));
    expect(sent(api.bodyFeatures.create)[0]?.args).toEqual({
      waterBodyId: MASCOMA_ID,
      type: 'spring_current',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [AT.lng, AT.lat] },
      radiusMeters: 45,
      note: 'Outlet',
      reason: 'Authored by hand: Spring / current.',
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Known feature added · Spring / current',
          target: { targetType: 'bodyFeature', targetId: 'f-new' },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: /New known/ })).toBeNull());
    expect(mocks.claim).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ lit: 'feature:f-new' }) }),
    );
  });

  it('as a line: the map holds a line, the save sends its band', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await addFeature(user);
    const before = claim().session;
    await user.click(within(task()).getByRole('button', { name: 'Line' }));
    expect(claim().session).not.toBe(before);
    expect(claim().engine.kind).toBe('line');
    trace(LINE);
    expect(claim().engine).toMatchObject({ kind: 'line', line: LINE });
    expect(claim().draft?.type).toBe('Polygon');
    await user.keyboard('{Meta>}s{/Meta}');
    await waitFor(() => expect(sent(api.bodyFeatures.create)).toHaveLength(1));
    expect(sent(api.bodyFeatures.create)[0]?.args).toMatchObject({
      geometryKind: 'line',
      geometry: LINE,
      bufferMeters: 15,
    });
    expect(sent(api.bodyFeatures.create)[0]?.args).not.toHaveProperty('note');
  });

  it('as an outline: the map holds a ring; the draw tool failing leaves the paste', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await addFeature(user);
    await user.click(within(task()).getByRole('button', { name: 'Outline' }));
    expect(claim().engine.kind).toBe('ring');
    trace(RING);
    expect(claim().draft).toEqual(RING);
    act(() => {
      const e = claim().engine;
      if (e.kind === 'ring') e.onUnavailable();
    });
    expect(claim().engine.kind).toBe('none');
    expect(within(task()).getByText(/draw tool couldn’t load/)).toBeVisible();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.bodyFeatures.create)).toHaveLength(1));
    expect(sent(api.bodyFeatures.create)[0]?.args).toMatchObject({
      geometryKind: 'polygon',
      geometry: RING,
    });
  });

  it('pasted: the map shows only the shape', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await addFeature(user);
    await user.click(within(task()).getByRole('button', { name: 'Paste' }));
    expect(claim().engine.kind).toBe('none');
    await user.click(within(task()).getByRole('textbox', { name: 'GeoJSON' }));
    await user.paste(JSON.stringify(RING));
    expect(claim().draft).toEqual(RING);
  });

  it('keeps the task when the save is refused, and says why in a toast', async () => {
    mocks.answer[getFunctionName(api.bodyFeatures.create)] = () => {
      throw new ConvexError('A known feature has to be on its lake');
    };
    const user = userEvent.setup();
    render(<Mounted />);
    await addFeature(user);
    pick();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(JSON.stringify(toasts)).toMatch(/on its lake/);
    expect(task()).toBeVisible();
    expect(mocks.claim).not.toBeNull();
  });

  it('Discard and Esc both leave the task and let go of the map', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await addFeature(user);
    await user.click(within(task()).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('group', { name: /New known/ })).toBeNull();
    expect(mocks.claim).toBeNull();
    await addFeature(user);
    expect(mocks.claim).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(mocks.claim).toBeNull();
    expect(mocks.writes).toEqual([]);
  });

  it('a viewer without the pre-ice tools is offered none of it', async () => {
    mocks.denied = new Set(['corpus.preIce']);
    render(<Mounted />);
    expect(await screen.findByText('Known features')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Add a feature|Edit shape/ })).toBeNull();
  });
});

describe('the feature task — a redraw', () => {
  it('Edit shape opens on the feature’s own point and radius; the save sends updateShape', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    const rows = await screen.findAllByRole('button', { name: 'Edit shape' });
    await user.click(rows[0] as HTMLElement);
    expect(within(task()).getByText('Redraw · Spring / current')).toBeVisible();
    expect(claim()).toMatchObject({
      mode: 'Redraw',
      focus: { bbox: BOX },
      engine: { kind: 'point', point: { lng: -72.1502, lat: 43.6385 } },
    });
    expect(within(task()).getByRole('spinbutton', { name: 'Radius in meters' })).toHaveValue(60);
    // A redraw sets the shape only: no type or note to change.
    expect(within(task()).queryByRole('textbox', { name: 'Note' })).toBeNull();
    pick();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.bodyFeatures.updateShape)).toHaveLength(1));
    expect(sent(api.bodyFeatures.updateShape)[0]?.args).toEqual({
      bodyFeatureId: 'f-spring',
      geometryKind: 'point_radius',
      geometry: { type: 'Point', coordinates: [AT.lng, AT.lat] },
      radiusMeters: 60,
      reason: 'Redrawn by hand: Spring / current.',
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Shape redrawn · Spring / current',
          target: { targetType: 'bodyFeature', targetId: 'f-spring' },
        }),
      ),
    );
  });

  it('a line feature opens on its line, to edit; redrawn as an outline it sends a polygon', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    const rows = await screen.findAllByRole('button', { name: 'Edit shape' });
    await user.click(rows[1] as HTMLElement);
    expect(claim().engine).toMatchObject({
      kind: 'line',
      line: (MASCOMA_FEATURES[1] as { geometry: unknown }).geometry,
    });
    await user.click(within(task()).getByRole('button', { name: 'Outline' }));
    trace(RING);
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.bodyFeatures.updateShape)).toHaveLength(1));
    expect(sent(api.bodyFeatures.updateShape)[0]?.args).toEqual({
      bodyFeatureId: 'f-narrows',
      geometryKind: 'polygon',
      geometry: RING,
      reason: 'Redrawn by hand: Bridge narrows.',
    });
  });
});
