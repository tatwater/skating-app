import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The sample-point task through the real Body console route** (B01-6b, D313): only the router,
 * the role, the Convex hooks, the undo shell's announce, the toast queue, the map's canvas and the
 * map's engine stood in — the engine's claim is captured. *Suggest a grid* shows core's grid on the
 * map as the claim's draft, with no engine; *Save* sends it with the points it was suggested over
 * as `expected`; *Clear* sends none; a refusal keeps the task; Discard and Esc leave it; a viewer
 * without `body.water` is offered none of it.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  params: { id: '' } as Record<string, string>,
  search: {} as Record<string, unknown>,
  denied: new Set<string>(),
  writes: [] as { name: string; args: Record<string, unknown> }[],
  answer: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  announce: vi.fn((_receipt: unknown) => Promise.resolve()),
  claim: null as null | import('../../frame/mapTool').MapToolClaim,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  const answer = (ref: Parameters<typeof getFunctionName>[0]) =>
    mocks.results.get(getFunctionName(ref));
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      args === 'skip' ? undefined : answer(ref),
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, answer(q.query)])),
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
  useNavigate: () => vi.fn(),
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
    // The map's ink mode (`mapInks`): what a tool's palette is built from.
    inks: 'dark' as const,
  }),
}));
vi.mock('../../map/useMapToolEngine', () => ({
  useMapToolEngine: (_live: unknown, claim: typeof mocks.claim) => {
    mocks.claim = claim;
  },
}));

import { api } from '@skating/convex/api';
import { suggestSamplePoints } from '@skating/core';
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

const STORED = [{ lat: 43.63, lng: -72.15 }];
const OUTLINE = MASCOMA_RECORD.polygon as unknown as GeoJSON.Polygon | GeoJSON.MultiPolygon;

const Mounted = () => (
  <ListWritersProvider>
    <KeysProvider>
      <BodyConsoleRoute />
    </KeysProvider>
  </ListWritersProvider>
);

beforeAll(stubJsdomAnimations);

const record = (points?: typeof STORED) =>
  set(api.waterBodies.get, {
    available: true,
    body: { ...MASCOMA_RECORD, ...(points !== undefined ? { weatherSamplePoints: points } : {}) },
  });

beforeEach(() => {
  resetConsoleReads();
  mocks.results.clear();
  mocks.params = { id: MASCOMA_ID };
  mocks.search = { tab: 'water' };
  mocks.denied = new Set();
  mocks.writes = [];
  mocks.answer = {
    [getFunctionName(api.waterBodies.setWeatherSamplePoints)]: () => MASCOMA_ID,
  };
  mocks.announce.mockClear();
  mocks.claim = null;
  toasts.length = 0;
  record(STORED);
  set(api.bodyConsole.depthChoices, {
    mean: { choices: [] },
    max: { choices: [] },
    recorded: false,
  });
  set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, touchingBodyIds: [], touching: [] });
  set(api.bodyConsole.history, { entries: [], capped: false });
  set(api.subAreas.listForBody, []);
  set(api.landmarks.listForEditor, []);
  set(api.putIns.listForBody, []);
  set(api.accessPoints.accessForBody, { putIns: [], parking: [], blockedIds: [], alerts: [] });
});

const task = () => screen.getByRole('group', { name: 'Suggested sample points' });
const claim = () => {
  if (mocks.claim === null) throw new Error('no tool is held');
  return mocks.claim;
};

