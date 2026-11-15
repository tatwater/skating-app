import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The status bar portals into the shell's chrome; here it draws in place, so its words can be read.
vi.mock('../../shell/ConsoleShell', async (original) => ({
  ...(await original<typeof import('../../shell/ConsoleShell')>()),
  ConsoleStatus: ({ groups }: { groups: readonly ReactNode[] }) => (
    <output aria-label="Status">{groups}</output>
  ),
}));

// The narrow-screen rule is measured; here a test says which side of it the page is on.
const columns = vi.hoisted(() => ({ fit: true }));
vi.mock('../../shell/columnsFit', () => ({ useColumnsFit: () => columns.fit }));

import { expectNoBlanks } from '@/test/blanksAudit';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { resetScrollMemory } from './PeopleList';
import { PeopleListView, type PeopleListViewProps } from './PeopleListView';
import {
  KATE,
  LANES,
  LANES_CAPPED,
  LANES_FLAGS_PREPARING,
  LANES_MODERATOR,
  LANES_PREPARING,
  NOW,
  ROB,
} from './peopleFixtures';
import { lanesFor } from './peopleLanes';
import type { LanesRead } from './peopleModel';
import { stubLayout } from './testLayout';

/**
 * The page on props: the lanes and their three answers (not ready, a floor, a number), the list's
 * head and its notes, the search lane (and the rule that typing belongs to the place it was typed
 * in), and the keys that move between them.
 */

beforeAll(stubLayout);
beforeEach(() => {
  resetScrollMemory();
  columns.fit = true;
});

const entriesOf = (read: LanesRead) => Object.fromEntries(read.lanes.map((l) => [l.lane, l]));

function draw(over: Partial<PeopleListViewProps> = {}) {
  const props: PeopleListViewProps = {
    lanes: lanesFor(true),
    laneEntries: entriesOf(LANES),
    query: { lane: 'suspended', q: '' },
    onQueryChange: vi.fn(),
    list: { status: 'done', rows: [ROB], reasons: [], pending: [] },
    selectedId: null,
    onOpenPerson: vi.fn(),
    now: NOW,
    ...over,
  };
  const result = render(<PeopleListView {...props} />);
  return {
    ...result,
    props,
    redraw: (next: Partial<PeopleListViewProps>) =>
      result.rerender(<PeopleListView {...props} {...next} />),
  };
}

const lanes = () => screen.getByRole('navigation', { name: 'People' });
const lane = (name: RegExp) => within(lanes()).getByRole('button', { name });
const countOf = (name: RegExp) =>
  lane(name).querySelector('[data-slot="lane-count"]')?.textContent ?? null;
const search = () => screen.getByRole('searchbox', { name: 'Search any account' });

describe('the lanes', () => {
  it('lists every lane the viewer has, with its count, the chosen one current', () => {
    draw();
    const names = within(lanes())
      .getAllByRole('button')
      .map((b) => b.querySelector('[data-slot="lane-label"]')?.textContent);
    expect(names).toEqual([
      'Everyone',
      'Staff',
      'Suspended',
      'Banned',
      'Restricted',
      'Flagged',
      'Appeals open',
      'Newest',
      'Leaving · 30-day window',
      'Deleted · tombstones',
    ]);
    expect(lane(/^Suspended/)).toHaveAttribute('aria-current', 'true');
    expect(countOf(/^Everyone/)).toBe('38');
    expect(lane(/^Banned/)).toHaveAttribute('data-dim');
  });

  it('inks Suspended amber while anyone is suspended, chosen or not, and quiet at none', () => {
    const { redraw } = draw();
    const tone = () => lane(/^Suspended/).querySelector('[data-slot="lane-count"]');
    // Chosen (board 8.1) or not, Suspended's count stays amber while anyone is suspended.
    expect(lane(/^Suspended/)).toHaveAttribute('aria-current', 'true');
    expect(tone()).toHaveAttribute('data-tone', 'warn');
    expect(tone()).toHaveTextContent('1');
    redraw({ query: { lane: 'everyone', q: '' } });
    expect(tone()).toHaveAttribute('data-tone', 'warn');
    const none = {
      ...LANES,
      lanes: LANES.lanes.map((l) => ({ ...l, count: { count: 0, capped: false } })),
    };
    redraw({ query: { lane: 'everyone', q: '' }, laneEntries: entriesOf(none) });
    expect(tone()).toHaveAttribute('data-tone', 'default');
  });

  it('gives a moderator no Appeals open — no error, no blank', () => {
    draw({ lanes: lanesFor(false), laneEntries: entriesOf(LANES_MODERATOR) });
    expect(within(lanes()).queryByRole('button', { name: /Appeals/ })).toBeNull();
  });

  it('draws no count while the counts are still being prepared, and says so at the foot', () => {
    draw({ laneEntries: entriesOf(LANES_PREPARING) });
    expect(lanes().querySelector('[data-slot="lane-count"]')).toBeNull();
    expect(screen.getByText('Counts still being prepared')).toBeInTheDocument();
    expect(screen.getByText(/^by end date$/)).toBeInTheDocument();
  });

  it('holds back only the counts not ready, naming them', () => {
    draw({ laneEntries: entriesOf(LANES_FLAGS_PREPARING) });
    expect(countOf(/^Flagged/)).toBeNull();
    expect(countOf(/^Everyone/)).toBe('38');
    expect(screen.getByText('Flagged count still being prepared')).toBeInTheDocument();
  });

  it('writes a floor with its “+”, and says why over the list', () => {
    draw({ laneEntries: entriesOf(LANES_CAPPED), query: { lane: 'newest', q: '' } });
    expect(countOf(/^Flagged/)).toBe('200+');
    expect(screen.getByText('200+ · newest first')).toBeInTheDocument();
    expect(screen.getByText(/The count stopped at its limit/)).toBeInTheDocument();
  });

  it('draws no count at all before the lanes’ read answers', () => {
    draw({ laneEntries: null });
    expect(lanes().querySelector('[data-slot="lane-count"]')).toBeNull();
    expect(screen.getByText('by end date')).toBeInTheDocument();
  });

  it('opens another lane fresh, its search cleared; the lane on screen stays as it is', async () => {
    const { props } = draw();
    await userEvent.click(lane(/^Staff/));
    expect(props.onQueryChange).toHaveBeenCalledWith({ lane: 'staff', q: '' });
    await userEvent.click(lane(/^Suspended/));
    expect(props.onQueryChange).toHaveBeenCalledTimes(1);
  });
});

