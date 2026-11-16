import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { assertSeeded } from '@/test/seeded';

import type { ReadFailure } from '../../reads/consoleReads';
import { RecordSheetView, type RecordSheetViewProps } from './RecordSheetView';
import {
  CHOICES,
  HIDDEN,
  ITEM_DELETED,
  ITEM_HIDDEN,
  ITEM_POST,
  ITEM_RESTORED,
  ITEM_UNDO_GONE,
  ITEM_WITHDRAWN,
  NOW,
  REVERSED,
  STANDING,
  SUBJECT,
} from './recordFixtures';
import {
  ACTION_ORDER,
  type ItemRead,
  leverOf,
  type RecordAction,
  type RecordLevers,
  type RecordWrite,
  type Target,
} from './recordModel';
import type { RecordListState } from './recordReads';

/**
 * The sheet's view, props in: the lever drawn is exactly the server's (a property over every
 * `can`), and a write is tied to the item it was made on — a late answer never lights a button,
 * writes a refusal, or moves focus on the item open now (a table over the four writes).
 */

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

const LIST: RecordListState<(typeof STANDING)[number]> = {
  status: 'done',
  rows: STANDING,
  pending: false,
  failure: null,
  loadMore: () => {},
};

const targetOf = (item: ItemRead): Target => ({
  targetType: item.targetType,
  targetId: item.targetId,
});

function props(over: Partial<RecordSheetViewProps> = {}): RecordSheetViewProps {
  return {
    open: true,
    onOpenChange: () => {},
    subject: SUBJECT,
    standing: HIDDEN,
    pending: false,
    counts: null,
    tab: 'standing',
    onTab: () => {},
    kind: null,
    onKind: () => {},
    list: LIST,
    restored: [],
    viewerFirst: 'Dana',
    selected: targetOf(ITEM_HIDDEN),
    onSelect: () => {},
    item: ITEM_HIDDEN,
    chooser: null,
    onChooser: () => {},
    choices: undefined,
    now: NOW,
    onAct: async () => null,
    onUndoRestored: () => {},
    onUndoEnd: () => {},
    onLateRefusal: () => {},
    narrow: false,
    keys: false,
    ...over,
  };
}

const foot = () => document.querySelector<HTMLElement>('[data-slot="record-foot"]');
const lever = () => document.querySelector<HTMLElement>('[data-slot="record-lever"]');

describe('the lever is exactly the server’s', () => {
  const answer = fc.oneof(
    fc.record(
      { ok: fc.constant(true as const), needsReason: fc.boolean(), needsChoice: fc.boolean() },
      { requiredKeys: ['ok', 'needsReason'] },
    ),
    fc.record({ ok: fc.constant(false as const), why: fc.stringMatching(/^[A-Z][a-z ]{3,30}\.$/) }),
  );
  const levers = fc.record(
    Object.fromEntries(ACTION_ORDER.map((a) => [a, answer])) as Record<RecordAction, typeof answer>,
    { requiredKeys: [] },
  ) as fc.Arbitrary<RecordLevers>;

  it('for any `can`: one button at most, the one offered, never one refused; else the server’s why', () => {
    assertSeeded(
      fc.property(levers, (can) => {
        render(<RecordSheetView {...props({ item: { ...ITEM_HIDDEN, can } })} />);
        try {
          const drawn = document.querySelectorAll('[data-slot="record-lever"]');
          const expected = leverOf(can);
          expect(drawn.length).toBe(expected?.ok === true ? 1 : 0);
          if (drawn.length === 1) {
            const action = (drawn[0] as HTMLElement).dataset.action as RecordAction;
            expect(can[action]?.ok).toBe(true);
            expect(action).toBe(expected?.action);
          }
          const say = document.querySelector('[data-slot="record-say"]');
          if (expected !== null && !expected.ok) {
            const why = can[expected.action];
            expect(say?.textContent).toBe(why !== undefined && !why.ok ? why.why : '');
          } else {
            expect(say).toBeNull();
          }
        } finally {
          cleanup();
        }
      }),
      // Each run draws the whole sheet; the model's own property (`recordModel.test`) runs 200.
      { numRuns: 8 },
    );
  });
});

