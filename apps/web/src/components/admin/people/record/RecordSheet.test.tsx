import { render, screen, waitFor, within } from '@testing-library/react';
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

const ITEMS: Record<string, unknown> = {
  'report:r4oct': ITEM_HIDDEN,
  'comment:cthermo': ITEM_DELETED,
  'comment:dstop': ITEM_WITHDRAWN,
};

beforeEach(() => {
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
  mocks.results.set('profiles:current', DANA);
  mocks.results.set(
    'contentRecord:item',
    (a: { targetType: string; targetId: string }) => ITEMS[`${a.targetType}:${a.targetId}`],
  );
});
afterEach(() => vi.useRealTimers());

function draw(open = true) {
  const onOpenChange = vi.fn();
  const view = render(
    <RecordSheet
      open={open}
      onOpenChange={onOpenChange}
      subject={SUBJECT}
      standing={HIDDEN}
      pending={false}
      counts={COUNTS}
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
    vi.restoreAllMocks();
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
    expect(mocks.announce).toHaveBeenCalledWith({
      title: 'The report is back on Mascoma Lake',
      target: { targetType: 'report', targetId: 'r4oct' },
      actionId: 'a1',
      undoNeedsReason: true,
    });
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
    ITEMS['report:r4oct'] = ITEM_HIDDEN;
  });

  it('a write that says it can’t be undone gets a receipt with none', async () => {
    draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations
      .get('moderation:setModerationStatus')
      ?.mockResolvedValue({ targetId: 'r4oct', actionId: 'a1', undoable: false });
    await userEvent.click(lever() as HTMLElement);
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith(expect.objectContaining({ undoable: false })),
    );
  });

  it('a refusal is the server’s own words, in place, and no toast', async () => {
    draw();
    await waitFor(() => expect(lever()).toHaveTextContent('Restore'));
    mocks.mutations
      .get('moderation:setModerationStatus')
      ?.mockRejectedValue(new ConvexError('This is already up.'));
    await userEvent.click(lever() as HTMLElement);
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('This is already up.');
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
    expect(mocks.announce).toHaveBeenCalledWith({
      title: 'The decision is off Rob Tremblay’s record',
      description: 'The comment stays deleted',
      target: { targetType: 'comment', targetId: 'cthermo' },
      actionId: 'a2',
      undoable: false,
    });
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
    ITEMS['report:r4oct'] = ITEM_HIDDEN;
  });
});

describe('closing', () => {
  it('Close ends the sitting', async () => {
    const { onOpenChange } = draw();
    await userEvent.click(within(sheet()).getByRole('button', { name: /Close/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
