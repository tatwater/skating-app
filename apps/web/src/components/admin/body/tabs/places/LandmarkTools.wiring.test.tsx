import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The landmark tools through the real Body console route** (B01-6b): only the router, the role,
 * the Convex hooks, the undo shell's announce, the toast queue, the map's canvas and the map's engine
 * stood in — the engine's claim is captured, so a test plays the map's part (a click or a drag's
 * release is `onPick`). A drop sends `landmarks.create` with the card's fields and the point picked,
 * and lights the new landmark; an emailed name and a skater's proposal arrive filled and send their
 * ask; an Inbox ask arrives by the address and goes back once saved; a move saves each pick and
 * keeps the tool; a removal asks its reason; each control is offered only with its capabilities.
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
  useRouterState: () => '/admin/body',
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
import type { LatLng } from '@skating/core';
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

const DAM: LatLng = { lat: 43.6497, lng: -72.1798 };
const SPOT: LatLng = { lat: 43.64536, lng: -72.16689 };
const FLATS: LatLng = { lat: 43.6468, lng: -72.1787 };
const INBOX = '/admin/inbox?lane=places&item=rq2';

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
  mocks.search = { tab: 'places' };
  mocks.denied = new Set();
  mocks.writes = [];
  mocks.answer = { [getFunctionName(api.landmarks.create)]: () => 'lm-new' };
  mocks.announce.mockClear();
  mocks.navigate.mockClear();
  mocks.push.mockClear();
  mocks.claim = null;
  toasts.length = 0;
  set(api.waterBodies.get, { available: true, body: { ...MASCOMA_RECORD, bbox: undefined } });
  set(
    api.subAreas.listForBody,
    MASCOMA_SUB_AREAS.map((s) => ({ ...s, polygon: MASCOMA_RECORD.polygon })),
  );
  set(api.bodyConsole.bayProvenance, MASCOMA_BAY_PROVENANCE);
  set(api.landmarks.listForEditor, [
    {
      _id: 'lm-dam',
      name: 'Mascoma Lake Dam',
      kind: 'dam',
      point: DAM,
      aliases: [],
      source: 'osm',
      externalIds: ['osm:way/768393630'],
    },
  ]);
  set(api.bodyConsole.landmarkProvenance, []);
  set(api.bodyConsole.landmarkProposers, []);
  set(api.putIns.listForBody, []);
  set(api.accessPoints.accessForBody, { putIns: [], parking: [], blockedIds: [], alerts: [] });
  set(api.corpusRequests.openBayRequestsForBody, { bays: [], more: false });
  set(api.corpusPlaceNames.openForBody, {
    names: [{ _id: 'pn1', name: 'the Narrows', aliases: ['Mascoma Narrows'], messages: 12 }],
    more: false,
  });
  set(api.corpusRequests.openLandmarkRequestsForBody, {
    proposals: [
      {
        requestId: 'rq1',
        requestIds: ['rq1', 'rq2'],
        name: 'the flats by the dam',
        aliases: ['Dam flats'],
        coord: FLATS,
        askers: 2,
        reportIds: [],
        createdAt: 1,
      },
    ],
    more: false,
  });
  set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, touchingBodyIds: [], touching: [] });
  set(api.bodyConsole.history, { entries: [], capped: false });
});

const card = () => screen.getByRole('region', { name: 'Back to landmarks' });
const claim = () => {
  if (mocks.claim === null) throw new Error('no tool is held');
  return mocks.claim;
};
/** Plays the map's part: a click there, or a drag of the mark let go there. */
const pick = (p: LatLng) =>
  act(() => {
    const e = claim().engine;
    if (e.kind !== 'point') throw new Error(`the map holds ${e.kind}, not a point`);
    e.onPick(p);
  });
const chooseKind = async (user: ReturnType<typeof userEvent.setup>, kind: string) => {
  await user.click(within(card()).getByRole('combobox', { name: 'Kind' }));
  await user.click(await screen.findByRole('option', { name: kind }));
};