/** A write the test settles by hand. */
function deferred() {
  let settle: (refused: string | null) => void = () => {};
  const promise = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

type Case = {
  write: RecordAction;
  item: ItemRead;
  /** What the press asks before the write goes (a dialog's reason). */
  confirm: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  sent: RecordWrite;
};

const dialogConfirm =
  (name: RegExp, reason: string | null) => async (user: ReturnType<typeof userEvent.setup>) => {
    const dialog = await screen.findByRole('alertdialog');
    if (reason !== null) await user.type(within(dialog).getByRole('textbox'), reason);
    await user.click(within(dialog).getByRole('button', { name }));
  };

const CASES: Case[] = [
  { write: 'restore', item: ITEM_HIDDEN, confirm: async () => {}, sent: { kind: 'restore' } },
  {
    write: 'hideAgain',
    item: ITEM_RESTORED,
    confirm: dialogConfirm(/Hide again/, 'Still wrong'),
    sent: { kind: 'hideAgain', reason: 'Still wrong' },
  },
  {
    write: 'overturn',
    item: ITEM_DELETED,
    confirm: dialogConfirm(/Overturn/, null),
    sent: { kind: 'overturn' },
  },
  {
    write: 'keep',
    item: ITEM_WITHDRAWN,
    confirm: dialogConfirm(/Keep on the record/, 'Evidence'),
    sent: { kind: 'keep', reason: 'Evidence' },
  },
];

/** Another item, open by the time the write comes back: its own Restore, at rest. */
const OTHER: ItemRead = {
  ...ITEM_HIDDEN,
  targetId: 'other',
  can: { restore: { ok: true, needsReason: false } },
};

describe('a write that comes back after the operator moved on', () => {
  for (const c of CASES) {
    for (const outcome of ['landed', 'refused'] as const) {
      it(`${c.write}, ${outcome}: nothing lights, says or moves on the item open now`, async () => {
        const user = userEvent.setup();
        const write = deferred();
        const onAct = vi.fn((_t: Target, _w: RecordWrite) => write.promise);
        const onLateRefusal = vi.fn();
        const view = render(
          <RecordSheetView
            {...props({ selected: targetOf(c.item), item: c.item, onAct, onLateRefusal })}
          />,
        );
        await user.click(lever() as HTMLElement);
        await c.confirm(user);
        expect(onAct).toHaveBeenCalledWith(targetOf(c.item), c.sent);
        // A reason dialog holds while its write is out: Esc does nothing.
        if (c.write !== 'restore') {
          await user.keyboard('{Escape}');
          expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        }
        // Moved on: another item is open, and focus is somewhere of the operator's choosing.
        view.rerender(
          <RecordSheetView
            {...props({ selected: targetOf(OTHER), item: OTHER, onAct, onLateRefusal })}
          />,
        );
        const there = lever() as HTMLElement;
        const before = document.activeElement;
        await act(async () => {
          write.settle(outcome === 'refused' ? 'Someone changed this since.' : null);
          await write.promise;
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        });
        expect(there).not.toHaveAttribute('aria-busy');
        expect(there).toHaveTextContent('Restore');
        expect(document.querySelector('[data-slot="record-refusal"]')).toBeNull();
        expect(document.activeElement).toBe(before);
        if (outcome === 'refused')
          expect(onLateRefusal).toHaveBeenCalledWith('Someone changed this since.');
        else expect(onLateRefusal).not.toHaveBeenCalled();
      });
    }
  }

  it('one still open gets its refusal in place, and focus stays in the item', async () => {
    const user = userEvent.setup();
    const write = deferred();
    const onLateRefusal = vi.fn();
    render(<RecordSheetView {...props({ onAct: () => write.promise, onLateRefusal })} />);
    await user.click(lever() as HTMLElement);
    expect(lever()).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      write.settle('This is already up.');
      await write.promise;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.querySelector('[data-slot="record-refusal"]')).toHaveTextContent(
      'This is already up.',
    );
    expect(onLateRefusal).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-slot="record-pane"]')?.contains(document.activeElement),
    ).toBe(true);
  });

  it('a press while its own write is out is not a second write', async () => {
    const user = userEvent.setup();
    const write = deferred();
    const onAct = vi.fn(() => write.promise);
    render(<RecordSheetView {...props({ onAct })} />);
    await user.click(lever() as HTMLElement);
    await user.click(lever() as HTMLElement);
    expect(onAct).toHaveBeenCalledTimes(1);
    await act(async () => {
      write.settle(null);
      await write.promise;
    });
  });

  it('a write that throws is said as something went wrong', async () => {
    const user = userEvent.setup();
    render(
      <RecordSheetView
        {...props({
          onAct: async () => {
            throw new Error('offline');
          },
        })}
      />,
    );
    await user.click(lever() as HTMLElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
  });
});

