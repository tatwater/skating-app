import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';

import { stubJsdomAnimations } from '../body/tabs/jsdomStubs';
import { ALL_OPEN_ROWS, LANES, page } from './list/inboxFixtures';
import type { InboxLanesView } from './list/inboxTypes';

/**
 * **The route and the view together** (Greptile on #171, round 1): what the wiring does, where the
 * pieces' own tests couldn't see it — the real `InboxRoute` around the real `InboxView`, with only
 * the router, the role and the read layer underneath them stood in. Every read the page asks for is
 * recorded by name with its arguments, so a test reads what the server would have been asked.
 */

const h = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: (() => {}) as (opts: { search: Record<string, unknown> }) => void,
  lanes: undefined as unknown,
  asked: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => h.search,
  useNavigate: () => h.navigate,
  Link: ({ children, ...p }: { children?: ReactNode }) => <a {...p}>{children}</a>,
}));
vi.mock('@/lib/useRole', () => ({ useRole: () => ({ can: () => true }) }));
vi.mock('../reads/consoleReads', async (orig) => {
  const actual = await orig<typeof import('../reads/consoleReads')>();
  return {
    ...actual,
    useConsoleReadSet: (specs: Record<string, { query: never; args: never } | null>) => {
      const reads: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(specs)) {
        if (spec === null) continue;
        const name = getFunctionName(spec.query);
        h.asked.push({ name, args: spec.args });
        reads[k] =
          name === 'inbox:lanes'
            ? h.lanes
            : name === 'inbox:listPage'
              ? page(ALL_OPEN_ROWS)
              : name === 'inbox:item'
                ? { item: null, pending: false }
                : undefined;
      }
      return { reads, retry: () => {}, live: true, failed: false, pending: false };
    },
  };
});

const { InboxRoute } = await import('./InboxRoute');

beforeAll(stubJsdomAnimations);

/** The arguments the newest read of `name` was asked with. */
const lastArgs = (name: string) => [...h.asked].reverse().find((a) => a.name === name)?.args;
/** The value, or a failed test saying what was missing. */
const must = <T,>(x: T | null | undefined, what: string): T => {
  if (x == null) throw new Error(`missing: ${what}`);
  return x;
};
/** Every distinct argument set `name` was asked with, in order. */
const argSets = (name: string) => [
  ...new Set(h.asked.filter((a) => a.name === name).map((a) => JSON.stringify(a.args))),
];

const mount = () => render(<InboxRoute />, { wrapper: KeysProvider });

describe('the day rolls over with the list open (finding 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    h.asked = [];
    h.search = {};
    h.navigate = () => {};
    // Inbox zero, so the day's own read (`inbox.today`) is asked beside the lanes'.
    h.lanes = { ...LANES, allOpen: 0, pending: false } satisfies InboxLanesView;
  });
  afterEach(() => vi.useRealTimers());

  it('counts today from the new midnight; the pages keep their clock; a minute re-asks nothing', () => {
    const evening = new Date(2026, 10, 21, 23, 58, 30);
    vi.setSystemTime(evening);
    mount();
    const listClock = lastArgs('inbox:listPage')?.now;
    const yesterday = new Date(2026, 10, 21).getTime();
    expect(lastArgs('inbox:lanes')).toMatchObject({ dayStart: yesterday, now: listClock });
    expect(lastArgs('inbox:today')).toMatchObject({ dayStart: yesterday, now: listClock });
    const before = {
      lanes: argSets('inbox:lanes'),
      today: argSets('inbox:today'),
      pages: argSets('inbox:listPage'),
    };

    // An ordinary minute: nothing any read is asked with changes.
    act(() => vi.advanceTimersByTime(60_000));
    expect(argSets('inbox:lanes')).toEqual(before.lanes);
    expect(argSets('inbox:today')).toEqual(before.today);
    expect(argSets('inbox:listPage')).toEqual(before.pages);

    // Past local midnight, the list still open: the day's reads count from the new midnight (with
    // a clock the server's `[now − 1.5 days, now]` hold keeps it at), and the pages don't move.
    act(() => vi.advanceTimersByTime(2 * 60_000));
    const midnight = new Date(2026, 10, 22).getTime();
    expect(lastArgs('inbox:lanes')).toEqual({ now: midnight, dayStart: midnight });
    expect(lastArgs('inbox:today')).toEqual({ now: midnight, dayStart: midnight });
    expect(argSets('inbox:listPage')).toEqual(before.pages);
    expect(lastArgs('inbox:listPage')?.now).toBe(listClock);

    // And the next minute re-asks nothing again.
    const after = argSets('inbox:lanes');
    act(() => vi.advanceTimersByTime(60_000));
    expect(argSets('inbox:lanes')).toEqual(after);
  });
});

describe('another lane, tab or filter keeps a linked item and closes a list-opened one (finding 2)', () => {
  const linked = ALL_OPEN_ROWS[0]?.itemId as string;
  let view: ReturnType<typeof mount>;
  const navigated: Record<string, unknown>[] = [];

  beforeEach(() => {
    h.asked = [];
    navigated.length = 0;
    h.lanes = LANES;
    h.navigate = ({ search }) => {
      navigated.push(search);
      h.search = search;
      view.rerender(<InboxRoute />);
    };
  });

  const lane = (label: string) =>
    fireEvent.click(
      within(
        must(document.querySelector<HTMLElement>('[data-pane="lanes"]'), 'the lanes'),
      ).getByText(label),
    );
  const lastPlace = () => navigated.at(-1);

  it('keeps an item that came by a link, through a lane, a tab and a filter', () => {
    h.search = { lane: 'contentFlags', item: linked, age: 7 };
    view = mount();
    // A tab (a kind).
    fireEvent.click(
      must(within(screen.getByRole('group', { name: 'Kind' })).getAllByRole('button')[1], 'a tab'),
    );
    expect(lastPlace()?.item).toBe(linked);
    // A filter cleared.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(lastPlace()?.item).toBe(linked);
    expect(lastPlace()?.age).toBeUndefined();
    // Another lane.
    lane('Safety');
    expect(lastPlace()).toMatchObject({ lane: 'safety', item: linked });
  });

  it('closes an item opened from the list on a lane, a tab or a filter', () => {
    const openFromList = () => {
      const rows = screen.getAllByRole('option');
      fireEvent.click(must(rows[0], 'a row'));
      expect(lastPlace()?.item).toBeDefined();
    };
    h.search = { lane: 'contentFlags', age: 7 };
    view = mount();
    openFromList();
    fireEvent.click(
      must(within(screen.getByRole('group', { name: 'Kind' })).getAllByRole('button')[1], 'a tab'),
    );
    expect(lastPlace()?.item).toBeUndefined();

    openFromList();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(lastPlace()?.item).toBeUndefined();

    openFromList();
    lane('Safety');
    expect(lastPlace()).toMatchObject({ lane: 'safety' });
    expect(lastPlace()?.item).toBeUndefined();
  });
});