describe('dropping a landmark', () => {
  it('a click places it, the save sends the fields and the point, and the new one is lit', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Drop a landmark/ }));
    expect(within(card()).getByText('A new landmark')).toBeVisible();
    expect(claim()).toMatchObject({ mode: 'Landmark mode', line: 'Click the map where it is.' });
    expect(claim().engine).toEqual({ kind: 'point', onPick: expect.any(Function) });
    const add = within(card()).getByRole('button', { name: /Add to the map/ });
    expect(add).toBeDisabled();
    await user.type(within(card()).getByRole('textbox', { name: 'Name' }), 'Shaker cove');
    await chooseKind(user, 'Bay');
    pick(SPOT);
    // The point as it stands rides the claim, so a map re-created mid-task puts it back.
    expect(claim().engine).toMatchObject({ kind: 'point', point: SPOT });
    expect(within(card()).getByText('43.6454, −72.1669')).toBeVisible();
    await user.click(add);
    await waitFor(() => expect(sent(api.landmarks.create)).toHaveLength(1));
    expect(sent(api.landmarks.create)[0]?.args).toEqual({
      waterBodyId: MASCOMA_ID,
      name: 'Shaker cove',
      kind: 'bay',
      point: SPOT,
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Added · Shaker cove',
          target: { targetType: 'bodyLandmark', targetId: 'lm-new' },
        }),
      ),
    );
    await waitFor(() => expect(mocks.claim).toBeNull());
    expect(screen.queryByRole('region', { name: 'Back to landmarks' })).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ lit: 'landmark:lm-new' }) }),
    );
  });

  it('L starts a drop, and ⏎ in the name saves it', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await screen.findByRole('button', { name: /Drop a landmark/ });
    await user.click(screen.getByRole('button', { name: /Drop a landmark/ }));
    await user.click(within(card()).getByRole('button', { name: /Back to landmarks/ }));
    expect(mocks.claim).toBeNull();
    screen.getByRole('button', { name: /Drop a landmark/ }).focus();
    await user.keyboard('l');
    expect(claim().engine.kind).toBe('point');
    await user.type(within(card()).getByRole('textbox', { name: 'Name' }), 'Gull rock');
    await chooseKind(user, 'Island');
    pick(SPOT);
    await user.type(within(card()).getByRole('textbox', { name: 'Name' }), '{Enter}');
    await waitFor(() => expect(sent(api.landmarks.create)).toHaveLength(1));
  });

  it('keeps the card when the save is refused, and says why in a toast', async () => {
    mocks.answer[getFunctionName(api.landmarks.create)] = () => {
      throw new ConvexError('That is the same place as Mascoma Lake Dam');
    };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Drop a landmark/ }));
    await user.type(within(card()).getByRole('textbox', { name: 'Name' }), 'Dam');
    await chooseKind(user, 'Dam');
    pick(DAM);
    await user.click(within(card()).getByRole('button', { name: /Add to the map/ }));
    await waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(JSON.stringify(toasts)).toMatch(/same place as Mascoma Lake Dam/);
    expect(card()).toBeVisible();
    expect(mocks.claim).not.toBeNull();
  });

  it('Esc on the map and Back on the card both leave without writing', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /Drop a landmark/ }));
    await user.click(within(card()).getByRole('button', { name: /Back to landmarks/ }));
    expect(mocks.claim).toBeNull();
    await user.click(screen.getByRole('button', { name: /Drop a landmark/ }));
    expect(mocks.claim).not.toBeNull();
    act(() => claim().onExit());
    expect(mocks.claim).toBeNull();
    expect(screen.queryByRole('region', { name: 'Back to landmarks' })).toBeNull();
    expect(mocks.writes).toEqual([]);
  });

  it('a viewer who can’t place landmarks is offered none of the tools', async () => {
    mocks.denied = new Set(['body.places']);
    render(<Mounted />);
    await screen.findByText('Mascoma Lake Dam');
    expect(screen.queryByRole('button', { name: /Drop a landmark/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Place it' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });
});

describe('placing what was asked', () => {
  it('an emailed name: the card filled, the save sends the name it places', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Place it' }));
    expect(within(card()).getByText('A name from the emails')).toBeVisible();
    expect(within(card()).getByRole('textbox', { name: 'Name' })).toHaveValue('the Narrows');
    await chooseKind(user, 'Narrows');
    pick(SPOT);
    await user.click(within(card()).getByRole('button', { name: /Add to the map/ }));
    await waitFor(() => expect(sent(api.landmarks.create)).toHaveLength(1));
    expect(sent(api.landmarks.create)[0]?.args).toMatchObject({
      name: 'the Narrows',
      aliases: ['Mascoma Narrows'],
      corpusNameId: 'pn1',
      point: SPOT,
    });
    expect(sent(api.landmarks.create)[0]?.args).not.toHaveProperty('requestId');
  });

  it('a skater’s proposal: placed where they put it, placed again by a click, sent with its ask', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    expect(within(card()).getByText('A skater’s proposal')).toBeVisible();
    expect(claim().engine).toMatchObject({ kind: 'point', point: FLATS });
    expect(claim().focus).toEqual({ point: FLATS });
    await chooseKind(user, 'Point');
    pick(SPOT);
    await user.click(within(card()).getByRole('button', { name: /Add to the map/ }));
    await waitFor(() => expect(sent(api.landmarks.create)).toHaveLength(1));
    expect(sent(api.landmarks.create)[0]?.args).toMatchObject({
      name: 'the flats by the dam',
      aliases: ['Dam flats'],
      requestId: 'rq1',
      point: SPOT,
    });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('each is offered only with the capability its ask is decided under', async () => {
    mocks.denied = new Set(['corpus.placeNames', 'inbox.request']);
    render(<Mounted />);
    await screen.findByRole('button', { name: /Drop a landmark/ });
    expect(screen.queryByRole('button', { name: 'Place it' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });
});

describe('an Inbox landmark ask arriving', () => {
  it('arrives filled by the ask’s own id; its save sends that ask and goes back to the Inbox', async () => {
    mocks.search = { tab: 'places', landmarkAsk: 'rq2', from: INBOX };
    const user = userEvent.setup();
    render(<Mounted />);
    const box = await screen.findByRole('region', { name: 'Back to landmarks' });
    expect(within(box).getByText(/answers all 2 skaters who asked/)).toBeVisible();
    expect(within(box).getByRole('textbox', { name: 'Name' })).toHaveValue('the flats by the dam');
    expect(claim().engine).toMatchObject({ kind: 'point', point: FLATS });
    // Taken once: the address drops it.
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
    await chooseKind(user, 'Point');
    await user.click(within(box).getByRole('button', { name: /Add to the map/ }));
    await waitFor(() => expect(sent(api.landmarks.create)).toHaveLength(1));
    expect(sent(api.landmarks.create)[0]?.args).toMatchObject({ requestId: 'rq2', point: FLATS });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(INBOX));
  });

  it('asks for the ask by its id, so one past the read’s bound still opens', async () => {
    mocks.search = { tab: 'places', landmarkAsk: 'rq9' };
    mocks.results.set(
      `${getFunctionName(api.corpusRequests.openLandmarkRequestsForBody)}|${JSON.stringify({
        waterBodyId: MASCOMA_ID,
        including: 'rq9',
      })}`,
      {
        proposals: [
          {
            requestId: 'rq9',
            requestIds: ['rq9'],
            name: 'Late point',
            aliases: [],
            coord: SPOT,
            askers: 1,
            reportIds: [],
            createdAt: 1,
          },
        ],
        more: true,
      },
    );
    render(<Mounted />);
    await waitFor(() => expect(mocks.claim).not.toBeNull());
    expect(within(card()).getByDisplayValue('Late point')).toBeVisible();
    expect(toasts).toEqual([]);
  });

  it('an ask no longer open says so, and arms nothing', async () => {
    mocks.search = { tab: 'places', landmarkAsk: 'rq7' };
    render(<Mounted />);
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Nothing to place'));
    expect(toasts[0]?.description).toBe('That ask isn’t open any more.');
    expect(mocks.claim).toBeNull();
  });

  it('a read that fails says so and lets the arrival go', async () => {
    mocks.search = { tab: 'places', landmarkAsk: 'rq2' };
    mocks.results.set(
      `${getFunctionName(api.corpusRequests.openLandmarkRequestsForBody)}|${JSON.stringify({
        waterBodyId: MASCOMA_ID,
        including: 'rq2',
      })}`,
      new Error('read failed'),
    );
    render(<Mounted />);
    await waitFor(() => expect(toasts.map((t) => t.title)).toContain('Nothing to place'));
    expect(toasts[0]?.description).toMatch(/couldn’t be read/);
    expect(mocks.claim).toBeNull();
  });
});

describe('a landmark on its card', () => {
  it('Move holds its point; each click or drag saves at once, and the tool stays until Esc', async () => {
    mocks.search = { tab: 'places', lit: 'landmark:lm-dam' };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /^Move/ }));
    expect(claim()).toMatchObject({
      mode: 'Landmark mode',
      line: 'Click where Mascoma Lake Dam really is, or drag it. Each move saves.',
      engine: { kind: 'point', point: DAM },
      focus: { point: DAM },
    });
    expect(screen.getByRole('button', { name: /Done moving/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    pick(SPOT);
    await waitFor(() => expect(sent(api.landmarks.update)).toHaveLength(1));
    expect(sent(api.landmarks.update)[0]?.args).toEqual({ landmarkId: 'lm-dam', point: SPOT });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Moved · Mascoma Lake Dam',
          target: { targetType: 'bodyLandmark', targetId: 'lm-dam' },
        }),
      ),
    );
    // Still moving: a second adjustment is one more pick.
    pick(FLATS);
    await waitFor(() => expect(sent(api.landmarks.update)).toHaveLength(2));
    expect(sent(api.landmarks.update)[1]?.args).toEqual({ landmarkId: 'lm-dam', point: FLATS });
    act(() => claim().onExit());
    expect(mocks.claim).toBeNull();
    expect(screen.getByRole('button', { name: /^Move/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the landmark’s point moving on the server (a move landing, an Undo) moves the mark', async () => {
    mocks.search = { tab: 'places', lit: 'landmark:lm-dam' };
    const user = userEvent.setup();
    const view = render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: /^Move/ }));
    const before = claim().session;
    set(api.landmarks.listForEditor, [
      {
        _id: 'lm-dam',
        name: 'Mascoma Lake Dam',
        kind: 'dam',
        point: SPOT,
        aliases: [],
        source: 'osm',
        externalIds: [],
      },
    ]);
    view.rerender(<Mounted />);
    await waitFor(() => expect(claim().session).not.toBe(before));
    expect(claim().engine).toMatchObject({ point: SPOT });
    // The camera went to the landmark once; a later move doesn't take it there again.
    expect(claim().focus).toBeNull();
  });

  it('Remove asks its reason and sends it; the receipt names the landmark', async () => {
    mocks.search = { tab: 'places', lit: 'landmark:lm-dam' };
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'A second label for the dam');
    await user.click(within(dialog).getByRole('button', { name: /^Remove/ }));
    await waitFor(() => expect(sent(api.landmarks.remove)).toHaveLength(1));
    expect(sent(api.landmarks.remove)[0]?.args).toEqual({
      landmarkId: 'lm-dam',
      reason: 'A second label for the dam',
    });
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Removed · Mascoma Lake Dam',
          target: { targetType: 'bodyLandmark', targetId: 'lm-dam' },
        }),
      ),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.not.objectContaining({ lit: expect.anything() }) }),
    );
  });
});
