import { fireEvent, screen, within } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import {
  argSets,
  harness as h,
  installCorpusRouteMocks,
  linkPlace,
  must,
  resetHarness,
  writesTo,
} from '../../testing/routeHarness';
import { GROTON, GROTON_DECIDED, GROTON_NOT_RECORDED } from './classesFixtures';
import type { ClassesItem } from './classesModel';

/**
 * **The Class conflicts handler through the real route** (the shared harness):
 * `?lane=class-conflicts&item=` opens the task in this handler — found by the registry, not imported
 * — which asks the map band's outlines, links to the body's Names tab, and sends
 * `corpusWrites.decideClass` with the task and the class; the landed decision is a receipt with Undo
 * on the write's own row, a refusal a toast.
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

const DECIDE = 'corpusWrites:decideClass';
const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');

/** Open `item` in its lane; one answer object, so every render reads the same item. */
function open(item: ClassesItem) {
  const answer = { item, pending: false };
  h.search = { lane: 'class-conflicts', item: item.taskId };
  h.answers['corpusTasks:item'] = () => answer;
  return mount();
}

describe('the Class conflicts handler, wired', () => {
  it('draws the task in this handler, not the placeholder, with the body’s Names tab linked', () => {
    // The task as the operator has it: a tab, a search, the open item.
    h.here = `/admin/corpus?lane=class-conflicts&tab=wetlandLake&q=groton&item=${GROTON.taskId}`;
    open(GROTON);
    const pane = inspector();
    expect(pane.querySelector('[data-slot="corpus-placeholder-facts"]')).toBeNull();
    expect(pane.querySelector('[data-slot="classes-handler"]')).not.toBeNull();
    // The catalogs' suggestion is the default pick.
    expect(within(pane).getByRole('radio', { name: 'Wetland' })).toBeChecked();
    // Its way back is this task, whole, so the console's return lands on it.
    expect(linkPlace(within(pane).getByRole('link', { name: /Open in Body/ }))).toEqual({
      path: `/admin/body/${GROTON.body.id}`,
      search: { tab: 'names', from: h.here },
    });
    expect(argSets('waterBodies:get')).toEqual(
      [GROTON.body.id, ...must(GROTON.neighbors, 'neighbors').map((n) => n.id)].map((id) =>
        JSON.stringify({ waterBodyId: id }),
      ),
    );
  });

  it('sends the picked class, with Undo on the write’s own row', async () => {
    open(GROTON);
    fireEvent.click(within(inspector()).getByRole('button', { name: /Set as Wetland/ }));
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
    expect(writesTo(DECIDE)).toEqual([
      { name: DECIDE, args: { taskId: GROTON.taskId, bodyClass: 'wetland' } },
    ]);
    expect(h.writes).toHaveLength(1);
  });

  it('sends a keep as the body’s own class', async () => {
    open(GROTON);
    fireEvent.click(within(inspector()).getByRole('radio', { name: 'Lake or pond' }));
    fireEvent.click(within(inspector()).getByRole('button', { name: /Keep as Lake or pond/ }));
    expect((await screen.findAllByText(/Kept as Lake or pond/)).length).toBeGreaterThan(0);
    expect(writesTo(DECIDE)).toEqual([
      { name: DECIDE, args: { taskId: GROTON.taskId, bodyClass: 'lakePond' } },
    ]);
  });

  it('says a refusal in a toast naming the body, and announces nothing', async () => {
    h.writeAnswers[DECIDE] = () => {
      throw new ConvexError('This body was removed from the corpus since this was asked.');
    };
    open(GROTON);
    fireEvent.click(within(inspector()).getByRole('button', { name: /Set as Wetland/ }));
    expect((await screen.findAllByText('Not saved · Unnamed water')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('a decided task opens locked: no bar, nothing to send', () => {
    open(GROTON_DECIDED);
    expect(within(inspector()).queryByRole('button', { name: /Keep as|Set as/ })).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it('nearest not computed yet: said so, and the map asks the body alone', () => {
    open(GROTON_NOT_RECORDED);
    expect(within(inspector()).getByText('Not computed yet')).toBeInTheDocument();
    expect(argSets('waterBodies:get')).toEqual([JSON.stringify({ waterBodyId: GROTON.body.id })]);
  });
});
