import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The record sheet as the person page mounts it: its reads (mocked at the Convex hooks) asked only
 * while it is open, each list by its own query, and every lever through its own server write — then
 * the shell's toast with Undo only where the write said so, or the server's refusal in place.
 */

const mocks = vi.hoisted(() => ({
  results: new Map<string, unknown>(),
  calls: new Map<string, unknown[]>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  announce: vi.fn(async () => {}),
  undo: vi.fn(),
  toast: vi.fn(),
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
    useMutation: (ref: never) => {
      const name = getFunctionName(ref);
      let fn = mocks.mutations.get(name);
      if (fn === undefined) {
        fn = vi.fn();
        mocks.mutations.set(name, fn);
      }
      return fn;
    },
  };
});
vi.mock('../../shell/undo', () => ({
  useUndo: () => ({ announce: mocks.announce, undo: mocks.undo }),
}));
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: mocks.toast,
}));

import { resetConsoleReads } from '../../reads/consoleReads';
import { RecordSheet } from './RecordSheet';
import {
  COUNTS,
  DANA,
  DELETED,
  HIDDEN,
  ITEM_DELETED,
  ITEM_HIDDEN,
  ITEM_RESTORED,
  ITEM_UNDO_GONE,
  ITEM_WITHDRAWN,
  NOW,
  page,
  REVERSED,
  STANDING,
  SUBJECT,
} from './recordFixtures';

beforeAll(() => {
  for (const [name, value] of [
    ['animate', () => ({ cancel: () => {}, finished: Promise.resolve() })],
    ['getAnimations', () => []],
  ] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value });
    }
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
});

const START_ITEMS: Readonly<Record<string, unknown>> = {
  'report:r4oct': ITEM_HIDDEN,
  'comment:cthermo': ITEM_DELETED,
  'comment:dstop': ITEM_WITHDRAWN,
};
/** The items as each test's server answers them; a test may change them, and the next starts over. */
let ITEMS: Record<string, unknown> = { ...START_ITEMS };

beforeEach(() => {
  ITEMS = { ...START_ITEMS };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetConsoleReads();
  mocks.results.clear();
  mocks.calls.clear();
  mocks.mutations.clear();
  mocks.announce.mockClear();
  mocks.undo.mockClear();
  mocks.toast.mockClear();
  mocks.results.set('contentRecord:personVerdicts', page(STANDING));
  mocks.results.set('contentRecord:personDeleted', page(DELETED));
  mocks.results.set('contentRecord:personReversed', page(REVERSED));
  // The viewer, as `profiles.current` answers: their profile.
  mocks.results.set('profiles:current', {
    _id: DANA.userId,
    displayName: DANA.displayName,
    username: DANA.username,
  });
  mocks.results.set('contentRecord:recordCounts', COUNTS);
  mocks.results.set(
    'contentRecord:item',
    (a: { targetType: string; targetId: string }) => ITEMS[`${a.targetType}:${a.targetId}`],
  );
});
afterEach(() => {
  vi.useRealTimers();
  // A spy a test set (a measured list) never outlives it, even when the test fails.
  vi.restoreAllMocks();
});

function draw(open = true) {
  const onOpenChange = vi.fn();
  const view = render(
    <RecordSheet
      open={open}
      onOpenChange={onOpenChange}
      subject={SUBJECT}
      standing={HIDDEN}
      pending={false}
    />,
  );
  return { ...view, onOpenChange };
}

const sheet = () => screen.getByRole('dialog');
const rowButton = (text: string) =>
  within(sheet())
    .getAllByRole('button')
    .find(
      (b) => b.getAttribute('data-slot') === 'record-row-button' && b.textContent?.includes(text),
    ) as HTMLElement;
const lever = () => sheet().querySelector<HTMLElement>('[data-slot="record-lever"]');
const rowCount = () =>
  within(sheet())
    .getAllByRole('button')
    .filter((b) => b.getAttribute('data-slot') === 'record-row-button').length;
