import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two People pages joined as the app mounts them: the list's layout with the person's page in
 * its third column. A deep link opens the list beside the person on the lane the URL names; the
 * person's way back returns to that lane and search; an id the server can't know is *No such
 * person* with the list still usable; and Esc or ⇧⏎ in the person's page puts focus back on the
 * list, on the person's row. Every read is mocked at the Convex hook.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: new Map<string, unknown[]>(),
  search: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  navigate: vi.fn(),
}));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          const name = getFunctionName(query);
          mocks.calls.set(name, [...(mocks.calls.get(name) ?? []), args]);
          const r = mocks.results.get(name);
          return [key, typeof r === 'function' ? (r as (a: unknown) => unknown)(args) : r];
        }),
      ),
    useMutation: () => vi.fn(async () => null),
  };
});
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useParams: () => mocks.params,
  useNavigate: () => mocks.navigate,
  Outlet: () => null,
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, string>;
    children?: ReactNode;
  }) => (
    <a href={search === undefined ? to : `${to}?${new URLSearchParams(search)}`} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('../shell/ConsoleShell', async (original) => ({
  ...(await original<typeof import('../shell/ConsoleShell')>()),
  ConsoleStatus: () => null,
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: () => true, userId: 'teagan'.padEnd(32, '0') }),
}));
vi.mock('../shell/undo', () => ({
  useUndo: () => ({ announce: vi.fn(async () => {}), undo: vi.fn() }),
}));

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { resetConsoleReads } from '../reads/consoleReads';
import { resetScrollMemory } from './list/PeopleList';
import { PeopleListRoute } from './list/PeopleListRoute';
import { KATE, LANES, page, ROB as ROB_ROW, SARAH as SARAH_ROW } from './list/peopleFixtures';
import { resetShownMemory } from './list/peopleReads';
import { peopleListHref, queryOf } from './list/peopleSearch';
import { stubLayout } from './list/testLayout';
import { PersonPane } from './person/PersonPane';
import { ROB, ROB_HISTORY, ROB_TREND } from './person/personFixtures';

const PAGE_READ = getFunctionName(api.people.listPage);

beforeAll(stubLayout);
beforeEach(() => {
  resetConsoleReads();
  resetScrollMemory();
  resetShownMemory();
  mocks.results.clear();
  mocks.calls.clear();
  mocks.search = {};
  mocks.params = {};
  mocks.navigate.mockReset();
  mocks.results.set(getFunctionName(api.people.lanes), LANES);
  mocks.results.set(getFunctionName(api.people.person), ROB);
  mocks.results.set(getFunctionName(api.people.reportTrend), ROB_TREND);
  mocks.results.set(getFunctionName(api.people.history), ROB_HISTORY);
  mocks.results.set(getFunctionName(api.people.staffStats), null);
  mocks.results.set(getFunctionName(api.people.staffSeason), null);
  mocks.results.set(getFunctionName(api.people.decisions), {
    rows: [],
    isDone: true,
    continueCursor: '',
  });
});

/** The joined page at `/admin/people/$id?…`, as the person route draws its pane into the layout. */
function open(id: string) {
  mocks.params = { id };
  const returnTo = peopleListHref(queryOf(mocks.search));
  return render(
    <PeopleListRoute detail={<PersonPane userId={id} returnTo={returnTo} className="h-full" />} />,
  );
}

const personPane = () => screen.getByRole('region', { name: 'Person' });
const list = () => screen.getByRole('listbox');
const active = () => document.getElementById(list().getAttribute('aria-activedescendant') ?? '');

