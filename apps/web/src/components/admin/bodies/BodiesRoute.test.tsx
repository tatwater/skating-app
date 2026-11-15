import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The library as the app mounts it: its place from the URL, the library's server reads (mocked at
 * the Convex hooks), and every state a read can be in — loading, short, done, failed, capped —
 * said as such. Never a fixture.
 */

type Paged = {
  results: unknown[];
  status: 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted';
};

const mocks = vi.hoisted(() => ({
  /** A read's result by function name: a value, or a function of the read's arguments. */
  results: new Map<string, unknown>(),
  /** The arguments each read was last asked with (`'skip'` for one not asked). */
  calls: new Map<string, unknown>(),
  /**
   * Each `useQueries` hook's reads, render by render (one log per hook, so a test reads one read's
   * history whatever else renders) — a retry drops a read for one render.
   */
  queryLog: [] as string[][][],
  paged: { results: [], status: 'LoadingFirstPage' } as Paged,
  pagedError: null as Error | null,
  pagedCalls: [] as Array<{ args: unknown; initialNumItems: number }>,
  loadMore: vi.fn(),
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  denied: new Set<string>(),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  const { useRef } = await import('react');
  const answer = (name: string, args: unknown) => {
    const r = mocks.results.get(name);
    return typeof r === 'function' ? (r as (a: unknown) => unknown)(args) : r;
  };
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) => {
      const log = useRef<string[][] | null>(null);
      if (log.current === null) {
        log.current = [];
        mocks.queryLog.push(log.current);
      }
      log.current.push(Object.values(queries).map(({ query }) => getFunctionName(query)));
      return Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          mocks.calls.set(name, args);
          return [key, answer(name, args)];
        }),
      );
    },
    usePaginatedQuery: (ref: never, args: unknown, opts: { initialNumItems: number }) => {
      mocks.calls.set(getFunctionName(ref), args);
      mocks.pagedCalls.push({ args, initialNumItems: opts.initialNumItems });
      if (mocks.pagedError !== null) throw mocks.pagedError;
      return { ...mocks.paged, isLoading: false, loadMore: mocks.loadMore };
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (s: { location: { href: string } }) => unknown }) =>
    select({ location: { href: '/admin/bodies?lane=dormant' } }),
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: { from?: string };
    children?: ReactNode;
  }) => (
    <a href={to} data-from={search?.from} {...props}>
      {children}
    </a>
  ),
}));
// The status bar portals into the shell's chrome; here it draws in place, so its words can be read.
vi.mock('../shell/ConsoleShell', async (original) => ({
  ...(await original<typeof import('../shell/ConsoleShell')>()),
  ConsoleStatus: ({ groups }: { groups: readonly ReactNode[] }) => (
    <output aria-label="Status">{groups}</output>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => !mocks.denied.has(c) }),
}));

import { api } from '@skating/convex/api';
import { LIBRARY_MAX_START, LIBRARY_PAGE_SIZE } from '@skating/core';
import { getFunctionName } from 'convex/server';

import { KeysProvider } from '@/lib/keys';
import { resetConsoleReads } from '../reads/consoleReads';
import { BODY_PATH, BodiesRoute, resetShownMemory, startingPageSize } from './BodiesRoute';
import { resetScrollMemory } from './BodiesTable';
import { listKey, queryOf } from './bodiesSearch';
import { rememberOpened } from './openedRecently';

const ACRE = 4046.8564224;
const ID = 'k17abcdefghijklmnopqrstuvwxyz012';
const MINUTE = 60_000;

beforeAll(() => {
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
    ['scrollIntoView', () => {}],
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

const count = (n: number, capped = false) => ({ count: n, capped });

const SUMMARY = {
  laneCounts: {
    all: count(24871),
    active: count(1412),
    inactive: count(22901),
    not_in_campaign: count(411),
    moderator: count(14),
    no_public_access: count(72),
    removed: count(61),
    changed: count(500, true),
  },
  corpus: count(24871),
  states: ['NH', 'VT'],
  total: count(1412),
  facetCounts: {
    class: { lakePond: 1300, reservoir: 100, bay: 12 },
    size: { 'under-10': 412, '10-100': 561, '100-1000': 252, '1000-up': 187 },
  },
  serves: {
    sort: ['name', 'class', 'state', 'acres', 'complete', 'asks', 'reports', 'changed'],
    facets: ['class', 'size', 'outline', 'putins', 'reports', 'complete', 'curation'],
    states: true,
    search: true,
  },
};

const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  bodyClass: 'lakePond',
  states: ['NH'],
  areaSqM: 371 * ACRE,
  complete: { have: 8, of: 10, missing: ['lots', 'bathymetry'] },
  asks: 0,
  asksCapped: false,
  asksWaiting: false,
  reports: 3,
  reportsCapped: false,
  changedAt: null,
  standing: 'active',
  ...over,
});

