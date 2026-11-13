import { render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusBar } from '@/components/kit/status-bar';

const convex = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: [] as unknown[],
  asked: [] as string[],
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    // A skipped read is never sent and never answers, as Convex's own `useQuery` does.
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === 'skip') return undefined;
      convex.calls.push(args);
      convex.asked.push(getFunctionName(ref));
      return convex.results.get(getFunctionName(ref));
    },
  };
});

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { LiveMark } from './LiveMark';
import { OverviewHome } from './OverviewHome';
import { OverviewPage } from './OverviewPage';
import { HOME, HOME_MODERATOR, LAST_CHECKED_QUIET, NOW } from './overviewFixtures';
import { overviewHref } from './overviewLinks';
import { OverviewLamp, overviewStatus } from './overviewStatus';
import { FEED_LIMIT, useOverviewHome } from './useOverviewHome';

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('The render is missing what this test reads.');
  return value;
}

const rowNamed = (label: string) =>
  screen
    .getAllByText(label)
    .map((el) => el.closest('[data-slot="count-row"]'))
    .find((r): r is HTMLElement => r !== null);

// jsdom has no Web Animations; the kit skeleton's shimmer and Base UI's scroll area ask for it.
beforeAll(() => {
  if (!('animate' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finished: Promise.resolve() }),
    });
  }
  if (!('getAnimations' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: () => [],
    });
  }
});

describe('OverviewHome', () => {
  it('draws every block from its view model, links and all', () => {
    render(<OverviewHome data={HOME} now={NOW} />);
    const safety = rowNamed('Safety');
    expect(within(must(safety)).getByText('1')).toHaveAttribute('data-tone', 'bad');
    expect(safety?.querySelector('a')).toHaveAttribute('href', '/admin/inbox?lane=safety');
    expect(within(must(rowNamed('Banned'))).getByText('0')).toHaveAttribute('data-tone', 'dim');
    expect(within(must(rowNamed('Chord re-fits'))).getByText('2')).toHaveAttribute(
      'data-tone',
      'warn',
    );
    expect(within(must(rowNamed('Pre-ice pass'))).getByText('not run')).toHaveAttribute(
      'data-tone',
      'warn',
    );
    expect(within(must(rowNamed('Suspended'))).getByText('until 19 Jan')).toBeInTheDocument();
    expect(screen.getByText('Oldest open 4 d · median age 1.5 d')).toBeInTheDocument();
    expect(screen.getByText('And 28 more, all ok')).toBeInTheDocument();
    expect(screen.getByText('19 open')).toBeInTheDocument();
    expect(screen.getByText('38 users')).toBeInTheDocument();
    expect(screen.getByText('Campaign 12 Jan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ledger/ })).toHaveAttribute(
      'href',
      '/admin/machinery/ledger',
    );
    // The feed: the machine named as such, clock words on the pinned clock.
    const feed = within(screen.getByRole('region', { name: 'Audit feed' }));
    expect(feed.getByText('11:41')).toBeInTheDocument();
    expect(feed.getByText('Fri 22:14')).toBeInTheDocument();
    expect(feed.getAllByText('system').length).toBeGreaterThan(0);
  });

  it('leaves out what a moderator cannot open, with no mark where it was', () => {
    render(<OverviewHome data={HOME_MODERATOR} now={NOW} />);
    expect(screen.queryByText('Support')).toBeNull();
    expect(screen.queryByText('Appeals open')).toBeNull();
    expect(screen.getByText('17 open')).toBeInTheDocument();
  });

  it('says when the appeals count stopped at its bound, as every other count does', () => {
    const people = must(HOME.people);
    render(
      <OverviewHome
        data={{ ...HOME, people: { ...people, appealsOpen: { count: 200, capped: true } } }}
        now={NOW}
      />,
    );
    expect(within(must(rowNamed('Appeals open'))).getByText('200+')).toHaveAttribute(
      'data-tone',
      'default',
    );
  });

  it('holds every block’s place while nothing has landed', () => {
    render(<OverviewHome data={{}} now={NOW} />);
    const cards = document.querySelectorAll('[data-slot="count-card"]');
    expect(cards).toHaveLength(4);
    for (const card of cards) expect(card).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('region', { name: 'By month' })).toHaveAttribute('aria-busy', 'true');
  });

  it('routes every link through the page’s router, and opens a feed row’s target', async () => {
    const onOpenTarget = vi.fn();
    render(
      <OverviewHome
        data={HOME}
        now={NOW}
        onOpenTarget={onOpenTarget}
        // A link template: its content arrives from whatever renders through it.
        // biome-ignore lint/a11y/useAnchorContent: the content is cloned in
        linkTo={(to) => <a href={`#${to.kind}`} data-router="" />}
      />,
    );
    expect(screen.getByRole('link', { name: /Health/ })).toHaveAttribute('href', '#machinery');
    expect(rowNamed('Duplicates')?.querySelector('a')).toHaveAttribute('data-router', '');
    await userEvent.click(screen.getByText('Mascoma Lake'));
    expect(onOpenTarget).toHaveBeenCalledWith({
      type: 'waterbody',
      id: 'waterbody-a2',
      label: 'Mascoma Lake',
    });
  });

  it('says when every job is listed, and a list with some not ok', () => {
    render(
      <OverviewHome
        data={{
          machinery: {
            jobs: [{ id: 'x', name: 'Rollovers', state: 'never', at: null }],
            more: 0,
            moreAllOk: true,
          },
        }}
        now={NOW}
      />,
    );
    expect(screen.getByText('Every job is listed')).toBeInTheDocument();
    expect(screen.getByText('not run')).toBeInTheDocument();
  });
});

