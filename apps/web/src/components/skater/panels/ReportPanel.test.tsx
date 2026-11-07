import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { fakes, resetFakes } from '../testMocks';
import {
  convexWithActions,
  panelFakes,
  panelRouter,
  polyfillAnimate,
  resetPanelFakes,
} from './panelTestMocks';

vi.mock('convex/react', () => convexWithActions);
vi.mock('@tanstack/react-router', () => panelRouter);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import { InsetCard, PanelColumn } from './InsetCard';
import { REPORT_PAT } from './panelFixtures';
import { PANEL_LOADING_SPEC, ReportPanel } from './ReportPanel';
import { ReportPanelView } from './ReportPanelView';

const HOUR = 3_600_000;
const end = Date.now() - 8 * HOUR;
const REPORT = {
  _id: 'r1',
  waterBodyId: 'w-stale',
  authorId: 'u1',
  postId: 'post1',
  photoIds: ['p1', 'p2'],
  moderationStatus: 'visible',
  subAreaName: 'Mascoma South',
  skateEndTime: end,
  skateStartTime: end - 2 * HOUR,
  skateQuality: 'good',
  suitability: 'experienced_only',
  observedFrom: 'shore',
  sightings: [{ type: 'open' }, { type: 'open' }],
  iceTypes: [{ type: 'black_ice' }],
  surfaceTags: [{ type: 'smooth' }],
  iceThickness: { readings: [{ valueCm: 12.7, method: 'drill' }] },
  snow: { coverage: 'dusting' },
  conditions: { airTempC: -8 },
  notes: 'Wind came up around 11.',
  conflicting: true,
  editedAt: end + HOUR,
  bayNames: {},
  point: { lat: 43.64, lng: -72.32 },
};

beforeAll(polyfillAnimate);
beforeEach(() => {
  resetFakes();
  resetPanelFakes();
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
});
afterEach(() => vi.restoreAllMocks());

function seed(over: Record<string, unknown> = {}) {
  fakes.queries.set('reports:get', { ...REPORT, ...over });
  fakes.queries.set('posts:getForReport', {
    title: 'Black ice to the islands',
    body: 'Drilled 5″ off the beach.',
    siblings: [{ reportId: 'r9', bodyName: 'Mascoma North' }],
  });
  fakes.queries.set('waterBodies:get', {
    available: true,
    body: { _id: 'w1', name: 'Mascoma Lake' },
  });
  fakes.queries.set('profiles:publicByIds', {
    u1: {
      displayName: 'Pat Lacasse',
      username: 'placasse',
      profileImageUrl: 'https://img/pat.jpg',
    },
  });
  fakes.queries.set('photos:getUrls', [
    {
      photoId: 'p1',
      url: 'https://img/1.jpg',
      thumbUrl: 'https://img/1-t.jpg',
      coord: { lat: 43.64, lng: -72.32 },
    },
    { photoId: 'p2', url: null, thumbUrl: 'https://img/2-t.jpg', caption: 'The islands' },
  ]);
  fakes.queries.set('gpsActivities:getForReport', {
    path: {
      type: 'LineString',
      coordinates: [
        [-72.33, 43.64],
        [-72.32, 43.65],
      ],
    },
    clipped: true,
  });
  fakes.queries.set('comments:listByReport', []);
}

const renderPanel = () =>
  render(
    <PanelColumn>
      <ReportPanel reportId="r1" />
    </PanelColumn>,
  );