describe('the item’s answers', () => {
  it('loading, failed and never-existed each say so', () => {
    const retry = vi.fn();
    const failed: ReadFailure = { failed: true, pending: false, retry };
    const view = render(<RecordSheetView {...props({ item: undefined })} />);
    expect(document.querySelector('[data-slot="record-item-loading"]')).not.toBeNull();
    view.rerender(<RecordSheetView {...props({ item: failed })} />);
    expect(screen.getByText('This item couldn’t be read')).toBeInTheDocument();
    view.rerender(<RecordSheetView {...props({ item: null })} />);
    expect(screen.getByText('Nothing on the record by that name')).toBeInTheDocument();
    expect(foot()).toBeNull();
  });

  it('two columns and nothing open opens the first row', () => {
    const onSelect = vi.fn();
    render(<RecordSheetView {...props({ selected: null, item: undefined, onSelect })} />);
    expect(onSelect).toHaveBeenCalledWith({ targetType: 'report', targetId: 'r4oct' });
  });

  it('a Post needing a choice opens its chooser instead of writing', async () => {
    const onChooser = vi.fn();
    const onAct = vi.fn();
    const post = {
      ...ITEM_HIDDEN,
      targetType: 'post' as const,
      targetId: 'p',
      can: { restore: { ok: true as const, needsReason: false, needsChoice: true } },
    };
    render(
      <RecordSheetView {...props({ selected: targetOf(post), item: post, onChooser, onAct })} />,
    );
    await userEvent.click(lever() as HTMLElement);
    expect(onChooser).toHaveBeenCalledWith({ targetType: 'post', targetId: 'p' });
    expect(onAct).not.toHaveBeenCalled();
  });

  it('the lever’s key presses it on a fine pointer, never while typing', async () => {
    const onAct = vi.fn(async () => null);
    render(<RecordSheetView {...props({ keys: true, onAct })} />);
    (document.querySelector('[data-slot="record-pane"]') as HTMLElement).focus();
    await userEvent.keyboard('x');
    expect(onAct).not.toHaveBeenCalled();
    await userEvent.keyboard('r');
    expect(onAct).toHaveBeenCalledWith(targetOf(ITEM_HIDDEN), { kind: 'restore' });
  });
});

describe('the list', () => {
  it('one tab stop: the arrows, Home and End move between rows', async () => {
    const user = userEvent.setup();
    render(<RecordSheetView {...props()} />);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="record-row-button"]')];
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    await user.click(rows[0] as HTMLElement);
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rows.at(-1));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows.at(-1));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rows.at(-2));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard('x');
    expect(document.activeElement).toBe(rows[0]);
  });

  it('loading draws skeleton rows and no end', () => {
    render(
      <RecordSheetView
        {...props({
          list: { ...LIST, status: 'loading', rows: [] },
          selected: null,
          item: undefined,
        })}
      />,
    );
    expect(document.querySelector('[data-slot="record-list-loading"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="record-end"]')).toBeNull();
  });

  it('a row restored in this sitting offers its own Undo', async () => {
    const onUndoRestored = vi.fn();
    const restored = {
      row: STANDING[0] as (typeof STANDING)[number],
      at: NOW,
      actionId: 'a1',
      undo: { needsReason: true },
    };
    render(
      <RecordSheetView
        {...props({
          list: { ...LIST, rows: STANDING.slice(1) },
          restored: [restored],
          onUndoRestored,
        })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndoRestored).toHaveBeenCalledWith(restored);
  });
});

