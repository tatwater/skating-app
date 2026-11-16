import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { BodiesTable, resetScrollMemory } from './BodiesTable';
import { BodiesView, type BodiesViewProps } from './BodiesView';
import { otherTowns, TOOLTIP_TOWNS } from './BodyPreview';
import { type BodiesListData, UNREAD_LIST } from './bodiesData';
import {
  CORPUS,
  LANE_COUNTS,
  LIST_ACTIVE,
  LIST_BIG,
  LIST_SEARCH,
  NOW,
  PREVIEW_MASCOMA,
  PREVIEW_MOREY,
} from './bodiesFixtures';
import type { BodyRow } from './bodiesModel';
import { type BodiesQuery, queryOf } from './bodiesSearch';
import { laneById } from './bodyLanes';
import { SEARCH_DEBOUNCE_MS } from './ListTools';

/**
 * The library page from props: every change of place goes out through `onQueryChange` (the URL),
 * the keyboard follows the founder's rules, and what no read serves is said, never invented.
 */

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

beforeEach(() => resetScrollMemory());
afterEach(() => vi.useRealTimers());

type HarnessProps = Partial<BodiesViewProps> & {
  initial?: BodiesQuery;
  spy?: BodiesViewProps['onQueryChange'];
};

function Harness({ initial = queryOf({ body: 'mascoma-lake' }), spy, ...props }: HarnessProps) {
  const [query, setQuery] = useState(initial);
  return (
    <KeysProvider>
      <div style={{ height: 900 }}>
        <BodiesView
          query={query}
          onQueryChange={(next, how) => {
            setQuery(next);
            spy?.(next, how);
          }}
          list={LIST_ACTIVE}
          laneCounts={LANE_COUNTS}
          corpus={CORPUS}
          preview={query.bodyId === 'mascoma-lake' ? PREVIEW_MASCOMA : null}
          now={NOW}
          onOpenBody={() => {}}
          {...props}
        />
      </div>
    </KeysProvider>
  );
}

const grid = () => screen.getByRole('grid');

describe('the page', () => {
  it('draws board 5.1: the lane, its kicker, the table and the open body', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { level: 1, name: 'Active bodies' })).toBeInTheDocument();
    expect(screen.getByText('1,412 of 24,871 in the corpus')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Active/ })).toHaveAttribute('aria-current', 'true');
    expect(within(grid()).getAllByRole('row')).toHaveLength(LIST_ACTIVE.rows.length);
    const chosen = within(grid())
      .getAllByRole('row')
      .find((r) => r.getAttribute('aria-selected') === 'true');
    expect(chosen).toHaveTextContent('Mascoma Lake');
    expect(screen.getByRole('heading', { level: 2, name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(screen.getByText('Reservoir · Enfield, NH ·')).toBeInTheDocument();
  });

  it('says in the preview’s kicker that the towns aren’t computed yet, never that there are none', () => {
    render(
      <Harness
        preview={{ ...PREVIEW_MASCOMA, town: null, moreTowns: [], townsNotComputed: true }}
      />,
    );
    expect(screen.getByText('Reservoir · NH · Towns not computed yet')).toBeInTheDocument();
  });

  it('names a big lake’s other towns up to a dozen, then counts the rest', () => {
    const many = Array.from({ length: 39 }, (_, i) => `Town ${i + 1}`);
    const words = otherTowns({ states: ['NY', 'VT'], moreTowns: many });
    expect(words.split(' · ')).toHaveLength(TOOLTIP_TOWNS);
    expect(words.endsWith('Town 12 and 27 more')).toBe(true);
    expect(otherTowns({ states: ['NH'], moreTowns: ['Canaan'] })).toBe('Canaan, NH');
  });

  it('picks a lane as a fresh list: no body, search, tab, filter or order carried over', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({ body: 'x', q: 'mor', size: '1000-up' })} />);
    await userEvent.click(screen.getByRole('button', { name: /^Dormant · moderator/ }));
    const next = spy.mock.lastCall?.[0] as BodiesQuery;
    expect(next.lane.id).toBe('moderator');
    expect(next).toMatchObject({ bodyId: null, q: '', state: null, facets: {} });
    expect(next.sort).toEqual(next.lane.sort);
  });

  it('keeps its place when the lane on screen is picked again', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({ q: 'mor' })} />);
    await userEvent.click(screen.getByRole('button', { name: /^Active/ }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('sorts by a heading, and again reverses it', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await userEvent.click(screen.getByRole('button', { name: 'Acres' }));
    expect(spy.mock.lastCall?.[0].sort).toEqual({ column: 'acres', dir: 'desc' });
    await userEvent.click(screen.getByRole('button', { name: 'Acres' }));
    expect(spy.mock.lastCall?.[0].sort).toEqual({ column: 'acres', dir: 'asc' });
  });

  it('opens a clicked row in the preview without stacking history', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await userEvent.click(screen.getByText('Crystal Lake'));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ bodyId: 'crystal-lake' }), {
      replace: true,
    });
  });

  it('applies the state tab', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await userEvent.click(screen.getByRole('button', { name: 'VT' }));
    expect(spy.mock.lastCall?.[0].state).toBe('VT');
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(spy.mock.lastCall?.[0].state).toBeNull();
  });
});

