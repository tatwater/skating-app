import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';
import { resetScrollMemory } from './BodiesTable';
import { BodiesView, type BodiesViewProps } from './BodiesView';
import { type BodiesListData, UNREAD_LIST } from './bodiesData';
import {
  CORPUS,
  LANE_COUNTS,
  LIST_ACTIVE,
  LIST_BIG,
  LIST_SEARCH,
  NOW,
  PREVIEW_MASCOMA,
} from './bodiesFixtures';
import type { BodyRow } from './bodiesModel';
import { type BodiesQuery, queryOf } from './bodiesSearch';
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

  it('picks a lane as a fresh list: no body, search, tab, filter or order carried over', async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={queryOf({ body: 'x', q: 'mor', size: '1000-up' })} />);
    await userEvent.click(screen.getByRole('button', { name: /^Dormant · moderator/ }));
    const next = spy.mock.lastCall?.[0] as BodiesQuery;
    expect(next.lane.id).toBe('moderator');
    expect(next).toMatchObject({ bodyId: null, q: '', state: null, facets: {} });
    expect(next.sort).toEqual(next.lane.sort);
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

  it('says a capped lane is its newest, and that more are loading', () => {
    const { rerender } = render(<Harness list={{ ...LIST_ACTIVE, status: 'capped' }} />);
    expect(screen.getByText('Newest 25')).toBeInTheDocument();
    rerender(<Harness list={LIST_ACTIVE} />);
    expect(screen.getByText('Loading more')).toBeInTheDocument();
  });
});
