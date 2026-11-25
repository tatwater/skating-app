import { fireEvent, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { stubJsdomAnimations } from '../body/tabs/jsdomStubs';
import {
  bodyId,
  DECIDED_BY_COLLEAGUE,
  DECIDED_BY_ME,
  NAME_ITEM,
  NAME_ITEM_DECIDED,
} from './corpusFixtures';
import type { CorpusTaskItemView } from './corpusTypes';
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
 * count, opens `?item=` in its lane's handler (the placeholder until one is registered) and runs the
 * decided-only lock over the item's live read.
 */

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
beforeEach(resetHarness);

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

  it('opens `item` in its lane’s handler — the placeholder, with no handler registered', () => {
    h.search = { lane: 'name-conflicts', item: NAME_ITEM.taskId };
    openItem(NAME_ITEM);
    mount();
    expect(lastArgs('corpusTasks:item')).toMatchObject({ ref: NAME_ITEM.taskId });
    expect(lastArgs('corpusTasks:item')).not.toHaveProperty('lane');
    const facts = must(
      inspector().querySelector('[data-slot="corpus-placeholder-facts"]'),
      'the placeholder',
    );
    expect(facts.textContent).toContain('“The Basin” · “Lake Auburn”');
    expect(within(inspector()).queryByRole('toolbar')).toBeNull();
    expect(
      inspector().querySelector('[data-slot="corpus-open-in-body"]')?.getAttribute('href'),
    ).toBe(`/admin/body/${NAME_ITEM.body.id}`);
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

describe('a library lane', () => {
  it('still draws the library, and asks no task read', () => {
    h.search = { lane: 'removed' };
    mount();
    expect(document.querySelector('[data-slot="bodies-page"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="corpus-task-page"]')).toBeNull();
    expect(h.asked.filter((a) => a.name.startsWith('corpusTasks:'))).toEqual([]);
    expect(lastArgs('bodies:listPage')).toMatchObject({ lane: 'removed' });
  });
});