describe('ReportPanel', () => {
  it('loads inside the card frame, the map holding still', async () => {
    renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Report' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="panel-loading"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Back/ })).toHaveTextContent('Back');
    expect(useSkaterMapStore.getState().specs.view).toEqual(PANEL_LOADING_SPEC);
    expect(fakes.capture).toHaveBeenCalledWith('report_viewed', { source: 'deep_link' });
  });

  it('says so inside the card when the report isn’t there, and goes back to Explore', async () => {
    fakes.queries.set('reports:get', null);
    renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Report not available' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Back to Explore/ }));
    expect(panelFakes.navigate).toHaveBeenCalledWith({ to: '/', replace: true });
  });

  it('opens hosted (Latest): back to the host, the host closes, and no map is declared', async () => {
    seed();
    const onClose = vi.fn();
    render(
      <PanelColumn>
        <ReportPanel reportId="r1" host={{ backTo: 'Latest', onClose }} />
      </PanelColumn>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Back to Latest/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panelFakes.navigate).not.toHaveBeenCalled();
    expect(useSkaterMapStore.getState().specs.view?.visible).toBe(false);
  });

  it('keeps the host’s name on the head while loading and when the report is gone', async () => {
    const host = { backTo: 'Latest', onClose: vi.fn() };
    const { unmount } = render(
      <PanelColumn>
        <ReportPanel reportId="r1" host={host} />
      </PanelColumn>,
    );
    expect(await screen.findByRole('button', { name: /Back to Latest/ })).toBeInTheDocument();
    unmount();
    fakes.queries.set('reports:get', null);
    render(
      <PanelColumn>
        <ReportPanel reportId="r1" host={host} />
      </PanelColumn>,
    );
    expect(await screen.findByRole('button', { name: /Back to Latest/ })).toBeInTheDocument();
  });

  it('draws the report from the reader’s side, frames the survivor lake with the path and pins', async () => {
    seed();
    fakes.queries.set('profiles:current', { _id: 'u2', status: 'active', displayName: 'Kate' });
    fakes.queries.set('blocks:blockedUserIds', []);
    renderPanel();
    expect(
      await screen.findByRole('dialog', { name: 'Mascoma South · Mascoma Lake' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to Mascoma Lake/ })).toBeInTheDocument();
    const head = document.querySelector('[data-slot="card-head"]') as HTMLElement;
    expect(head).toHaveTextContent(/off the ice .* · skated 2h · edited/);
    expect(screen.getByText('Black ice to the islands')).toBeInTheDocument();
    expect(screen.getByText('Conflicting reports')).toBeInTheDocument();
    expect(screen.getByText('From shore')).toBeInTheDocument();
    // Two sightings that read the same are said once.
    expect(screen.getAllByText('Still open')).toHaveLength(1);
    expect(screen.getByText(/hidden: the skater didn’t share their put-in/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mascoma North' })).toHaveAttribute(
      'href',
      '/report/r9',
    );
    expect(screen.getByRole('img', { name: 'The islands' })).toBeInTheDocument();

    const spec = useSkaterMapStore.getState().specs.view;
    expect(spec?.id).toBe('panel');
    expect(spec?.focus).toEqual({ bodyId: 'w1' });
    expect(spec?.overlays.track?.key).toBe('track:r1:2');
    expect(spec?.overlays.photos?.key).toBe('photos:r1:p1');

    // Somebody else's: thumbs and a flag in the foot.
    const foot = document.querySelector('[data-slot="inset-card-foot"]') as HTMLElement;
    expect(within(foot).getByRole('button', { name: /Helpful/ })).toBeInTheDocument();
    expect(within(foot).getByRole('button', { name: 'Flag' })).toBeInTheDocument();
  });

  it('dims a blocked author and says so, and never hides the report (D3)', async () => {
    seed();
    fakes.queries.set('profiles:current', { _id: 'u2', status: 'active', displayName: 'Kate' });
    fakes.queries.set('blocks:blockedUserIds', ['u1']);
    renderPanel();
    const byline = await waitFor(() => {
      const el = document.querySelector('[data-slot="report-byline"]');
      if (el === null) throw new Error('no byline');
      return el as HTMLElement;
    });
    expect(byline).toHaveAttribute('data-blocked');
    expect(within(byline).getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Black ice to the islands')).toBeInTheDocument();
  });

  it('gives the author edit and a delete that asks, then arms red, then acts', async () => {
    seed();
    fakes.queries.set('profiles:current', { _id: 'u1', status: 'active', displayName: 'Pat' });
    fakes.queries.set('bounties:answeredByMyReport', 2);
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError('Already removed'))
      .mockResolvedValue(null);
    fakes.mutations.set('reports:remove', remove);
    renderPanel();
    expect(
      await screen.findByText(/At least 2 skaters were looking forward to it/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Edit report' }));
    const edit = panelFakes.navigate.mock.calls[0]?.[0];
    expect(edit).toMatchObject({ to: '/report/$id', params: { id: 'r1' } });
    expect(edit.search({ postBody: undefined })).toEqual({ postBody: undefined, post: 'r1' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const action = await screen.findByRole('button', { name: /Delete report/ });
    await userEvent.click(action);
    expect(remove).not.toHaveBeenCalled(); // the first press only arms it
    await userEvent.click(screen.getByRole('button', { name: /Delete report/ }));
    expect(await screen.findByText('Already removed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Delete report/ }));
    await userEvent.click(screen.getByRole('button', { name: /Delete report/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenCalledWith({ reportId: 'r1' });
  });

  it('keeps a moderated report’s author from editing it', async () => {
    seed({ moderationStatus: 'hidden' });
    fakes.queries.set('profiles:current', { _id: 'u1', status: 'active', displayName: 'Pat' });
    renderPanel();
    await screen.findByRole('dialog', { name: 'Mascoma South · Mascoma Lake' });
    expect(screen.queryByRole('button', { name: 'Edit report' })).toBeNull();
    expect(document.querySelector('[data-slot="inset-card-foot"]')).toBeNull();
  });

  it('frames the stored lake when the body hasn’t resolved, and shows the weather since', async () => {
    seed({ photoIds: [] });
    fakes.queries.delete('waterBodies:get');
    fakes.queries.delete('gpsActivities:getForReport');
    panelFakes.actions.set('weather:getWeatherSinceForBody', vi.fn().mockResolvedValue(null));
    renderPanel();
    await screen.findByRole('dialog', { name: 'Mascoma South · Report' });
    expect(useSkaterMapStore.getState().specs.view?.focus).toEqual({ bodyId: 'w-stale' });
    expect(panelFakes.actions.get('weather:getWeatherSinceForBody')).toHaveBeenCalledWith({
      reportId: 'r1',
    });
  });
});

function InCard({ children }: { children: React.ReactNode }) {
  return (
    <PanelColumn>
      <InsetCard backTo="Mascoma Lake" onClose={vi.fn()} returnKey="report:r1" label="Report">
        {children}
      </InsetCard>
    </PanelColumn>
  );
}

describe('ReportPanelView', () => {
  it('draws board 2.4 from the fixture: sections in order, photos opening in a new tab', async () => {
    render(
      <InCard>
        <ReportPanelView
          data={{
            ...REPORT_PAT,
            photos: [{ photoId: 'p1', url: 'https://img/1.jpg', thumbUrl: 'https://img/1-t.jpg' }],
            trackClipped: false,
            bountiesAnswered: 1,
          }}
          comments={<p>comments</p>}
        />
      </InCard>,
    );
    await screen.findByRole('dialog');
    const labels = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(labels).toEqual([
      'Ice types',
      'Surface',
      'Thickness',
      'Snow',
      'Conditions',
      'Also in this post',
      'Photos',
    ]);
    const photo = screen.getByRole('link', { name: /Photo 1/ });
    expect(photo).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/At least one skater was looking forward to it/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pat Lacasse' })).toHaveAttribute(
      'href',
      '/u/placasse',
    );
    expect(screen.getByText('comments')).toBeInTheDocument();
  });

  it('names a departed author without a link', async () => {
    render(
      <InCard>
        <ReportPanelView
          data={{
            ...REPORT_PAT,
            author: { displayName: 'Deleted user', username: '', deleted: true },
          }}
        />
      </InCard>,
    );
    await screen.findByRole('dialog');
    expect(screen.getByText('Deleted user').closest('a')).toBeNull();
  });
});
