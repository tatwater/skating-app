import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../body/tabs/jsdomStubs';
import {
  bodyId,
  CLASS_ITEM,
  DECIDED_BY_COLLEAGUE,
  DECIDED_BY_ME,
  NAME_DECIDED_ROW,
  NAME_ITEM,
  NAME_ITEM_DECIDED,
  NAME_ROWS,
  page,
} from './corpusFixtures';
import type { CorpusTaskItemView } from './corpusTypes';
import type { CorpusHandlerProps } from './inspector/handlerRegistry';
import { PlaceholderHandler } from './inspector/PlaceholderHandler';
import { TASK_SEARCH_DEBOUNCE_MS } from './list/TaskSearch';
import {
  harness as h,
  installCorpusRouteMocks,
  lastArgs,
  must,
  resetHarness,
} from './testing/routeHarness';

/**
 * **A task lane through the real route and view** (the shared harness: only the router, the role,
 * the read layer and the mutation hook stood in): `BodiesRoute` dispatches a task lane to
 * `CorpusTaskRoute`, which asks the task reads with the place in the URL, draws the list with its
 * count, opens `?item=` in its lane's handler (the placeholder where none is registered) and runs
 * the decided-only lock over the item's live read.
 *
 * The registry is stood in here — a stub for Name conflicts, none for Class conflicts — so the frame's
 * dispatch is tested apart from the handlers (each has its own wiring test beside it).
 */

/** The stub handler: the placeholder's facts in a frame of its own, so the lock still draws. */
function StubHandler(props: CorpusHandlerProps) {
  return (
    <div data-slot="stub-handler">
      <PlaceholderHandler {...props} />
    </div>
  );
}
vi.doMock('./inspector/handlerRegistry', async (orig) => ({
  ...(await orig<typeof import('./inspector/handlerRegistry')>()),
  CORPUS_HANDLERS: new Map([['nameConflicts', StubHandler]]),
}));

// The narrow-screen rule is measured; here a test says which side of it the page is on.
const columns = { fit: true };
vi.doMock('../shell/columnsFit', async (orig) => ({
  ...(await orig<typeof import('../shell/columnsFit')>()),
  useColumnsFit: () => columns.fit,
}));

const { mount } = await installCorpusRouteMocks();

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () =>
      ({
        cancel() {},
        pause() {},
        play() {},
        currentTime: 0,
        finished: Promise.resolve(),
      }) as unknown as Animation,
  });
  stubJsdomAnimations();
});
beforeEach(() => {
  resetHarness();
  columns.fit = true;
});

const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');
const sidebar = () =>
  must(document.querySelector<HTMLElement>('[data-pane="lanes"]'), 'the sidebar');
const navigations = () => {
  const seen: Record<string, unknown>[] = [];
  h.navigate = ({ search }) => {
    seen.push(search);
  };
  return seen;
};
/** The newest ask for the open list's page (the decided tail asks the same read with `tab: 'decided'`). */
const listArgs = () =>
  [...h.asked].reverse().find((a) => a.name === 'corpusTasks:listPage' && a.args.tab !== 'decided')
    ?.args;
/** A read that failed, as the read layer hands it over. */
const failed = () => ({
  failed: true,
  error: new Error('refused'),
  pending: false,
  retry: () => {},
});
const openItem = (item: CorpusTaskItemView) => {
  h.answers['corpusTasks:item'] = () => ({ item, pending: false });
};