describe('the sample-point task', () => {
  it('suggests core’s grid, shows it on the map with no engine, and saves it expecting the old points', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Suggest a grid' }));
    const grid = suggestSamplePoints(OUTLINE, 11).points;
    expect(claim()).toMatchObject({
      mode: 'Sample points',
      engine: { kind: 'none' },
      draft: { type: 'MultiPoint', coordinates: grid.map((p) => [p.lng, p.lat]) },
    });
    // The section's tools rest while the grid is up.
    expect(screen.queryByRole('button', { name: 'Suggest a grid' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.waterBodies.setWeatherSamplePoints)).toHaveLength(1));
    expect(sent(api.waterBodies.setWeatherSamplePoints)[0]?.args).toEqual({
      waterBodyId: MASCOMA_ID,
      points: grid,
      expected: STORED,
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: `Sample points set · ${grid.length}`,
          target: { targetType: 'waterbody', targetId: MASCOMA_ID },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: /Suggested/ })).toBeNull());
    expect(mocks.claim).toBeNull();
  });

  it('suggests again at another spacing, as a new preview', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Suggest a grid' }));
    const before = claim().session;
    const spacing = within(task()).getByRole('spinbutton', { name: 'Spacing in km' });
    await user.clear(spacing);
    await user.type(spacing, '1');
    expect(claim().session).toBe(before);
    await user.click(within(task()).getByRole('button', { name: 'Suggest again' }));
    expect(claim().session).not.toBe(before);
    const grid = suggestSamplePoints(OUTLINE, 1).points;
    expect(claim().draft).toEqual({
      type: 'MultiPoint',
      coordinates: grid.map((p) => [p.lng, p.lat]),
    });
    await user.clear(spacing);
    await user.type(spacing, '500');
    expect(within(task()).getByText('The spacing is 1 to 100 km')).toBeVisible();
    expect(within(task()).getByRole('button', { name: 'Suggest again' })).toBeDisabled();
    await user.keyboard('{Meta>}s{/Meta}');
    await waitFor(() => expect(sent(api.waterBodies.setWeatherSamplePoints)).toHaveLength(1));
    expect(sent(api.waterBodies.setWeatherSamplePoints)[0]?.args.points).toEqual(grid);
  });

  it('a grid suggested again while a save is out stays up, and its save expects the points just saved', async () => {
    let release: (v: unknown) => void = () => {};
    mocks.answer[getFunctionName(api.waterBodies.setWeatherSamplePoints)] = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Suggest a grid' }));
    const first = suggestSamplePoints(OUTLINE, 11).points;
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.waterBodies.setWeatherSamplePoints)).toHaveLength(1));
    const spacing = within(task()).getByRole('spinbutton', { name: 'Spacing in km' });
    await user.clear(spacing);
    // The button rests while the save is out; ⏎ in the field still suggests.
    await user.type(spacing, '1{Enter}');
    await act(async () => release(MASCOMA_ID));
    expect(task()).toBeVisible();
    mocks.answer[getFunctionName(api.waterBodies.setWeatherSamplePoints)] = () => MASCOMA_ID;
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(sent(api.waterBodies.setWeatherSamplePoints)).toHaveLength(2));
    expect(sent(api.waterBodies.setWeatherSamplePoints)[1]?.args.expected).toEqual(first);
  });

  it('keeps the grid when the save is refused, and says why in a toast', async () => {
    mocks.answer[getFunctionName(api.waterBodies.setWeatherSamplePoints)] = () => {
      throw new ConvexError('Someone changed this body’s weather sample points meanwhile');
    };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Suggest a grid' }));
    await user.click(within(task()).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(JSON.stringify(toasts)).toMatch(/changed this body/);
    expect(task()).toBeVisible();
    expect(mocks.claim).not.toBeNull();
  });

  it('Discard and Esc both let the grid go, saving nothing', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Suggest a grid' }));
    await user.click(within(task()).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('group', { name: /Suggested/ })).toBeNull();
    expect(mocks.claim).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Suggest a grid' }));
    expect(mocks.claim).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(mocks.claim).toBeNull();
    expect(mocks.writes).toEqual([]);
  });

  it('Clear sends no points, expecting the ones shown, with Undo', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(sent(api.waterBodies.setWeatherSamplePoints)).toHaveLength(1));
    expect(sent(api.waterBodies.setWeatherSamplePoints)[0]?.args).toEqual({
      waterBodyId: MASCOMA_ID,
      points: [],
      expected: STORED,
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Sample points cleared' }),
      ),
    );
  });

  it('with no points set by hand there is nothing to clear', async () => {
    record();
    render(<Mounted />);
    expect(await screen.findByRole('button', { name: 'Suggest a grid' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('a viewer who can’t edit the water is offered none of it', async () => {
    mocks.denied = new Set(['body.water']);
    render(<Mounted />);
    expect(await screen.findByText(/Weather sample point/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Suggest a grid|Clear/ })).toBeNull();
  });
});