beforeEach(() => {
  resetScrollMemory();
  resetShownMemory();
  window.localStorage.clear();
  mocks.search = {};
  mocks.navigate.mockReset();
  mocks.loadMore.mockReset();
  mocks.results.clear();
  mocks.calls.clear();
  mocks.pagedCalls.length = 0;
  mocks.queryLog.length = 0;
  mocks.paged = { results: [], status: 'LoadingFirstPage' };
  mocks.pagedError = null;
  mocks.denied = new Set();
  mocks.results.set(name(api.bodies.listSummary), SUMMARY);
  resetConsoleReads();
});
afterEach(() => vi.restoreAllMocks());

const name = (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref);
/** The render-by-render reads of the one `useQueries` hook that ever asked `ref`. */
const logOf = (ref: Parameters<typeof getFunctionName>[0]) =>
  mocks.queryLog.find((log) => log.some((reads) => reads.includes(name(ref)))) ?? [];
const view = () => (
  <KeysProvider>
    <BodiesRoute />
  </KeysProvider>
);
const mount = () => render(view());
const lanes = () => screen.getByRole('region', { name: 'Lanes' });
const grid = () => screen.getByRole('grid');

describe('the list', () => {
  it('asks the server for the lane, its order and a first page of the library’s size', () => {
    mocks.paged = {
      results: [row('a', 'Crystal Lake'), row('b', 'Post Pond')],
      status: 'CanLoadMore',
    };
    mount();
    const asked = mocks.calls.get(name(api.bodies.listPage)) as Record<string, unknown>;
    expect(asked).toMatchObject({ lane: 'active', sort: { column: 'reports', dir: 'desc' } });
    expect(typeof asked.now).toBe('number');
    expect(mocks.pagedCalls.at(-1)?.initialNumItems).toBe(LIBRARY_PAGE_SIZE);
    // The summary is asked the same place, short of the order (it counts; it doesn't sort).
    const { sort: _sort, ...place } = asked;
    expect(mocks.calls.get(name(api.bodies.listSummary))).toEqual(place);
    expect(within(grid()).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('1,412 of 24,871 in the corpus')).toBeInTheDocument();
  });

  it('asks a search’s other standings in one standing’s lane — never in All — and draws them', async () => {
    mocks.search = { lane: 'active', q: 'mor', size: '1000-up' };
    mocks.paged = { results: [row('a', 'Lake Morey')], status: 'Exhausted' };
    mocks.results.set(name(api.bodies.searchOtherStandings), {
      q: 'mor',
      groups: [
        { lane: 'inactive', count: 3, capped: false, rows: [row('d', 'Morey Pond')] },
        { lane: 'removed', count: 50, capped: true, rows: [] },
      ],
      facetsIgnored: true,
    });
    const { unmount } = mount();
    expect(mocks.calls.get(name(api.bodies.searchOtherStandings))).toMatchObject({
      lane: 'active',
      q: 'mor',
      facets: { size: ['1000-up'] },
    });
    expect(mocks.calls.get(name(api.bodies.searchOtherStandings))).not.toHaveProperty('sort');
    expect(
      await screen.findByText('1 active · 3 dormant · 50+ removed (other standings unfiltered)'),
    ).toBeInTheDocument();
    unmount();
    mocks.calls.clear();
    mocks.search = { lane: 'all', q: 'mor' };
    mount();
    expect(mocks.calls.has(name(api.bodies.searchOtherStandings))).toBe(false);
  });

  it('sends every narrowing to the server — the tab, the facets, the search — and sorts nothing itself', () => {
    mocks.search = { lane: 'all', state: 'VT', size: '1000-up', class: 'bay', q: 'mor' };
    mocks.paged = {
      results: [row('b', 'Post Pond', { reports: 9 }), row('a', 'Crystal Lake', { reports: 1 })],
      status: 'Exhausted',
    };
    mount();
    expect(mocks.calls.get(name(api.bodies.listPage))).toMatchObject({
      lane: 'all',
      state: 'VT',
      q: 'mor',
      facets: { class: ['bay'], size: ['1000-up'] },
    });
    // The read's order stands: no column orders a search, and the page never re-sorts a page.
    expect([...grid().querySelectorAll('[data-slot=body-name]')].map((n) => n.textContent)).toEqual(
      ['Post Pond', 'Crystal Lake'],
    );
    // A search answers its lane only: no other-standing group, and no tally pretending to be whole.
    expect(document.querySelector('[data-slot=search-tally]')).toBeNull();
    expect(grid().querySelector('[data-slot=table-group-row]')).toBeNull();
  });

  it('keeps asking past a page its scan budget cut short, and draws no end until done', () => {
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'CanLoadMore' };
    const { rerender } = mount();
    expect(mocks.loadMore).toHaveBeenCalledWith(LIBRARY_PAGE_SIZE);
    expect(screen.getByText('Loading more')).toBeInTheDocument();
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'Exhausted' };
    rerender(view());
    expect(screen.getByText('All 1,412')).toBeInTheDocument();
  });

  it('holds the table’s shape while the first page loads', () => {
    mount();
    expect(grid()).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('None here')).toBeNull();
  });

  it('says a failed page failed, and leaves the rest of the page standing', () => {
    mocks.pagedError = new Error('Not allowed');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    expect(within(lanes()).getByText('1,412')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Active bodies' })).toBeInTheDocument();
  });

  it('tries a failed list again from its own button, subscribing anew', async () => {
    mocks.pagedError = new Error('Not allowed');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    const asked = mocks.pagedCalls.length;
    mocks.pagedError = null;
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'Exhausted' };
    const note = document.querySelector('[data-slot=bodies-error]') as HTMLElement;
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveAttribute('aria-live', 'polite');
    const button = within(note).getByRole('button', { name: 'Try again' });
    // Reachable by the keyboard: a button in the tab order, pressed with Enter.
    act(() => button.focus());
    await userEvent.keyboard('{Enter}');
    expect(mocks.pagedCalls.length).toBeGreaterThan(asked);
    expect(screen.queryByText('Couldn’t read this list')).toBeNull();
    expect(screen.getByText('Crystal Lake')).toBeInTheDocument();
    // The note emptied where it stood (the same live region) and kept the focus: not the page.
    expect(document.querySelector('[data-slot=bodies-error]')).toBe(note);
    expect(document.activeElement).toBe(note);
  });

  it('holds a retried list as Trying again… until its first page lands, the note mounted throughout', async () => {
    mocks.pagedError = new Error('Not allowed');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = mount();
    const note = document.querySelector('[data-slot=bodies-error]') as HTMLElement;
    mocks.pagedError = null;
    mocks.paged = { results: [], status: 'LoadingFirstPage' };
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    // The boundary reset and the first page is on its way: pending, never "None here".
    expect(within(note).getByRole('button', { name: 'Trying again…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByText('None here')).toBeNull();
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'Exhausted' };
    rerender(view());
    expect(document.querySelector('[data-slot=bodies-error]')).toBe(note);
    expect(note).toBeEmptyDOMElement();
    expect(screen.getByText('Crystal Lake')).toBeInTheDocument();
  });

  it('a list that failed mid-way holds as Trying again… from the press, never its old rows between', async () => {
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'CanLoadMore' };
    const { rerender } = mount();
    mocks.pagedError = new Error('down');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rerender(view());
    const note = document.querySelector('[data-slot=bodies-error]') as HTMLElement;
    expect(note).toHaveTextContent('Couldn’t read this list');
    mocks.pagedError = null;
    mocks.paged = { results: [], status: 'LoadingFirstPage' };
    const records: MutationRecord[] = [];
    const seen = new MutationObserver((r) => records.push(...r));
    seen.observe(document.body, { childList: true, subtree: true });
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    records.push(...seen.takeRecords());
    seen.disconnect();
    // A removed node keeps the words it had: the failure's never left the note (so they aren't
    // announced again), and the rows read before the failure were never drawn back (then taken).
    const gone = (text: string) =>
      records.some((r) => [...r.removedNodes].some((n) => n.textContent?.includes(text)));
    expect(gone('Couldn’t read this list')).toBe(false);
    expect(gone('Crystal Lake')).toBe(false);
    expect(screen.queryByText('Crystal Lake')).toBeNull();
    expect(within(note).getByRole('button', { name: 'Trying again…' })).toBeInTheDocument();
  });

  it('a list drawn again after another lane starts on its first page, never the rows from before', () => {
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'Exhausted' };
    const { rerender } = mount();
    expect(screen.getByText('Crystal Lake')).toBeInTheDocument();
    mocks.search = { lane: 'opened' };
    rerender(view());
    mocks.search = {};
    mocks.paged = { results: [], status: 'LoadingFirstPage' };
    const records: MutationRecord[] = [];
    const seen = new MutationObserver((r) => records.push(...r));
    seen.observe(document.body, { childList: true, subtree: true });
    rerender(view());
    records.push(...seen.takeRecords());
    seen.disconnect();
    // A removed node keeps the words it had: the old rows were never drawn (then taken away).
    expect(
      records.some((r) => [...r.removedNodes].some((n) => n.textContent?.includes('Crystal Lake'))),
    ).toBe(false);
    expect(screen.queryByText('Crystal Lake')).toBeNull();
    expect(grid()).toHaveAttribute('aria-busy', 'true');
  });

  it('a list that failed and was left starts clean when it comes back — no old failure, no old retry', async () => {
    mocks.pagedError = new Error('down');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = mount();
    // Tried again, and left (another filter) before its first page landed.
    mocks.pagedError = null;
    mocks.paged = { results: [], status: 'LoadingFirstPage' };
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeInTheDocument();
    mocks.search = { state: 'VT' };
    mocks.paged = { results: [row('b', 'Post Pond')], status: 'Exhausted' };
    rerender(view());
    expect(screen.getByText('Post Pond')).toBeInTheDocument();
    // Back to the first list, its first page on its way: loading — not a failure, and not
    // Trying again….
    mocks.search = {};
    mocks.paged = { results: [], status: 'LoadingFirstPage' };
    rerender(view());
    expect(grid()).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Couldn’t read this list')).toBeNull();
    expect(screen.queryByRole('button', { name: /Try/ })).toBeNull();
  });

  it('announces a failure in a live region that was there before it', () => {
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'CanLoadMore' };
    const { rerender } = mount();
    const note = document.querySelector('[data-slot=bodies-error]') as HTMLElement;
    expect(note).toBeEmptyDOMElement();
    mocks.pagedError = new Error('down');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rerender(view());
    expect(document.querySelector('[data-slot=bodies-error]')).toBe(note);
    expect(note).toHaveTextContent('Couldn’t read this list');
  });

  it('comes back to a list with as many rows as it was showing, up to the library’s most', () => {
    const key = listKey(queryOf({}));
    mocks.paged = {
      results: Array.from({ length: 120 }, (_, i) => row(`r${i}`, `Pond ${i}`)),
      status: 'CanLoadMore',
    };
    const first = mount();
    first.unmount();
    expect(startingPageSize(key)).toBe(120);
    mount();
    expect(mocks.pagedCalls.at(-1)?.initialNumItems).toBe(120);
    expect(startingPageSize('another list')).toBe(LIBRARY_PAGE_SIZE);
    mocks.paged = {
      results: Array.from({ length: LIBRARY_MAX_START + 80 }, (_, i) => row(`r${i}`, `Pond ${i}`)),
      status: 'CanLoadMore',
    };
    mount();
    expect(startingPageSize(key)).toBe(LIBRARY_MAX_START);
  });

  it('reads against the minute the list was opened, so a new minute never restarts it', () => {
    let clock = Date.UTC(2027, 0, 16, 17, 0, 30);
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'CanLoadMore' };
    const { rerender } = mount();
    const opened = (mocks.calls.get(name(api.bodies.listPage)) as { now: number }).now;
    expect(opened).toBe(Date.UTC(2027, 0, 16, 17));
    clock += 5 * MINUTE;
    rerender(view());
    expect((mocks.calls.get(name(api.bodies.listPage)) as { now: number }).now).toBe(opened);
    // Another place is another list: it reads the clock again.
    mocks.search = { lane: 'inactive' };
    rerender(view());
    expect((mocks.calls.get(name(api.bodies.listPage)) as { now: number }).now).toBe(
      Date.UTC(2027, 0, 16, 17, 5),
    );
  });

  it('asks no server list for this browser’s own lane, nor anything for a viewer without the library', () => {
    mocks.search = { lane: 'opened' };
    const { unmount } = mount();
    expect(mocks.pagedCalls).toHaveLength(0);
    expect(screen.getByText('None here')).toBeInTheDocument();
    unmount();
    mocks.search = {};
    mocks.denied = new Set(['body.read']);
    mocks.calls.clear();
    mount();
    expect(mocks.pagedCalls).toHaveLength(0);
    expect(mocks.calls.has(name(api.bodies.listSummary))).toBe(false);
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
  });
});