describe('a person beside the list', () => {
  it('opens a deep link beside the list on the lane the URL names', () => {
    mocks.search = { lane: 'staff', q: 'rob' };
    mocks.results.set(PAGE_READ, page([{ ...ROB_ROW, userId: ROB.userId }]));
    open(ROB.userId);
    expect((mocks.calls.get(PAGE_READ) ?? []).at(-1)).toMatchObject({ search: 'rob' });
    expect(within(personPane()).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Rob Tremblay',
    );
    expect(within(list()).getByRole('option', { name: /Rob Tremblay/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens a deep link with no lane on Everyone', () => {
    mocks.results.set(PAGE_READ, page([KATE]));
    open(ROB.userId);
    expect((mocks.calls.get(PAGE_READ) ?? []).at(-1)).toMatchObject({ lane: 'everyone' });
  });

  it('says No such person for an id that can’t be one, and the list still opens people', () => {
    mocks.search = { lane: 'suspended' };
    mocks.results.set(PAGE_READ, page([KATE]));
    open('not an id');
    expect(within(personPane()).getByText('No such person')).toBeInTheDocument();
    // Its way back is the list, on its lane.
    expect(within(personPane()).getByRole('link', { name: /People/ })).toHaveAttribute(
      'href',
      '/admin/people?lane=suspended',
    );
    // An id of the wrong shape is never asked about.
    expect(mocks.calls.get(getFunctionName(api.people.person))).toBeUndefined();
    fireEvent.click(within(list()).getByText('Kate Donovan'));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin/people/$id',
      params: { id: KATE.userId },
      search: { lane: 'suspended' },
      replace: true,
    });
  });

  it('says No such person for an id the server has no account for', () => {
    mocks.results.set(getFunctionName(api.people.person), null);
    mocks.results.set(PAGE_READ, page([KATE]));
    open(ROB.userId);
    expect(within(personPane()).getByText('No such person')).toBeInTheDocument();
    expect(within(list()).getByRole('option', { name: /Kate Donovan/ })).toBeInTheDocument();
  });
});

/** Every heading's level on the page, in reading order. */
const outline = () =>
  [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));

/** One h1, and no level deeper than one past the level before it. */
function expectOutline() {
  const levels = outline();
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  expect(levels[0]).toBe(1);
  levels.forEach((l, i) => {
    if (i > 0) expect(l).toBeLessThanOrEqual((levels[i - 1] as number) + 1);
  });
}

describe('one outline', () => {
  it('has one h1, the lane’s word; the person’s name under it, their blocks under that', () => {
    mocks.results.set(PAGE_READ, page([KATE]));
    open(ROB.userId);
    expectOutline();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Everyone');
    expect(within(personPane()).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Rob Tremblay',
    );
    expect(within(personPane()).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(1);
  });

  it('skips no level when the person couldn’t be read, or there is no such person', () => {
    mocks.results.set(PAGE_READ, page([KATE]));
    mocks.results.set(getFunctionName(api.people.person), new Error('boom'));
    const failed = open(ROB.userId);
    expectOutline();
    expect(
      within(personPane()).getByRole('heading', { level: 2, name: /History/ }),
    ).toBeInTheDocument();
    failed.unmount();
    open('not an id');
    expectOutline();
  });
});

describe('back to the list', () => {
  const rows = () =>
    page([KATE, { ...ROB_ROW, userId: ROB.userId }, { ...SARAH_ROW, userId: 'k17sarah' as never }]);

  it.each([
    ['Escape', { key: 'Escape' }],
    ['⇧⏎', { key: 'Enter', shiftKey: true }],
  ])('%s in the person’s page puts focus on the list, on the person’s row', (_, key) => {
    mocks.results.set(PAGE_READ, rows());
    open(ROB.userId);
    const inside = within(personPane()).getByRole('heading', { level: 2 });
    act(() => personPane().focus());
    expect(fireEvent.keyDown(inside, key)).toBe(false);
    expect(list()).toHaveFocus();
    expect(active()).toHaveTextContent('Rob Tremblay');
  });

  it('comes back to the row a person was opened from with the keys', () => {
    mocks.results.set(PAGE_READ, rows());
    mocks.params = {};
    const { rerender } = render(<PeopleListRoute />);
    act(() => list().focus());
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin/people/$id',
      params: { id: ROB.userId },
      search: {},
      replace: false,
    });
    expect(personPane()).toHaveFocus();
    // The route now holds the person.
    mocks.params = { id: ROB.userId };
    rerender(<PeopleListRoute detail={<PersonPane userId={ROB.userId} />} />);
    fireEvent.keyDown(personPane(), { key: 'Escape' });
    expect(list()).toHaveFocus();
    expect(active()).toHaveTextContent('Rob Tremblay');
  });

  it('leaves Esc to a field, and ignores a key something in the page already used', () => {
    mocks.results.set(PAGE_READ, rows());
    open(ROB.userId);
    const field = document.createElement('input');
    personPane().appendChild(field);
    act(() => field.focus());
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(true);
    expect(field).toHaveFocus();
    const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    used.preventDefault();
    act(() => personPane().focus());
    personPane().dispatchEvent(used);
    expect(personPane()).toHaveFocus();
    // A modified Escape is the browser's.
    expect(fireEvent.keyDown(personPane(), { key: 'Escape', metaKey: true })).toBe(true);
    field.remove();
  });
});
