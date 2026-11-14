import { render, screen, within } from '@testing-library/react';
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
  /** The viewer's role still on its way (`can` says no until it lands). */
  roleLoading: false,
  mutate: vi.fn(() => Promise.resolve()),
  announce: vi.fn(() => Promise.resolve()),
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
    children,
    className,
    onClick,
  }: {
    to: string;
    params?: { id: string };
    children?: ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <a href={to.replace('$id', params?.id ?? '')} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: () => mocks.can, isLoading: mocks.roleLoading }),
}));
vi.mock('../../shell/undo', () => ({ useUndo: () => ({ announce: mocks.announce }) }));
vi.mock('../map/useBodyMapCanvas', () => ({
  FIT_PADDING: { top: 0, right: 0, bottom: 0, left: 0 },
  useBodyMapCanvas: () => ({
    ground: <div data-testid="ground" />,
    surface: null,
    zoomIn: () => {},
    zoomOut: () => {},
    atMinZoom: false,
    atMaxZoom: false,
  }),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';
import { KeysProvider } from '@/lib/keys';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { SHAPE_TAB } from '../tabs/shape/ShapeTabRoute';
import { BodyConsoleRoute, listWords } from './BodyConsoleRoute';
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
  return <KeysProvider>{children ?? <BodyConsoleRoute />}</KeysProvider>;
}

const historyRow = (h: (typeof MASCOMA_HISTORY)[number]) => ({
  ...h,
  reason: h.reason ?? '',
  undo: { state: 'unavailable', why: '' },
});

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  mocks.results.clear();
  mocks.asked.length = 0;
  mocks.search = {};
  mocks.params = { id: MASCOMA_ID };
  mocks.can = true;
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
  set(api.corpusRequests.openBayRequestsForBody, [
    { requestId: 'r1', name: 'Shaker cove', askers: 3, createdAt: 1, notes: [], aliases: [] },
  ]);
  set(api.corpusPlaceNames.openForBody, []);
  set(api.corpusRequests.openLandmarkRequestsForBody, { proposals: [], more: false });
  set(api.bodyConsole.consoleExtras, MASCOMA_EXTRAS);
  set(api.bodies.preview, {
    complete: { have: 9, of: 10, missing: ['bathymetry'] },
    allTime: { count: 42, capped: false, firstSeason: 2023 },
  });
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
    expect(
      askedFor(api.bodies.preview).every((a) => JSON.parse(a).waterBodyId === MASCOMA_ID),
    ).toBe(true);
    // The main read was whole and held the ruling: no read of the one verb.
    expect(askedFor(api.bodyConsole.history).some((a) => a.includes('action'))).toBe(false);
  });

  it('says *Not recorded yet* for a body with no stored completeness — never a guess', () => {
    set(api.bodies.preview, null);
    render(<Mounted />);
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
    expect(screen.queryByRole('meter', { name: /Complete/ })).toBeNull();
    expect(screen.queryByText('Missing something')).toBeNull();
  });

  it('never draws a capped history as whole, and reads the ruling’s verb alone when it fell off', () => {
    const boost = MASCOMA_HISTORY.find((h) => h.action === 'set_curated_boost');
    set(api.bodyConsole.history, {
      entries: [historyRow(MASCOMA_HISTORY[0] as never), historyRow(boost as never)],
      capped: true,
    });
    const rulingArgs = { waterBodyId: MASCOMA_ID, action: 'set_public_access', limit: 10 };
    set(
      api.bodyConsole.history,
      {
        entries: [
          historyRow({
            ...(MASCOMA_HISTORY.find((h) => h.action === 'set_public_access') as HistoryAction),
            actor: { displayName: 'Sarah B', username: 's' },
          }),
        ],
        capped: true,
      },
      rulingArgs,
    );
    render(<Mounted />);
    expect(screen.getByText('Latest 2')).toBeInTheDocument();
    expect(screen.getByText('More history exists than is shown here.')).toBeInTheDocument();
    // The ruling's row fell off the capped read: its own verb's read names who ruled.
    expect(askedFor(api.bodyConsole.history)).toContain(JSON.stringify(rulingArgs));
    expect(screen.getByText('Sarah')).toBeInTheDocument();
    // The boost's row was in the main read: no read of that verb.
    expect(askedFor(api.bodyConsole.history).some((a) => a.includes('set_curated_boost'))).toBe(
      false,
    );
  });

  it('says in its own place each read that failed, and tries it again', async () => {
    const user = userEvent.setup();
    set(api.bodyConsole.history, new Error('history down'));
    set(api.bodies.preview, new Error('preview down'));
    set(api.subAreas.listForBody, new Error('bays down'));
    set(api.accessPoints.accessForBody, new Error('lots down'));
    render(<Mounted />);
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(screen.getByText('The history couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('Completeness couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('The bays couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('The map couldn’t read the bays and the lots')).toBeInTheDocument();
    mocks.asked.length = 0;
    set(api.bodyConsole.history, { entries: [], capped: false });
    const note = screen
      .getByText('The history couldn’t be read')
      .closest('[data-slot="read-failed"]');
    await user.click(within(note as HTMLElement).getByRole('button', { name: 'Try again' }));
    expect(askedFor(api.bodyConsole.history).length).toBeGreaterThan(0);
    expect(screen.getByText('Nothing recorded')).toBeInTheDocument();
  });

  it('opens the tab the URL names, and a slot with no tab says so', () => {
    mocks.search = { tab: 'water', lit: 'not valid' };
    render(<Mounted />);
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
    expect(screen.getByText('Names couldn’t be read')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
    throws = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Names drawn')).toBeInTheDocument();
  });

  it('keeps the return path when the tab changes, and goes back to it on ⇧⏎', async () => {
    const user = userEvent.setup();
    mocks.search = { from: '/admin/bodies?q=mascoma' };
    render(<Mounted />);
    await user.click(screen.getByRole('tab', { name: /Names/ }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '.',
        search: { tab: 'names', from: '/admin/bodies?q=mascoma' },
      }),
    );
    screen.getByRole('tab', { name: /Shape/ }).focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(mocks.push).toHaveBeenCalledWith('/admin/bodies?q=mascoma');
  });

  it('opens an ask on its tab with it lit', async () => {
    const user = userEvent.setup();
    render(<Mounted />);
    await user.click(screen.getByRole('option', { name: /Shaker cove/ }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { lit: 'ask:r1' } }),
    );
  });

  it('offers the merge when another body touches this one, and reads that body for its name', () => {
    set(api.bodyConsole.consoleExtras, { ...MASCOMA_EXTRAS, touchingBodyIds: [NEIGHBOR_ID] });
    set(
      api.waterBodies.get,
      {
        available: true,
        body: {
          ...MASCOMA_RECORD,
          _id: NEIGHBOR_ID,
          name: 'Crystal Lake',
          polygon: NEIGHBOR_POLYGON,
        },
      },
      { waterBodyId: NEIGHBOR_ID },
    );
    render(<Mounted />);
    const merge = screen.getByRole('region', { name: 'Merge into another body' });
    expect(within(merge).getByText('Crystal Lake')).toBeInTheDocument();
    expect(within(merge).getByRole('link', { name: 'Open →' })).toHaveAttribute(
      'href',
      `/admin/body/${NEIGHBOR_ID}`,
    );
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

  it('says a rejected body has been removed, and what the record still holds', () => {
    set(api.waterBodies.get, { available: false });
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

  it('never counts the asks as whole when a read without a flag came back full', () => {
    set(
      api.corpusPlaceNames.openForBody,
      Array.from({ length: 400 }, (_, i) => ({ _id: `pn${i}`, name: `Name ${i}`, messages: 1 })),
    );
    const { container } = render(<Mounted />);
    expect(container.querySelector('[data-slot="body-asks-more"]')).not.toBeNull();
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
});

describe('listWords', () => {
  it('joins what the map couldn’t read as a sentence', () => {
    expect(listWords(['the bays'])).toBe('the bays');
    expect(listWords(['the bays', 'the lots'])).toBe('the bays and the lots');
    expect(listWords(['the bays', 'the put-ins', 'the lots'])).toBe(
      'the bays, the put-ins and the lots',
    );
    expect(listWords([])).toBe('');
  });
});