describe('a task lane', () => {
  it('opens its list with its count, asking the lane’s page on the list’s clock', () => {
    h.search = { lane: 'name-conflicts' };
    mount();
    expect(document.querySelector('[data-slot="corpus-task-page"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="bodies-page"]')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Name conflicts');
    expect(document.querySelector('[data-slot="corpus-kicker"]')?.textContent).toBe('412 bodies');
    expect(screen.getByText('The Basin')).toBeInTheDocument();
    expect(listArgs()).toMatchObject({
      lane: 'nameConflicts',
      cursor: null,
      pageSize: 50,
    });
    expect(listArgs()).not.toHaveProperty('tab');
    // The decided tail beside it, newest first.
    expect(h.asked.some((a) => a.name === 'corpusTasks:listPage' && a.args.tab === 'decided')).toBe(
      true,
    );
    // The sidebar counts the task lanes from the lanes read, above the library's groups.
    const lanes = within(sidebar());
    expect(lanes.getByText('Tasks')).toBeInTheDocument();
    expect(lanes.getByText('412')).toBeInTheDocument();
    expect(lanes.getByText('140')).toBeInTheDocument();
    expect(lanes.getByText('Standing')).toBeInTheDocument();
  });

  it('a tab writes `tab`, and the tab in the URL reads its facet and counts it', () => {
    const seen = navigations();
    h.search = { lane: 'name-conflicts' };
    const first = mount();
    fireEvent.click(screen.getByRole('button', { name: 'One letter' }));
    expect(seen.at(-1)).toEqual({ lane: 'name-conflicts', tab: 'oneLetter' });
    first.unmount();
    h.search = { lane: 'name-conflicts', tab: 'oneLetter' };
    mount();
    expect(listArgs()).toMatchObject({ lane: 'nameConflicts', tab: 'oneLetter' });
    // On a facet tab the decided tail is still the lane's whole tail.
    expect(lastArgs('corpusTasks:listPage')).toMatchObject({ tab: 'decided', pageSize: 20 });
    expect(document.querySelector('[data-slot="corpus-kicker"]')?.textContent).toBe('97 bodies');
  });

  it('opening another lane resets the place: a task lane fresh, a library lane by its id', () => {
    const seen = navigations();
    h.search = { lane: 'name-conflicts', tab: 'qualifier', item: NAME_ITEM.taskId };
    openItem(NAME_ITEM);
    mount();
    fireEvent.click(within(sidebar()).getByText('Class conflicts'));
    expect(seen.at(-1)).toEqual({ lane: 'class-conflicts' });
    fireEvent.click(within(sidebar()).getByText('Removed · rejected'));
    expect(seen.at(-1)).toEqual({ lane: 'removed' });
    // The library's default lane is written as no lane at all.
    fireEvent.click(within(sidebar()).getByText('Active'));
    expect(seen.at(-1)).toEqual({});
  });

  it('opens `item` in the handler registered for its lane', () => {
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    openItem(NAME_ITEM);
    mount();
    expect(lastArgs('corpusTasks:item')).toMatchObject({ ref: NAME_ITEM.taskId });
    expect(lastArgs('corpusTasks:item')).not.toHaveProperty('lane');
    expect(inspector().querySelector('[data-slot="stub-handler"]')).not.toBeNull();
    // The open row is the list's selected one.
    const grid = screen.getByRole('grid', { name: 'Name conflicts' });
    const chosen = within(grid)
      .getAllByRole('row')
      .find((r) => r.getAttribute('aria-selected') === 'true');
    expect(chosen?.textContent).toContain('The Basin');
  });

  it('opens a lane no handler claims in the placeholder: the facts, read only', () => {
    h.search = { lane: 'class-conflicts', item: CLASS_ITEM.taskId };
    openItem(CLASS_ITEM);
    mount();
    expect(inspector().querySelector('[data-slot="stub-handler"]')).toBeNull();
    const facts = must(
      inspector().querySelector('[data-slot="corpus-placeholder-facts"]'),
      'the placeholder',
    );
    expect(facts.textContent).toContain('OSM Lake or pond · NHD Wetland');
    expect(within(inspector()).queryByRole('toolbar')).toBeNull();
    expect(
      inspector().querySelector('[data-slot="corpus-open-in-body"]')?.getAttribute('href'),
    ).toBe(`/admin/body/${CLASS_ITEM.body.id}`);
  });

  it('asks a body ref with its lane', () => {
    const ref = `body:${bodyId('basin')}`;
    h.search = { lane: 'class-conflicts', item: ref };
    mount();
    expect(lastArgs('corpusTasks:item')).toMatchObject({ ref, lane: 'classConflicts' });
  });

  it('says No such task, and Not yet while the tasks are still being filed', () => {
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    const first = mount();
    expect(inspector().querySelector('[data-slot="corpus-no-such-task"]')).not.toBeNull();
    first.unmount();
    h.answers['corpusTasks:item'] = () => ({ item: null, pending: true });
    mount();
    expect(inspector().querySelector('[data-slot="corpus-item-pending"]')).not.toBeNull();
  });

  it('a decided task opened from the tail shows the lock', () => {
    h.search = { lane: 'name-conflicts', item: NAME_ITEM_DECIDED.taskId };
    openItem(NAME_ITEM_DECIDED);
    mount();
    const lock = must(inspector().querySelector('[data-slot="inbox-inspector-lock"]'), 'the lock');
    expect(lock.textContent).toContain('Decided by Avery Lindqvist');
    expect(lock.textContent).toContain('renamed');
  });

  it('a colleague’s decision while open locks it; the viewer’s own clears quietly', () => {
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    openItem(NAME_ITEM);
    const view = mount();
    expect(inspector().querySelector('[data-slot="inbox-inspector-lock"]')).toBeNull();
    openItem({ ...NAME_ITEM, can: {}, decided: DECIDED_BY_COLLEAGUE });
    view.refresh();
    expect(inspector().querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
    view.unmount();

    openItem(NAME_ITEM);
    const mine = mount();
    openItem({ ...NAME_ITEM, can: {}, decided: DECIDED_BY_ME });
    mine.refresh();
    expect(inspector().querySelector('[data-slot="inbox-inspector-lock"]')).toBeNull();
    expect(inspector().querySelector('[data-locked]')).not.toBeNull();
  });

  it('reads nothing of the tasks for a viewer without corpus.read', () => {
    h.can = (c) => c !== 'corpus.read';
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    mount();
    expect(h.asked.filter((a) => a.name.startsWith('corpusTasks:'))).toEqual([]);
  });
});

describe('the list', () => {
  it('a search writes `q` in place, asks the page with it, and marks it in the names', () => {
    vi.useFakeTimers();
    try {
      const seen: { search: Record<string, unknown>; replace?: boolean }[] = [];
      h.navigate = (opts) => {
        seen.push(opts as (typeof seen)[number]);
      };
      h.search = { lane: 'name-conflicts' };
      const first = mount();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Find a body' }), {
        target: { value: ' basin ' },
      });
      expect(seen).toEqual([]);
      act(() => vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS));
      expect(seen.at(-1)).toMatchObject({
        search: { lane: 'name-conflicts', q: 'basin' },
        replace: true,
      });
      first.unmount();
      h.search = { lane: 'name-conflicts', q: 'basin' };
      mount();
      expect(listArgs()).toMatchObject({ lane: 'nameConflicts', q: 'basin' });
      const marks = [...document.querySelectorAll('[data-slot="corpus-task-grid"] mark')];
      expect(marks.map((m) => m.textContent)).toContain('Basin');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops typing when the place moves before the search is asked', () => {
    vi.useFakeTimers();
    try {
      const seen: Record<string, unknown>[] = [];
      h.navigate = ({ search }) => {
        seen.push(search);
      };
      h.search = { lane: 'name-conflicts' };
      const view = mount();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Find a body' }), {
        target: { value: 'basin' },
      });
      // Another tab, before the beat ends: the typing belonged to the place it was typed in.
      h.search = { lane: 'name-conflicts', tab: 'oneLetter' };
      view.refresh();
      act(() => vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS * 2));
      expect(seen.some((search) => search.q !== undefined)).toBe(false);
      expect(
        (screen.getByRole('searchbox', { name: 'Find a body' }) as HTMLInputElement).value,
      ).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws the decided tail only under a list whose every row is in', () => {
    h.answers['corpusTasks:listPage'] = (args) =>
      args.tab === 'decided'
        ? page([NAME_DECIDED_ROW])
        : page(NAME_ROWS.slice(0, 2), { isDone: false, continueCursor: 'c1' });
    h.search = { lane: 'name-conflicts' };
    mount();
    const grid = screen.getByRole('grid', { name: 'Name conflicts' });
    expect(within(grid).queryByText('Decided lately')).toBeNull();
    expect(within(grid).queryByText(NAME_DECIDED_ROW.shown)).toBeNull();
  });

  it('opens a row from the keyboard, the tail running on under the open rows', () => {
    const seen = navigations();
    h.answers['corpusTasks:listPage'] = (args) =>
      page(args.tab === 'decided' ? [NAME_DECIDED_ROW] : NAME_ROWS.slice(0, 2));
    h.search = { lane: 'name-conflicts' };
    mount();
    const grid = screen.getByRole('grid', { name: 'Name conflicts' });
    expect(within(grid).getByText('Decided lately')).toBeInTheDocument();
    expect(within(grid).getByText('All 2')).toBeInTheDocument();
    grid.focus();
    fireEvent.keyDown(grid, { key: 'End' });
    // Space opens, as ⏎ does, outside a type-ahead run.
    fireEvent.keyDown(grid, { key: ' ' });
    expect(seen.at(-1)).toEqual({ lane: 'name-conflicts', item: NAME_DECIDED_ROW.taskId });
    // Type-ahead by the first name, from the cursor on.
    fireEvent.keyDown(grid, { key: 's' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(seen.at(-1)).toEqual({ lane: 'name-conflicts', item: NAME_ROWS[1]?.taskId });
  });

  it('says a failed page with Try again, and a failed tail under a list that is all in', () => {
    h.answers['corpusTasks:listPage'] = () => failed();
    h.search = { lane: 'name-conflicts' };
    const first = mount();
    expect(document.querySelector('[data-slot="corpus-list-error"]')?.textContent).toContain(
      'The list couldn’t be read',
    );
    first.unmount();
    h.answers['corpusTasks:listPage'] = (args) =>
      args.tab === 'decided' ? failed() : page(NAME_ROWS);
    mount();
    expect(document.querySelector('[data-slot="corpus-list-error"]')?.textContent).toBe('');
    expect(document.querySelector('[data-slot="corpus-tail-error"]')?.textContent).toContain(
      'The decided tasks couldn’t be read',
    );
  });

  it('stops a search at its scan bound with More to read and Read on', () => {
    h.answers['corpusTasks:listPage'] = (args) =>
      args.tab === 'decided'
        ? page([])
        : page(NAME_ROWS, { isDone: false, continueCursor: 'c1', scanBudgetSpent: true });
    h.search = { lane: 'name-conflicts', q: 'lake' };
    mount();
    expect(document.querySelector('[data-slot="corpus-end"]')?.textContent).toBe('More to read');
    expect(screen.getByRole('button', { name: 'Read on' })).toBeInTheDocument();
  });

  it('a search the server cut at its bound says more may match: never All, no Read on, no tail', () => {
    // The search as `corpusTasks.listPage` answers it: one read, done, `scanBudgetSpent` at its bound.
    h.answers['corpusTasks:listPage'] = (args) =>
      args.tab === 'decided'
        ? page(NAME_ROWS.map((r) => ({ ...r, taskId: `d-${r.taskId}` as never })))
        : page(NAME_ROWS, { scanBudgetSpent: true });
    h.search = { lane: 'name-conflicts', q: 'pond' };
    mount();
    const end = document.querySelector('[data-slot="corpus-end"]');
    expect(end?.textContent).toBe('More may match: narrow the search');
    expect(end?.textContent).not.toContain('All');
    expect(screen.queryByRole('button', { name: 'Read on' })).toBeNull();
    // The decided tail sits only under a list whose every row is in.
    expect(document.querySelector('[data-slot="corpus-tail"]')).toBeNull();
  });

  it('a cut search that found nothing in what it read still says more may match', () => {
    h.answers['corpusTasks:listPage'] = (args) =>
      args.tab === 'decided' ? page([]) : page([], { scanBudgetSpent: true });
    h.search = { lane: 'name-conflicts', q: 'pond' };
    mount();
    expect(document.querySelector('[data-slot="corpus-end"]')?.textContent).toBe(
      'More may match: narrow the search',
    );
  });

  it('says the server is still filing, and draws no count it can’t vouch for', () => {
    h.lanes = {
      lanes: { nameConflicts: { open: 3, facets: {} }, classConflicts: { open: 0, facets: {} } },
      pending: true,
    };
    h.answers['corpusTasks:listPage'] = () => page(NAME_ROWS, { pending: true });
    h.search = { lane: 'name-conflicts' };
    mount();
    expect(document.querySelector('[data-slot="corpus-pending"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="corpus-kicker"]')).toBeNull();
    expect(within(sidebar()).queryByText('3')).toBeNull();
  });

  it('a failed lanes read is said at the sidebar’s foot, never drawn as zero', () => {
    h.answers['corpusTasks:lanes'] = () => failed();
    h.search = { lane: 'name-conflicts' };
    mount();
    expect(document.querySelector('[data-slot="counts-error"]')?.textContent).toContain(
      'Counts couldn’t be read',
    );
    expect(document.querySelector('[data-slot="corpus-kicker"]')).toBeNull();
  });
});