describe('the keyboard', () => {
  it('moves with ↑↓, opens with ⏎ into the preview, comes back with ⇧⏎', async () => {
    const spy = vi.fn();
    const onOpenBody = vi.fn();
    render(<Harness spy={spy} onOpenBody={onOpenBody} />);
    act(() => grid().focus());
    expect(grid().getAttribute('aria-activedescendant')).toMatch(/mascoma-lake$/);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(grid().getAttribute('aria-activedescendant')).toMatch(/lake-morey$/);
    await userEvent.keyboard('{End}');
    expect(grid().getAttribute('aria-activedescendant')).toMatch(/lake-eden$/);
    await userEvent.keyboard('{Home}{ }');
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ bodyId: 'mascoma-lake' }), {
      replace: true,
    });
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(preview).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenBody).toHaveBeenCalledWith('mascoma-lake');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(grid()).toHaveFocus();
  });

  it('types ahead by name, a letter again cycling; G and ? pass through', async () => {
    render(<Harness />);
    act(() => grid().focus());
    await userEvent.keyboard('ne');
    expect(grid().getAttribute('aria-activedescendant')).toMatch(/newfound-lake$/);
    await userEvent.keyboard('{Home}');
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('p');
    expect(grid().getAttribute('aria-activedescendant')).toMatch(/post-pond$/);
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('p');
    expect(grid().getAttribute('aria-activedescendant')).toMatch(/pemigewasset-lake$/);
    const before = grid().getAttribute('aria-activedescendant');
    await new Promise((r) => setTimeout(r, 600));
    await userEvent.keyboard('g');
    expect(grid().getAttribute('aria-activedescendant')).toBe(before);
  });

  it('sends / to the search', async () => {
    render(<Harness />);
    act(() => grid().focus());
    await userEvent.keyboard('/');
    expect(screen.getByRole('searchbox', { name: 'Find a body' })).toHaveFocus();
  });

  it('opens the filter with F from the list’s tools, but not while typing in the rows', async () => {
    render(<Harness />);
    act(() => grid().focus());
    await userEvent.keyboard('f');
    expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull();
    act(() => screen.getByRole('button', { name: 'All' }).focus());
    await userEvent.keyboard('f');
    expect(await screen.findByRole('dialog', { name: 'Filter' })).toBeInTheDocument();
  });
});

describe('the keyboard reaches what a click does', () => {
  it('the lanes, the tools, the rows and the preview all answer the keyboard', () => {
    const { container } = render(
      <Harness list={LIST_BIG} initial={queryOf({ size: '1000-up' })} />,
    );
    expect(expectKeyboardOperable(container).length).toBeGreaterThan(0);
  });
});

