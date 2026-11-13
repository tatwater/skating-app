import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Body console as the app mounts it at `/admin/body/$id`: the body from the old editor's reads,
 * the tab and the return path from the validated search, the map's own instance (replaced here by
 * a still, since jsdom has no WebGL), and every slot that has no tab yet saying so.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  params: { id: 'j57mascoma0000000000000000000' } as Record<string, string>,
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  push: vi.fn(),
  can: true,
  mutate: vi.fn(() => Promise.resolve()),
  announce: vi.fn(() => Promise.resolve()),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      args === 'skip' ? undefined : mocks.results.get(getFunctionName(ref)),
    useMutation: () => mocks.mutate,
  };
});
vi.mock('@tanstack/react-router', () => ({
  useParams: () => mocks.params,
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { push: mocks.push } }),
}));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: () => mocks.can }) }));
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
import { BodyConsoleRoute } from './BodyConsoleRoute';
import { MASCOMA_HISTORY, MASCOMA_ID, MASCOMA_RECORD, MASCOMA_SUB_AREAS } from './bodyFixtures';

const set = (ref: Parameters<typeof getFunctionName>[0], value: unknown) =>
  mocks.results.set(getFunctionName(ref), value);

function Mounted({ children }: { children?: ReactNode }) {
  return <KeysProvider>{children ?? <BodyConsoleRoute />}</KeysProvider>;
}

beforeAll(() => {
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
  ] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value });
    }
  }
});

beforeEach(() => {
  mocks.results.clear();
  mocks.search = {};
  mocks.can = true;
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
  set(
    api.moderation.listActions,
    MASCOMA_HISTORY.map((h) => ({
      ...h,
      targetId: MASCOMA_ID,
      reason: '',
      undo: { state: 'unavailable', why: '' },
    })),
  );
});

describe('BodyConsoleRoute', () => {
  it('draws the body from the reads that exist, on Shape', () => {
    render(<Mounted />);
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Shape/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('OpenStreetMap')).toBeInTheDocument();
    expect(screen.getByText('Mascoma North')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Shaker cove/ })).toBeInTheDocument();
    expect(screen.getByText('Ruled on public access')).toBeInTheDocument();
    // No read says the towns or the bathymetry yet: absent, not guessed.
    expect(screen.queryByText('Towns')).toBeNull();
    expect(screen.queryByText(/^Missing/)).toBeNull();
    // The map draws the live landmarks only.
    expect(screen.queryByText('Gone')).toBeNull();
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

  it('says a broken link is broken, and an unlisted body is unlisted', () => {
    set(api.waterBodies.get, null);
    const { rerender } = render(<Mounted />);
    expect(screen.getByText(/No such body/)).toBeInTheDocument();
    set(api.waterBodies.get, { available: false });
    rerender(<Mounted key="2" />);
    expect(screen.getByText(/This body is unlisted/)).toBeInTheDocument();
  });

  it('draws nothing while the body loads', () => {
    set(api.waterBodies.get, undefined);
    const { container } = render(<Mounted />);
    expect(container.querySelector('[data-slot="body-console"]')).toBeNull();
  });

  it('leaves History out for a viewer who can’t read the audit trail, and the boost unmovable', () => {
    mocks.can = false;
    render(<Mounted />);
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
    expect(screen.getByRole('slider', { name: 'Map boost' })).toBeDisabled();
  });
});
