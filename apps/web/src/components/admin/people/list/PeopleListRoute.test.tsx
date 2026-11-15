import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The People list as the app mounts it: its place from the URL, the People server's reads (mocked
 * at the Convex hook), the chain of pages, and every state a read can be in — on its way, done,
 * short, failed, not ready — said as such. Never a fixture on screen but the server's rows.
 */

const mocks = vi.hoisted(() => ({
  /** A read's result by function name: a value, or a function of the read's arguments. */
  results: new Map<string, unknown>(),
  /** Every set of arguments each read was asked with, in order. */
  calls: new Map<string, unknown[]>(),
  search: {} as Record<string, unknown>,
  params: {} as Record<string, string>,
  navigate: vi.fn(),
  denied: new Set<string>(),
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
  };
});
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useParams: () => mocks.params,
  useNavigate: () => mocks.navigate,
  Outlet: () => <p>the person’s page</p>,
}));
vi.mock('../../shell/ConsoleShell', async (original) => ({
  ...(await original<typeof import('../../shell/ConsoleShell')>()),
  ConsoleStatus: ({ groups }: { groups: readonly ReactNode[] }) => (
    <output aria-label="Status">{groups}</output>
  ),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => !mocks.denied.has(c) }),
}));

import { api } from '@skating/convex/api';
import { PEOPLE_PAGE_SIZE } from '@skating/core';
import { getFunctionName } from 'convex/server';

import { resetConsoleReads } from '../../reads/consoleReads';
import { resetScrollMemory } from './PeopleList';
import { PeopleListRoute } from './PeopleListRoute';
import { KATE, LANES, LUC, MATT, page, ROB, SARAH, TEAGAN } from './peopleFixtures';
import { resetShownMemory, startingPageSize } from './peopleReads';
import { stubLayout } from './testLayout';

const LANES_READ = getFunctionName(api.people.lanes);
const PAGE_READ = getFunctionName(api.people.listPage);
type PageArgs = {
  lane: string;
  search?: string;
  cursor: string | null;
  pageSize: number;
  now: number;
};

beforeAll(stubLayout);
beforeEach(() => {
  resetScrollMemory();
  resetShownMemory();
  resetConsoleReads();
  mocks.results.clear();
  mocks.calls.clear();
  mocks.search = {};
  mocks.params = {};
  mocks.navigate.mockReset();
  mocks.denied = new Set();
  mocks.results.set(LANES_READ, LANES);
});

const pageCalls = () => (mocks.calls.get(PAGE_READ) ?? []) as PageArgs[];
const lastPageCall = () => pageCalls().at(-1);
const mount = () => render(<PeopleListRoute />);