describe('a reversal’s undo', () => {
  const reversed = (undo: (typeof REVERSED)[number]['undo']) =>
    ({ ...REVERSED[0], undo }) as (typeof REVERSED)[number];
  const at = (row: (typeof REVERSED)[number]) =>
    props({
      tab: 'reversed',
      list: { ...LIST, rows: [row] } as unknown as RecordSheetViewProps['list'],
      selected: { targetType: 'comment', targetId: 'xguess' },
      item: ITEM_UNDO_GONE,
    });

  it('offered while the server says available', async () => {
    const onUndoEnd = vi.fn();
    const row = reversed({ state: 'available', needsReason: true });
    render(<RecordSheetView {...at(row)} onUndoEnd={onUndoEnd} />);
    await userEvent.click(screen.getByRole('button', { name: 'Undo the restore' }));
    expect(onUndoEnd).toHaveBeenCalledWith(row);
  });

  it('drawn off once it ran out; gone once undone', () => {
    const view = render(
      <RecordSheetView {...at(reversed({ state: 'unavailable', why: 'No.' }))} />,
    );
    expect(screen.getByRole('button', { name: 'Undo the restore' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    view.rerender(
      <RecordSheetView {...at(reversed({ state: 'undone', byActionId: 'x' as never }))} />,
    );
    expect(screen.queryByRole('button', { name: 'Undo the restore' })).toBeNull();
  });
});

describe('the Post’s chooser', () => {
  const post = targetOf(ITEM_POST);
  const chooserProps = (over: Partial<RecordSheetViewProps>) =>
    props({ selected: post, item: ITEM_POST, chooser: post, ...over });
  const chooser = () => document.querySelector<HTMLElement>('[data-slot="post-chooser"]');

  it('says while its reports load, when they couldn’t be read, and when the post is gone', () => {
    const retry = vi.fn();
    const view = render(<RecordSheetView {...chooserProps({ choices: undefined })} />);
    expect(chooser()?.querySelector('[aria-busy="true"]')).not.toBeNull();
    view.rerender(
      <RecordSheetView {...chooserProps({ choices: { failed: true, pending: false, retry } })} />,
    );
    expect(chooser()).toHaveTextContent('Its reports couldn’t be read');
    view.rerender(<RecordSheetView {...chooserProps({ choices: null })} />);
    expect(chooser()).toHaveTextContent('Nothing on the record by that name');
  });

  it('⌘⏎ restores with the reports chosen; a refusal stands over them, and Cancel closes', async () => {
    const user = userEvent.setup();
    const onAct = vi.fn(async () => 'Something changed this since.');
    const onChooser = vi.fn();
    render(<RecordSheetView {...chooserProps({ choices: CHOICES, onAct, onChooser })} />);
    const boxes = within(chooser() as HTMLElement).getAllByRole('checkbox');
    // Nothing chosen: ⌘⏎ does nothing.
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onAct).not.toHaveBeenCalled();
    await user.click(boxes[0] as HTMLElement);
    await user.click(boxes[1] as HTMLElement);
    await user.click(boxes[1] as HTMLElement);
    (boxes[0] as HTMLElement).focus();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onAct).toHaveBeenCalledWith(post, { kind: 'restore', withReportIds: ['m1'] });
    expect(
      await within(chooser() as HTMLElement).findByText('Something changed this since.'),
    ).toBeInTheDocument();
    await user.click(within(chooser() as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(onChooser).toHaveBeenCalledWith(null);
  });
});