describe('the cursor in view', () => {
  it.each([
    ['ArrowDown', ['ArrowDown']],
    ['End', ['End']],
    ['Home', ['End', 'Home']],
    ['type-ahead', ['m']],
  ])('%s scrolls the cursor’s row into view at its nearest edge, never smoothly', (_n, keys) => {
    const scrolled: { id: string; options: unknown }[] = [];
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push({ id: this.id, options });
    });
    try {
      render(<Harness initial={queryOf({})} />);
      grid().focus();
      for (const key of keys) fireEvent.keyDown(grid(), { key });
      expect(scrolled.at(-1)?.id).toBe(grid().getAttribute('aria-activedescendant'));
      expect(scrolled.at(-1)?.options).toEqual({ block: 'nearest' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the search', () => {
  it('asks only once the typing settles, and ranks by match', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByRole('searchbox', { name: 'Find a body' }), 'mor');
    expect(spy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ q: 'mor', sort: { column: 'match' } });
    // Clearing it puts the lane's order back.
    await user.keyboard('{Escape}');
    expect(spy.mock.lastCall?.[0]).toMatchObject({ q: '', sort: { column: 'reports' } });
  });

  it('Escape on typing that never landed clears the field and leaves the order alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({ sort: 'acres' })} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByRole('searchbox', { name: 'Find a body' }), 'mor');
    await user.keyboard('{Escape}');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('searchbox', { name: 'Find a body' })).toHaveValue('');
  });

  /**
   * Every action that moves the place the typing was in: pending typing is dropped, never sent —
   * old typing never filters another lane, even when both lanes have an empty search.
   */
  const CONTEXT_CHANGES: [
    string,
    {
      initial: BodiesQuery;
      list?: BodiesListData;
      act: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
    },
  ][] = [
    [
      'another lane',
      {
        initial: queryOf({}),
        act: (user) => user.click(screen.getByRole('button', { name: /^Dormant · moderator/ })),
      },
    ],
    [
      'a state tab',
      {
        initial: queryOf({}),
        act: (user) => user.click(screen.getByRole('button', { name: 'VT' })),
      },
    ],
    [
      'a facet removed',
      {
        initial: queryOf({ size: '1000-up' }),
        list: LIST_BIG,
        act: (user) =>
          user.click(screen.getByRole('button', { name: 'Remove Size: 1,000 ac and up' })),
      },
    ],
    [
      'a body opened in the preview',
      {
        initial: queryOf({}),
        act: (user) => user.click(within(grid()).getByText('Mascoma Lake')),
      },
    ],
  ];

  it.each(CONTEXT_CHANGES)(
    'drops pending typing on %s: no late search, the field says what the URL does',
    async (_name, c) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const spy = vi.fn();
      render(<Harness spy={spy} initial={c.initial} {...(c.list ? { list: c.list } : {})} />);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(screen.getByRole('searchbox', { name: 'Find a body' }), 'mor');
      await c.act(user);
      const calls = spy.mock.calls.length;
      act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
      // Nothing lands after the move, and nothing the move sent carried the typing.
      expect(spy.mock.calls.length).toBe(calls);
      expect(spy.mock.calls.every(([next]) => next.q === '')).toBe(true);
      expect(screen.getByRole('searchbox', { name: 'Find a body' })).toHaveValue('');
    },
  );

  it('a pending search fires nothing once the page is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    const { unmount } = render(<Harness spy={spy} initial={queryOf({})} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByRole('searchbox', { name: 'Find a body' }), 'mor');
    unmount();
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
    expect(spy).not.toHaveBeenCalled();
  });

  it('a heading sorted while typing keeps the typing: the sort is the search’s, not its place', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({})} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByRole('searchbox', { name: 'Find a body' }), 'mor');
    await user.click(screen.getByRole('button', { name: 'Reports' }));
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(spy.mock.lastCall?.[0]).toMatchObject({ q: 'mor' });
  });

  it('drops what was being typed when the place moves on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({ q: 'mor' })} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByRole('searchbox', { name: 'Find a body' }), 'e');
    // Another lane clears the search before the wait runs out: the typing never lands on it.
    await user.click(screen.getByRole('button', { name: /^Dormant · moderator/ }));
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ q: '' });
    expect(screen.getByRole('searchbox', { name: 'Find a body' })).toHaveValue('');
  });

  it('draws board 5.3: the tally, the divider and the marks', () => {
    render(<Harness initial={queryOf({ q: 'mor' })} list={LIST_SEARCH} />);
    expect(screen.getByText('2 active · 4 dormant')).toBeInTheDocument();
    expect(screen.getByText('Dormant', { selector: 'th > span' }).closest('th')).toHaveTextContent(
      'Dormant4',
    );
    expect(screen.getAllByText('Mor')).toHaveLength(6);
    expect(within(grid()).getByText('Dormant · moderator')).toBeInTheDocument();
    for (const head of screen.getAllByRole('columnheader').slice(0, 8)) {
      expect(head.getAttribute('aria-sort')).not.toMatch(/ending$/);
    }
  });

  it('lights the lane’s heading while a search is too short to rank, and reverses it', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({ q: 'm' })} />);
    const reports = screen.getByRole('columnheader', { name: /Reports/ });
    expect(reports).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(screen.getByRole('button', { name: 'Reports' }));
    expect(spy.mock.lastCall?.[0].sort).toEqual({ column: 'reports', dir: 'asc' });
  });

  it('draws no other-standing group and no tally while no read gives the other standings', () => {
    render(<Harness initial={queryOf({ q: 'mor' })} list={{ ...LIST_SEARCH, others: null }} />);
    expect(document.querySelector('[data-slot=search-tally]')).toBeNull();
    expect(screen.queryByText(/active ·/)).toBeNull();
    expect(screen.queryByText('Dormant', { selector: 'th > span' })).toBeNull();
    expect(within(grid()).getAllByRole('row')).toHaveLength(LIST_SEARCH.rows.length);
  });
});

