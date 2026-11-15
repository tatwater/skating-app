import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PeopleList, type PeopleListProps, resetScrollMemory } from './PeopleList';
import { KATE, LUC, manyPeople, NOW, ROB } from './peopleFixtures';
import { rowView } from './peopleModel';
import { stubLayout } from './testLayout';

/**
 * The list's own behavior, on props: the keys (one tab stop, ↑↓, type-ahead, ⏎ and Space, `/`, G
 * passing through), the cursor kept in view, pages asked for near the end, and how each state ends —
 * skeletons, a failure with Try again, an empty lane's words, the end tab only once every row is in.
 */

const FACTS = { flagsPending: false, flagsFloor: false, appealsFloor: false };
const view = (rows = [ROB, KATE, LUC]) => rows.map((r) => rowView(r, 'everyone', FACTS, NOW));

const scrolled: Element[] = [];
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: Element) {
      scrolled.push(this);
    },
  });
  stubLayout();
});
beforeEach(() => {
  resetScrollMemory();
  scrolled.length = 0;
});

function draw(over: Partial<PeopleListProps> = {}) {
  const props: PeopleListProps = {
    label: 'Everyone',
    rows: view(),
    status: 'done',
    selectedId: null,
    onOpen: vi.fn(),
    emptyWords: 'No accounts yet',
    memoryKey: 'lane:everyone',
    ...over,
  };
  const result = render(<PeopleList {...props} />);
  return { ...result, props, list: screen.getByRole('listbox', { name: props.label }) };
}

const active = (list: HTMLElement) =>
  document.getElementById(list.getAttribute('aria-activedescendant') ?? '');