describe('the counts', () => {
  it('still count every lane on one no server read lists, from All’s summary', () => {
    mocks.search = { lane: 'opened' };
    mount();
    expect(mocks.calls.get(name(api.bodies.listSummary))).toEqual({
      lane: 'all',
      now: expect.any(Number),
    });
    expect(within(lanes()).getByRole('button', { name: /^Active/ })).toHaveTextContent('1,412');
  });

  it('count every lane, the capped Changed count in its capped style', () => {
    mount();
    expect(within(lanes()).getByRole('button', { name: /^Changed this week/ })).toHaveTextContent(
      '500+',
    );
    expect(within(lanes()).getByRole('button', { name: /^All bodies/ })).toHaveTextContent(
      '24,871',
    );
    // This browser's own lane has no server count.
    expect(
      within(lanes()).getByRole('button', { name: /^Opened recently/ }).textContent,
    ).not.toMatch(/\d/);
  });

  it('show the menu’s counts the read answers, and no number where it answers none', async () => {
    mocks.search = { size: '1000-up' };
    mocks.results.set(name(api.bodies.listSummary), {
      ...SUMMARY,
      total: count(187),
      facetCounts: { size: SUMMARY.facetCounts.size },
    });
    mount();
    expect(screen.getByText('187 of 1,412 active · 1,000 ac and up')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const menu = await screen.findByRole('dialog', { name: 'Filter' });
    expect(within(menu).getByRole('button', { name: /^1,000 and up/ })).toHaveTextContent('187');
    // Class isn't counted with a size applied: no number — never a zero, never the last one.
    const bay = within(menu).getByRole('button', { name: /^Bay/ });
    expect(bay.querySelector('[data-slot=facet-menu-count]')).toBeNull();
  });

  it('shows no reports count while the season turns — no total, no option numbers, never a zero', async () => {
    mocks.search = { reports: 'season' };
    const { reports: _turning, ...others } = { ...SUMMARY.facetCounts, reports: undefined };
    mocks.results.set(name(api.bodies.listSummary), {
      ...SUMMARY,
      total: null,
      facetCounts: others,
    });
    mount();
    // The chip says what the URL says; the kicker carries no number.
    expect(
      screen.getByText('Reported this season', { selector: '[data-slot=bodies-kicker]' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ of 1,412 active/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const menu = await screen.findByRole('dialog', { name: 'Filter' });
    for (const label of [/^Reported this season/, /^Never reported/]) {
      expect(
        within(menu)
          .getByRole('button', { name: label })
          .querySelector('[data-slot=facet-menu-count]'),
      ).toBeNull();
    }
  });

  it('never shows a stale count while this query’s summary is on its way', async () => {
    const first = mount();
    mocks.search = { class: 'bay' };
    // The new place's summary hasn't landed.
    mocks.results.set(name(api.bodies.listSummary), (args: { facets?: unknown }) =>
      args.facets === undefined ? SUMMARY : undefined,
    );
    first.rerender(view());
    // The lanes hold their counts (a filter doesn't move them); the list's total and menu don't.
    expect(within(lanes()).getByText('1,412')).toBeInTheDocument();
    expect(screen.queryByText(/ of 1,412 active/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const menu = await screen.findByRole('dialog', { name: 'Filter' });
    expect(menu.querySelector('[data-slot=facet-menu-count]')).toBeNull();
  });

  it('say when they couldn’t be read, and leave every count out', () => {
    mocks.results.set(name(api.bodies.listSummary), new Error('nope'));
    mount();
    // Said at the lanes' foot (the counts are theirs), not in the one-line status bar.
    expect(lanes().querySelector('[data-slot=counts-error]')).toHaveTextContent(
      'Counts couldn’t be read',
    );
    expect(screen.getByRole('status', { name: 'Status' })).not.toHaveTextContent(/Counts/);
    expect(within(lanes()).queryByText('1,412')).toBeNull();
    expect(screen.queryByText(/in the corpus/)).toBeNull();
  });

  it('try a failed summary again once — the read dropped for one render, the note holding as pending and keeping focus, no count shown meanwhile', async () => {
    mocks.results.set(name(api.bodies.listSummary), new Error('nope'));
    const { rerender } = mount();
    const foot = () => lanes().querySelector('[data-slot=counts-error]');
    const note = foot() as HTMLElement;
    expect(note).toHaveAttribute('aria-live', 'polite');
    const log = logOf(api.bodies.listSummary);
    const before = log.length;
    // The server hasn't answered yet: the read comes back on its way.
    mocks.results.set(name(api.bodies.listSummary), undefined);
    const button = within(note).getByRole('button', { name: 'Try again' });
    act(() => button.focus());
    await userEvent.keyboard('{Enter}');
    rerender(view());
    // Pending: the note holds, Try again again does nothing more, and no count is drawn — not 0,
    // not the last one held.
    const pending = within(note).getByRole('button', { name: 'Trying again…' });
    await userEvent.click(pending);
    expect(within(lanes()).queryByText('1,412')).toBeNull();
    expect(within(lanes()).queryByText('0')).toBeNull();
    const dropped = log
      .slice(before)
      .filter((reads) => !reads.includes(name(api.bodies.listSummary)));
    expect(dropped.length).toBeGreaterThan(0);
    // The fresh answer lands: counted, the note empty where it stood, focus still in it.
    mocks.results.set(name(api.bodies.listSummary), SUMMARY);
    rerender(view());
    expect(within(lanes()).getByText('1,412')).toBeInTheDocument();
    expect(foot()).toBe(note);
    expect(note).toBeEmptyDOMElement();
    expect(document.activeElement).toBe(note);
    // Dropped in one run of renders only: never let go of twice for the one retry.
    const runs = log
      .slice(before)
      .map((reads) => reads.includes(name(api.bodies.listSummary)))
      .join('')
      .split('true')
      .filter((r) => r !== '');
    expect(runs).toHaveLength(1);
  });
});

describe('Opened recently, this browser’s own', () => {
  const A = 'k17aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const B = 'k17bbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const C = 'k17ccccccccccccccccccccccccccccc';
  const ok = (id: string, bodyName: string, over: Record<string, unknown> = {}) => ({
    requested: id,
    status: 'ok',
    row: row(id, bodyName, over),
  });
  const answer = (entries: unknown[], dropped = 0) => ({ entries, dropped });
  const names = () =>
    [...grid().querySelectorAll('[data-slot=body-name]')].map((n) => n.textContent);

  it('lists the bodies this browser opened, newest first, as the library lists them — one read', () => {
    rememberOpened(A);
    rememberOpened(B);
    mocks.search = { lane: 'opened' };
    mocks.results.set(
      name(api.bodies.rowsByIds),
      answer([ok(B, 'Lake Morey', { reports: 4 }), ok(A, 'Mascoma Lake')]),
    );
    mount();
    expect(mocks.pagedCalls).toHaveLength(0);
    expect(mocks.calls.get(name(api.bodies.rowsByIds))).toEqual({
      ids: [B, A],
      now: expect.any(Number),
    });
    expect(names()).toEqual(['Lake Morey', 'Mascoma Lake']);
    // The library's own row: its reports are drawn, not "not recorded".
    expect(within(grid()).getAllByRole('row')[0]).toHaveTextContent('4');
    expect(within(lanes()).getByRole('button', { name: /^Opened recently/ })).toHaveTextContent(
      '2',
    );
    // Nothing narrows or orders a list the server doesn't answer.
    expect(screen.getByRole('button', { name: /Filter/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Acres' })).toBeNull();
  });

  it('holds while the read is on its way', () => {
    rememberOpened(A);
    mocks.search = { lane: 'opened' };
    mount();
    expect(grid()).toHaveAttribute('aria-busy', 'true');
  });

  it('says the ids the library didn’t list, never leaving one out unsaid', () => {
    rememberOpened(A);
    rememberOpened(B);
    rememberOpened(C);
    mocks.search = { lane: 'opened' };
    mocks.results.set(
      name(api.bodies.rowsByIds),
      answer([
        { requested: C, status: 'unknown', row: null },
        { requested: B, status: 'unlisted', row: null },
        ok(A, 'Mascoma Lake'),
      ]),
    );
    mount();
    expect(names()).toEqual(['Mascoma Lake']);
    expect(
      screen.getByText('All 1 · 1 opened isn’t in the library · 1 is no longer a body'),
    ).toBeInTheDocument();
  });

  it('says a failed read failed — never a body quietly left out — and tries it again', async () => {
    rememberOpened(A);
    mocks.search = { lane: 'opened' };
    mocks.results.set(name(api.bodies.rowsByIds), new Error('nope'));
    mount();
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    expect(
      within(lanes()).getByRole('button', { name: /^Opened recently/ }).textContent,
    ).not.toMatch(/\d/);
    mocks.results.set(name(api.bodies.rowsByIds), answer([ok(A, 'Mascoma Lake')]));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(names()).toEqual(['Mascoma Lake']);
  });

  it('marks no search it doesn’t answer, and never says nothing matches it', () => {
    rememberOpened(A);
    // A name the search would match: nothing is marked, since the lane's read doesn't search.
    mocks.search = { lane: 'opened', q: 'mas' };
    mocks.results.set(name(api.bodies.rowsByIds), answer([ok(A, 'Mascoma Lake')]));
    mount();
    expect(grid().querySelector('mark')).toBeNull();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
    expect(document.querySelector('[data-slot=search-tally]')).toBeNull();
  });

  it('lists a merged body once, as the survivor the read follows', () => {
    rememberOpened(A);
    rememberOpened(B);
    mocks.search = { lane: 'opened' };
    // B was merged into A: the read follows the merge and returns A's row for it.
    mocks.results.set(
      name(api.bodies.rowsByIds),
      answer([
        { requested: B, status: 'merged', row: row(A, 'Mascoma Lake'), survivorId: A },
        ok(A, 'Mascoma Lake'),
      ]),
    );
    mount();
    expect(names()).toEqual(['Mascoma Lake']);
    expect(screen.getByText('All 1')).toBeInTheDocument();
  });

  it('is an empty lane, not a broken page, when storage has nothing or can’t be read', () => {
    mocks.search = { lane: 'opened' };
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Opened recently');
    expect(screen.queryAllByRole('row').filter((r) => r.querySelector('td') !== null)).toEqual([]);
    expect(mocks.calls.has(name(api.bodies.rowsByIds))).toBe(false);
    get.mockRestore();
  });
});

describe('the place in the URL', () => {
  it('navigates to the same route with the new search, replacing for a row', async () => {
    mocks.search = { lane: 'moderator' };
    mocks.paged = {
      results: [row(ID, 'Echo Lake', { standing: 'moderator' })],
      status: 'Exhausted',
    };
    mount();
    await userEvent.click(screen.getByText('Echo Lake'));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '.',
      search: { lane: 'moderator', body: ID },
      replace: true,
    });
    await userEvent.click(screen.getByRole('button', { name: /^Active/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '.', search: {} });
  });

  it('opens a body at its console, the id escaped as every other link to it is', () => {
    expect(BODY_PATH(ID)).toBe(`/admin/body/${ID}`);
    expect(BODY_PATH('k1/7')).toBe('/admin/body/k1%2F7');
  });
});

describe('the preview', () => {
  const body = {
    _id: ID,
    name: 'Mascoma Lake',
    type: 'reservoir',
    states: ['NH'],
    centroid: { lat: 43.63, lng: -72.15 },
    bbox: { minLng: -72.18, minLat: 43.6, maxLng: -72.12, maxLat: 43.65 },
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-72.18, 43.6],
          [-72.12, 43.6],
          [-72.12, 43.65],
          [-72.18, 43.6],
        ],
      ],
    },
    surfaceAreaSqM: 1143 * ACRE,
    dedupStatus: 'clean',
  };

  const facts = {
    season: {
      count: 3,
      capped: false,
      recordOpen: true,
      byVantage: { on_ice: 2, shore: 1, secondhand: 0, unstated: 0 },
    },
    allTime: { count: 86, capped: false, firstSeason: 2023 },
    asks: [
      {
        id: 'q1',
        kind: 'request',
        requestKind: 'name_bay',
        name: 'Shaker cove',
        note: 'Near the Shaker Bridge launch',
        createdAt: 1,
      },
    ],
    town: 'Enfield',
    moreTowns: ['Canaan'],
    townState: 'NH',
    moreTownsWithState: [{ name: 'Canaan', state: 'NH' }],
    intake: [],
    complete: { have: 9, of: 10, missing: ['bathymetry'] },
  };

  const open = () => {
    mocks.search = { body: ID };
    mocks.results.set(name(api.waterBodies.get), { available: true, body });
    mocks.results.set(name(api.putIns.listForBody), []);
    mocks.results.set(name(api.subAreas.listForBody), [{}, {}]);
    mocks.results.set(name(api.bodies.preview), facts);
    mocks.results.set(name(api.bodyConsole.history), { entries: [], capped: false });
  };
  const pane = () => screen.getByRole('region', { name: 'Preview' });

  it('reads the open body and its facts, words them, and opens its console', async () => {
    open();
    mount();
    expect(mocks.calls.get(name(api.bodyConsole.history))).toEqual({
      waterBodyId: ID,
      limit: 7,
    });
    expect(mocks.calls.get(name(api.bodies.preview))).toMatchObject({ waterBodyId: ID });
    expect(within(pane()).getByRole('heading', { name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(within(pane()).getByText(/2 bays/)).toBeInTheDocument();
    expect(within(pane()).getByText('Reservoir · Enfield, NH ·')).toBeInTheDocument();
    expect(within(pane()).getByText('2 on the ice · 1 from shore')).toBeInTheDocument();
    expect(within(pane()).getByText('Since 2023–24')).toBeInTheDocument();
    expect(within(pane()).getByText('Bay name · Inbox')).toBeInTheDocument();
    expect(within(pane()).getByText('Missing bathymetry')).toBeInTheDocument();
    expect(within(pane()).getByRole('meter', { name: 'Complete' })).toHaveAttribute(
      'aria-valuenow',
      '9',
    );
    const link = within(pane())
      .getByText(/Open in Body/)
      .closest('a');
    expect(link).toHaveAttribute('href', `/admin/body/${ID}`);
    expect(link).toHaveAttribute('data-from', '/admin/bodies?lane=dormant');
    act(() => pane().focus());
    await userEvent.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: `/admin/body/${ID}`,
      // The list's own address rides along, so the console's way back finds it as it was.
      search: { from: '/admin/bodies?lane=dormant' },
    });
  });

  it('skips the history for a viewer who can’t read the audit', () => {
    open();
    mocks.denied = new Set(['audit.read']);
    mount();
    expect(mocks.calls.has(name(api.bodyConsole.history))).toBe(false);
    expect(screen.queryByText('Last changed')).toBeNull();
  });

  it('says what failed, block by block', () => {
    open();
    mocks.results.set(name(api.bodies.preview), new Error('nope'));
    mocks.results.set(name(api.bodyConsole.history), new Error('nope'));
    mocks.results.set(name(api.putIns.listForBody), new Error('nope'));
    const { rerender } = mount();
    expect(
      within(pane()).getByText('Reports, completeness and asks couldn’t be read'),
    ).toBeInTheDocument();
    expect(within(pane()).getByText('Couldn’t read the history')).toBeInTheDocument();
    // A failed put-ins read is said, never drawn like a body with none.
    expect(within(pane()).getByText('Put-ins and bays couldn’t be read')).toBeInTheDocument();
    mocks.results.set(name(api.waterBodies.get), new Error('nope'));
    rerender(view());
    expect(within(pane()).getByText('Couldn’t read this body')).toBeInTheDocument();
  });

  it('tries the preview’s failed reads again, each from its own button, and only those', async () => {
    open();
    mocks.results.set(name(api.bodies.preview), new Error('nope'));
    mocks.results.set(name(api.bodyConsole.history), new Error('nope'));
    mount();
    expect(within(pane()).getAllByRole('button', { name: 'Try again' })).toHaveLength(2);
    mocks.results.set(name(api.bodies.preview), facts);
    mocks.results.set(name(api.bodyConsole.history), { entries: [], capped: false });
    const log = logOf(api.bodies.preview);
    const before = log.length;
    const button = within(pane()).getAllByRole('button', { name: 'Try again' })[0] as HTMLElement;
    act(() => button.focus());
    await userEvent.keyboard('{Enter}');
    // Waits for the state it describes — the reads taken back and the fresh answer drawn — rather
    // than sampling the renders once, at whatever moment the press resolved.
    await waitFor(() =>
      expect(within(pane()).getByText('2 on the ice · 1 from shore')).toBeInTheDocument(),
    );
    const after = log.slice(before);
    // The failed reads were dropped for a render and taken up again; the body's read never was.
    expect(after.map((reads) => reads.includes(name(api.bodies.preview)))).toContain(false);
    expect(after.map((reads) => reads.includes(name(api.bodyConsole.history)))).toContain(false);
    expect(after.at(-1)).toEqual(expect.arrayContaining([name(api.bodies.preview)]));
    expect(after.every((reads) => reads.includes(name(api.waterBodies.get)))).toBe(true);
    expect(within(pane()).queryByText('Couldn’t read the history')).toBeNull();
    expect(within(pane()).queryByRole('button', { name: 'Try again' })).toBeNull();
    // The note emptied where it stood and kept the focus — never dropped to the page.
    expect(document.activeElement).not.toBe(document.body);
    expect(pane().contains(document.activeElement)).toBe(true);
  });

  it('moves a body merged away to its survivor, never drawing the one over the other’s facts', () => {
    open();
    const survivor = 'k17survivorsurvivorsurvivor00000';
    mocks.results.set(name(api.waterBodies.get), {
      available: true,
      body: { ...body, _id: survivor },
    });
    mount();
    // The pane holds while the place moves to the survivor, whose reads are all the survivor's.
    expect(pane().querySelector('[data-slot=preview-scroll]')).toHaveAttribute('aria-busy', 'true');
    expect(within(pane()).queryByRole('heading', { name: 'Mascoma Lake' })).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '.',
      search: { body: survivor },
      replace: true,
    });
  });

  it('holds the body’s shape while it loads', () => {
    mocks.search = { body: ID };
    mount();
    expect(pane().querySelector('[data-slot=preview-scroll]')).toHaveAttribute('aria-busy', 'true');
  });

  it('never sends a junk id to a query, and says nothing is open', () => {
    mocks.search = { body: 'not-an-id' };
    mount();
    expect(mocks.calls.has(name(api.waterBodies.get))).toBe(false);
    expect(screen.getByText('No body open')).toBeInTheDocument();
  });

  it('draws a rejected body from its list row, and offers no way into the console', async () => {
    mocks.search = { lane: 'removed', body: ID };
    mocks.paged = {
      results: [
        row(ID, 'Echo Lake', { standing: 'rejected', changedAt: Date.now() - 3 * 86_400_000 }),
      ],
      status: 'Exhausted',
    };
    mocks.results.set(name(api.waterBodies.get), { available: false });
    mount();
    expect(screen.queryByText('No body open')).toBeNull();
    expect(within(pane()).getByRole('heading', { name: 'Echo Lake' })).toBeInTheDocument();
    expect(within(pane()).getByText('Rejected')).toBeInTheDocument();
    expect(within(pane()).getByText(/^Last changed /)).toBeInTheDocument();
    expect(
      within(pane()).getByText('The full preview isn’t available for a rejected body.'),
    ).toBeInTheDocument();
    expect(within(pane()).queryByText(/Open in Body/)).toBeNull();
    act(() => pane().focus());
    await userEvent.keyboard('{Enter}');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('says plainly what it can’t show for an unlisted body the list doesn’t hold', () => {
    mocks.search = { body: ID };
    mocks.results.set(name(api.waterBodies.get), { available: false });
    // While the first page is on its way the row may yet arrive: the pane holds its shape.
    const first = mount();
    expect(pane().querySelector('[data-slot=preview-scroll]')).toHaveAttribute('aria-busy', 'true');
    expect(within(pane()).queryByText(/isn’t available/)).toBeNull();
    mocks.paged = { results: [row('a', 'Crystal Lake')], status: 'Exhausted' };
    first.rerender(view());
    expect(screen.queryByText('No body open')).toBeNull();
    expect(
      within(pane()).getByText('The full preview isn’t available for a body that isn’t listed.'),
    ).toBeInTheDocument();
  });

  it('says nothing is open for a body that doesn’t exist', () => {
    mocks.search = { body: ID };
    mocks.results.set(name(api.waterBodies.get), null);
    mount();
    expect(screen.getByText('No body open')).toBeInTheDocument();
  });
});