describe('the filters', () => {
  it('draws board 5.2: the narrowed kicker, the count, a chip that takes itself off, Clear', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({ size: '1000-up' })} list={LIST_BIG} />);
    expect(screen.getByText('187 of 1,412 active · 1,000 ac and up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Filter/ })).toHaveTextContent('1Filter');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Size: 1,000 ac and up' }));
    expect(spy.mock.lastCall?.[0].facets).toEqual({});
  });

  it('applies an option from the menu, with its count', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} list={LIST_BIG} />);
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const menu = await screen.findByRole('dialog', { name: 'Filter' });
    const bay = within(menu).getByRole('button', { name: /^Bay/ });
    expect(bay).toHaveTextContent('10');
    await userEvent.click(bay);
    expect(spy.mock.lastCall?.[0].facets).toEqual({ class: ['bay'] });
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(spy.mock.lastCall?.[0].facets).toEqual({});
  });
});

describe('what no read serves', () => {
  it('says the lane isn’t recorded, with no count, kicker or control pretending otherwise', () => {
    render(<Harness list={UNREAD_LIST} laneCounts={{}} preview={null} />);
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
    expect(screen.queryByText(/in the corpus/)).toBeNull();
    expect(screen.getByRole('button', { name: /Filter/ })).toBeDisabled();
    expect(screen.getByRole('searchbox', { name: 'Find a body' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Acres/ })).toBeNull();
    expect(screen.getByText('No body open')).toBeInTheDocument();
  });

  it('leaves an unrecorded cell empty, never a zero', () => {
    const list: BodiesListData = {
      ...LIST_ACTIVE,
      rows: [{ ...(LIST_ACTIVE.rows[0] as BodyRow), asks: null, reports: null, complete: null }],
    };
    render(<Harness list={list} />);
    const cells = within(within(grid()).getByRole('row')).getAllByRole('gridcell');
    expect(cells.map((c) => c.textContent)).toEqual([
      'Mascoma Lake',
      'reservoir',
      'NH',
      '1,143',
      '',
      '',
      '',
      '11:02',
    ]);
  });

  it('marks a count the read stopped short on as a floor', () => {
    const list: BodiesListData = {
      ...LIST_ACTIVE,
      rows: [
        {
          ...(LIST_ACTIVE.rows[0] as BodyRow),
          asks: 100,
          asksCapped: true,
          reports: 300,
          reportsCapped: true,
        },
      ],
    };
    render(<Harness list={list} />);
    const cells = within(within(grid()).getByRole('row')).getAllByRole('gridcell');
    expect(cells[5]).toHaveTextContent('100+');
    expect(cells[6]).toHaveTextContent('300+');
  });
});

