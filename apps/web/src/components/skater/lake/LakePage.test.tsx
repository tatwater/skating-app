import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { activeMapHandlers } from '../map/useMapSpec';
import { convexReact, fakes, resetFakes } from '../testMocks';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('convex/react', () => convexReact);
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: fakes.push, replace: nav.replace } }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: fakes.location }),
}));
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import { MapFloatContext } from '../map/MapFloat';
import { useBountyLakeId, useHazardLakeId, useReportLakeId } from '../panels/panelLake';
import { LakeBehind } from './LakeBehind';
import { LakePage } from './LakePage';
import { lakeSearchSchema } from './lakeSearch';
import { resetWaterBodyOpenSource } from './openSource';

const FT = 0.3048;
const ACRE = 4046.8564224;
const MI = 1609.344;
const now = Date.now();

const MASCOMA = {
  _id: 'mascoma',
  name: 'Mascoma Lake',
  type: 'reservoir',
  states: ['NH'],
  source: 'osm',
  dedupStatus: 'clean',
  centroid: { lat: 43.62, lng: -72.13 },
  surfaceAreaSqM: 1143 * ACRE,
  meanDepthM: 31 * FT,
  maxDepthM: 79 * FT,
  meanDepthSource: 'state_agency',
  maxDepthSource: 'state_agency',
  elevationM: 748 * FT,
  shorelineM: 11.4 * MI,
  longAxisM: 4.1 * MI,
  longAxisBearingDeg: 135,
  shortAxisM: 0.8 * MI,
  publicAccess: { verdict: 'open', decidedAt: now - 30 * 86_400_000, decidedByUserId: 'm1' },
  referenceLinks: [{ label: 'Mascoma Lake Association', url: 'https://www.mascomalake.org/' }],
};

const NORTH = {
  _id: 'bay1',
  name: 'Mascoma North',
  centroid: { lat: 43.64, lng: -72.15 },
  surfaceAreaSqM: 296 * ACRE,
  maxDepthM: 36 * FT,
  maxDepthSource: 'state_agency',
  removed: false,
};

const HAZARD = {
  _id: 'h1',
  type: 'open_water',
  freshness: 'fresh',
  provisional: false,
  subAreaName: 'Mascoma North',
  firstReportedAt: now - 2 * 86_400_000,
  confirmCount: 2,
};

const REPORT = {
  reportId: 'r1',
  waterBodyId: 'mascoma',
  bodyName: 'Mascoma Lake',
  skateEndTime: now - 60 * 60_000,
  iceTypes: [],
  surfaceTags: [],
  suitability: 'experienced_only',
  skateQuality: 'good',
  notesExcerpt: 'Black ice from the launch to the islands.',
  photoThumbUrls: [],
  author: { displayName: 'Pat Lacasse', username: 'placasse' },
  blocked: false,
};

function lake(over: Record<string, unknown> = {}) {
  return { available: true, body: { ...MASCOMA, ...over } };
}

function answer(over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    'waterBodies:get': lake(),
    'subAreas:listForBody': [NORTH],
    'waterBodyFavorites:isFavorite': false,
    'accessPoints:accessForBody': {
      putIns: [
        {
          id: 'pi1',
          coord: { lat: 43.63, lng: -72.15 },
          parkingAreaId: 'lot1',
          source: 'official',
          approachKind: 'drive_up',
        },
      ],
      parking: [{ id: 'lot1', coord: { lat: 43.631, lng: -72.151 }, amenities: [] }],
      blockedIds: [],
      alerts: [],
    },
    'putIns:listForBody': [],
    'weatherAlerts:listForBody': [],
    'hazards:listForBody': [HAZARD],
    'bodyFeatures:listForBody': [],
    'profiles:publicByIds': { p1: { displayName: 'Pat Lacasse', username: 'placasse' } },
    'bounties:listForBody': [{ _id: 'b1' }, { _id: 'b2' }],
    'profiles:current': { _id: 'me', role: 'member' },
    'waterBodies:pendingAccessReportCount': 0,
    'contentFlags:myAccessFlags': [],
    'recurrence:listForBody': [],
    'corpusRequests:listMineForBody': [],
    'corpusRequests:openCountsForBody': {},
    ...over,
  };
  for (const [k, v] of Object.entries(base)) fakes.queries.set(k, v);
}