describe('the keys', () => {
  it('is one tab stop whose cursor starts on the open person, else the first', async () => {
    const { list } = draw({ selectedId: KATE.userId });
    await userEvent.tab();
    expect(list).toHaveFocus();
    expect(active(list)).toHaveTextContent('Kate Donovan');
  });

  it('moves with the arrows and the ends, keeps the cursor in view, and opens with ⏎ or Space', async () => {
    const { list, props } = draw();
    act(() => list.focus());
    expect(active(list)).toHaveTextContent('Rob Tremblay');
    await userEvent.keyboard('{ArrowDown}');
    expect(active(list)).toHaveTextContent('Kate Donovan');
    expect(scrolled.at(-1)).toBe(active(list));
    await userEvent.keyboard('{End}');
    expect(active(list)).toHaveTextContent('Luc Pelletier');
    await userEvent.keyboard('{ArrowDown}');
    expect(active(list)).toHaveTextContent('Luc Pelletier');
    await userEvent.keyboard('{Home}{ArrowUp}');
    expect(active(list)).toHaveTextContent('Rob Tremblay');
    await userEvent.keyboard('{Enter}');
    expect(props.onOpen).toHaveBeenLastCalledWith(ROB.userId);
    await userEvent.keyboard('{ArrowDown} ');
    expect(props.onOpen).toHaveBeenLastCalledWith(KATE.userId);
    // ⇧⏎ is not an open.
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(props.onOpen).toHaveBeenCalledTimes(2);
  });

  it('types ahead on names, a letter again stepping through the names that start with it', async () => {
    const rows = view([ROB, KATE, LUC]).concat(
      view([{ ...KATE, userId: 'k2' as never, displayName: 'Kim Roy' }]),
    );
    const { list } = draw({ rows });
    list.focus();
    await userEvent.keyboard('k');
    expect(active(list)).toHaveTextContent('Kate Donovan');
    await userEvent.keyboard('k');
    expect(active(list)).toHaveTextContent('Kim Roy');
  });

  it('reads a quick run of letters as a prefix, and stays put when no name starts with it', async () => {
    const { list } = draw();
    list.focus();
    await userEvent.keyboard('lu');
    expect(active(list)).toHaveTextContent('Luc Pelletier');
    await userEvent.keyboard('z');
    expect(active(list)).toHaveTextContent('Luc Pelletier');
  });

  it('lets G and ? through to the keyboard layer, and sends / to the search', () => {
    const onSearchKey = vi.fn();
    const { list } = draw({ onSearchKey });
    list.focus();
    expect(fireEvent.keyDown(list, { key: 'g' })).toBe(true);
    expect(fireEvent.keyDown(list, { key: '?' })).toBe(true);
    expect(fireEvent.keyDown(list, { key: '/' })).toBe(false);
    expect(onSearchKey).toHaveBeenCalledTimes(1);
    // A modified key is the browser's.
    expect(fireEvent.keyDown(list, { key: 'k', metaKey: true })).toBe(true);
    // Keys other than letters and the list's own do nothing.
    expect(fireEvent.keyDown(list, { key: 'F2' })).toBe(true);
  });

  it('sends / to the search from an empty list too, and nothing else', () => {
    const onSearchKey = vi.fn();
    const { list } = draw({ rows: [], onSearchKey });
    expect(fireEvent.keyDown(list, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(list, { key: '/' })).toBe(false);
    expect(onSearchKey).toHaveBeenCalledTimes(1);
  });

  it('opens a person on a press, which moves the cursor there', async () => {
    const { list, props } = draw();
    await userEvent.click(within(list).getByText('Luc Pelletier'));
    expect(props.onOpen).toHaveBeenCalledWith(LUC.userId);
    expect(active(list)).toHaveTextContent('Luc Pelletier');
  });
});

describe('the row', () => {
  it('marks the open person and draws the age only where one is on record', () => {
    const { list } = draw({ selectedId: ROB.userId, mark: 'trem' });
    const rob = within(list).getByRole('option', { name: /Rob Tremblay/ });
    expect(rob).toHaveAttribute('aria-selected', 'true');
    expect(rob.querySelector('mark')).toHaveTextContent('Trem');
    expect(rob.querySelector('[data-slot="people-row-age"]')).toHaveTextContent('8 months');
    const stillAge = view([{ ...KATE }]).map((r) => ({ ...r, age: null }));
    draw({ rows: stillAge, label: 'Staff' });
    const staff = screen.getByRole('listbox', { name: 'Staff' });
    expect(staff.querySelector('[data-slot="people-row-age"]')).toBeNull();
  });
});

describe('how it ends', () => {
  it('draws skeletons while the first page is on its way, and no end tab', () => {
    const { list } = draw({ status: 'loading', rows: [] });
    expect(list).toHaveAttribute('aria-busy', 'true');
    expect(list.querySelectorAll('[data-slot="people-skeleton"]')).toHaveLength(6);
    expect(document.querySelector('[data-slot="people-end"]')).toBeNull();
  });

  it('ends in its tab only once every row is in', () => {
    const { rerender, props } = draw({ status: 'more' });
    expect(screen.getByText('Loading more')).toBeInTheDocument();
    rerender(<PeopleList {...props} status="done" />);
    expect(screen.getByText('All 3')).toBeInTheDocument();
  });

  it('says an empty lane in plain words', () => {
    draw({ rows: [], emptyWords: 'No one is banned' });
    expect(screen.getByText('No one is banned')).toBeInTheDocument();
  });

  it('says a failed read in its own place, with Try again, and keeps the rows it had', async () => {
    const onRetry = vi.fn();
    const { rerender, props } = draw({ status: 'error', rows: [], onRetry });
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<PeopleList {...props} rows={view()} retryPending />);
    expect(screen.getByText('Couldn’t read the rest of this list')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Trying again/ })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('says Not recorded yet for a viewer who can’t read people', () => {
    draw({ status: 'unread', rows: [] });
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
  });
});

describe('paging and scrolling', () => {
  it('asks for the next page at once when what came back doesn’t fill the list', () => {
    const onLoadMore = vi.fn();
    draw({ status: 'more', onLoadMore });
    // jsdom lays nothing out: every list is "near its end".
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('asks for nothing while a page is on its way, or once every row is in', () => {
    const onLoadMore = vi.fn();
    const { rerender, props } = draw({ status: 'fetching', onLoadMore });
    rerender(<PeopleList {...props} status="done" />);
    fireEvent.scroll(screen.getByRole('listbox').parentElement as HTMLElement);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('remembers where each list was scrolled, and comes back there', () => {
    const { unmount } = draw();
    const scroller = screen.getByRole('listbox').parentElement as HTMLElement;
    scroller.scrollTop = 120;
    fireEvent.scroll(scroller);
    unmount();
    draw();
    expect((screen.getByRole('listbox').parentElement as HTMLElement).scrollTop).toBe(120);
  });

  it('brings the open person into view coming back to a list it hasn’t scrolled', () => {
    draw({ selectedId: LUC.userId });
    expect(scrolled.at(-1)).toHaveTextContent('Luc Pelletier');
  });

  it('draws only the rows in view of a long list, the cursor’s always', () => {
    // A viewport the virtualizer can measure (jsdom lays nothing out).
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(340);
    try {
      const rows = manyPeople(150).map((r) => rowView(r, 'everyone', FACTS, NOW));
      const { list } = draw({ rows });
      act(() => list.focus());
      fireEvent.keyDown(list, { key: 'End' });
      expect(active(list)).toHaveTextContent(rows.at(-1)?.name ?? '');
      const drawn = list.querySelectorAll('[data-slot="people-row"]').length;
      expect(drawn).toBeGreaterThan(1);
      expect(drawn).toBeLessThan(150);
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });
});