describe('the list’s reading', () => {
  it('says a failed list failed — never that it is empty', () => {
    render(<Harness list={{ ...UNREAD_LIST, status: 'error', serves: LIST_ACTIVE.serves }} />);
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    expect(screen.queryByText('None here')).toBeNull();
    expect(screen.queryByText('Not recorded yet')).toBeNull();
  });

  it('draws no end until the read is done', () => {
    const { rerender } = render(<Harness list={LIST_ACTIVE} />);
    expect(screen.getByText('Loading more')).toBeInTheDocument();
    rerender(<Harness list={{ ...LIST_ACTIVE, status: 'fetching' }} />);
    expect(screen.getByText('Loading more')).toBeInTheDocument();
    rerender(<Harness list={{ ...LIST_ACTIVE, status: 'done' }} />);
    expect(screen.getByText('All 1,412')).toBeInTheDocument();
    rerender(<Harness list={{ ...LIST_ACTIVE, status: 'done', total: null }} />);
    expect(screen.getByText(`All ${LIST_ACTIVE.rows.length}`)).toBeInTheDocument();
    // A total counted to a cap is a floor; once every row is in, the rows say exactly.
    rerender(
      <Harness list={{ ...LIST_ACTIVE, status: 'done', total: { count: 20, capped: true } }} />,
    );
    expect(screen.getByText(`All ${LIST_ACTIVE.rows.length}`)).toBeInTheDocument();
  });

  it('asks for the next page at once when one came back short, and again after an empty one', () => {
    const onLoadMore = vi.fn();
    const short: BodiesListData = { ...LIST_ACTIVE, rows: LIST_ACTIVE.rows.slice(0, 2) };
    const { rerender } = render(<Harness list={short} onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // The next page is on its way: nothing more is asked for meanwhile.
    rerender(<Harness list={{ ...short, status: 'fetching' }} onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // It came back empty — its scan ran out, the list didn't end — so the next is asked for.
    rerender(<Harness list={short} onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    rerender(<Harness list={{ ...short, status: 'done' }} onLoadMore={onLoadMore} />);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });
});

describe('the preview', () => {
  it('words the body’s facts: reports by vantage, since when, completeness, the asks', () => {
    render(<Harness />);
    const pane = screen.getByRole('region', { name: 'Preview' });
    expect(within(pane).getByText('2 on the ice · 1 from shore')).toBeInTheDocument();
    expect(within(pane).getByText('Since 2023–24')).toBeInTheDocument();
    expect(within(pane).getByText('9 / 10')).toBeInTheDocument();
    expect(within(pane).getByText('Missing bathymetry')).toBeInTheDocument();
    expect(within(pane).getByText('“Shaker cove”')).toBeInTheDocument();
  });

  it('a switch to another body already read shows only that body — the preview is keyed by it', () => {
    // The preview holds no draft and sends no write; it is keyed by its body all the same.
    const { rerender } = render(<Harness preview={PREVIEW_MASCOMA} />);
    const pane = () => screen.getByRole('region', { name: 'Preview' });
    const first = pane().firstElementChild;
    expect(within(pane()).getByText('“Shaker cove”')).toBeInTheDocument();
    // Lake Morey chosen in the list; its preview already read.
    fireEvent.click(screen.getAllByText('Lake Morey')[0] as HTMLElement);
    rerender(<Harness preview={PREVIEW_MOREY} />);
    expect(pane().firstElementChild).not.toBe(first);
    expect(within(pane()).queryByText('“Shaker cove”')).toBeNull();
  });

  it('marks a floor, holds the reports’ shape while they load, and says when they failed', () => {
    const floor = {
      ...PREVIEW_MASCOMA,
      allTime: { count: 1000, capped: true, sub: null },
      season: { count: 1, capped: false, sub: null },
    };
    const { rerender } = render(<Harness preview={floor} />);
    const pane = () => screen.getByRole('region', { name: 'Preview' });
    expect(within(pane()).getByText('1,000+')).toBeInTheDocument();
    expect(within(pane()).getByText('report')).toBeInTheDocument();
    rerender(<Harness preview={{ ...PREVIEW_MASCOMA, facts: 'loading', season: null }} />);
    expect(pane().querySelector('[data-slot=preview-reports][aria-busy=true]')).not.toBeNull();
    rerender(
      <Harness
        preview={{
          ...PREVIEW_MASCOMA,
          facts: 'error',
          season: null,
          allTime: null,
          complete: null,
          asks: null,
        }}
      />,
    );
    expect(
      within(pane()).getByText('Reports, completeness and asks couldn’t be read'),
    ).toBeInTheDocument();
    expect(within(pane()).queryByText('9 / 10')).toBeNull();
  });

  it('says a failed body or history failed, and offers no way in to a body it couldn’t read', () => {
    const { rerender } = render(<Harness preview={{ ...PREVIEW_MASCOMA, history: 'error' }} />);
    expect(screen.getByText('Couldn’t read the history')).toBeInTheDocument();
    rerender(<Harness preview="error" />);
    expect(screen.getByText('Couldn’t read this body')).toBeInTheDocument();
    expect(screen.queryByText(/Open in Body/)).toBeNull();
  });

  it('counts every open ask, and says plainly when the list is only the newest of them', () => {
    const { rerender } = render(
      <Harness
        preview={{ ...PREVIEW_MASCOMA, askCount: { count: 21, capped: false }, asksPartial: true }}
      />,
    );
    const asks = () => screen.getByRole('region', { name: 'Asked of this body' });
    expect(within(asks()).getByText('Newest 3 of 21')).toBeInTheDocument();
    expect(asks().querySelector('[data-slot=section-count]')).toHaveTextContent('21');
    rerender(
      <Harness
        preview={{ ...PREVIEW_MASCOMA, askCount: { count: 400, capped: true }, asksPartial: true }}
      />,
    );
    expect(within(asks()).getByText('Newest 3 of 400+')).toBeInTheDocument();
    expect(asks().querySelector('[data-slot=section-count]')).toHaveTextContent('400+');
    // A whole list says nothing of the kind.
    rerender(<Harness />);
    expect(screen.queryByText(/^Newest /)).toBeNull();
  });

  it('writes a history read that stopped short as a floor, never the whole', () => {
    render(<Harness preview={{ ...PREVIEW_MASCOMA, historyCapped: true }} />);
    const history = screen.getByRole('region', { name: 'Last changed' });
    const rows = (PREVIEW_MASCOMA.history as readonly unknown[]).length;
    expect(history.querySelector('[data-slot=section-count]')).toHaveTextContent(`${rows}+`);
  });

  it('says a failed put-ins or bays read, with Try again, rather than drawing none', async () => {
    const onRetry = vi.fn();
    render(
      <Harness
        preview={{ ...PREVIEW_MASCOMA, putIns: null, bays: null, marksError: true }}
        onRetryPreview={onRetry}
      />,
    );
    const note = document.querySelector('[data-slot=preview-marks-error]') as HTMLElement;
    expect(note).toHaveTextContent('Put-ins and bays couldn’t be read');
    await userEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('names the other towns with the body’s one state', () => {
    render(<Harness />);
    expect(screen.getByText('+1')).toBeInTheDocument();
  });
});

describe('the list’s place', () => {
  it('keeps a list’s scroll through the scroll another list’s skeleton clamps, and lands there', () => {
    const lane = laneById('active');
    const props = {
      lane,
      q: '',
      sort: lane.sort,
      selectedId: null,
      now: NOW,
      onSort: () => {},
      onSelect: () => {},
      onOpen: () => {},
    };
    const loading: BodiesListData = { ...LIST_ACTIVE, rows: [], status: 'loading' };
    const table = (list: BodiesListData, memoryKey: string) => (
      <KeysProvider>
        <BodiesTable {...props} list={list} memoryKey={memoryKey} />
      </KeysProvider>
    );
    const { container, rerender } = render(table(LIST_ACTIVE, 'b'));
    const scroller = () => container.querySelector('[data-slot=bodies-scroll]') as HTMLElement;
    scroller().scrollTop = 500;
    fireEvent.scroll(scroller());
    rerender(table(LIST_ACTIVE, 'a'));
    // Back to b: its skeleton clamps the scroll before its rows land — no place of b's.
    rerender(table(loading, 'b'));
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    rerender(table(LIST_ACTIVE, 'b'));
    expect(scroller().scrollTop).toBe(500);
  });
});