describe('the list', () => {
  it('heads the list with the lane’s word, its count and its order', () => {
    draw();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Suspended');
    expect(screen.getByText('1 · by end date')).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Suspended' })).toBeInTheDocument();
  });

  it('says once, over the rows, what the page may be missing and why', () => {
    draw({
      list: {
        status: 'done',
        rows: [ROB],
        reasons: ['flags_capped', 'rows_missing'],
        pending: ['flagSubjects'],
      },
    });
    expect(screen.getByText('Open flags are still being prepared')).toBeInTheDocument();
    expect(screen.getByText(/more open flags than one read covers/)).toBeInTheDocument();
    expect(screen.getByText(/isn’t listed yet/)).toBeInTheDocument();
    // Open flags that may be wrong are not drawn on the rows.
    expect(screen.getByRole('option', { name: /Rob/ })).not.toHaveTextContent('open flag');
  });

  it('ends a list short of its lane on what it shows, never “All”', () => {
    draw({
      query: { lane: 'flagged', q: '' },
      list: { status: 'done', rows: [ROB, KATE], reasons: ['flags_capped'], pending: [] },
    });
    expect(screen.getByText('2 shown')).toBeInTheDocument();
    expect(screen.queryByText('All 2')).toBeNull();
  });

  it('says nothing about the page while its first page is on its way', () => {
    draw({ list: { status: 'loading', rows: [], reasons: [], pending: ['rows'] } });
    expect(document.querySelector('[data-slot="people-notes"]')).toBeNull();
  });

  it('opens a person, and says no one is open until one is', async () => {
    const { props, redraw } = draw();
    expect(screen.getByText('No one open')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Rob Tremblay'));
    expect(props.onOpenPerson).toHaveBeenCalledWith(ROB.userId, 'press');
    redraw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
    expect(screen.getByText('Rob’s page')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Rob/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('names the open appeals in the status bar, and nothing while they aren’t ready', () => {
    const { redraw } = draw();
    expect(screen.getByRole('status', { name: 'Status' })).toHaveTextContent('1 appeal open');
    const two = LANES.lanes.map((l) =>
      l.lane === 'appeals' ? { ...l, count: { count: 2, capped: false } } : l,
    );
    redraw({ laneEntries: entriesOf({ ...LANES, lanes: two }) });
    expect(screen.getByRole('status', { name: 'Status' })).toHaveTextContent('2 appeals open');
    redraw({ laneEntries: entriesOf(LANES_PREPARING) });
    expect(screen.getByRole('status', { name: 'Status' })).toBeEmptyDOMElement();
  });
});

describe('the search', () => {
  it('runs over every account: no lane is current, the head says Search, the match is marked', () => {
    draw({
      query: { lane: 'suspended', q: '@kate' },
      list: { status: 'done', rows: [KATE], reasons: ['tickets_capped'], pending: [] },
    });
    expect(lanes().querySelector('[aria-current]')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Search');
    expect(screen.getByText('best match first')).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Search: @kate' })).toBeInTheDocument();
    expect(screen.getByText('Kate', { selector: 'mark' })).toBeInTheDocument();
    // The lanes' reasons are the lane's; a search's page says only its own.
    expect(screen.getByText(/more waiting tickets/)).toBeInTheDocument();
  });

  it('says plainly when no one matches', () => {
    draw({
      query: { lane: 'everyone', q: 'zzz' },
      list: { status: 'done', rows: [], reasons: [], pending: [] },
    });
    expect(screen.getByText('No one matches “zzz”')).toBeInTheDocument();
  });

  it('goes back to a lane from a search, even the lane it was typed over', async () => {
    const { props } = draw({ query: { lane: 'suspended', q: 'rob' } });
    await userEvent.click(lane(/^Suspended/));
    expect(props.onQueryChange).toHaveBeenCalledWith({ lane: 'suspended', q: '' });
  });

  describe('typing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('sends the search with the lane it was typed over, once typing rests, in place', () => {
      const { props } = draw();
      fireEvent.change(search(), { target: { value: 'rob' } });
      act(() => vi.advanceTimersByTime(300));
      // Typing refines the place: it replaces the entry rather than stacking one per pause.
      expect(props.onQueryChange).toHaveBeenCalledWith(
        { lane: 'suspended', q: 'rob' },
        { replace: true },
      );
    });

    it('drops typing pending when another lane opens', () => {
      const { props, redraw } = draw();
      fireEvent.change(search(), { target: { value: 'rob' } });
      redraw({ query: { lane: 'staff', q: '' } });
      act(() => vi.advanceTimersByTime(1_000));
      expect(props.onQueryChange).not.toHaveBeenCalled();
      expect(search()).toHaveValue('');
    });

    it('drops typing pending when a person opens', () => {
      const { props, redraw } = draw();
      fireEvent.change(search(), { target: { value: 'rob' } });
      redraw({ selectedId: ROB.userId });
      act(() => vi.advanceTimersByTime(1_000));
      expect(props.onQueryChange).not.toHaveBeenCalled();
    });
  });
});

describe('the keys', () => {
  it('sends / to the search from the lanes, the list and the page, never from a field', () => {
    draw();
    act(() => lane(/^Staff/).focus());
    fireEvent.keyDown(lane(/^Staff/), { key: '/' });
    expect(search()).toHaveFocus();

    const list = screen.getByRole('listbox');
    act(() => list.focus());
    fireEvent.keyDown(list, { key: '/' });
    expect(search()).toHaveFocus();

    const head = screen.getByRole('heading', { level: 1 });
    act(() => list.focus());
    fireEvent.keyDown(head, { key: '/' });
    expect(search()).toHaveFocus();

    // In the field it types; a modified / in the lanes is the browser's.
    expect(fireEvent.keyDown(search(), { key: '/' })).toBe(true);
    expect(fireEvent.keyDown(lane(/^Staff/), { key: '/', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(head, { key: 'x' })).toBe(true);
  });

  it('leaves / alone in a dialog the person’s page opened (a portal, out of the page)', () => {
    const portal = document.createElement('div');
    document.body.append(portal);
    try {
      draw({
        selectedId: ROB.userId,
        detail: createPortal(<button type="button">In the dialog</button>, portal),
      });
      const inDialog = screen.getByRole('button', { name: 'In the dialog' });
      act(() => inDialog.focus());
      expect(fireEvent.keyDown(inDialog, { key: '/' })).toBe(true);
      expect(inDialog).toHaveFocus();
    } finally {
      portal.remove();
    }
  });
});

describe('a narrow screen (the console’s master–detail rule)', () => {
  const pane = (name: string) => document.querySelector<HTMLElement>(`[data-pane="${name}"]`);

  it('keeps the board’s three columns while they fit', () => {
    draw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
    expect(document.querySelector('[data-slot="people-page"]')).not.toHaveAttribute('data-narrow');
    for (const name of ['lanes', 'middle', 'detail']) expect(pane(name)).not.toHaveClass('hidden');
    expect(screen.queryByRole('button', { name: 'Back to the list' })).toBeNull();
  });

  it('gives the page to the open person, with the way back', async () => {
    columns.fit = false;
    const onCloseDetail = vi.fn();
    draw({ selectedId: ROB.userId, detail: <p>Rob’s page</p>, onCloseDetail });
    expect(pane('lanes')).toHaveClass('hidden');
    expect(pane('middle')).toHaveClass('hidden');
    expect(pane('detail')).not.toHaveClass('hidden');
    await userEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(onCloseDetail).toHaveBeenCalledTimes(1);
  });

  it('asks for no more pages while the person hides the list, and again once it shows', () => {
    columns.fit = false;
    const onLoadMore = vi.fn();
    const list = { status: 'more' as const, rows: [ROB], reasons: [], pending: [] };
    const { redraw } = draw({
      selectedId: ROB.userId,
      detail: <p>Rob’s page</p>,
      list,
      onLoadMore,
    });
    expect(onLoadMore).not.toHaveBeenCalled();
    redraw({ selectedId: null, detail: undefined, list, onLoadMore });
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('with no one open, gives it to the lanes and the list', () => {
    columns.fit = false;
    draw();
    expect(pane('lanes')).not.toHaveClass('hidden');
    expect(pane('middle')).not.toHaveClass('hidden');
    expect(pane('detail')).toHaveClass('hidden');
  });

  it('Esc in the person’s page goes back, and focus lands on the list once it is drawn', () => {
    columns.fit = false;
    const onCloseDetail = vi.fn();
    const { redraw } = draw({ selectedId: ROB.userId, detail: <p>Rob’s page</p>, onCloseDetail });
    fireEvent.keyDown(screen.getByText('Rob’s page'), { key: 'Escape' });
    expect(onCloseDetail).toHaveBeenCalledTimes(1);
    redraw({ selectedId: null, detail: undefined, onCloseDetail });
    expect(screen.getByRole('listbox')).toHaveFocus();
  });

  it('a person opened from the list takes focus with the page, the list being hidden', () => {
    columns.fit = false;
    const { redraw } = draw();
    act(() => screen.getByRole('listbox').focus());
    // The route's own focus lands on a pane not yet drawn; the person's page, once it is, has it.
    redraw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
    expect(pane('detail')).toHaveFocus();
  });

  it('closed some other way (the browser’s back), focus in their page goes to the list', () => {
    columns.fit = false;
    const { redraw } = draw({
      selectedId: ROB.userId,
      detail: <button type="button">Lift</button>,
    });
    act(() => screen.getByRole('button', { name: 'Lift' }).focus());
    redraw({ selectedId: null, detail: undefined });
    expect(screen.getByRole('listbox')).toHaveFocus();
  });

  it('a person opened from elsewhere (a link, the palette) takes focus from the search', () => {
    columns.fit = false;
    const { redraw } = draw();
    act(() => search().focus());
    redraw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
    expect(pane('detail')).toHaveFocus();
  });

  it('never pulls back focus that had left the page', () => {
    columns.fit = false;
    const outside = document.body.appendChild(document.createElement('button'));
    try {
      const { redraw } = draw();
      act(() => screen.getByRole('listbox').focus());
      act(() => outside.focus());
      redraw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
      expect(outside).toHaveFocus();
    } finally {
      outside.remove();
    }
  });

  it('moves no focus that wasn’t in a pane it hides', () => {
    columns.fit = false;
    const { redraw } = draw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
    redraw({ selectedId: null, detail: undefined });
    expect(document.body).toHaveFocus();
  });

  it('keeps every pane and focus where they are while the columns fit', () => {
    const { redraw } = draw();
    act(() => screen.getByRole('listbox').focus());
    redraw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
    expect(screen.getByRole('listbox')).toHaveFocus();
  });

  it('columns side by side: a page closed under focus (the browser’s back) hands it to the list', () => {
    const { redraw } = draw({
      selectedId: ROB.userId,
      detail: <button type="button">Lift</button>,
    });
    act(() => screen.getByRole('button', { name: 'Lift' }).focus());
    redraw({ selectedId: null, detail: undefined });
    expect(screen.getByRole('listbox')).toHaveFocus();
  });

  it('columns side by side: a page closed with focus elsewhere leaves focus where it is', () => {
    const { redraw } = draw({ selectedId: ROB.userId, detail: <p>Rob’s page</p> });
    act(() => search().focus());
    redraw({ selectedId: null, detail: undefined });
    expect(search()).toHaveFocus();
  });

  it('leaves / alone while the person’s page covers the search', () => {
    columns.fit = false;
    draw({ selectedId: ROB.userId, detail: <p>Rob’s page</p>, onCloseDetail: vi.fn() });
    const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    screen.getByText('Rob’s page').dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(false);
    expect(search()).not.toHaveFocus();
  });
});

describe('the house audits', () => {
  it.each([
    ['a lane, a person open', { selectedId: ROB.userId, detail: <p>Rob’s page</p> }],
    [
      'a search',
      {
        query: { lane: 'suspended', q: 'kat' },
        list: { status: 'done', rows: [KATE], reasons: [], pending: [] },
      },
    ],
    ['counts not ready', { laneEntries: entriesOf(LANES_PREPARING) }],
  ] as const)(
    '%s: every clickable thing answers the keyboard, and nothing is a blank',
    (_name, over) => {
      const { container } = draw(over as Partial<PeopleListViewProps>);
      expect(expectKeyboardOperable(container).length).toBeGreaterThan(0);
      expectNoBlanks(container);
    },
  );
});
