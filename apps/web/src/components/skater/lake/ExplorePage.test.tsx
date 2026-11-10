import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { convexReact, fakes, resetFakes } from '../testMocks';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: fakes.push, replace: nav.replace } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: fakes.location }),
}));

import { BOARD_NOON } from '@/test/boardNow';
import { pinBoardClock } from '@/test/pinBoardClock';
import { ExplorePage } from './ExplorePage';
import { buildInViewModel } from './InViewList';
import { resetWaterBodyOpenSource, takeWaterBodyOpenSource } from './openSource';

const ACRE = 4046.8564224;
const now = BOARD_NOON;

const square = (lng: number, lat: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng, lat],
      [lng + 0.01, lat],
      [lng + 0.01, lat + 0.01],
      [lng, lat + 0.01],
      [lng, lat],
    ],
  ],
});

const body = (id: string, name: string, acres: number, over: Record<string, unknown> = {}) => ({
  _id: id,
  name,
  type: 'lakePond',
  dedupStatus: 'clean',
  surfaceAreaSqM: acres * ACRE,
  polygon: square(-72.1, 43.6),
  ...over,
});

const BODIES = [
  body('smith', 'Smith Pond', 67),
  body('mascoma', 'Mascoma Lake', 1143, { type: 'reservoir', maxDepthM: 24 }),
  body('george', 'George Pond', 47, { dormant: { since: 1, reason: 'inactive' } }),
  body('nameless', '', 30),
];

beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  resetFakes();
  resetWaterBodyOpenSource();
  nav.replace = vi.fn();
  fakes.location = { pathname: '/', searchStr: '' };
  useSkaterMapStore.setState({
    viewportLakes: null,
    hoveredBodyId: null,
    specs: { view: null, flow: null },
  });
});
afterEach(() => useSkaterMapStore.setState({ viewportLakes: null }));

pinBoardClock();

describe('Explore, nothing chosen (1.1)', () => {
  it('holds the loading frame until the map answers, and declares the explore map', () => {
    render(<ExplorePage search={{}} />);
    expect(screen.getByRole('complementary', { name: 'Lakes in view' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(useSkaterMapStore.getState().specs.view?.id).toBe('explore');
  });

  it('lists the named lakes in view: favorites first, inactive gray, recent reports at the end', () => {
    fakes.queries.set('waterBodyFavorites:listForUser', [{ waterBodyId: 'smith' }]);
    fakes.queries.set('reports:recentCardsForBodies', [
      { waterBodyId: 'mascoma', skateEndTime: now - 60_000 },
      { waterBodyId: 'mascoma', skateEndTime: now - 120_000 },
    ]);
    act(() => useSkaterMapStore.getState().setViewportLakes(BODIES as never));
    render(<ExplorePage search={{}} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('3 lakes');
    const rows = screen.getAllByRole('link');
    // The first run in a row is its name.
    const names = rows.map((r) => r.querySelector('span.truncate')?.textContent);
    expect(names).toEqual(['Smith Pond', 'Mascoma Lake', 'George Pond']);
    expect(within(rows[0] as HTMLElement).getByLabelText('A favorite')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('2 reports');
    expect(rows[1]).toHaveTextContent('Today');
    expect(rows[1]).toHaveTextContent('Reservoir · 1,143 acres · 79 ft max');
    expect(rows[2]).toHaveAttribute('data-inactive', '');
    expect(rows[2]).toHaveTextContent('Inactive');
    expect(rows[0]).toHaveTextContent('No recent reports');
    expect(fakes.calls.find((c) => c.name === 'reports:recentCardsForBodies')?.args).toEqual({
      waterBodyIds: ['smith', 'mascoma', 'george'],
    });
  });

  it('opens a lake from the list, marked as the list', () => {
    act(() => useSkaterMapStore.getState().setViewportLakes(BODIES as never));
    render(<ExplorePage search={{}} />);
    const mascoma = screen.getByRole('link', { name: /Mascoma Lake/ });
    fireEvent.mouseEnter(mascoma);
    expect(useSkaterMapStore.getState().hoveredBodyId).toBe('mascoma');
    fireEvent.mouseLeave(mascoma);
    expect(useSkaterMapStore.getState().hoveredBodyId).toBeNull();
    fireEvent.focus(mascoma);
    expect(useSkaterMapStore.getState().hoveredBodyId).toBe('mascoma');
    fireEvent.blur(mascoma);
    fireEvent.click(mascoma, { metaKey: true });
    expect(fakes.push).not.toHaveBeenCalled();
    fireEvent.click(mascoma);
    expect(fakes.push).toHaveBeenCalledWith('/water/mascoma');
    expect(takeWaterBodyOpenSource('/water/mascoma', { entryPath: null })).toBe('list');
  });

  it('says what to do when nothing listed is in view', () => {
    act(() => useSkaterMapStore.getState().setViewportLakes([body('x', '', 3)] as never));
    render(<ExplorePage search={{}} />);
    expect(screen.getByText(/No listed lakes in view/)).toBeInTheDocument();
  });

  it('opens request-a-lake over the sidebar, and Esc drops it', () => {
    fakes.location = { pathname: '/', searchStr: '?act=request' };
    render(<ExplorePage search={{ act: 'request' }} />);
    expect(screen.getByRole('region', { name: 'Request a lake' })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(nav.replace).toHaveBeenCalledWith('/');
  });
});

describe('the In view model', () => {
  it('says how many more are past the cap, and draws what has no outline as a gap', () => {
    const many = Array.from({ length: 52 }, (_, i) =>
      body(`b${i}`, `Pond ${i}`, 100 - i, i === 0 ? { polygon: undefined } : {}),
    );
    const model = buildInViewModel(many as never, new Set(), [], now);
    expect(model.rows).toHaveLength(50);
    expect(model.hiddenCount).toBe(2);
    expect(model.rows?.[0]?.silhouette).toBeNull();
    expect(model.rows?.[1]?.silhouette?.rings.length).toBe(1);
    // An outline is simplified once per polygon.
    expect(buildInViewModel(many as never, new Set(), [], now).rows?.[1]?.silhouette).toBe(
      model.rows?.[1]?.silhouette,
    );
  });

  it('renders the overflow line', () => {
    const many = Array.from({ length: 51 }, (_, i) => body(`b${i}`, `Pond ${i}`, 100 - i));
    act(() => useSkaterMapStore.getState().setViewportLakes(many as never));
    render(<ExplorePage search={{}} />);
    expect(screen.getByText('1 more in view — zoom in to list them.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('51 lakes');
  });

  it('is the loading frame while the map hasn’t answered', () => {
    expect(buildInViewModel(null, new Set(), [], now)).toEqual({ rows: null, hiddenCount: 0 });
  });

  it('skips a geometry that isn’t a polygon', () => {
    const model = buildInViewModel(
      [body('l', 'Line', 5, { polygon: { type: 'LineString', coordinates: [] } })] as never,
      new Set(),
      [],
      now,
    );
    expect(model.rows?.[0]?.silhouette).toBeNull();
  });
});