const mutation = (name: string) => mocks.mutations.get(name) as ReturnType<typeof vi.fn>;

describe('the reads', () => {
  it('asks nothing while closed', () => {
    draw(false);
    expect(mocks.calls.size).toBe(0);
  });

  it('opens on Standing, asks this person’s first page, and opens its first item', async () => {
    draw();
    expect(mocks.calls.get('contentRecord:personVerdicts')?.[0]).toEqual({
      userId: SUBJECT.userId,
      cursor: null,
    });
    await waitFor(() =>
      expect(mocks.calls.get('contentRecord:item')).toContainEqual({
        targetType: 'report',
        targetId: 'r4oct',
      }),
    );
    expect(within(sheet()).getByText('6 items')).toBeInTheDocument();
  });

  it('each tab asks its own list, and the filter narrows it by one kind', async () => {
    draw();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Deleted' }));
    expect(mocks.calls.get('contentRecord:personDeleted')?.[0]).toMatchObject({ cursor: null });
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Reversed' }));
    expect(mocks.calls.get('contentRecord:personReversed')?.[0]).toMatchObject({ cursor: null });
    await userEvent.click(within(sheet()).getByRole('button', { name: /Filter/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Comments/ }));
    await waitFor(() =>
      expect(mocks.calls.get('contentRecord:personReversed')).toContainEqual({
        userId: SUBJECT.userId,
        targetType: 'comment',
        cursor: null,
      }),
    );
  });

  it('a list with more to come asks for its next page from where the last ended', async () => {
    mocks.results.set('contentRecord:personVerdicts', (a: { cursor: string | null }) =>
      a.cursor === null
        ? page(STANDING.slice(0, 3), { isDone: false, cursor: 'p2' })
        : page(STANDING.slice(3)),
    );
    // Measured and in sight: the list may page.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    draw();
    await waitFor(() =>
      expect(mocks.calls.get('contentRecord:personVerdicts')).toContainEqual({
        userId: SUBJECT.userId,
        cursor: 'p2',
      }),
    );
  });

  it('a page read past is pinned to where it ended, and its rows stand while the pinned read comes', async () => {
    mocks.results.set(
      'contentRecord:personVerdicts',
      (a: { cursor: string | null; endCursor?: string }) =>
        a.cursor === null
          ? a.endCursor === undefined
            ? page(STANDING.slice(0, 3), { isDone: false, cursor: 'p2' })
            : undefined
          : page(STANDING.slice(3)),
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    draw();
    await waitFor(() =>
      expect(mocks.calls.get('contentRecord:personVerdicts')).toContainEqual({
        userId: SUBJECT.userId,
        cursor: null,
        endCursor: 'p2',
      }),
    );
    // The pinned read is on its way: the first page's rows still stand, and the next page's after.
    expect(rowCount()).toBe(STANDING.length);
  });

  it('a pinned page that outgrew a page is read as its two halves', async () => {
    mocks.results.set(
      'contentRecord:personVerdicts',
      (a: { cursor: string | null; endCursor?: string }) => {
        if (a.cursor === null && a.endCursor === undefined)
          return page(STANDING.slice(0, 3), { isDone: false, cursor: 'p2' });
        if (a.cursor === null && a.endCursor === 'p2')
          return {
            ...page(STANDING.slice(0, 2), { isDone: false, cursor: 'p2' }),
            pageStatus: 'SplitRequired',
            splitCursor: 's1',
          };
        if (a.cursor === null && a.endCursor === 's1')
          return page(STANDING.slice(0, 2), { isDone: false, cursor: 's1' });
        if (a.cursor === 's1') return page(STANDING.slice(2, 3), { isDone: false, cursor: 'p2' });
        return page(STANDING.slice(3));
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    draw();
    await waitFor(() =>
      expect(mocks.calls.get('contentRecord:personVerdicts')).toContainEqual({
        userId: SUBJECT.userId,
        cursor: 's1',
        endCursor: 'p2',
      }),
    );
    expect(mocks.calls.get('contentRecord:personVerdicts')).toContainEqual({
      userId: SUBJECT.userId,
      cursor: null,
      endCursor: 's1',
    });
    await waitFor(() => expect(rowCount()).toBe(STANDING.length));
  });
});

describe('the writes', () => {
  it('Restore goes to its write; the toast offers the undo the write named; the row stays with it', async () => {
    mutation('moderation:setModerationStatus');
    draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations.get('moderation:setModerationStatus')?.mockImplementation(async () => {
      // The server lists it no longer; the item now reads restored.
      mocks.results.set('contentRecord:personVerdicts', page(STANDING.slice(1)));
      ITEMS['report:r4oct'] = ITEM_RESTORED;
      return { targetId: 'r4oct', actionId: 'a1', undoable: true, undoNeedsReason: true };
    });
    await userEvent.click(lever() as HTMLElement);
    expect(mutation('moderation:setModerationStatus')).toHaveBeenCalledWith({
      targetType: 'report',
      targetId: 'r4oct',
      status: 'visible',
    });
    expect(mocks.announce).toHaveBeenCalledWith(
      {
        title: 'The report is back on Mascoma Lake',
        // What came back, as the pane read it before the restore.
        description: 'Its 1 comment and 2 thumbs came back with it',
        target: { targetType: 'report', targetId: 'r4oct' },
        actionId: 'a1',
        undoNeedsReason: true,
        // A receipt that may show over another page names whose it is…
        subject: 'Rob Tremblay',
      },
      // …and asks the person's page is still the one standing before it shows.
      expect.any(Function),
    );
    // The row keeps its place, lit with who restored it, and its Undo is the write's own row.
    const kept = await waitFor(() => {
      const row = sheet().querySelector<HTMLElement>('[data-slot="record-row"][data-back]');
      if (row === null) throw new Error('not kept yet');
      return row;
    });
    expect(kept).toHaveTextContent('Restored · Dana');
    await userEvent.click(within(kept).getByRole('button', { name: 'Undo' }));
    expect(mocks.undo).toHaveBeenCalledWith({
      actionId: 'a1',
      needsReason: true,
      what: 'The report is back on Mascoma Lake',
    });
  });

  it('a kept row goes for good once the server lists the item again — never back for another hand', async () => {
    const view = draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations.get('moderation:setModerationStatus')?.mockImplementation(async () => {
      mocks.results.set('contentRecord:personVerdicts', page(STANDING.slice(1)));
      // The open item reads restored, by the viewer.
      ITEMS['report:r4oct'] = ITEM_RESTORED;
      return { targetId: 'r4oct', actionId: 'a1', undoable: true, undoNeedsReason: true };
    });
    await userEvent.click(lever() as HTMLElement);
    const kept = () => sheet().querySelector('[data-slot="record-row"][data-back]');
    await waitFor(() => expect(kept()).not.toBeNull());
    const redraw = () =>
      view.rerender(
        <RecordSheet
          open
          onOpenChange={() => {}}
          subject={SUBJECT}
          standing={HIDDEN}
          pending={false}
        />,
      );
    // Its restore undone (from the toast): the server lists it again.
    mocks.results.set('contentRecord:personVerdicts', page(STANDING));
    redraw();
    await waitFor(() => expect(kept()).toBeNull());
    // Another moderator restores it: the server lists it no longer, and no row of ours comes back.
    mocks.results.set('contentRecord:personVerdicts', page(STANDING.slice(1)));
    redraw();
    await waitFor(() => expect(rowButton('Mascoma Lake · 3 reports')).toBeDefined());
    expect(kept()).toBeNull();
  });

  it('a write that says it can’t be undone gets a receipt with none', async () => {
    draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations
      .get('moderation:setModerationStatus')
      ?.mockResolvedValue({ targetId: 'r4oct', actionId: 'a1', undoable: false });
    await userEvent.click(lever() as HTMLElement);
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(
        expect.objectContaining({ undoable: false }),
        expect.any(Function),
      ),
    );
  });

  it('a receipt is bound to the person’s page: gone once the page is', async () => {
    const view = draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations
      .get('moderation:setModerationStatus')
      ?.mockResolvedValue({ targetId: 'r4oct', actionId: 'a1', undoable: false });
    await userEvent.click(lever() as HTMLElement);
    await waitFor(() => expect(mocks.announce).toHaveBeenCalled());
    const here = (mocks.announce.mock.calls[0] as unknown[])[1] as () => boolean;
    expect(here()).toBe(true);
    view.unmount();
    expect(here()).toBe(false);
  });

  it('a refusal while the sheet slides closed is the toast naming the person; and once the page has gone too', async () => {
    let refuse: (e: Error) => void = () => {};
    const view = draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations.get('moderation:setModerationStatus')?.mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = reject;
        }),
    );
    await userEvent.click(lever() as HTMLElement);
    const closed = (
      <RecordSheet
        open={false}
        onOpenChange={() => {}}
        subject={SUBJECT}
        standing={HIDDEN}
        pending={false}
      />
    );
    view.rerender(closed);
    await act(async () => {
      refuse(new ConvexError('This is already up.'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Not changed · Rob Tremblay',
        description: 'This is already up.',
        tone: 'bad',
        timeout: 0,
      }),
    );
    expect(mocks.announce).not.toHaveBeenCalled();
    // Again, but the person's page goes (another person opened): said all the same, naming the
    // person — a refusal is never buried by where the moderator went.
    mocks.toast.mockClear();
    view.unmount();
    const again = draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    await userEvent.click(lever() as HTMLElement);
    again.unmount();
    await act(async () => {
      refuse(new ConvexError('This is already up.'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Not changed · Rob Tremblay',
        description: 'This is already up.',
        tone: 'bad',
        timeout: 0,
      }),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('a restore that lands while the sheet slides closed keeps no row in it; its receipt still says it', async () => {
    let land: (result: unknown) => void = () => {};
    let sliding = false;
    let lit = true;
    const view = draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations.get('moderation:setModerationStatus')?.mockImplementation(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    await userEvent.click(lever() as HTMLElement);
    view.rerender(
      <RecordSheet
        open={false}
        onOpenChange={() => {}}
        subject={SUBJECT}
        standing={HIDDEN}
        pending={false}
      />,
    );
    await act(async () => {
      // The server lists it no longer: a row kept for the sitting would be drawn lit.
      mocks.results.set('contentRecord:personVerdicts', page(STANDING.slice(1)));
      land({ targetId: 'r4oct', actionId: 'a1', undoable: true, undoNeedsReason: true });
      // The write's answer, through the one write helper, lands in a few microtasks.
      for (let i = 0; i < 10 && mocks.announce.mock.calls.length === 0; i++)
        await Promise.resolve();
      // Still sliding out, its rows drawn: none is kept lit for a sitting on its way out.
      sliding = document.querySelector('[data-slot="record-sheet"]') !== null;
      lit = document.querySelector('[data-slot="record-row"][data-back]') !== null;
    });
    expect(sliding).toBe(true);
    expect(lit).toBe(false);
    expect(mocks.announce).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'a1', undoNeedsReason: true }),
      expect.any(Function),
    );
  });

  it('a refusal with the sheet open is the same one toast, naming the person — never printed in it', async () => {
    draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations
      .get('moderation:setModerationStatus')
      ?.mockRejectedValue(new ConvexError('This is already up.'));
    await userEvent.click(lever() as HTMLElement);
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        title: 'Not changed · Rob Tremblay',
        description: 'This is already up.',
        tone: 'bad',
        timeout: 0,
      }),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(within(sheet()).queryByRole('alert')).toBeNull();
    expect(within(sheet()).queryByText('This is already up.')).toBeNull();
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it('Overturn takes a reason only if given, and its receipt says when only with the server’s date', async () => {
    draw();
    await userEvent.click(rowButton('thermometer'));
    await waitFor(() => expect(lever()).toHaveTextContent('Overturn'));
    mocks.mutations
      .get('moderation:overturnVerdict')
      ?.mockResolvedValue({ targetId: 'cthermo', actionId: 'a2', eraseAt: null });
    await userEvent.click(lever() as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Overturn/ }));
    expect(mutation('moderation:overturnVerdict')).toHaveBeenCalledWith({
      targetType: 'comment',
      targetId: 'cthermo',
    });
    expect(mocks.announce).toHaveBeenCalledWith(
      {
        title: 'The decision is off Rob Tremblay’s record',
        description: 'The comment stays deleted',
        target: { targetType: 'comment', targetId: 'cthermo' },
        actionId: 'a2',
        undoable: false,
      },
      // Overturn names the person in its own title: no subject after it.
      expect.any(Function),
    );
  });

  it('Keep on the record asks a reason and goes to its own write', async () => {
    draw();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Deleted' }));
    await waitFor(() => expect(lever()).toHaveTextContent('Keep on the record'));
    mocks.mutations
      .get('moderation:keepOnRecord')
      ?.mockResolvedValue({ targetId: 'dstop', actionId: 'a3', undoable: false });
    await userEvent.click(lever() as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Evidence');
    await userEvent.click(within(dialog).getByRole('button', { name: /Keep on the record/ }));
    expect(mutation('moderation:keepOnRecord')).toHaveBeenCalledWith({
      targetType: 'comment',
      targetId: 'dstop',
      reason: 'Evidence',
    });
  });

  it('Hide again asks a reason and hides', async () => {
    ITEMS['report:r4oct'] = ITEM_RESTORED;
    draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Hide again'));
    mocks.mutations.get('moderation:setModerationStatus')?.mockResolvedValue({
      targetId: 'r4oct',
      actionId: 'a4',
      undoable: true,
      undoNeedsReason: false,
    });
    await userEvent.click(lever() as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Still wrong');
    await userEvent.click(within(dialog).getByRole('button', { name: /Hide again/ }));
    expect(mutation('moderation:setModerationStatus')).toHaveBeenCalledWith({
      targetType: 'report',
      targetId: 'r4oct',
      status: 'hidden',
      reason: 'Still wrong',
    });
  });
});

describe('the undo of the write that ended the newest decision', () => {
  it('runs the shell’s undo on the write the item’s own read names', async () => {
    mocks.results.set('contentRecord:personReversed', page([REVERSED[0]]));
    ITEMS['comment:xguess'] = {
      ...ITEM_UNDO_GONE,
      decisions: ITEM_UNDO_GONE.decisions.map((d) => ({
        ...d,
        undo: { state: 'available' as const, needsReason: true },
      })),
    };
    draw();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Reversed' }));
    await userEvent.click(await within(sheet()).findByRole('button', { name: 'Undo the restore' }));
    expect(mocks.undo).toHaveBeenCalledWith({
      actionId: 'end-xguess',
      needsReason: true,
      what: 'The comment is back on Jamie Moreau’s report',
    });
  });
});

describe('closing', () => {
  it('slides out as it was, then asks nothing more; opening again starts a new sitting', async () => {
    const view = draw();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Deleted' }));
    view.rerender(
      <RecordSheet
        open={false}
        onOpenChange={() => {}}
        subject={SUBJECT}
        standing={HIDDEN}
        pending={false}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    mocks.calls.clear();
    view.rerender(
      <RecordSheet
        open
        onOpenChange={() => {}}
        subject={SUBJECT}
        standing={HIDDEN}
        pending={false}
      />,
    );
    // A new sitting: back on Standing.
    await waitFor(() => expect(mocks.calls.has('contentRecord:personVerdicts')).toBe(true));
    expect(mocks.calls.has('contentRecord:personDeleted')).toBe(false);
  });

  it('Close ends the sitting', async () => {
    const { onOpenChange } = draw();
    await userEvent.click(within(sheet()).getByRole('button', { name: /Close/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
