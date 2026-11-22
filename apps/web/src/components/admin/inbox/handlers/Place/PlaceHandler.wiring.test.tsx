import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { KeysProvider } from '@/lib/keys';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider } from '../../../shell/undo';
import { LANES } from '../../list/inboxFixtures';
import type { InboxItemView } from '../../list/inboxTypes';
import { PLACE_MAP } from '../../map/itemMapFixtures';
import {
  harness as h,
  installInboxRouteMocks,
  must,
  resetHarness,
} from '../../testing/routeHarness';
import { BAY_DRAWN, BAY_UNDRAWN, NARROWS, PLACE_BY_VIEWER, PLACE_DECIDED } from './placeFixtures';

/**
 * **The place handler through the real route and view** (the shared harness: only the router, the
 * role and the read layer stood in, plus the mutations, the theme and the live map's canvas): a
 * `place` item opens this handler, not the placeholder; *Same place* calls `corpusRequests.approve`
 * with the item's first ask and the lookalike as `sameAs`; *Approve* and *Decline* call theirs with
 * the ask's id; *Draw in Body →* opens the old editor in a new tab; a refusal reaches a toast; a
 * decided item drops the bar; and on a narrow page the map is view-only.
 */

const writes = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  answer: {} as Record<string, (args: Record<string, unknown>) => unknown>,
}));
const page = vi.hoisted(() => ({ fits: true }));
const maps = vi.hoisted(() => ({ viewOnly: [] as (boolean | undefined)[] }));

vi.doMock('convex/react', async (orig) => ({
  ...(await orig<typeof import('convex/react')>()),
  useMutation: (ref: never) => {
    const name = getFunctionName(ref);
    return async (args: Record<string, unknown>) => {
      writes.calls.push({ name, args });
      const answer = writes.answer[name];
      if (answer) return answer(args);
      // As the server answers a decision: the ask, its own audit row and this viewer's offer.
      return {
        requestId: args.requestId,
        itemId: null,
        actionId: 'ma_wired',
        undoable: true,
        undoNeedsReason: false,
      };
    };
  },
}));
vi.doMock('@/components/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));
vi.doMock('../../map/InboxMap', async (orig) => ({
  ...(await orig<typeof import('../../map/InboxMap')>()),
  InboxMap: ({ viewOnly }: { viewOnly?: boolean }) => {
    maps.viewOnly.push(viewOnly);
    return <div data-slot="live-map" />;
  },
}));
vi.doMock('../../../shell/columnsFit', async (orig) => ({
  ...(await orig<typeof import('../../../shell/columnsFit')>()),
  useColumnsFit: () => page.fits,
}));

const { Route } = await installInboxRouteMocks();

const mount = () =>
  render(
    <Toaster>
      <UndoProvider server={{ latestOwn: async () => null, run: async () => {} }}>
        <Route />
      </UndoProvider>
    </Toaster>,
    { wrapper: KeysProvider },
  );

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

const open = (item: InboxItemView) => {
  h.lanes = LANES;
  h.search = { lane: 'placesAsked', item: item.itemId };
  h.answers['inbox:item'] = () => ({ item, pending: false });
  h.answers['inbox:itemMap'] = () => ({ map: PLACE_MAP, pending: false });
};

beforeEach(() => {
  resetHarness();
  writes.calls = [];
  writes.answer = {};
  page.fits = true;
  maps.viewOnly = [];
});

const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');
const called = (name: string) => writes.calls.filter((c) => c.name === name);
const firstAsk = (item: InboxItemView) =>
  must((item as typeof NARROWS).asks[0], 'an ask').requestId;

describe('a place item, through the route and the view', () => {
  it('opens the place handler, not the placeholder', () => {
    open(NARROWS);
    mount();
    expect(inspector().querySelector('[data-slot="place-handler"]')).not.toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-placeholder-facts"]')).toBeNull();
  });

  it('Same place approves the first ask with the lookalike as sameAs', async () => {
    open(NARROWS);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Same place' }));
    await waitFor(() =>
      expect(called('corpusRequests:approve')).toEqual([
        {
          name: 'corpusRequests:approve',
          args: {
            requestId: firstAsk(NARROWS),
            sameAs: {
              landmarkId: (NARROWS.lookalikes[0] as { landmarkId: string }).landmarkId,
              name: 'The Narrows',
              point: { lat: 43.676, lng: -71.7571 },
            },
          },
        },
      ]),
    );
  });

  it('Approve answers a drawn bay with the first ask', async () => {
    open(BAY_DRAWN);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(called('corpusRequests:approve')).toEqual([
        { name: 'corpusRequests:approve', args: { requestId: firstAsk(BAY_DRAWN) } },
      ]),
    );
  });

  it('Decline asks the note and calls corpusRequests.decline with it', async () => {
    open(BAY_UNDRAWN);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Not a name anyone uses' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(called('corpusRequests:decline')).toEqual([
        {
          name: 'corpusRequests:decline',
          args: { requestId: firstAsk(BAY_UNDRAWN), note: 'Not a name anyone uses' },
        },
      ]),
    );
  });

  it('Draw in Body opens the old editor in a new tab, and writes nothing', () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    open(BAY_UNDRAWN);
    mount();
    expect(within(inspector()).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(inspector()).getByRole('button', { name: /Draw in Body/ }));
    expect(opened).toHaveBeenCalledWith(
      `/admin/water/${BAY_UNDRAWN.body.waterBodyId}`,
      '_blank',
      'noopener',
    );
    expect(writes.calls).toEqual([]);
    opened.mockRestore();
  });

  it('a refusal reaches a toast, in the server’s words', async () => {
    open(NARROWS);
    writes.answer['corpusRequests:approve'] = () => {
      throw new ConvexError('The person who asked withdrew this request.');
    };
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Same place' }));
    await waitFor(() =>
      expect(
        screen.getAllByText('The decision: The person who asked withdrew this request.').length,
      ).toBeGreaterThan(0),
    );
    expect(within(inspector()).queryByText(/withdrew/)).toBeNull();
  });

  it('a decided item drops the bar and shows the lock', () => {
    open(PLACE_DECIDED);
    mount();
    expect(within(inspector()).queryByRole('toolbar')).toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
  });

  it('draws nothing the viewer is refused, and says why once', () => {
    open(PLACE_BY_VIEWER);
    mount();
    expect(within(inspector()).queryByRole('toolbar')).toBeNull();
    expect(within(inspector()).getByText(/You filed this/)).toBeInTheDocument();
  });

  it('draws the map view-only on a narrow page, and not on a wide one', () => {
    open(NARROWS);
    const wide = mount();
    expect(maps.viewOnly.at(-1)).toBe(false);
    wide.unmount();
    page.fits = false;
    maps.viewOnly = [];
    mount();
    expect(maps.viewOnly.length).toBeGreaterThan(0);
    expect(maps.viewOnly.every((v) => v === true)).toBe(true);
  });
});
