import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

/**
 * The Body console as the app mounts it at `/admin/body/$id`: the body and the frame's reads (each
 * block saying so in its own place when its read fails), the tab and the return path from the
 * validated search, the map's own instance (replaced here by a still, since jsdom has no WebGL),
 * and a body the reads can't serve drawn as its own honest page. Mocked at the Convex hook boundary.
 */

const mocks = vi.hoisted(() => ({
  /** Each read's answer: by `name|args` first, else by name. */
  results: new Map<string, unknown>(),
  /** The reads asked for, as `name|args`, across every render. */
  asked: [] as string[],
  params: { id: 'j57mascoma0000000000000000000000' } as Record<string, string>,
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  push: vi.fn(),
  can: true,
  /** Capabilities this viewer lacks, beside `can`. */
  denied: new Set<string>(),
  /** The viewer's role still on its way (`can` says no until it lands). */
  roleLoading: false,
  mutate: vi.fn(() => Promise.resolve()),
  announce: vi.fn(() => Promise.resolve()),
  /** Whether the map was last asked for the summer aerial. */
  aerial: false as boolean | undefined,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  const answer = (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(ref);
    const key = `${name}|${JSON.stringify(args)}`;
    mocks.asked.push(key);
    return mocks.results.has(key) ? mocks.results.get(key) : mocks.results.get(name);
  };
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === 'skip') return undefined;
      const value = answer(ref, args);
      if (value instanceof Error) throw value;
      return value;
    },
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, answer(q.query, q.args)])),
    useMutation: () => mocks.mutate,
  };
});
vi.mock('@tanstack/react-router', () => ({
  useParams: () => mocks.params,
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { push: mocks.push } }),
  Link: ({
    to,
    params,
    search,
    children,
    className,
    onClick,
  }: {
    to: string;
    params?: { id: string };
    search?: { from?: string };
    children?: ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <a
      href={to.replace('$id', params?.id ?? '')}
      data-from={search?.from}
      className={className}
      onClick={onClick}
    >
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({
    can: (c: string) => mocks.can && !mocks.denied.has(c),
    isLoading: mocks.roleLoading,
  }),
}));
vi.mock('../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
const toasts = vi.hoisted(() => [] as { title: string; description?: string }[]);
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: { title: string; description?: string }) => toasts.push(t),
}));
vi.mock('../map/useBodyMapCanvas', () => ({
  FIT_PADDING: { top: 0, right: 0, bottom: 0, left: 0 },
  useBodyMapCanvas: (options: { aerial?: boolean }) => {
    mocks.aerial = options.aerial;
    return {
      ground: <div data-testid="ground" />,
      surface: null,
      zoomIn: () => {},
      zoomOut: () => {},
      atMinZoom: false,
      atMaxZoom: false,
      aerialCredit: options.aerial ? 'Aerial · NAIP' : null,
      liveMap: () => null,
    };
  },
}));

import { api } from '@skating/convex/api';
import { CAPABILITIES } from '@skating/core';
import { getFunctionName } from 'convex/server';
import { resetConsoleReads } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { readOpened } from '../../bodies/openedRecently';
import { AERIAL_KEY } from '../map/aerialSwitch';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { ListWritersProvider } from '../tabs/listWriter';
import { SHAPE_TAB } from '../tabs/shape/ShapeTabRoute';
import { BodyConsoleRoute } from './BodyConsoleRoute';
import {
  MASCOMA_BAY_PROVENANCE,
  MASCOMA_EXTRAS,
  MASCOMA_HISTORY,
  MASCOMA_ID,
  MASCOMA_RECORD,
  MASCOMA_SUB_AREAS,
  NEIGHBOR_ID,
  NEIGHBOR_POLYGON,
  on,
  REMOVAL_NOTE_NEAR_CAP,
  REMOVAL_SENTENCE_SHORTENED,
} from './bodyFixtures';
import type { HistoryAction } from './bodyModel';
import { registerBodyTabs } from './tabRegistry';

type Ref = Parameters<typeof getFunctionName>[0];
const set = (ref: Ref, value: unknown, args?: unknown) =>
  mocks.results.set(
    args === undefined ? getFunctionName(ref) : `${getFunctionName(ref)}|${JSON.stringify(args)}`,
    value,
  );
const askedFor = (ref: Ref): string[] =>
  mocks.asked
    .filter((k) => k.startsWith(`${getFunctionName(ref)}|`))
    .map((k) => k.slice(k.indexOf('|') + 1));