describe('a library lane', () => {
  it('still draws the library, under the same sidebar, asking only the task lanes’ counts', () => {
    h.search = { lane: 'removed' };
    mount();
    expect(document.querySelector('[data-slot="bodies-page"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="corpus-task-page"]')).toBeNull();
    expect([
      ...new Set(h.asked.filter((a) => a.name.startsWith('corpusTasks:')).map((a) => a.name)),
    ]).toEqual(['corpusTasks:lanes']);
    expect(lastArgs('bodies:listPage')).toMatchObject({ lane: 'removed' });
    // The task lanes sit above the library's, counted.
    const lanes = within(sidebar());
    expect(lanes.getByText('Name conflicts')).toBeInTheDocument();
    expect(lanes.getByText('412')).toBeInTheDocument();
  });

  it('opens a task lane fresh from the library’s sidebar', () => {
    const seen = navigations();
    h.search = { lane: 'removed', q: 'echo' };
    mount();
    fireEvent.click(within(sidebar()).getByText('Class conflicts'));
    expect(seen.at(-1)).toEqual({ lane: 'class-conflicts' });
  });
});

/** Every navigation with its options (`replace`), in order. */
const goes = () => {
  const seen: { search: Record<string, unknown>; replace?: boolean }[] = [];
  h.navigate = (opts) => {
    seen.push(opts as (typeof seen)[number]);
  };
  return seen;
};
const grid = () => screen.getByRole('grid', { name: 'Name conflicts' });
const searchbox = () => screen.getByRole('searchbox', { name: 'Find a body' }) as HTMLInputElement;