function renderLake(search: Record<string, unknown> = {}, id = 'mascoma') {
  const parsed = lakeSearchSchema.parse(search);
  const query = new URLSearchParams(
    Object.entries(search).map(([k, v]) => [k, String(v)]),
  ).toString();
  fakes.location = { pathname: `/water/${id}`, searchStr: query ? `?${query}` : '' };
  return render(<LakePage id={id} search={parsed} />);
}

beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
  // jsdom has no Web Animations; Base UI's scroll area asks for them.
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  resetFakes();
  resetWaterBodyOpenSource();
  nav.replace = vi.fn();
  fakes.paginated = { results: [REPORT], status: 'Exhausted', loadMore: vi.fn() };
  useSkaterMapStore.setState({ contourCredit: null, specs: { view: null, flow: null } });
});
afterEach(() => useSkaterMapStore.setState({ specs: { view: null, flow: null } }));

describe('the lake page’s states', () => {
  it('loads with the 2.8 skeleton — the sidebar only; the map is the layout’s', () => {
    answer({ 'waterBodies:get': undefined });
    renderLake();
    expect(screen.getByRole('complementary', { name: 'Loading the lake' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(document.querySelector('[data-slot="skater-map"]')).toBeNull();
  });

  it('says a broken link is a broken link, and offers the way back', () => {
    answer({ 'waterBodies:get': null });
    renderLake();
    expect(screen.getByRole('heading', { name: 'Lake not found' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Back to Explore' }));
    expect(fakes.push).toHaveBeenCalledWith('/');
  });

  it('says a removed lake is unavailable', () => {
    answer({ 'waterBodies:get': { available: false } });
    renderLake();
    expect(screen.getByRole('heading', { name: 'This lake isn’t available' })).toBeInTheDocument();
  });
});

describe('the header', () => {
  it('names the lake, its kind and its facts, units with the values', () => {
    answer();
    renderLake();
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Mascoma Lake');
    expect(header).toHaveTextContent('Reservoir · NH');
    expect(header).toHaveTextContent('Depth avg / max');
    expect(header).toHaveTextContent('31 / 79ft');
    expect(header).toHaveTextContent('1,143ac');
  });

  it('opens Add a report over the page, seeded with the lake', () => {
    answer();
    renderLake({ tab: 'about' });
    const link = screen.getByRole('link', { name: 'Add a report' });
    expect(link).toHaveAttribute('href', '/water/mascoma?tab=about&post=new&postBody=mascoma');
    fireEvent.click(link);
    expect(fakes.push).toHaveBeenCalledWith('/water/mascoma?tab=about&post=new&postBody=mascoma', {
      reportSheetEntryRecorded: true,
    });
    expect(fakes.capture).toHaveBeenCalledWith('report_sheet_opened', { entry: 'water_body' });
  });

  it('opens the hazard and bounty actions as params, and a modified click as a tab', () => {
    answer();
    renderLake();
    fireEvent.click(screen.getByRole('link', { name: 'Report a hazard' }));
    expect(fakes.push).toHaveBeenLastCalledWith('/water/mascoma?act=hazard');
    fireEvent.click(screen.getByRole('link', { name: 'Post a bounty' }), { metaKey: true });
    expect(fakes.push).toHaveBeenCalledTimes(1);
  });

  it('routes directions to the parking, in a new tab', () => {
    answer();
    renderLake();
    const directions = screen.getByRole('link', { name: 'Directions to parking' });
    expect(directions).toHaveAttribute('target', '_blank');
    fireEvent.click(directions);
    expect(fakes.capture).toHaveBeenCalledWith('directions_opened', { target: 'parking' });
  });

  it('falls back to a derived put-in, and offers nothing without a way in', () => {
    answer({
      'accessPoints:accessForBody': { putIns: [], parking: [], blockedIds: [], alerts: [] },
      'putIns:listForBody': [{ coord: { lat: 43.6, lng: -72.1 }, source: 'derived' }],
    });
    const { unmount } = renderLake();
    fireEvent.click(screen.getByRole('link', { name: 'Directions' }));
    expect(fakes.capture).toHaveBeenCalledWith('directions_opened', { target: 'put_in' });
    unmount();
    answer({ 'accessPoints:accessForBody': undefined, 'putIns:listForBody': [] });
    renderLake();
    expect(screen.queryByRole('link', { name: /^Directions/ })).toBeNull();
  });

  it('toggles the star and records it from the server’s answer', async () => {
    answer();
    fakes.mutations.set(
      'waterBodyFavorites:toggle',
      vi.fn().mockResolvedValue({ favorited: true }),
    );
    renderLake();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add this lake to favorites' }));
    });
    expect(fakes.mutations.get('waterBodyFavorites:toggle')).toHaveBeenCalledWith({
      waterBodyId: 'mascoma',
    });
    expect(fakes.capture).toHaveBeenCalledWith('water_body_favorited', {
      target_type: 'water_body',
    });
  });

  it('records an unfavorite, and swallows a refused toggle', async () => {
    answer({ 'waterBodyFavorites:isFavorite': true });
    const toggle = vi
      .fn()
      .mockResolvedValueOnce({ favorited: false })
      .mockRejectedValueOnce(new Error('gone'));
    fakes.mutations.set('waterBodyFavorites:toggle', toggle);
    renderLake();
    const star = screen.getByRole('button', { name: 'Remove this lake from favorites' });
    expect(star).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      fireEvent.click(star);
    });
    expect(fakes.capture).toHaveBeenCalledWith('water_body_unfavorited', {
      target_type: 'water_body',
    });
    await act(async () => {
      fireEvent.click(star);
    });
    expect(fakes.capture).toHaveBeenCalledTimes(3); // opened, tab viewed, unfavorited
  });

  it('closes every composer while an account deletion is pending', () => {
    answer({ 'profiles:current': { _id: 'me', role: 'member', deletionRequestedAt: now } });
    renderLake();
    expect(screen.queryByRole('link', { name: 'Add a report' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Report a hazard' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Post a bounty' })).toBeNull();
  });

  it('shows the NWS alert above the tabs, in their words', () => {
    answer({
      'weatherAlerts:listForBody': [
        {
          id: 'a1',
          event: 'Winter Storm Warning',
          severity: 'Severe',
          headline: 'Winter Storm Warning issued January 16 by NWS Gray ME',
        },
      ],
    });
    renderLake();
    const alerts = screen.getByRole('region', { name: 'National Weather Service alerts' });
    expect(alerts).toHaveTextContent('Winter Storm Warning');
    expect(alerts).toHaveTextContent('issued January 16 by NWS Gray ME');
  });
});

describe('a bay (1.10) and an inactive lake (1.13)', () => {
  it('reframes the header as the bay, its star the bay’s own', async () => {
    answer({
      'waterBodyFavorites:isFavorite': (args: { subAreaId?: string }) =>
        args.subAreaId === undefined,
    });
    fakes.mutations.set(
      'waterBodyFavorites:toggle',
      vi.fn().mockResolvedValue({ favorited: true }),
    );
    renderLake({ sub: 'bay1' });
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Mascoma North');
    expect(header).toHaveTextContent('Bay · NH');
    expect(header).toHaveTextContent('Depth max');
    expect(within(header).getByLabelText('Mascoma Lake is a favorite')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add this bay to favorites' }));
    });
    expect(fakes.mutations.get('waterBodyFavorites:toggle')).toHaveBeenCalledWith({
      waterBodyId: 'mascoma',
      subAreaId: 'bay1',
    });
    expect(fakes.capture).toHaveBeenCalledWith('water_body_favorited', { target_type: 'sub_area' });
    fireEvent.click(within(header).getByRole('link', { name: 'Mascoma Lake' }));
    expect(fakes.push).toHaveBeenCalledWith('/water/mascoma');
    expect(useSkaterMapStore.getState().specs.view?.focus).toEqual({
      bodyId: 'mascoma',
      subAreaId: 'bay1',
    });
  });

  it('falls back to the lake when the bay isn’t a live one', () => {
    answer({ 'subAreas:listForBody': [{ ...NORTH, removed: true }] });
    renderLake({ sub: 'bay1' });
    expect(within(screen.getByRole('banner')).getByRole('heading', { level: 1 })).toHaveTextContent(
      'Mascoma Lake',
    );
  });

  it('grays an inactive lake, says why, and asks for no bounty', () => {
    answer({
      'waterBodies:get': lake({
        name: 'George Pond',
        dormant: { since: now - 1, reason: 'inactive' },
      }),
    });
    renderLake();
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-inactive', '');
    expect(header).toHaveTextContent('Inactive');
    expect(header).toHaveTextContent('isn’t on the active map');
    expect(screen.queryByRole('link', { name: 'Post a bounty' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Report a hazard' })).toBeInTheDocument();
  });
});

describe('the Reports tab', () => {
  it('lists the hazards with the (i), the reports, and the bounties line', () => {
    answer();
    renderLake();
    expect(screen.getByRole('button', { name: 'About known hazards' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open water / lead'));
    expect(fakes.push).toHaveBeenLastCalledWith('/hazard/h1');
    expect(screen.getByText('Pat Lacasse')).toBeInTheDocument();
    expect(screen.getByText('Experienced only')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Black ice from the launch to the islands.'));
    expect(fakes.push).toHaveBeenLastCalledWith('/report/r1');
    fireEvent.click(screen.getByText('2 open bounties'));
    expect(fakes.push).toHaveBeenLastCalledWith('/bounty/b1');
  });

  it('says the full sentence on an empty list, and no (i)', () => {
    answer({ 'hazards:listForBody': [], 'bounties:listForBody': [] });
    fakes.paginated = { results: [], status: 'Exhausted', loadMore: vi.fn() };
    renderLake();
    expect(
      screen.getByText(/^No known hazards\. That does not mean the ice is safe/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'About known hazards' })).toBeNull();
    expect(screen.getByText('No reports yet this season — be the first.')).toBeInTheDocument();
    expect(screen.queryByText(/open bount/)).toBeNull();
  });

  it('narrows to the bay, and loads more on demand', () => {
    answer();
    fakes.paginated = { results: [REPORT], status: 'CanLoadMore', loadMore: vi.fn() };
    renderLake({ sub: 'bay1' });
    expect(fakes.paginatedArgs.at(-1)).toEqual({ waterBodyId: 'mascoma', subAreaId: 'bay1' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(fakes.paginated.loadMore).toHaveBeenCalledWith(20);
  });

  it('holds the frames while the lists load', () => {
    answer({ 'hazards:listForBody': undefined });
    fakes.paginated = { results: [], status: 'LoadingFirstPage', loadMore: vi.fn() };
    renderLake();
    const busy = screen.getAllByRole('region', { busy: true });
    expect(busy.map((r) => r.getAttribute('aria-labelledby')).length).toBe(2);
  });

  it('reads the reports as cards', () => {
    answer();
    renderLake();
    expect(fakes.paginatedArgs.at(-1)).toEqual({ waterBodyId: 'mascoma' });
    expect(document.querySelector('[data-slot="report-card"]')).toHaveTextContent('Pat Lacasse');
  });
});

describe('the tabs', () => {
  it('switch by replacing the param, and record each tab brought up', () => {
    answer();
    renderLake();
    expect(fakes.capture).toHaveBeenCalledWith('water_body_opened', { source: 'map' });
    expect(fakes.capture).toHaveBeenCalledWith('water_body_tab_viewed', { tab: 'reports' });
    fireEvent.click(screen.getByRole('tab', { name: 'About' }));
    expect(nav.replace).toHaveBeenCalledWith('/water/mascoma?tab=about');
  });

  it('drops the param for Reports, the default', () => {
    answer();
    renderLake({ tab: 'about' });
    fireEvent.click(screen.getByRole('tab', { name: 'Reports' }));
    expect(nav.replace).toHaveBeenCalledWith('/water/mascoma');
  });

  it('holds the Weather and Getting there frames for their tabs', () => {
    answer();
    const { unmount } = renderLake({ tab: 'weather' });
    expect(screen.getByRole('heading', { name: 'What’s coming' })).toBeInTheDocument();
    // The map rings the lake's sample points on this tab, and only this one (board 1.7).
    const rings = useSkaterMapStore.getState().specs.view?.overlays.samples;
    expect(rings?.data.features.map((f) => f.properties?.name)).toEqual([
      'Whole lake',
      'Mascoma North',
    ]);
    unmount();
    renderLake({ tab: 'access' });
    expect(screen.getByRole('heading', { name: 'Put-ins' })).toBeInTheDocument();
    expect(useSkaterMapStore.getState().specs.view?.overlays.samples).toBeNull();
  });
});

describe('About (1.9, 1.14)', () => {
  it('reads the ruling, the shape, the depth’s source and the links', () => {
    answer();
    renderLake({ tab: 'about' });
    expect(screen.getByText('Accessible to the public.')).toBeInTheDocument();
    expect(screen.getByText('4.1 mi, northwest to southeast')).toBeInTheDocument();
    expect(screen.getByText(/^Depth: /)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Mascoma Lake Association/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveTextContent('mascomalake.org');
    expect(screen.queryByRole('region', { name: 'Moderator tools' })).toBeNull();
  });

  it('reuses the shipped wind rose, with the bay’s own fetch in a bay', () => {
    const rose = Array.from({ length: 16 }, (_, i) => (i === 13 ? 0.25 : 0.05));
    answer({
      'waterBodies:get': lake({
        windRose: rose,
        meanWindMps: rose.map(() => 4),
        fetchProfileM: rose.map(() => 900),
      }),
      'subAreas:listForBody': [{ ...NORTH, fetchProfileM: rose.map(() => 400) }],
    });
    const { unmount } = renderLake({ tab: 'about', sub: 'bay1' });
    expect(screen.getByRole('region', { name: 'Wind exposure' })).toBeInTheDocument();
    unmount();
    answer({ 'waterBodies:get': lake({ windRose: rose }) });
    renderLake({ tab: 'about' });
    expect(screen.getByRole('region', { name: 'Wind exposure' })).toBeInTheDocument();
  });

  it('takes a skater’s report of no public access, with the note a ruling asks for', async () => {
    answer();
    const flag = vi.fn().mockResolvedValue(null);
    fakes.mutations.set('contentFlags:flag', flag);
    renderLake({ tab: 'about' });
    fireEvent.click(screen.getByRole('button', { name: 'Report no public access' }));
    const send = screen.getByRole('button', { name: 'Send' });
    // An open ruling makes the note compulsory: "what changed since the review?"
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New gate at the lot' } });
    await act(async () => {
      fireEvent.click(send);
    });
    expect(flag).toHaveBeenCalledWith({
      targetType: 'waterbody',
      targetId: 'mascoma',
      reason: 'no_public_access',
      note: 'New gate at the lot',
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says so when the report fails, and lets the skater cancel', async () => {
    answer({ 'waterBodies:get': lake({ publicAccess: undefined }) });
    fakes.mutations.set('contentFlags:flag', vi.fn().mockRejectedValue(new Error('no')));
    renderLake({ tab: 'about' });
    fireEvent.click(screen.getByRole('button', { name: 'Report no public access' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not send that. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('marks a report already sent, and shows the open reports while unruled', () => {
    answer({
      'waterBodies:get': lake({ publicAccess: undefined }),
      'contentFlags:myAccessFlags': ['mascoma'],
      'waterBodies:pendingAccessReportCount': 3,
    });
    renderLake({ tab: 'about' });
    expect(screen.getByRole('button', { name: 'You reported no public access' })).toBeDisabled();
    expect(screen.getByText(/3 people have reported no public access here/)).toBeInTheDocument();
  });

  it('gives a moderator the ruling and the tools', async () => {
    answer({
      'profiles:current': { _id: 'me', role: 'moderator' },
      'waterBodies:get': lake({ source: 'user', reviewStatus: 'pending' }),
      'waterBodies:pendingAccessReportCount': 1,
    });
    const rule = vi.fn().mockResolvedValue(null);
    fakes.mutations.set('waterBodies:setPublicAccess', rule);
    renderLake({ tab: 'about' });
    const ruling = screen.getByRole('region', { name: 'Access ruling' });
    expect(ruling).toHaveTextContent('1 report of no public access is waiting.');
    expect(within(ruling).getByRole('button', { name: 'Confirm public access' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(within(ruling).getByRole('button', { name: 'Mark no public access' }));
    });
    expect(rule).toHaveBeenCalledWith({ waterBodyId: 'mascoma', verdict: 'none' });
    await act(async () => {
      fireEvent.click(within(ruling).getByRole('button', { name: 'Clear' }));
    });
    expect(rule).toHaveBeenLastCalledWith({ waterBodyId: 'mascoma', verdict: null });

    const tools = screen.getByRole('region', { name: 'Moderator tools' });
    const edit = within(tools).getByRole('link', { name: /Edit this lake/ });
    expect(edit).toHaveAttribute('href', '/admin/water/mascoma');
    expect(edit).toHaveAttribute('target', '_blank');
    await act(async () => {
      fireEvent.click(within(tools).getByRole('button', { name: 'Approve this lake' }));
    });
    expect(fakes.mutations.get('waterBodies:approve')).toHaveBeenCalledWith({
      waterBodyId: 'mascoma',
    });
    await act(async () => {
      fireEvent.click(within(tools).getByRole('button', { name: 'Reject' }));
    });
    expect(fakes.mutations.get('waterBodies:reject')).toHaveBeenCalledWith({
      waterBodyId: 'mascoma',
    });
  });

  it('says so when a ruling fails', async () => {
    answer({ 'profiles:current': { _id: 'me', role: 'admin' } });
    fakes.mutations.set('waterBodies:setPublicAccess', vi.fn().mockRejectedValue(new Error('x')));
    renderLake({ tab: 'about' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark no public access' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save the ruling. Try again.');
  });
});

describe('actions over the sidebar (row 3)', () => {
  it('opens as an inset over the tab, and Esc leaves by dropping the param', () => {
    answer();
    renderLake({ act: 'access-problem', tab: 'about' });
    expect(screen.getByRole('button', { name: 'Back to Mascoma Lake' })).toHaveFocus();
    expect(document.querySelector('[data-slot="lake-tab-panel"]')).toHaveAttribute('inert');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(nav.replace).toHaveBeenCalledWith('/water/mascoma?tab=about');
  });

  it('floats the imagery over the map, leaving the tabs live; its close and Esc both leave', () => {
    answer();
    const slot = document.createElement('div');
    document.body.append(slot);
    const search = { act: 'imagery', band: 'vh', frame: '2027-01-12' } as const;
    fakes.location = {
      pathname: '/water/mascoma',
      searchStr: '?act=imagery&band=vh&frame=2027-01-12',
    };
    render(
      <MapFloatContext.Provider value={slot}>
        <LakePage id="mascoma" search={lakeSearchSchema.parse(search)} />
      </MapFloatContext.Provider>,
    );
    const plate = within(slot).getByRole('region', { name: 'Latest imagery' });
    expect(document.querySelector('[data-slot="lake-tab-panel"]')).not.toHaveAttribute('inert');
    fireEvent.click(within(plate).getByRole('button', { name: 'Turn off imagery' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/water/mascoma');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(nav.replace).toHaveBeenCalledTimes(2);
    slot.remove();
  });

  it('opens the imagery action from the map’s dock', () => {
    answer();
    renderLake();
    activeMapHandlers().onOpenImagery?.();
    expect(fakes.push).toHaveBeenCalledWith('/water/mascoma?act=imagery');
  });

  it('declares the lake’s map, framed on the lake', () => {
    answer();
    renderLake();
    const spec = useSkaterMapStore.getState().specs.view;
    expect(spec?.id).toBe('lake');
    expect(spec?.fit).toEqual({ kind: 'body', bodyId: 'mascoma' });
  });

  it('credits the contours at the foot while the map draws them', () => {
    answer();
    useSkaterMapStore.setState({ contourCredit: '5 ft contours, surveyed by NH GRANIT.' });
    renderLake();
    expect(screen.getByText('5 ft contours, surveyed by NH GRANIT.')).toBeInTheDocument();
    expect(screen.getByText('Basemap and water © OpenStreetMap contributors.')).toBeInTheDocument();
  });
});

describe('the lake behind a card', () => {
  it('is bare ground until the card’s lake is known', () => {
    answer();
    fakes.location = { pathname: '/report/r1', searchStr: '' };
    const { container } = render(<LakeBehind waterBodyId={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws the sidebar inert, with none of the page’s side effects', () => {
    answer();
    fakes.location = { pathname: '/report/r1', searchStr: '' };
    render(<LakeBehind waterBodyId="mascoma" />);
    const behind = document.querySelector('[data-slot="lake-behind"]');
    expect(behind).toHaveAttribute('inert');
    expect(behind).toHaveAttribute('aria-hidden', 'true');
    expect(behind?.querySelector('[data-slot="lake-sidebar"]')).toHaveTextContent('Mascoma Lake');
    expect(fakes.capture).not.toHaveBeenCalled();
    expect(useSkaterMapStore.getState().specs.view).toBeNull();
  });

  it('draws nothing for a lake that is gone', () => {
    answer({ 'waterBodies:get': { available: false } });
    fakes.location = { pathname: '/report/r1', searchStr: '' };
    const { container } = render(<LakeBehind waterBodyId="mascoma" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads each card’s lake from the card’s own first read', () => {
    fakes.queries.set('reports:get', { waterBodyId: 'mascoma' });
    fakes.queries.set('hazards:get', { waterBodyId: 'sunapee' });
    fakes.queries.set('bounties:getDetail', { waterBody: { _id: 'newfound' } });
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useReportLakeId('r1'), useHazardLakeId('h1'), useBountyLakeId('b1'));
      return null;
    }
    render(<Probe />);
    expect(seen.slice(-3)).toEqual(['mascoma', 'sunapee', 'newfound']);
  });
});
