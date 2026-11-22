import { zonedInstant } from '@skating/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { KeysProvider } from '@/lib/keys';

import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider, type UndoServer } from '../../../shell/undo';
import { LANES } from '../../list/inboxFixtures';
import type { InboxItemView } from '../../list/inboxTypes';
import { ADMIT_MAP } from '../../map/itemMapFixtures';
import {
  harness as h,
  installInboxRouteMocks,
  must,
  resetHarness,
} from '../../testing/routeHarness';
import { skateLine } from '../asks/AskList';
import {
  activate,
  activateNoDormancy,
  activateShelved,
  admit,
  admitClosedFirst,
  admitNoMatch,
  contest,
  contestNoRuling,
  POST_POND_SHELVED,
  REQUEST_NOW,
  restore,
  takedown,
} from './requestFixtures';
import { dormancyRows, type RequestItem } from './requestModel';

/**
 * **The request handler in the real route and view** (the shared harness, `testing/routeHarness`:
 * only the router, the role and the read layer stood in). Beside them this file stands in the three
 * corpus request mutations (`convex/react`'s `useMutation`, by function name), the map's MapLibre
 * canvas (its still takes the same props), and — for the narrow case — the view's one narrow signal.
 * The shell's undo and toasts are the real ones, around the route as the console's layout mounts them.
 */

/** Each write the handler sends, by function name (`corpusRequests:approve`, …). */
const writes = {
  'corpusRequests:approve': vi.fn(async (_args: unknown): Promise<unknown> => ({})),
  'corpusRequests:decline': vi.fn(async (_args: unknown): Promise<unknown> => ({})),
  'corpusRequests:reresolve': vi.fn(async (_args: unknown): Promise<unknown> => ({})),
};
/** A decision's answer, as the server writes it: its own row and this viewer's undo offer. */
const answered = (args: unknown) => ({
  ...(args as { requestId: string }),
  itemId: null,
  actionId: 'ma_request',
  undoable: true as const,
  undoNeedsReason: false,
});
let narrowPage = false;

vi.doMock('convex/react', async (orig) => {
  const actual = await orig<typeof import('convex/react')>();
  return {
    ...actual,
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref) as keyof typeof writes;
      return (args: unknown) => must(writes[name], name)(args);
    },
  };
});
vi.doMock('../../../shell/columnsFit', async (orig) => ({
  ...(await orig<typeof import('../../../shell/columnsFit')>()),
  useColumnsFit: () => !narrowPage,
}));
vi.doMock('../../map/InboxMap', async (orig) => {
  const actual = await orig<typeof import('../../map/InboxMap')>();
  return {
    ...actual,
    InboxMap: (p: Parameters<typeof actual.InboxMap>[0]) => (
      <actual.InboxMapStill view={p.view} viewOnly={p.viewOnly ?? false} width={336} />
    ),
  };
});

const { Route } = await installInboxRouteMocks();