describe('the inspector', () => {
  it('says a failed read of the open task with Try again', () => {
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    h.answers['corpusTasks:item'] = () => failed();
    mount();
    const error = must(
      inspector().querySelector<HTMLElement>('[data-slot="corpus-item-error"]'),
      'the failed note',
    );
    expect(error.textContent).toContain('couldn’t be read');
    expect(within(error).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(inspector().querySelector('[data-slot="stub-handler"]')).toBeNull();
  });

  it('⇧⏎ or Esc in it goes back to the list — never with a modifier, a repeat, or a key used', () => {
    const seen = goes();
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    openItem(NAME_ITEM);
    mount();
    const back = (init: KeyboardEventInit) => {
      act(() => inspector().focus());
      fireEvent.keyDown(inspector(), init);
      return document.activeElement === grid();
    };
    expect(back({ key: 'Enter', shiftKey: true })).toBe(true);
    expect(back({ key: 'Escape' })).toBe(true);
    expect(back({ key: 'Enter' })).toBe(false);
    expect(back({ key: 'Escape', repeat: true })).toBe(false);
    expect(back({ key: 'Enter', shiftKey: true, metaKey: true })).toBe(false);
    expect(back({ key: 'Escape', ctrlKey: true })).toBe(false);
    expect(back({ key: 'Escape', altKey: true })).toBe(false);
    // A key a handler already used is its own.
    act(() => inspector().focus());
    const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    used.preventDefault();
    inspector().dispatchEvent(used);
    expect(document.activeElement).not.toBe(grid());
    // Wide, the task stays open beside the list: the way back is focus, not a navigation.
    expect(seen).toEqual([]);
  });
});

describe('the list’s keys and pointer', () => {
  it('/ goes to the search from the list’s column, and types into a field', () => {
    h.search = { lane: 'name-conflicts' };
    mount();
    const tab = screen.getByRole('button', { name: 'One letter' });
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: '/' });
    expect(searchbox()).toHaveFocus();
    // In the field, it is a character like any other.
    const typed = fireEvent.keyDown(searchbox(), { key: '/' });
    expect(typed).toBe(true);
    // A key already used is not taken again.
    act(() => tab.focus());
    const used = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    used.preventDefault();
    tab.dispatchEvent(used);
    expect(tab).toHaveFocus();
  });

  it('/ from the rows goes to the search too: it is no type-ahead letter', () => {
    h.search = { lane: 'name-conflicts' };
    mount();
    act(() => grid().focus());
    fireEvent.keyDown(grid(), { key: '/' });
    expect(searchbox()).toHaveFocus();
  });

  it('a press on a row opens it', () => {
    const seen = goes();
    h.search = { lane: 'name-conflicts' };
    mount();
    const row = must(
      within(grid())
        .getAllByRole('row')
        .find((r) => r.textContent?.includes('The Basin')),
      'The Basin’s row',
    );
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    expect(seen.at(-1)).toEqual({
      to: '/admin/corpus',
      search: { lane: 'name-conflicts', item: NAME_ROWS[0]?.taskId },
    });
  });

  it('Esc clears the search and asks the list without it at once; typing not yet sent sends nothing', () => {
    vi.useFakeTimers();
    try {
      const seen = goes();
      h.search = { lane: 'name-conflicts', q: 'basin' };
      const view = mount();
      expect(searchbox().value).toBe('basin');
      fireEvent.keyDown(searchbox(), { key: 'Escape' });
      expect(searchbox().value).toBe('');
      expect(seen).toEqual([
        { to: '/admin/corpus', search: { lane: 'name-conflicts' }, replace: true },
      ]);
      // The URL follows; then typing cleared before its beat ends was never asked.
      h.search = { lane: 'name-conflicts' };
      view.refresh();
      fireEvent.change(searchbox(), { target: { value: 'echo' } });
      fireEvent.keyDown(searchbox(), { key: 'Escape' });
      expect(searchbox().value).toBe('');
      act(() => vi.advanceTimersByTime(TASK_SEARCH_DEBOUNCE_MS * 2));
      expect(seen).toHaveLength(1);
      // An empty field's Esc is the browser's.
      expect(fireEvent.keyDown(searchbox(), { key: 'Escape' })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a narrow screen (the console’s master–detail rule)', () => {
  const pane = (name: string) =>
    must(document.querySelector<HTMLElement>(`[data-pane="${name}"]`), `the ${name} pane`);

  it('gives the page to the open task; Back to the list closes it in place, focus on the rows', () => {
    columns.fit = false;
    const seen = goes();
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    openItem(NAME_ITEM);
    const view = mount();
    expect(document.querySelector('[data-slot="corpus-task-page"]')).toHaveAttribute('data-narrow');
    expect(pane('lanes')).toHaveClass('hidden');
    expect(pane('middle')).toHaveClass('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(seen).toEqual([
      { to: '/admin/corpus', search: { lane: 'name-conflicts' }, replace: true },
    ]);
    // The URL follows: the list takes the page, and its rows have focus once drawn.
    h.search = { lane: 'name-conflicts' };
    view.refresh();
    expect(pane('middle')).not.toHaveClass('hidden');
    expect(pane('detail')).toHaveClass('hidden');
    expect(grid()).toHaveFocus();
  });

  it('⇧⏎ in the open task closes it the same way', () => {
    columns.fit = false;
    const seen = goes();
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    openItem(NAME_ITEM);
    mount();
    act(() => pane('detail').focus());
    fireEvent.keyDown(pane('detail'), { key: 'Enter', shiftKey: true });
    expect(seen).toEqual([
      { to: '/admin/corpus', search: { lane: 'name-conflicts' }, replace: true },
    ]);
  });
});
