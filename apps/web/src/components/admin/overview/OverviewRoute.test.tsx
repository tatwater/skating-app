import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Overview as the app mounts it at `/admin`: the reads that exist, and every block no read
 * serves drawn as *Not recorded yet* — never a fixture, never a zero standing in for one.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  status: 'online' as 'online' | 'connecting' | 'offline',
  support: true,
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
      args === 'skip' ? undefined : mocks.results.get(getFunctionName(ref)),
  };
});
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => c !== 'inbox.support.read' || mocks.support }),
}));
vi.mock('@/lib/useConnection', () => ({
  useConnection: () => ({
    status: mocks.status,
    firstLoad: false,
    lastConnectedAt: 1_000,
    lastTriedAt: null,
  }),
}));

import { api } from '@skating/convex/api';
import { seasonRecordWindow } from '@skating/core';
import { getFunctionName } from 'convex/server';

import { OverviewRoute } from './OverviewRoute';
import { liveStateOf } from './overviewStatus';

const count = (n: number) => ({ count: n, capped: false });

beforeAll(() => {
  // jsdom has no Web Animations or font loading; the kit's skeletons and list-end tabs ask for them.
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
  ] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value });
    }
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

beforeEach(() => {
  mocks.search = {};
  mocks.navigate.mockReset();
  mocks.status = 'online';
  mocks.support = true;
  mocks.results.clear();
  mocks.results.set(getFunctionName(api.console.overview), {
    inbox: {
      safety: count(1),
      accessReports: count(0),
      requests: count(2),
      placesAsked: count(0),
      drawnBodies: count(0),
      contentFlags: count(3),
      support: count(1),
      oldestOpenAt: null,
      medianOpenedAt: null,
    },
    people: {
      moderators: count(2),
      admins: count(1),
      newThisWeek: count(4),
      suspended: count(0),
      nextSuspensionEnds: null,
      banned: count(0),
      flaggedPeople: count(1),
      appealsOpen: count(0),
      leaving: count(0),
      totalUsers: null,
    },
  });
  mocks.results.set(getFunctionName(api.waterBodies.reviewQueueCounts), {
    'duplicate-candidate': { count: 5, capped: false, advisory: false },
  });
  mocks.results.set(getFunctionName(api.console.corpusCounts), {
    duplicates: count(3),
    chordRefits: count(0),
    placeNames: count(0),
    preIcePass: null,
    enrichment: null,
    campaignAt: null,
  });
  mocks.results.set(getFunctionName(api.moderation.listActions), [
    {
      id: 'a1',
      action: 'hide',
      targetType: 'comment',
      targetId: 'c1',
      reason: 'spam',
      createdAt: 1_000,
      actor: { userId: 'u', username: 'sarah', displayName: 'Sarah Berman' },
      undo: { kind: 'none' },
    },
    {
      id: 'a2',
      action: 'set_standing',
      targetType: 'waterbody',
      targetId: 'w1',
      reason: 'dormant',
      createdAt: 900,
      actor: { userId: 'u', username: 'sarah', displayName: 'Sarah Berman' },
      undo: { kind: 'none' },
    },
  ]);
});

const statTile = (label: string) => {
  const el = screen.getByText(label, { selector: '[data-slot="stat-label"]' }).parentElement;
  if (el === null) throw new Error(`No tile labeled ${label}`);
  return el;
};