describe('the reads', () => {
  it('asks for the lanes and the lane’s first page, on the list’s minute', () => {
    mocks.search = { lane: 'suspended' };
    mocks.results.set(PAGE_READ, page([ROB]));
    mount();
    const args = lastPageCall();
    expect(args).toMatchObject({ lane: 'suspended', cursor: null, pageSize: PEOPLE_PAGE_SIZE });
    expect(args).not.toHaveProperty('search');
    expect((args?.now ?? 1) % 60_000).toBe(0);
    expect(mocks.calls.get(LANES_READ)?.at(-1)).toEqual({ now: args?.now });
    expect(screen.getByRole('option', { name: /Rob Tremblay/ })).toBeInTheDocument();
    expect(screen.getByText('All 1')).toBeInTheDocument();
  });

  it('sends the search as the server runs it, and the lane it was typed over', () => {
    mocks.search = { lane: 'staff', q: '@sarah' };
    mocks.results.set(PAGE_READ, page([SARAH]));
    mount();
    expect(lastPageCall()).toMatchObject({ lane: 'staff', search: 'sarah' });
  });

  it('opens a moderator’s link to Appeals open on Everyone, and asks for no appeals', () => {
    mocks.denied = new Set(['inbox.support.read']);
    mocks.search = { lane: 'appeals' };
    mocks.results.set(PAGE_READ, page([]));
    mount();
    expect(lastPageCall()).toMatchObject({ lane: 'everyone' });
    expect(screen.queryByRole('button', { name: /Appeals/ })).toBeNull();
  });

  it('makes no read for a viewer who can’t read people, and says Not recorded yet', () => {
    mocks.denied = new Set(['people.read']);
    mount();
    expect(mocks.calls.get(PAGE_READ)).toBeUndefined();
    expect(mocks.calls.get(LANES_READ)).toBeUndefined();
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
  });

  it('draws skeletons while the first page is on its way', () => {
    mount();
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('the chain of pages', () => {
  it('asks for the next page from where the last ended, and draws each row once', () => {
    mocks.results.set(PAGE_READ, (args: PageArgs) =>
      args.cursor === null
        ? { ...page([TEAGAN, SARAH], { isDone: false }), continueCursor: 'c1' }
        : args.cursor === 'c1'
          ? page([SARAH, MATT])
          : undefined,
    );
    mount();
    // jsdom lays nothing out, so the list is always near its end: the next page is asked at once.
    expect(pageCalls().some((a) => a.cursor === 'c1' && a.pageSize === PEOPLE_PAGE_SIZE)).toBe(
      true,
    );
    const names = screen
      .getAllByRole('option')
      .map((o) => o.querySelector('[data-slot="person-name"]')?.textContent);
    expect(names).toEqual(['Teagan Atwater', 'Sarah Berman', 'Matt Steinberg']);
    expect(screen.getByText('All 3')).toBeInTheDocument();
  });

  it('keeps loading while a page is on its way, and draws no end until every row is in', () => {
    mocks.results.set(PAGE_READ, (args: PageArgs) =>
      args.cursor === null
        ? { ...page([KATE], { isDone: false }), continueCursor: 'c1' }
        : undefined,
    );
    mount();
    expect(screen.getByText('Loading more')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
  });

  it('re-anchors the pages after one whose end moved', () => {
    let end = 'c1';
    mocks.results.set(PAGE_READ, (args: PageArgs) =>
      args.cursor === null
        ? { ...page([KATE], { isDone: false }), continueCursor: end }
        : page([LUC]),
    );
    const { rerender } = mount();
    expect(pageCalls().some((a) => a.cursor === 'c1')).toBe(true);
    end = 'c1b';
    rerender(<PeopleListRoute />);
    rerender(<PeopleListRoute />);
    expect(lastPageCall()?.cursor).toBe('c1b');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('stops the chain where a reactive first page now ends the list', () => {
    let done = false;
    mocks.results.set(PAGE_READ, (args: PageArgs) =>
      args.cursor === null
        ? { ...page([KATE], { isDone: done }), continueCursor: 'c1' }
        : page([LUC]),
    );
    const { rerender } = mount();
    done = true;
    rerender(<PeopleListRoute />);
    mocks.calls.clear();
    rerender(<PeopleListRoute />);
    expect(pageCalls().every((a) => a.cursor === null)).toBe(true);
    expect(screen.getByText('All 1')).toBeInTheDocument();
  });

  it('starts a list left and come back to as long as it was showing', () => {
    mocks.results.set(PAGE_READ, page([KATE, LUC, ROB]));
    const { unmount } = mount();
    unmount();
    expect(startingPageSize('lane:everyone')).toBe(PEOPLE_PAGE_SIZE);
    const many = Array.from({ length: 70 }, (_, i) => ({ ...KATE, userId: `k${i}` as never }));
    mocks.results.set(PAGE_READ, page(many));
    mount();
    expect(startingPageSize('lane:everyone')).toBe(70);
  });

  it('joins what every page says it may be missing', () => {
    mocks.results.set(PAGE_READ, (args: PageArgs) =>
      args.cursor === null
        ? {
            ...page([KATE], { isDone: false }),
            continueCursor: 'c1',
            reasons: ['flags_capped'],
            partial: true,
          }
        : { ...page([LUC]), pending: ['rows'] },
    );
    mount();
    expect(screen.getByText(/more open flags than one read covers/)).toBeInTheDocument();
    expect(screen.getByText(/this list may not have everyone yet/)).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('says a failed list in its own place, and tries it again', async () => {
    mocks.results.set(PAGE_READ, new Error('boom'));
    mount();
    expect(screen.getByText('Couldn’t read this list')).toBeInTheDocument();
    mocks.results.set(PAGE_READ, undefined);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: /Trying again/ })).toBeInTheDocument();
  });

  it('keeps the rows it has when a later page fails', () => {
    mocks.results.set(PAGE_READ, (args: PageArgs) =>
      args.cursor === null
        ? { ...page([KATE], { isDone: false }), continueCursor: 'c1' }
        : new Error('boom'),
    );
    mount();
    expect(screen.getByText('Couldn’t read the rest of this list')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('shows no count when the counts fail — never a zero, never the last ones held', () => {
    mocks.results.set(PAGE_READ, page([KATE]));
    mocks.results.set(LANES_READ, new Error('boom'));
    mount();
    expect(screen.getByText('Counts couldn’t be read')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="lane-count"]')).toBeNull();
  });

  it('holds the last counts while the next list’s are on their way', () => {
    mocks.results.set(PAGE_READ, page([KATE]));
    const { rerender } = mount();
    expect(document.querySelector('[data-slot="lane-count"]')).not.toBeNull();
    mocks.results.set(LANES_READ, undefined);
    mocks.search = { lane: 'staff' };
    rerender(<PeopleListRoute />);
    expect(
      within(screen.getByRole('button', { name: /^Everyone/ })).getByText('38'),
    ).toBeInTheDocument();
  });
});

describe('where it goes', () => {
  it('opens another lane at the list, closing the open person', async () => {
    mocks.params = { id: ROB.userId };
    mocks.results.set(PAGE_READ, page([ROB]));
    mount();
    await userEvent.click(screen.getByRole('button', { name: /^Staff/ }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin/people', search: { lane: 'staff' } });
  });

  it('opens a person with the list’s place in their path, focus following', async () => {
    mocks.search = { lane: 'suspended' };
    mocks.results.set(PAGE_READ, page([ROB]));
    mount();
    const list = screen.getByRole('listbox');
    act(() => list.focus());
    await userEvent.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenCalledWith({
      href: `/admin/people/${ROB.userId}?lane=suspended`,
      replace: false,
    });
    expect(screen.getByRole('region', { name: 'Person' })).toHaveFocus();
  });

  it('opens one person over another in place, and draws the person’s page beside the list', async () => {
    mocks.params = { id: ROB.userId };
    mocks.results.set(PAGE_READ, page([ROB, KATE]));
    mount();
    expect(screen.getByText('the person’s page')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Kate Donovan'));
    expect(mocks.navigate).toHaveBeenCalledWith({
      href: `/admin/people/${KATE.userId}`,
      replace: true,
    });
    // A press leaves focus where the pointer is.
    expect(screen.getByRole('region', { name: 'Person' })).not.toHaveFocus();
  });

  it('keeps the open person through a search, replacing the entry as it is typed', () => {
    vi.useFakeTimers();
    try {
      mocks.params = { id: ROB.userId };
      mocks.results.set(PAGE_READ, page([ROB]));
      mount();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search any account' }), {
        target: { value: 'rob' },
      });
      act(() => vi.advanceTimersByTime(300));
      expect(mocks.navigate).toHaveBeenCalledWith({
        href: `/admin/people/${ROB.userId}?q=rob`,
        replace: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a search from the list at the list', () => {
    vi.useFakeTimers();
    try {
      mocks.results.set(PAGE_READ, page([ROB]));
      mount();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search any account' }), {
        target: { value: 'rob' },
      });
      act(() => vi.advanceTimersByTime(300));
      expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin/people', search: { q: 'rob' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws a page handed in place of the outlet', () => {
    mocks.params = { id: ROB.userId };
    mocks.results.set(PAGE_READ, page([ROB]));
    render(<PeopleListRoute detail={<p>handed in</p>} />);
    expect(screen.getByText('handed in')).toBeInTheDocument();
  });
});