describe('overviewHref', () => {
  it('sends each target to its mode', () => {
    expect(overviewHref({ kind: 'inbox' })).toBe('/admin/inbox');
    expect(overviewHref({ kind: 'corpus', task: 'duplicates' })).toBe(
      '/admin/corpus?task=duplicates',
    );
    expect(overviewHref({ kind: 'corpus' })).toBe('/admin/corpus');
    expect(overviewHref({ kind: 'people' })).toBe('/admin/people');
    expect(overviewHref({ kind: 'people', list: 'banned' })).toBe('/admin/people?list=banned');
    expect(overviewHref({ kind: 'audit', type: 'waterbody', id: 'w 1' })).toBe('/admin/body/w%201');
    expect(overviewHref({ kind: 'audit', type: 'user', id: 'u' })).toBe('/admin/people/u');
    expect(overviewHref({ kind: 'audit', type: 'comment', id: 'c' })).toBe('/admin/reports?item=c');
    expect(overviewHref({ kind: 'audit', type: 'contentFlag', id: 'f' })).toBe(
      '/admin/inbox?item=f',
    );
  });
});

describe('OverviewPage', () => {
  it('is controlled: a tab press asks, and only the chosen panel is mounted', async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <OverviewPage
        value="home"
        onValueChange={onValueChange}
        tabs={[
          { value: 'home', label: 'Home', panel: <p>Home panel</p> },
          { value: 'metrics', label: 'Metrics', panel: <p>Metrics panel</p> },
        ]}
        heads={[{ kicker: 'Needs a hand', tone: 'bad', badges: ['1 stalled', '2 failed'] }]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('Home panel')).toBeInTheDocument();
    expect(screen.queryByText('Metrics panel')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(onValueChange).toHaveBeenCalledWith('metrics');
    // Nothing moves until the route says so.
    expect(screen.getByText('Home panel')).toBeInTheDocument();
    rerender(
      <OverviewPage
        value="metrics"
        onValueChange={onValueChange}
        tabs={[
          { value: 'home', label: 'Home', panel: <p>Home panel</p> },
          { value: 'metrics', label: 'Metrics', panel: <p>Metrics panel</p> },
        ]}
      />,
    );
    expect(screen.getByText('Metrics panel')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="heads"]')).toBeNull();
  });

  it('draws two states as two badges under their kicker', () => {
    render(
      <OverviewPage
        value="home"
        onValueChange={() => {}}
        tabs={[{ value: 'home', label: 'Home', panel: null }]}
        heads={[{ kicker: 'Needs a hand', tone: 'bad', badges: ['1 stalled', '2 failed'] }]}
      />,
    );
    const head = screen.getByRole('region', { name: 'Needs a hand' });
    expect(head.querySelectorAll('[data-slot="badge"]')).toHaveLength(2);
  });
});