function Mounted({ children }: { children?: ReactNode }) {
  // The whole-list queues sit above the route, as the admin shell mounts them.
  return (
    <ListWritersProvider>
      <KeysProvider>{children ?? <BodyConsoleRoute />}</KeysProvider>
    </ListWritersProvider>
  );
}

const historyRow = (h: (typeof MASCOMA_HISTORY)[number]) => ({
  ...h,
  reason: h.reason ?? '',
  undo: { state: 'unavailable', why: '' },
});

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  // The read layer's registry is module-wide: a Try again in one test never pauses the next.
  resetConsoleReads();
  mocks.results.clear();
  mocks.asked.length = 0;
  mocks.search = {};
  mocks.params = { id: MASCOMA_ID };
  mocks.can = true;
  mocks.denied = new Set();
  mocks.roleLoading = false;
  mocks.navigate.mockReset();
  mocks.push.mockReset();
  mocks.mutate.mockClear();
  set(api.waterBodies.get, {
    available: true,
    body: { ...MASCOMA_RECORD, lastCampaignId: 'a07a-20261012', bbox: undefined },
  });
  set(
    api.subAreas.listForBody,
    MASCOMA_SUB_AREAS.map((s) => ({ ...s, polygon: MASCOMA_RECORD.polygon })),
  );
  set(api.bodyConsole.bayProvenance, MASCOMA_BAY_PROVENANCE);
  set(api.landmarks.listForEditor, [
    {
      _id: 'lm1',
      name: 'Relham Island',
      kind: 'island',
      point: { lat: 43.629, lng: -72.141 },
      source: 'osm',
    },
    {
      _id: 'lm2',
      name: 'Gone',
      kind: 'point',
      point: { lat: 43.62, lng: -72.14 },
      source: 'osm',
      removedAt: 1,
    },
  ]);
  set(api.putIns.listForBody, [
    { id: 'p1', coord: { lat: 43.631, lng: -72.157 }, source: 'official' },
  ]);
  set(api.accessPoints.accessForBody, {
    putIns: [],
    parking: [{ id: 'l1', coord: { lat: 43.631, lng: -72.156 } }],
    blockedIds: [],
    alerts: [],
  });
  set(api.corpusRequests.openBayRequestsForBody, {
    bays: [
      { requestId: 'r1', name: 'Shaker cove', askers: 3, createdAt: 1, notes: [], aliases: [] },
    ],
    more: false,
  });
  set(api.corpusPlaceNames.openForBody, { names: [], more: false });
  set(api.corpusRequests.openLandmarkRequestsForBody, { proposals: [], more: false });
  set(api.bodyConsole.consoleExtras, MASCOMA_EXTRAS);
  set(api.bodyConsole.history, { entries: MASCOMA_HISTORY.map(historyRow), capped: false });
});

