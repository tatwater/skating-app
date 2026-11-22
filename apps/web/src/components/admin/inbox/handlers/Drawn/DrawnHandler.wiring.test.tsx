import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { KeysProvider } from '@/lib/keys';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider } from '../../../shell/undo';
import { LANES } from '../../list/inboxFixtures';
import type { InboxItemView } from '../../list/inboxTypes';
import { DRAWN_MAP } from '../../map/itemMapFixtures';
import {
  harness as h,
  installInboxRouteMocks,
  must,
  resetHarness,
} from '../../testing/routeHarness';
import { DRAWN_DECIDED, MODERATOR_VIEW, OVER_CASPIAN } from './drawnFixtures';

/**
 * **The drawn handler through the real route and view** (the shared harness: only the router, the
 * role and the read layer stood in, plus the mutations, the theme and the live map's canvas): a
 * `drawn` item opens this handler, not the placeholder; *Approve as new* and *Reject* call their
 * writes with the item's body; *Merge* writes nothing; a refusal reaches a toast; a decided item
 * drops the bar; and on a narrow page the map is view-only.
 */

// ── What the harness doesn't stand in ────────────────────────────────────────────────────────
const writes = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  /** A write's answer by name; throws to refuse. */
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
      // As the server answers a decision: the row it decided by, its own audit row and the offer.
      return answer
        ? answer(args)
        : { ...args, itemId: null, actionId: 'ma_wired', undoable: true, undoNeedsReason: false };
    };
  },
}));
vi.doMock('@/components/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));
// The live map is a canvas jsdom can't draw: a stand-in records whether it was asked view-only.
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
  h.search = { lane: 'drawnBodies', item: item.itemId };
  h.answers['inbox:item'] = () => ({ item, pending: false });
  h.answers['inbox:itemMap'] = () => ({ map: DRAWN_MAP, pending: false });
};

beforeEach(() => {
  resetHarness();
  writes.calls = [];
  writes.answer = {};
  page.fits = true;
  maps.viewOnly = [];
});
afterEach(() => vi.clearAllTimers());

const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');
const called = (name: string) => writes.calls.filter((c) => c.name === name);

describe('a drawn item, through the route and the view', () => {
  it('opens the drawn handler, not the placeholder', () => {
    open(OVER_CASPIAN);
    mount();
    expect(inspector().querySelector('[data-slot="drawn-handler"]')).not.toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-placeholder-facts"]')).toBeNull();
    // The map is the item's, read by its id.
    expect(
      h.asked.some((a) => a.name === 'inbox:itemMap' && a.args.ref === OVER_CASPIAN.itemId),
    ).toBe(true);
  });

  it('Approve as new calls waterBodies.approve with the item’s body', async () => {
    open(OVER_CASPIAN);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Approve as new' }));
    await waitFor(() =>
      expect(called('waterBodies:approve')).toEqual([
        { name: 'waterBodies:approve', args: { waterBodyId: OVER_CASPIAN.body.waterBodyId } },
      ]),
    );
  });

  it('Reject asks the reason and calls waterBodies.reject with it', async () => {
    open(OVER_CASPIAN);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Not water' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(called('waterBodies:reject')).toEqual([
        {
          name: 'waterBodies:reject',
          args: { waterBodyId: OVER_CASPIAN.body.waterBodyId, reason: 'Not water' },
        },
      ]),
    );
  });

  it('Merge writes nothing: it says Coming soon', async () => {
    open(OVER_CASPIAN);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: /Merge into Caspian Lake/ }));
    await waitFor(() => expect(screen.getAllByText('Coming soon').length).toBeGreaterThan(0));
    expect(writes.calls).toEqual([]);
  });

  it('a refusal reaches a toast, in the server’s words', async () => {
    open(OVER_CASPIAN);
    writes.answer['waterBodies:approve'] = () => {
      throw new ConvexError('This has already been decided.');
    };
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Approve as new' }));
    await waitFor(() =>
      expect(
        screen.getAllByText('The decision: This has already been decided.').length,
      ).toBeGreaterThan(0),
    );
    // Said in the toast, never in the pane.
    expect(within(inspector()).queryByText(/already been decided/)).toBeNull();
  });

  it('a decided item drops the bar and shows the lock', () => {
    open(DRAWN_DECIDED);
    mount();
    expect(within(inspector()).queryByRole('toolbar')).toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
  });

  it('draws only what can allows: no merge for a moderator refused it', () => {
    open(MODERATOR_VIEW);
    mount();
    expect(within(inspector()).queryByRole('button', { name: /Merge/ })).toBeNull();
    expect(within(inspector()).getByRole('button', { name: 'Approve as new' })).toBeInTheDocument();
  });

  it('draws the map view-only on a narrow page, and not on a wide one', async () => {
    open(OVER_CASPIAN);
    const wide = mount();
    expect(maps.viewOnly.at(-1)).toBe(false);
    wide.unmount();
    page.fits = false;
    maps.viewOnly = [];
    mount();
    await act(async () => {});
    expect(maps.viewOnly.length).toBeGreaterThan(0);
    expect(maps.viewOnly.every((v) => v === true)).toBe(true);
  });
});
