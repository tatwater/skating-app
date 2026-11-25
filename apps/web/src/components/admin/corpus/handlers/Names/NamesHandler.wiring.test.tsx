import { fireEvent, screen, within } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import {
  argSets,
  harness as h,
  installCorpusRouteMocks,
  must,
  resetHarness,
  writesTo,
} from '../../testing/routeHarness';
import { BASIN, BASIN_DECIDED, BASIN_NOT_RECORDED } from './namesFixtures';
import type { NamesItem } from './namesModel';

/**
 * **The Name conflicts handler through the real route** (the shared harness): `?lane=name-conflicts&item=`
 * opens the task in this handler — found by the registry, not imported — which asks the head map's
 * outlines, links to the body's Names tab, and sends `corpusWrites.decideName` with the task and the
 * pick; the landed decision is a receipt with Undo on the write's own row, a refusal a toast.
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

const DECIDE = 'corpusWrites:decideName';
const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');

/** Open `item` in its lane; one answer object, so every render reads the same item. */
function open(item: NamesItem) {
  const answer = { item, pending: false };
  h.search = { lane: 'name-conflicts', item: item.taskId };
  h.answers['corpusTasks:item'] = () => answer;
  return mount();
}

describe('the Name conflicts handler, wired', () => {
  it('draws the task in this handler, not the placeholder, with the body’s Names tab linked', () => {
    open(BASIN);
    const pane = inspector();
    expect(pane.querySelector('[data-slot="corpus-placeholder-facts"]')).toBeNull();
    expect(pane.querySelector('[data-slot="names-facts"]')).not.toBeNull();
    expect(within(pane).getByRole('radio', { name: 'The Basin' })).toBeChecked();
    expect(
      within(pane)
        .getByRole('link', { name: /Open in Body/ })
        .getAttribute('href'),
    ).toBe(`/admin/body/${BASIN.body.id}?tab=names`);
    // The head map asks the body's outline and each neighbor's, one read each.
    expect(argSets('waterBodies:get')).toEqual(
      [BASIN.body.id, ...must(BASIN.neighbors, 'neighbors').map((n) => n.id)].map((id) =>
        JSON.stringify({ waterBodyId: id }),
      ),
    );
  });

  it('sends a keep as “shown”, and announces it with Undo on the write’s own row', async () => {
    open(BASIN);
    fireEvent.click(within(inspector()).getByRole('button', { name: /Keep “The Basin”/ }));
    expect((await screen.findAllByText(/Keeps “The Basin”/)).length).toBeGreaterThan(0);
    expect(writesTo(DECIDE)).toEqual([
      { name: DECIDE, args: { taskId: BASIN.taskId, pick: 'shown' } },
    ]);
    expect(h.writes).toHaveLength(1);
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
  });

  it('sends the other spelling when it is picked', async () => {
    open(BASIN);
    fireEvent.click(within(inspector()).getByRole('radio', { name: 'Lake Auburn' }));
    fireEvent.click(
      within(inspector()).getByRole('button', { name: /Display “Lake Auburn” instead/ }),
    );
    expect((await screen.findAllByText(/Displays “Lake Auburn”/)).length).toBeGreaterThan(0);
    expect(writesTo(DECIDE)).toEqual([
      { name: DECIDE, args: { taskId: BASIN.taskId, pick: 'Lake Auburn' } },
    ]);
  });

  it('says a refusal in a toast naming the body, and announces nothing', async () => {
    h.writeAnswers[DECIDE] = () => {
      throw new ConvexError('The Basin was merged into another body since this was asked.');
    };
    open(BASIN);
    fireEvent.click(within(inspector()).getByRole('button', { name: /Keep “The Basin”/ }));
    expect((await screen.findAllByText('Not saved · The Basin')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Keeps “The Basin”/)).toBeNull();
  });

  it('a decided task opens locked: no bar, nothing to send', () => {
    open(BASIN_DECIDED);
    const pane = inspector();
    expect(within(pane).queryByRole('button', { name: /Keep “/ })).toBeNull();
    expect(within(pane).queryByRole('button', { name: /instead/ })).toBeNull();
    expect(within(pane).getAllByText(/Kate Donovan/).length).toBeGreaterThan(0);
    expect(h.writes).toEqual([]);
  });

  it('neighbors not computed yet: said so, and the map asks the body alone', () => {
    open(BASIN_NOT_RECORDED);
    expect(within(inspector()).getByText('Not computed yet')).toBeInTheDocument();
    expect(argSets('waterBodies:get')).toEqual([JSON.stringify({ waterBodyId: BASIN.body.id })]);
  });
});