describe('BodyConsoleRoute', () => {
  it('draws the body from its reads, on Shape', () => {
    render(<Mounted />);
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Shape/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('OpenStreetMap')).toBeInTheDocument();
    expect(screen.getByText('Mascoma North')).toBeInTheDocument();
    expect(screen.getAllByText('Seeded · 2 Sep · Teagan')).toHaveLength(2);
    expect(screen.getByRole('option', { name: /Shaker cove/ })).toBeInTheDocument();
    // The family's history: the body's own rows and a landmark's, with an exact count (whole).
    expect(screen.getByText('Ruled on public access')).toBeInTheDocument();
    expect(screen.getByText('Edited a landmark')).toBeInTheDocument();
    expect(screen.getByText('6 changes')).toBeInTheDocument();
    // The frame's extras: the towns and the outline's trust.
    expect(screen.getByText('Enfield, NH')).toBeInTheDocument();
    expect(screen.getByText('Since 12 Oct 2026')).toBeInTheDocument();
    // Completeness is the stored answer: 9 / 10, bathymetry missing, Water flagged.
    expect(screen.getByText('Missing bathymetry')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Water/ })).toHaveTextContent('Missing something');
    // Nothing touches Mascoma: no merge block.
    expect(screen.queryByRole('heading', { name: 'Merge into another body' })).toBeNull();
    // The map draws the live landmarks only.
    expect(screen.queryByText('Gone')).toBeNull();
  });

  it('reads the family’s history and the stored completeness with the body', () => {
    render(<Mounted />);
    expect(askedFor(api.bodyConsole.history)).toContain(
      JSON.stringify({ waterBodyId: MASCOMA_ID, limit: 50 }),
    );
    // Completeness rides on the extras now: the preview and its report scan are never asked.
    expect(askedFor(api.bodies.preview)).toEqual([]);
    // The main read was whole and held the ruling: no read of the one verb.
    expect(askedFor(api.bodyConsole.history).some((a) => a.includes('action'))).toBe(false);
  });

  it('says *Not recorded yet* for a body with no stored completeness — never a guess', () => {
    set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, complete: null });
    render(<Mounted />);
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
    expect(screen.queryByRole('meter', { name: /Complete/ })).toBeNull();
    expect(screen.queryByText('Missing something')).toBeNull();
  });

  it('never draws a capped history as whole, and reads who ruled on the body alone when it fell off', () => {
    const boost = MASCOMA_HISTORY.find((h) => h.action === 'set_curated_boost');
    set(api.bodyConsole.history, {
      entries: [historyRow(MASCOMA_HISTORY[0] as never), historyRow(boost as never)],
      capped: true,
    });
    const rulingArgs = {
      waterBodyId: MASCOMA_ID,
      action: 'set_public_access',
      bodyOnly: true,
      limit: 10,
    };
    const ruling = MASCOMA_HISTORY.find((h) => h.action === 'set_public_access') as HistoryAction;
    set(
      api.bodyConsole.history,
      {
        entries: [
          // A body merged into this one, ruled on later than this body was: its row comes first.
          historyRow({
            ...ruling,
            id: 'absorbed-ruling',
            targetId: NEIGHBOR_ID,
            createdAt: ruling.createdAt + 1,
            actor: { displayName: 'Pat Q', username: 'p' },
          }),
          historyRow({ ...ruling, actor: { displayName: 'Sarah B', username: 's' } }),
        ],
        capped: true,
      },
      rulingArgs,
    );
    render(<Mounted />);
    expect(screen.getByText('Latest 2')).toBeInTheDocument();
    expect(screen.getByText('More history exists than is shown here.')).toBeInTheDocument();
    // Who ruled is the body's own latest ruling, read on the body alone (`bodyOnly`) — read past
    // its first row, which can be an absorbed body's own.
    expect(askedFor(api.bodyConsole.history)).toContain(JSON.stringify(rulingArgs));
    expect(screen.getByText('Sarah')).toBeInTheDocument();
    expect(screen.queryByText('Pat')).toBeNull();
    // The boost's row was in the main read: no read of that verb.
    expect(askedFor(api.bodyConsole.history).some((x) => x.includes('set_curated_boost'))).toBe(
      false,
    );
  });

  it('says in its own place each read that failed, and tries it again', async () => {
    const user = userEvent.setup();
    set(api.bodyConsole.history, new Error('history down'));
    set(api.subAreas.listForBody, new Error('bays down'));
    set(api.accessPoints.accessForBody, new Error('lots down'));
    render(<Mounted />);
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(screen.getByText('The history couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('The bays couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('The map couldn’t read the bays and the lots')).toBeInTheDocument();
    mocks.asked.length = 0;
    set(api.bodyConsole.history, { entries: [], capped: false });
    const note = screen
      .getByText('The history couldn’t be read')
      .closest('[data-slot="retry-note"]');
    await user.click(within(note as HTMLElement).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing recorded')).toBeInTheDocument();
    expect(askedFor(api.bodyConsole.history).length).toBeGreaterThan(0);
  });

  it('says the map couldn’t read the bodies that touch it when the extras failed', () => {
    set(api.bodyConsole.consoleExtras, new Error('extras down'));
    render(<Mounted />);
    expect(screen.getByText('The map couldn’t read the bodies that touch it')).toBeInTheDocument();
  });

  it('remembers, in this browser only, that the body was opened', () => {
    window.localStorage.clear();
    const id = 'k17mascoma00000000000000000000000';
    mocks.params = { id };
    set(api.waterBodies.get, { available: true, body: { ...MASCOMA_RECORD, _id: id } });
    render(<Mounted />);
    expect(readOpened()).toEqual([id]);
  });

  it('opens the tab the URL names, and a slot with no tab says so', () => {
    mocks.search = { tab: 'water', lit: 'not valid' };
    // A registry with Shape alone, so the Water slot is empty whatever the console has built.
    render(
      <Mounted>
        <BodyConsoleRoute registry={registerBodyTabs({ shape: SHAPE_TAB })} />
      </Mounted>,
    );
    expect(screen.getByRole('tab', { name: /Water/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Water isn’t in the console yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Old editor →' })).toHaveAttribute(
      'href',
      `/admin/water/${MASCOMA_ID}`,
    );
  });

  it('says so in the tab’s place when a tab throws, and tries it again', async () => {
    const user = userEvent.setup();
    let throws = true;
    function Throwing(): ReactNode {
      if (throws) throw new Error('tab down');
      return <p>Names drawn</p>;
    }
    // React logs the error the boundary caught; this test means it.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    mocks.search = { tab: 'names' };
    render(
      <Mounted>
        <BodyConsoleRoute registry={registerBodyTabs({ names: { Wiring: Throwing } })} />
      </Mounted>,
    );
    expect(screen.getByText('Names couldn’t be shown')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
    throws = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Names drawn')).toBeInTheDocument();
  });

  it('keeps the return path when the tab changes, and goes back to it on ⇧⏎', async () => {
    const user = userEvent.setup();
    mocks.search = { from: '/admin/corpus?q=mascoma' };
    render(<Mounted />);
    await user.click(screen.getByRole('tab', { name: /Names/ }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '.',
        search: { tab: 'names', from: '/admin/corpus?q=mascoma' },
      }),
    );
    screen.getByRole('tab', { name: /Shape/ }).focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(mocks.push).toHaveBeenCalledWith('/admin/corpus?q=mascoma');
  });

  it('goes back to the list on ⇧⏎ from a bay row, without lighting the bay', async () => {
    const user = userEvent.setup();
    mocks.search = { from: '/admin/corpus?q=mascoma' };
    const { container } = render(<Mounted />);
    container.querySelector<HTMLElement>('[data-id="bay:bay-north"]')?.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(mocks.push).toHaveBeenCalledWith('/admin/corpus?q=mascoma');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('gives a moderator the summer aerial on every tab, kept across tabs, bodies and visits', async () => {
    // A moderator: every capability an admin alone holds is refused. The switch is console staff's,
    // gated by nothing past the console itself.
    mocks.denied = new Set(
      Object.entries(CAPABILITIES)
        .filter(([, rule]) => rule.role === 'admin')
        .map(([name]) => name),
    );
    window.localStorage.removeItem(AERIAL_KEY);
    const user = userEvent.setup();
    const { rerender, unmount } = render(<Mounted />);
    const aerial = () => screen.getByRole('switch', { name: /Summer aerial/ });
    expect(aerial()).not.toBeChecked();
    expect(mocks.aerial).toBe(false);
    await user.click(aerial());
    expect(aerial()).toBeChecked();
    expect(mocks.aerial).toBe(true);
    expect(screen.getByText('Aerial · NAIP')).toBeInTheDocument();
    expect(window.localStorage.getItem(AERIAL_KEY)).toBe('on');
    // Another tab puts the scene's switches back, never this one.
    mocks.search = { tab: 'names' };
    rerender(<Mounted />);
    expect(aerial()).toBeChecked();
    // Another visit finds it on.
    unmount();
    render(<Mounted />);
    expect(aerial()).toBeChecked();
    await user.click(aerial());
    expect(window.localStorage.getItem(AERIAL_KEY)).toBeNull();
  });

  it('puts the map’s switches back for a new body on the same tab, though it opens at once', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Mounted />);
    const putIns = () => screen.getByRole('switch', { name: /Put-ins/ });
    await user.click(putIns());
    expect(putIns()).not.toBeChecked();
    // The neighbor was already read (for Merge's name), so the console never shows it loading.
    set(
      api.waterBodies.get,
      {
        available: true,
        body: { ...MASCOMA_RECORD, _id: NEIGHBOR_ID, name: 'Mascoma North Pond', bbox: undefined },
      },
      { waterBodyId: NEIGHBOR_ID },
    );
    mocks.params = { id: NEIGHBOR_ID };
    rerender(<Mounted />);
    expect(putIns()).toBeChecked();
  });

  it('a new body opening at once remounts the open tab and the left column — nothing of the last body carries', async () => {
    // Shape has no draft of its own (its ways aren't built), so this holds the frame's own rule:
    // the tab's subtree and the left column are the body's, keyed by it (`BodyTabHost`).
    const { rerender } = render(<Mounted />);
    const panelNode = () => screen.getByRole('tabpanel').firstElementChild;
    const before = panelNode();
    const slider = screen.getByRole('slider', { name: 'Map boost' });
    set(
      api.waterBodies.get,
      {
        available: true,
        body: { ...MASCOMA_RECORD, _id: NEIGHBOR_ID, name: 'Mascoma North Pond', bbox: undefined },
      },
      { waterBodyId: NEIGHBOR_ID },
    );
    mocks.params = { id: NEIGHBOR_ID };
    rerender(<Mounted />);
    expect(panelNode()).not.toBe(before);
    expect(screen.getByRole('slider', { name: 'Map boost' })).not.toBe(slider);
  });

  it('opens an ask on its tab with it lit', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(screen.getByRole('option', { name: /Shaker cove/ }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { lit: 'ask:r1' } }),
    );
  });

  it('offers the merge when another body touches this one, named from the extras — no read of its own', () => {
    set(api.bodyConsole.consoleExtras, {
      ...MASCOMA_EXTRAS,
      touchingBodyIds: [NEIGHBOR_ID],
      touching: [
        { waterBodyId: NEIGHBOR_ID, name: 'Crystal Lake', ring: NEIGHBOR_POLYGON.coordinates[0] },
      ],
    });
    mocks.search = { from: '/admin/corpus?lane=inactive' };
    render(<Mounted />);
    const merge = screen.getByRole('region', { name: 'Merge into another body' });
    expect(within(merge).getByText('Crystal Lake')).toBeInTheDocument();
    const open = within(merge).getByRole('link', { name: 'Open →' });
    expect(open).toHaveAttribute('href', `/admin/body/${NEIGHBOR_ID}`);
    expect(askedFor(api.waterBodies.get).some((a) => a.includes(NEIGHBOR_ID))).toBe(false);
    // The neighbor opens with this body's way back: to the list the operator came from.
    expect(open).toHaveAttribute('data-from', '/admin/corpus?lane=inactive');
  });

  it('says a broken link is broken, without reading anything for a malformed id', () => {
    set(api.waterBodies.get, null);
    const { unmount } = render(<Mounted />);
    expect(screen.getByText(/No such body/)).toBeInTheDocument();
    unmount();
    mocks.asked.length = 0;
    mocks.params = { id: 'not an id' };
    render(<Mounted />);
    expect(screen.getByText(/No such body/)).toBeInTheDocument();
    expect(mocks.asked.filter((k) => !k.startsWith('waterBodies:get|{"waterBodyId":"j'))).toEqual(
      [],
    );
  });

  it('says the body couldn’t be read when its own read fails, and reads it again', async () => {
    const user = userEvent.setup();
    set(api.waterBodies.get, new Error('down'));
    render(<Mounted />);
    expect(screen.getByText('This body couldn’t be read')).toBeInTheDocument();
    set(api.waterBodies.get, {
      available: true,
      body: { ...MASCOMA_RECORD, lastCampaignId: 'a07a-20261012' },
    });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
  });

  const removedFacts = (by: { displayName: string } | null) => ({
    id: MASCOMA_ID,
    name: 'Mascoma Lake',
    bodyClass: 'lakePond',
    states: ['NH'],
    areaSqM: 4_623_575,
    standing: 'removed',
    left: {
      action: 'remove',
      at: on(10, 2),
      // The composed sentence, shortened under the cap; the note is what was typed, whole.
      reason: REMOVAL_SENTENCE_SHORTENED,
      note: REMOVAL_NOTE_NEAR_CAP,
      removalReason: 'landowner_request',
      by,
    },
    towns: [{ name: 'Enfield', state: 'NH' }],
    reports: { count: 3, capped: false },
  });

  it.each([
    ['with', new Set<string>()],
    ['without', new Set(['audit.read'])],
  ])(
    'draws how a removed body left exactly as removedFacts serves it, %s audit.read',
    (_, denied) => {
      mocks.denied = denied;
      set(api.waterBodies.get, { available: false });
      set(api.bodyConsole.removedFacts, removedFacts({ displayName: 'Teagan Atwater' }));
      set(api.bodyConsole.history, { entries: [], capped: false });
      render(<Mounted />);
      const row = document.querySelector('[data-slot="body-gone-removal"]') as HTMLElement;
      expect(row).toHaveTextContent('2 Oct 2026');
      expect(row).toHaveTextContent('Teagan');
      expect(row).toHaveTextContent('Landowner request');
      expect(row).toHaveTextContent(`“${REMOVAL_NOTE_NEAR_CAP}”`);
      expect(row).not.toHaveTextContent('Removed from map');
      // History is the audit trail's alone.
      expect(screen.queryByRole('heading', { name: 'History' }) === null).toBe(denied.size > 0);
    },
  );

  it('draws no one where the server withholds who decided — never “not recorded”', () => {
    mocks.denied = new Set(['audit.read']);
    set(api.waterBodies.get, { available: false });
    set(api.bodyConsole.removedFacts, removedFacts(null));
    render(<Mounted />);
    const row = document.querySelector('[data-slot="body-gone-removal"]') as HTMLElement;
    expect(row).toHaveTextContent('2 Oct 2026');
    expect(row).not.toHaveTextContent('Teagan');
    expect(row).not.toHaveTextContent(/Not recorded/);
  });

  it('says a rejected body has been removed, and what the record still holds', () => {
    set(api.waterBodies.get, { available: false });
    // What the record still holds (`bodyConsole.removedFacts`).
    set(api.bodyConsole.removedFacts, {
      id: MASCOMA_ID,
      name: 'Mascoma Lake',
      bodyClass: 'lakePond',
      states: ['NH'],
      areaSqM: 4_623_575,
      standing: 'rejected',
      left: {
        action: 'reject_waterbody',
        at: on(10, 2),
        reason: 'Drawn over the town beach',
        removalReason: null,
        note: null,
        by: { displayName: 'Teagan Atwater' },
      },
      towns: [
        { name: 'Enfield', state: 'NH' },
        { name: 'Lebanon', state: 'NH' },
      ],
      reports: { count: 42, capped: false },
    });
    set(api.bodyConsole.history, {
      entries: [
        {
          id: 'rej',
          action: 'reject_waterbody',
          targetType: 'waterbody',
          targetId: MASCOMA_ID,
          reason: 'Drawn over the town beach',
          createdAt: on(10, 2),
          actor: { displayName: 'Teagan Atwater', username: 'teagan', userId: 't' },
          undo: { state: 'unavailable', why: '' },
        },
      ],
      capped: false,
    });
    render(<Mounted />);
    expect(screen.getByText(/This body has been removed/)).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('2 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('“Drawn over the town beach”')).toBeInTheDocument();
    expect(screen.getByText('Enfield, NH')).toBeInTheDocument();
    expect(screen.getByText('42 since the record began')).toBeInTheDocument();
    // Never an empty console.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText(/No body open/)).toBeNull();
  });

  it('says a merged body was merged, and opens the body that took it in', () => {
    const survivor = 'k57survivor000000000000000000000';
    set(api.waterBodies.get, {
      available: true,
      body: { ...MASCOMA_RECORD, _id: survivor, name: 'Mascoma Lake' },
    });
    set(api.bodyConsole.history, { entries: [], capped: false });
    render(<Mounted />);
    expect(screen.getByText(/This body was merged into/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Mascoma Lake' })).toHaveAttribute(
      'href',
      `/admin/body/${survivor}`,
    );
    expect(screen.getByText('The history read doesn’t say when or by whom')).toBeInTheDocument();
    // A merged body's facts went with it: none are read as its own.
    expect(screen.queryByText(/since the record began/)).toBeNull();
  });

  it('holds the console’s place while the body loads', () => {
    set(api.waterBodies.get, undefined);
    const { container } = render(<Mounted />);
    expect(container.querySelector('[data-slot="body-console"]')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('leaves History out for a viewer who can’t read the audit trail, and the boost unmovable', () => {
    mocks.can = false;
    render(<Mounted />);
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
    expect(screen.getByRole('slider', { name: 'Map boost' })).toBeDisabled();
    expect(askedFor(api.bodyConsole.history)).toEqual([]);
    // What `body.read` withholds is never asked — by the frame or by Shape — and Shape draws no
    // Merge block rather than a failure.
    expect(askedFor(api.bodyConsole.consoleExtras)).toEqual([]);
    expect(askedFor(api.bodyConsole.bayProvenance)).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Merge into another body' })).toBeNull();
  });

  it('holds what the role gates as on its way while the role loads — never *Not recorded yet*', () => {
    mocks.can = false;
    mocks.roleLoading = true;
    const { container } = render(<Mounted />);
    expect(screen.queryByText('Not recorded yet')).toBeNull();
    expect(container.querySelector('[data-slot="body-complete"][aria-busy="true"]')).not.toBeNull();
    // History is on its way too, not withheld.
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
  });

  it.each([
    ['the place names', api.corpusPlaceNames.openForBody, { names: [], more: true }],
    ['the bay requests', api.corpusRequests.openBayRequestsForBody, { bays: [], more: true }],
    [
      'the landmark proposals',
      api.corpusRequests.openLandmarkRequestsForBody,
      { proposals: [], more: true },
    ],
  ])('never counts the asks as whole when %s say more exist', (_what, fn, answer) => {
    set(fn, answer);
    const { container } = render(<Mounted />);
    expect(container.querySelector('[data-slot="body-asks-more"]')).not.toBeNull();
  });

  it('counts the asks as whole when every read says it holds them all', () => {
    const { container } = render(<Mounted />);
    expect(container.querySelector('[data-slot="body-asks-more"]')).toBeNull();
  });

  it('says the towns aren’t computed yet before the geometry is, and that a body is in no town', () => {
    set(api.bodyConsole.consoleExtras, {
      ...MASCOMA_EXTRAS,
      towns: null,
      touchingBodyIds: null,
      touching: null,
      geoComputedAt: null,
    });
    const { unmount } = render(<Mounted />);
    expect(screen.getByText('Not computed yet')).toBeInTheDocument();
    expect(screen.queryByText('Not recorded yet')).toBeNull();
    unmount();
    set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, towns: [], townsWithState: [] });
    render(<Mounted />);
    expect(screen.getByText('In no town')).toBeInTheDocument();
  });

  it('draws the map again on another tab when the open tab’s drawing threw', async () => {
    const user = userEvent.setup();
    // React logs the error the boundary caught; this test means it.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    const throwing = {
      Wiring: () => <p>Names drawn</p>,
      map: {
        useData: (): never => {
          throw new Error('drawing down');
        },
        describe: () => ({ items: [], lit: null }),
      },
    };
    mocks.search = { tab: 'names' };
    const { rerender } = render(
      <Mounted>
        <BodyConsoleRoute registry={registerBodyTabs({ shape: SHAPE_TAB, names: throwing })} />
      </Mounted>,
    );
    expect(screen.getByText('The map couldn’t be drawn')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Shape/ }));
    mocks.search = { tab: 'shape' };
    rerender(
      <Mounted>
        <BodyConsoleRoute registry={registerBodyTabs({ shape: SHAPE_TAB, names: throwing })} />
      </Mounted>,
    );
    expect(screen.queryByText('The map couldn’t be drawn')).toBeNull();
    expect(screen.getByTestId('ground')).toBeInTheDocument();
  });

  it('the map boost, once the record holds the value it sent, follows it and sends nothing more', async () => {
    // `setCuratedBoost` patches the body's boost (reactivating a dormant body when it rises above
    // zero): the record answers with the new value.
    const get = getFunctionName(api.waterBodies.get);
    const answer = async (args: { curatedBoost: number }) => {
      const prior = mocks.results.get(get) as { body: Record<string, unknown> };
      mocks.results.set(get, {
        available: true,
        body: { ...prior.body, curatedBoost: args.curatedBoost },
      });
    };
    mocks.mutate.mockImplementation(answer as never);
    // `mockClear` in `beforeEach` keeps an implementation: put the plain one back however this ends.
    onTestFinished(() => {
      mocks.mutate.mockImplementation(() => Promise.resolve());
    });
    const { rerender } = render(<Mounted />);
    const slider = screen.getByRole('slider', { name: 'Map boost' });
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(mocks.mutate).toHaveBeenLastCalledWith({ waterBodyId: MASCOMA_ID, curatedBoost: 0.4 });
    rerender(<Mounted />);
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'Map boost' })).toHaveAttribute(
        'aria-valuenow',
        '0.4',
      ),
    );
    // Letting go where the record already stands sends nothing (`boostToSend`, above).
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  /**
   * The save lifetime's named examples, in the real route with the real tabs (the model-based test
   * in `bodyBinding.model.test.tsx` proves it over any session): a pressed save reaches the body it
   * was composed for whatever the page does next, and its result always names that body.
   */
  describe('the binding — named examples', () => {
    const releases: ((ok: boolean) => void)[] = [];
    const hold = () => {
      releases.length = 0;
      mocks.mutate.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            releases.push((ok) => (ok ? resolve() : reject(new Error('refused'))));
          }) as never,
      );
      onTestFinished(() => {
        mocks.mutate.mockImplementation(() => Promise.resolve());
      });
    };
    const landAll = async (ok = true) => {
      toasts.length = 0;
      for (let i = 0; i < 6 && releases.length > 0; i++) {
        await act(async () => releases.shift()?.(ok));
      }
      await act(async () => new Promise((r) => setTimeout(r, 0)));
    };
    const LINKS = [
      { label: 'Mascoma Lake Association', url: 'https://mascomalake.org' },
      { label: 'Lake level at Mascoma Lake Dam', url: 'https://des.nh.gov/dams' },
    ];
    const withLinks = () =>
      set(api.waterBodies.get, {
        available: true,
        body: { ...MASCOMA_RECORD, bbox: undefined, referenceLinks: LINKS },
      });
    /** Two saves on Links: one on its way, one queued behind it. */
    const twoLinkSaves = async () => {
      const user = userEvent.setup();
      await user.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
      await user.type(screen.getByRole('textbox', { name: /Label/ }), ' (1){Enter}');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
      await user.type(screen.getByRole('textbox', { name: /Label/ }), ' (2){Enter}');
      expect(mocks.mutate).toHaveBeenCalledTimes(1);
    };
    const toNeighbor = (as: 'uncached' | 'fails') => {
      set(api.waterBodies.get, as === 'uncached' ? undefined : new Error('no such body'), {
        waterBodyId: NEIGHBOR_ID,
      });
      mocks.params = { id: NEIGHBOR_ID };
    };

    const A = { waterBodyId: MASCOMA_ID };

    it('Greptile’s sequence: two Links saves queued on A, then an uncached B — both reach A, each receipt naming A', async () => {
      withLinks();
      mocks.search = { tab: 'links' };
      hold();
      const { rerender } = render(<Mounted />);
      await twoLinkSaves();
      toNeighbor('uncached');
      rerender(<Mounted />);
      await landAll();
      expect(mocks.mutate).toHaveBeenCalledTimes(2);
      for (const [args] of mocks.mutate.mock.calls as unknown as [Record<string, unknown>][]) {
        expect(args).toMatchObject(A);
      }
      expect(mocks.announce).toHaveBeenCalledTimes(2);
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Mascoma Lake' }),
      );
    });

    it('A, then a body that fails to load: A’s refusal is said in a toast naming A — never swallowed', async () => {
      withLinks();
      mocks.search = { tab: 'links' };
      hold();
      const { rerender } = render(<Mounted />);
      await twoLinkSaves();
      toNeighbor('fails');
      rerender(<Mounted />);
      await landAll(false);
      expect(mocks.mutate).toHaveBeenCalledTimes(2);
      expect(toasts.map((t) => t.title)).toContain('Not saved · Mascoma Lake');
      expect(mocks.announce).not.toHaveBeenCalled();
    });

    it('A, out of the Bodies area, back to A: the queued save goes out once, never twice', async () => {
      withLinks();
      mocks.search = { tab: 'links' };
      hold();
      const { rerender } = render(<Mounted />);
      await twoLinkSaves();
      rerender(<p>Inbox</p>);
      rerender(<Mounted />);
      await landAll();
      expect(mocks.mutate).toHaveBeenCalledTimes(2);
      expect(mocks.announce).toHaveBeenCalledTimes(2);
    });

    it('Standing’s form: a write started on A lands on A over an uncached B, its receipt naming A', async () => {
      set(api.standing.retentionForBody, null);
      mocks.search = { tab: 'standing' };
      hold();
      const { rerender } = render(<Mounted />);
      const user = userEvent.setup();
      await user.click(screen.getByRole('radio', { name: /^Dormant/ }));
      await user.type(screen.getByRole('textbox', { name: /Note for skaters/ }), 'Dam work{Enter}');
      expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining(A));
      toNeighbor('uncached');
      rerender(<Mounted />);
      await landAll();
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Mascoma Lake' }),
      );
    });

    it('the map boost: a commit on A lands on A over an uncached B, its receipt naming A', async () => {
      hold();
      const { rerender } = render(<Mounted />);
      const slider = screen.getByRole('slider', { name: 'Map boost' });
      slider.focus();
      await userEvent.keyboard('{ArrowRight}');
      await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
      toNeighbor('uncached');
      rerender(<Mounted />);
      await landAll();
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Mascoma Lake' }),
      );
    });

    it('a dialog-driven write (Access’s Hide) started on A: refused over an uncached B, it is said naming A', async () => {
      set(api.accessPoints.accessForBody, {
        putIns: [
          { id: 'pi1', coord: { lat: 43.6489, lng: -72.1793 }, name: 'NW launch', source: 'osm' },
        ],
        parking: [],
        blockedIds: [],
        alerts: [],
      });
      mocks.search = { tab: 'access' };
      hold();
      const { rerender } = render(<Mounted />);
      const user = userEvent.setup();
      await user.click(screen.getAllByRole('button', { name: 'Hide' })[0] as HTMLElement);
      const dialog = await screen.findByRole('alertdialog');
      await user.type(within(dialog).getByRole('textbox'), 'A private dock');
      await user.click(within(dialog).getByRole('button', { name: /^Hide/ }));
      toNeighbor('uncached');
      rerender(<Mounted />);
      await landAll(false);
      expect(toasts).toContainEqual(expect.objectContaining({ title: 'Not saved · Mascoma Lake' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });
});