beforeAll(() => {
  // The toast's time bar asks for a whole Animation (play, pause), not only the kit's stub.
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

const undo = (): UndoServer & { latestOwn: ReturnType<typeof vi.fn> } => ({
  latestOwn: vi.fn(async () => ({
    actionId: 'ma_request',
    undo: { state: 'available', needsReason: false },
  })),
  run: vi.fn(async () => {}),
});

let server = undo();

beforeEach(() => {
  // The item's clock: the fixtures' noon on 14 Oct (Date only, so the user's events keep their timers).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(REQUEST_NOW);
  resetHarness();
  narrowPage = false;
  server = undo();
  for (const w of Object.values(writes)) {
    w.mockReset();
    w.mockImplementation(async (args) => answered(args));
  }
  h.lanes = LANES;
});
afterEach(() => vi.useRealTimers());

/** The real route, around the item, inside the console's undo and toasts. */
function open(item: RequestItem) {
  h.search = { lane: 'requests', item: item.itemId };
  h.answers['inbox:item'] = () => ({ item: item as InboxItemView, pending: false });
  h.answers['inbox:itemMap'] = () => ({ map: ADMIT_MAP, pending: false });
  return render(
    <Toaster>
      <UndoProvider server={server}>
        <Route />
      </UndoProvider>
    </Toaster>,
    { wrapper: KeysProvider },
  );
}

const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');
const bar = () => within(inspector()).queryByRole('toolbar');
const button = (name: string) => within(inspector()).getByRole('button', { name });

describe('a request opens its handler, not the placeholder', () => {
  it('draws 2.3 in the inspector', () => {
    open(admit());
    expect(inspector().querySelector('[data-slot="request-handler"]')).not.toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-placeholder-elsewhere"]')).toBeNull();
    expect(within(inspector()).getByText('Admit a body')).toBeInTheDocument();
    expect(within(inspector()).getByText('Asked by 2 · 3 days ago')).toBeInTheDocument();
  });

  it('links a request on a body we hold into the body’s page, with the way back here', () => {
    // Where the console is, as the router says (every handler's link reads it the same way).
    h.here = `/admin/inbox?lane=requests&item=${activate().itemId}`;
    open(activate());
    const link = must(
      inspector().querySelector<HTMLElement>(
        '[data-slot="open-in-body"] a, a[data-slot="open-in-body"]',
      ),
      'Open in Body',
    );
    expect(link.closest('[data-slot="open-in-body"]')).toHaveTextContent('Open in Body');
    const id = activate().body?.waterBodyId as string;
    const to = new URL(must(link.getAttribute('href'), 'href'), 'https://gli.test');
    expect(to.pathname).toBe(`/admin/body/${id}`);
    expect(to.searchParams.get('from')).toBe(h.here);
  });
});

describe('what the read serves reaches the page', () => {
  it('draws contest access’s standing ruling as the Access handler draws it, and the body without one', () => {
    const { unmount } = open(contest());
    const ruling = within(inspector()).getByRole('region', { name: 'The ruling' });
    expect(within(ruling).getByText('Standing ruling')).toBeInTheDocument();
    expect(within(ruling).getByText('Sarah Berman')).toBeInTheDocument();
    expect(within(ruling).getByText('“Posted private by the landowner.”')).toBeInTheDocument();
    // The decision it sends is unchanged: the bar still confirms the body accessible.
    expect(button('Confirm accessible')).toBeInTheDocument();
    unmount();
    open(contestNoRuling());
    expect(within(inspector()).queryByRole('region', { name: 'The ruling' })).toBeNull();
    expect(within(inspector()).getByRole('region', { name: 'The body' })).toBeInTheDocument();
  });

  it('says why an activate’s body is dormant, and nothing when the read serves no dormancy', () => {
    const item = activate();
    const { unmount } = open(item);
    // The route reads the date in the runner's zone, as the model does with none given.
    const [row] = dormancyRows(must(item.dormancy, 'the dormancy'));
    expect(row?.value).toMatch(/^Inactive · since \d+ [A-Z][a-z]{2} 2025$/);
    expect(within(inspector()).getByRole('region', { name: 'Activating it' })).toHaveTextContent(
      must(row, 'the dormancy row').value,
    );
    unmount();
    open(activateNoDormancy());
    expect(
      within(inspector()).getByRole('region', { name: 'Activating it' }),
    ).not.toHaveTextContent('Dormant');
  });

  it('says when an ask’s recorded skate was, and how long', () => {
    const item = admit();
    open(item);
    // The one skate format, read in the runner's zone as the route reads it (the zone-pinned
    // wording is AskList's own test).
    const skated = must(
      item.asks.find((a) => a.skate !== null),
      'an ask with a skate',
    );
    const line = must(skateLine(skated), 'its line');
    expect(line).toMatch(/^With a recorded skate · 48m · \d+ [A-Z][a-z]{2} \d\d:\d\d–\d\d:\d\d$/);
    expect(within(inspector()).getByText(line)).toBeInTheDocument();
  });
});

describe('the inspector’s zone', () => {
  it('reads the dormancy’s date in it, not the runner’s', async () => {
    const { RequestBody } = await import('./RequestView');
    const { InspectorProvider } = await import('../../inspector/inspectorContext');
    // 00:30 on 25 Sep in New York is still 24 Sep at UTC−11.
    const item = {
      ...activateShelved(),
      dormancy: { ...POST_POND_SHELVED, since: zonedInstant(2026, 9, 25, 30, 'America/New_York') },
    };
    const at = (timeZone: string) =>
      render(
        <InspectorProvider
          value={{ pane: { current: null }, decidedOnOpen: false, now: REQUEST_NOW, timeZone }}
        >
          <RequestBody item={item} now={REQUEST_NOW} map={null} />
        </InspectorProvider>,
      );
    const ny = at('America/New_York');
    expect(ny.getByRole('region', { name: 'Activating it' })).toHaveTextContent(
      'Moderator · since 25 Sep 2026',
    );
    ny.unmount();
    expect(
      at('Pacific/Pago_Pago').getByRole('region', { name: 'Activating it' }),
    ).toHaveTextContent('Moderator · since 24 Sep 2026');
  });
});

describe('each lever calls its write with the item’s ids', () => {
  it('Admit approves the ask the server names', async () => {
    const user = userEvent.setup();
    const item = admit();
    open(item);
    await user.click(button('Admit'));
    await waitFor(() =>
      expect(writes['corpusRequests:approve']).toHaveBeenCalledWith({
        requestId: item.primaryRequestId,
      }),
    );
    // The receipt, with Undo from the write's own answer: nothing is looked up.
    expect((await screen.findAllByText(/Admitted/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByRole('button', { name: /Undo/ })).length).toBeGreaterThan(0);
    expect(server.latestOwn).not.toHaveBeenCalled();
  });

  it('sends the ask the server names even when a newer closed ask is served first', async () => {
    const user = userEvent.setup();
    const item = admitClosedFirst();
    expect(item.asks[0]?.status).toBe('closed');
    expect(item.primaryRequestId).not.toBe(item.asks[0]?.requestId);
    open(item);
    await user.click(button('Admit'));
    await waitFor(() =>
      expect(writes['corpusRequests:approve']).toHaveBeenCalledWith({
        requestId: item.primaryRequestId,
      }),
    );
    expect(writes['corpusRequests:approve']).not.toHaveBeenCalledWith({
      requestId: item.asks[0]?.requestId,
    });
  });

  it('Decline asks the note the asker reads, then declines with it', async () => {
    const user = userEvent.setup();
    const item = admit();
    open(item);
    await user.click(button('Decline'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Decline · Unnamed water');
    await user.type(within(dialog).getByRole('textbox'), 'That one is a beaver flowage.');
    await user.click(within(dialog).getByRole('button', { name: /^Decline/ }));
    await waitFor(() =>
      expect(writes['corpusRequests:decline']).toHaveBeenCalledWith({
        requestId: item.primaryRequestId,
        note: 'That one is a beaver flowage.',
      }),
    );
  });

  it('Look up again asks the catalog again for an admit with no match', async () => {
    const user = userEvent.setup();
    const item = admitNoMatch();
    open(item);
    expect(within(inspector()).queryByRole('button', { name: 'Admit' })).toBeNull();
    await user.click(button('Look up again'));
    await waitFor(() =>
      expect(writes['corpusRequests:reresolve']).toHaveBeenCalledWith({
        requestId: item.primaryRequestId,
      }),
    );
  });

  it('Take it down asks its reason and sends it as the note', async () => {
    const user = userEvent.setup();
    const item = takedown();
    open(item);
    await user.click(button('Take it down'));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'The owner wrote in.');
    // Destructive: the kit's armed step takes two presses.
    const confirm = () => within(dialog).getByRole('button', { name: /^Take it down/ });
    await user.click(confirm());
    await user.click(confirm());
    await waitFor(() =>
      expect(writes['corpusRequests:approve']).toHaveBeenCalledWith({
        requestId: item.primaryRequestId,
        note: 'The owner wrote in.',
      }),
    );
  });

  it('acts on its letter only with the inspector focused, and a held D types nothing in the note', async () => {
    const user = userEvent.setup();
    open(admit());
    await user.keyboard('a');
    expect(writes['corpusRequests:approve']).not.toHaveBeenCalled();
    act(() => inspector().focus());
    await user.keyboard('d');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('textbox')).toHaveValue('');
  });
});

describe('a refusal reaches a toast', () => {
  it('says the server’s sentence in a toast naming the item, never in place', async () => {
    const user = userEvent.setup();
    writes['corpusRequests:approve'].mockImplementation(async () => {
      throw new ConvexError('This has already been decided.');
    });
    open(admit());
    await user.click(button('Admit'));
    const said = await screen.findAllByText('The decision: This has already been decided.');
    expect(said.length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not saved · Unnamed water').length).toBeGreaterThan(0);
    // Not printed in the inspector.
    expect(within(inspector()).queryByText(/already been decided/)).toBeNull();
  });
});

describe('the bar follows the item', () => {
  it('drops the bar once the item is decided', () => {
    open(admit('decided'));
    expect(bar()).toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
  });

  it('draws no bar on a restore a moderator can’t decide either way, in the server’s sentence', () => {
    open(restore('moderator'));
    expect(bar()).toBeNull();
    expect(within(inspector()).getByText('Requires admin role')).toBeInTheDocument();
  });
});

describe('the narrow layout', () => {
  it('draws the item’s map view-only, and the wide one not', () => {
    narrowPage = true;
    const { unmount } = open(admit());
    expect(inspector().querySelector('[data-slot="item-map"] [data-view-only]')).not.toBeNull();
    unmount();
    narrowPage = false;
    open(admit());
    expect(inspector().querySelector('[data-slot="item-map"]')).not.toBeNull();
    expect(inspector().querySelector('[data-slot="item-map"] [data-view-only]')).toBeNull();
  });
});