describe('the Overview at /admin', () => {
  it('opens Home, from the reads that exist', () => {
    render(<OverviewRoute />);
    expect(screen.getByRole('tab', { name: 'Home', selected: true })).toBeInTheDocument();
    const safety = screen.getByText('Safety').closest('[data-slot="count-row"]') as HTMLElement;
    expect(within(safety).getByText('1')).toBeInTheDocument();
    // The heads row counts the Inbox the read returned (1 + 2 + 3 + 1).
    expect(screen.getByText('7 in the inbox')).toBeInTheDocument();
    const feed = within(screen.getByRole('region', { name: 'Audit feed' }));
    expect(feed.getByText('Comment')).toBeInTheDocument();
    expect(feed.getByText('Body')).toBeInTheDocument();
  });

  it('draws whatever the server records as null as not recorded — no fixture, no zero', () => {
    mocks.results.set(getFunctionName(api.machinery.overviewJobs), null);
    mocks.results.set(getFunctionName(api.seasonWatch.homeSummary), {
      season: 2026,
      countsFrom: '2026-10-01',
      watch: null,
      winter: null,
      imagery: { state: 'not-started', granules: 0, lastLandedAt: null, lastFrameAt: null },
      firstSkate: null,
    });
    render(<OverviewRoute />);
    for (const label of ['Winter, region-wide', 'First skated', 'Cost · this season']) {
      expect(statTile(label)).toHaveTextContent('—Not recorded yet');
    }
    // A waiting watch and imagery not started are facts, not absences.
    expect(statTile('Ice watch')).toHaveTextContent('Waiting');
    expect(statTile('Imagery')).toHaveTextContent('Not started');
    const machinery = screen.getByRole('region', { name: 'Machinery' });
    expect(within(machinery).getByText('Not recorded yet')).toBeInTheDocument();
    expect(screen.getByText('Spend by month lands here')).toBeInTheDocument();
    // Nothing links to a page that doesn't exist yet.
    expect(screen.queryByRole('link', { name: /Ledger/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Health/ })).toBeNull();
    // Nothing from the stories' fixtures.
    for (const fixture of ['Mascoma Lake', '$75.80', 'Rob Tremblay', 'Campaign']) {
      expect(screen.queryByText(fixture, { exact: false })).toBeNull();
    }
    // The Corpus rows the server records as null are left out, not zeroed; a measured zero shows.
    expect(screen.queryByText('Pre-ice pass')).toBeNull();
    expect(screen.queryByText('Awaiting enrichment')).toBeNull();
    expect(screen.getByText('Chord re-fits')).toBeInTheDocument();
  });

  it('sends each link to the old page that does the work', () => {
    render(<OverviewRoute />);
    const row = (label: string) =>
      (screen.getByText(label).closest('[data-slot="count-row"]') as HTMLElement).querySelector(
        'a',
      );
    expect(row('Safety')).toHaveAttribute('href', '/admin/flags');
    expect(row('Requests')).toHaveAttribute('href', '/admin/water/requests');
    expect(row('Duplicates')).toHaveAttribute('href', '/admin/water/review');
    expect(row('Banned')).toHaveAttribute('href', '/admin/users');
  });

  it('opens a feed row on its old page', async () => {
    render(<OverviewRoute />);
    await userEvent.click(screen.getByText('Body'));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin/water/w1' });
    await userEvent.click(screen.getByText('Comment'));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin/flags' });
  });

  it('opens Metrics from the URL, every figure unread', () => {
    mocks.search = { tab: 'metrics' };
    render(<OverviewRoute />);
    expect(screen.getByRole('tab', { name: 'Metrics', selected: true })).toBeInTheDocument();
    for (const label of ['Open flags', 'Oldest open flag', 'Flags resolved', 'Open tickets']) {
      expect(statTile(label)).toHaveTextContent('—Not recorded yet');
    }
    expect(screen.queryByText('Nothing open')).toBeNull();
    expect(screen.queryByText('None resolved this season')).toBeNull();
  });

  it('draws Metrics from its reads, only on the days the page draws', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.UTC(2026, 10, 13, 15);
      vi.setSystemTime(now);
      const { days, opensOn } = seasonRecordWindow(2026, now);
      const keepingUp = (on: string[]) => ({
        season: 2026,
        opensOn,
        days: on,
        keepingUp: {
          openFlags: { total: 3, safety: 1 },
          oldestOpenFlag: null,
          resolvedWeek: null,
          resolveSeason: null,
          queueByDay: on.map(() => null),
          support: null,
        },
      });
      mocks.search = { tab: 'metrics' };
      mocks.results.set(getFunctionName(api.metrics.keepingUp), keepingUp(days));
      const { unmount } = render(<OverviewRoute />);
      expect(statTile('Open flags')).toHaveTextContent('3');
      unmount();
      // A read from either side of midnight waits until it matches the page's days.
      mocks.results.set(getFunctionName(api.metrics.keepingUp), keepingUp(days.slice(1)));
      render(<OverviewRoute />);
      expect(statTile('Open flags')).toHaveTextContent('—Not recorded yet');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the support half of Metrics out for a viewer who may not read it', () => {
    mocks.search = { tab: 'metrics' };
    mocks.support = false;
    render(<OverviewRoute />);
    expect(screen.queryByText('Open tickets')).toBeNull();
  });

  it('writes the tab into the URL, Home as no param', async () => {
    render(<OverviewRoute />);
    await userEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'metrics' } });
  });

  it.each([
    ['online', 'Live'],
    ['connecting', 'Checking'],
    ['offline', 'Not live'],
  ] as const)('wears the live mark %s as %s', (status, words) => {
    mocks.status = status;
    render(<OverviewRoute />);
    expect(screen.getByRole('button', { name: new RegExp(`^${words} —`) })).toBeInTheDocument();
  });
});

describe('liveStateOf', () => {
  it('reads the connection in the live mark’s states', () => {
    expect(liveStateOf('online')).toBe('live');
    expect(liveStateOf('connecting')).toBe('checking');
    expect(liveStateOf('offline')).toBe('off');
  });
});