describe('LiveMark', () => {
  it('says its state, and the quiet plate offers a refresh', async () => {
    const onRefresh = vi.fn();
    render(<LiveMark state="off" lastCheckedAt={LAST_CHECKED_QUIET} onRefresh={onRefresh} />);
    const mark = screen.getByRole('button', { name: /Not live/ });
    expect(mark).toHaveAttribute('data-state', 'off');
    await userEvent.click(mark);
    expect(await screen.findByText('11:53:34')).toBeInTheDocument();
    expect(screen.getByText('Refresh the page to catch up')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('shows the spinner while checking, and no time before it has ever heard', async () => {
    render(<LiveMark state="checking" lastCheckedAt={null} open />);
    expect(
      await screen.findByText('Checking', { selector: 'span:not([data-slot])' }),
    ).toBeVisible();
    expect(document.querySelector('[data-slot="live-spinner"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="live-time"]')).toBeNull();
  });

  it('draws the live plate with the time alone', async () => {
    const onOpenChange = vi.fn();
    render(<LiveMark state="live" lastCheckedAt={NOW - 29_000} onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Live/ }));
    expect(await screen.findByText('11:59:31')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe('the status bar’s integration points', () => {
  it('names safety, the machinery’s trouble and an unrun pass, a group each', () => {
    render(<StatusBar status={overviewStatus(HOME)} lamp={<OverviewLamp state="off" />} />);
    expect(screen.getByText('1 safety')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByText('1 stalled · 2 failed')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByText('1 late · 1 retried')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText('pre-ice pass not run')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Convex not live');
  });

  it('is quiet when nothing needs saying', () => {
    expect(overviewStatus({})).toEqual([]);
    expect(
      overviewStatus({
        inbox: {
          lanes: { ...must(HOME.inbox).lanes, safety: { count: 0, capped: false } },
          oldestOpenAt: null,
          medianOpenedAt: null,
        },
        machinery: { jobs: [], more: 3, moreAllOk: true },
        corpus: { ...must(HOME.corpus), preIcePass: { state: 'done', at: 1 } },
      }),
    ).toEqual([]);
    render(<OverviewLamp state="live" />);
    expect(screen.getByText('Convex live')).toBeInTheDocument();
  });
});

describe('useOverviewHome', () => {
  beforeEach(() => {
    convex.results.clear();
    convex.calls.length = 0;
    convex.asked.length = 0;
  });

  const admin = () => true;
  const moderator = (cap: string) => cap !== 'machinery.read' && cap !== 'inbox.support.read';

  it('is undefined block by block until each read lands', () => {
    const { result } = renderHook(() => useOverviewHome({ season: 2026, now: NOW, can: admin }));
    expect(result.current).toEqual({
      inbox: undefined,
      people: undefined,
      corpus: undefined,
      machinery: undefined,
      watch: undefined,
      winter: undefined,
      imagery: undefined,
      firstSkate: undefined,
      feed: undefined,
    });
    expect(convex.calls).toContainEqual({ limit: FEED_LIMIT });
    expect(convex.calls).toContainEqual({ season: 2026 });
    // Machinery is read on the minute, so a job falls late as the clock moves.
    expect(convex.calls).toContainEqual({ now: Math.floor(NOW / 60_000) * 60_000 });
  });

  it('asks only for what the viewer may read; Machinery is left out for a moderator', () => {
    const { result } = renderHook(() =>
      useOverviewHome({ season: 2026, now: NOW, can: moderator }),
    );
    expect(convex.asked).not.toContain(getFunctionName(api.machinery.overviewJobs));
    expect(result.current.machinery).toBe('withheld');
  });

  it('adapts each read, the Corpus counts over the intake rows, and the feeds in time order', () => {
    convex.results.set(getFunctionName(api.console.overview), {
      inbox: { ...must(HOME.inbox).lanes, oldestOpenAt: 5, medianOpenedAt: 6 },
      people: { ...must(HOME.people), totalUsers: null },
    });
    convex.results.set(getFunctionName(api.waterBodies.reviewQueueCounts), {
      'name-conflict': { count: 3, capped: false, advisory: true },
      'duplicate-candidate': { count: 8, capped: false, advisory: false },
    });
    convex.results.set(getFunctionName(api.console.corpusCounts), {
      duplicates: { count: 4, capped: false },
      chordRefits: { count: 2, capped: false },
      placeNames: { count: 237, capped: false },
      preIcePass: null,
      enrichment: null,
      campaignAt: 7,
    });
    convex.results.set(getFunctionName(api.machinery.overviewJobs), {
      jobs: [{ id: 'imagery-poll', name: 'Imagery poll', state: 'failed', at: NOW - 3_600_000 }],
      more: 22,
      moreAllOk: false,
      untracked: 22,
    });
    convex.results.set(getFunctionName(api.seasonWatch.homeSummary), {
      season: 2026,
      countsFrom: '2026-10-01',
      watch: null,
      winter: { state: 'not-yet' },
      imagery: { state: 'ended', granules: 4, lastLandedAt: null, lastFrameAt: 9 },
      firstSkate: { first: null, lastWinter: null },
    });
    convex.results.set(getFunctionName(api.moderation.listActions), [
      {
        id: 'x',
        action: 'hide',
        targetType: 'comment',
        targetId: 'c',
        reason: 'spam',
        createdAt: 1,
        actor: { userId: 'u', username: 'sarah', displayName: 'Sarah Berman' },
        undo: { kind: 'none' },
      },
    ]);
    convex.results.set(getFunctionName(api.console.systemFeed), [
      {
        id: 'import:r',
        at: 2,
        actor: null,
        action: 'Run failed',
        target: { type: 'importRun', id: 'r', label: 'VT canonical water' },
      },
    ]);
    const { result } = renderHook(() => useOverviewHome({ season: 2026, now: NOW, can: admin }));
    const r = result.current;
    expect(r.inbox?.oldestOpenAt).toBe(5);
    expect(r.inbox?.medianOpenedAt).toBe(6);
    expect(r.people?.totalUsers).toBeNull();
    expect(r.corpus?.nameConflicts).toEqual({ count: 3, capped: false });
    // Decisions, not rows: the Corpus counts replace the intake reasons' sum.
    expect(r.corpus?.duplicates).toEqual({ count: 4, capped: false });
    expect(r.corpus?.preIcePass).toBeNull();
    expect(r.machinery).toEqual({
      jobs: [{ id: 'imagery-poll', name: 'Imagery poll', state: 'failed', at: NOW - 3_600_000 }],
      more: 22,
      moreAllOk: false,
    });
    expect(r.watch).toEqual({ state: 'waiting', countsFrom: new Date(2026, 9, 1).getTime() });
    expect(r.imagery).toMatchObject({ state: 'ended', lastFrameAt: 9 });
    expect(r.feed?.map((row) => [row.actor, row.action])).toEqual([
      [null, 'Run failed'],
      ['Sarah', 'Hid'],
    ]);
  });
});
