import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../body/tabs/jsdomStubs';
import { FAILED_READ } from '../reads/readFailureFixtures';
import { ALL_OPEN_ROWS, LANES } from './list/inboxFixtures';
import type { InboxLanesView } from './list/inboxTypes';
import {
  argSets,
  harness as h,
  installInboxRouteMocks,
  lastArgs,
  must,
  resetHarness,
} from './testing/routeHarness';
import { ITEM_FAILED } from './words/inboxWords';

/**
 * **The route and the view together** (Greptile on #171, round 1): what the wiring does, where the
 * pieces' own tests couldn't see it — through the shared harness (`testing/routeHarness`), which
 * stands in only the router, the role and the read layer and records every read's arguments.
 */

const { Route: InboxRoute, mount } = await installInboxRouteMocks();

beforeAll(stubJsdomAnimations);
beforeEach(resetHarness);

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

describe('an item the server couldn’t read (R8: a required row past the budget throws)', () => {
  it('draws the inspector’s failed read with Try again — never a crash or a blank pane', () => {
    h.lanes = LANES;
    h.search = { lane: 'requests', item: 'request:rq_heavy' };
    // The read layer turns the query's throw into its failure (`consoleReads`' own tests hold that).
    h.answers['inbox:item'] = () => FAILED_READ;
    mount();
    const pane = must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');
    expect(within(pane).getAllByText(ITEM_FAILED).length).toBeGreaterThan(0);
    expect(within(pane).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // The list beside it still draws: one failed read takes down its own block, not the page.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
});
