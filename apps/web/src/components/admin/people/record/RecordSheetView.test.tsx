import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
  /** Draw the item's foot for `can`, and hold it to `leverOf`: one button at most, never a refusal. */
  function checkDrawn(can: RecordLevers) {
    // No rows: the foot is what is under test, and each draw stays cheap.
    render(
      <RecordSheetView
        {...props({ list: { ...LIST, rows: [] }, item: { ...ITEM_HIDDEN, can } })}
      />,
    );
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
  }

  const yes = { ok: true, needsReason: false } as const;
  const no = (why: string) => ({ ok: false, why }) as const;

  // Every shape `can` takes, pinned: the drawn check is a few renders, not a search. The search over
  // every `can` is the model's (`recordModel.test`, 200 runs a seed); the draw follows `leverOf`.
  it.each<[string, RecordLevers]>([
    ['nothing to offer', {}],
    ['Restore', { restore: yes }],
    ['Restore needing a choice', { restore: { ok: true, needsReason: false, needsChoice: true } }],
    ['Hide again', { hideAgain: { ok: true, needsReason: true } }],
    ['Overturn', { overturn: yes }],
    ['Keep on the record', { keep: { ok: true, needsReason: true } }],
    ['a refusal', { restore: no('Your account is being deleted.') }],
    ['an offer beside a refusal', { restore: no('No.'), overturn: yes }],
    ['two refusals', { keep: no('First.'), overturn: no('Second.') }],
    ['two offers', { hideAgain: yes, keep: yes }],
  ])('%s: the foot draws exactly the server’s lever', (_, can) => {
    checkDrawn(can);
  });

  it('and a short random run over any `can`', () => {
    const answer = fc.oneof(
      fc.record(
        { ok: fc.constant(true as const), needsReason: fc.boolean(), needsChoice: fc.boolean() },
        { requiredKeys: ['ok', 'needsReason'] },
      ),
      fc.record({
        ok: fc.constant(false as const),
        why: fc.stringMatching(/^[A-Z][a-z ]{3,30}\.$/),
      }),
    );
    const levers = fc.record(
      Object.fromEntries(ACTION_ORDER.map((a) => [a, answer])) as Record<
        RecordAction,
        typeof answer
      >,
      { requiredKeys: [] },
    ) as fc.Arbitrary<RecordLevers>;
    fc.assert(fc.property(levers, checkDrawn), { numRuns: 4 });
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

  it('while the list loads, a restored row it isn’t drawing yet never opens itself', () => {
    const onSelect = vi.fn();
    const restored = {
      row: STANDING[1] as (typeof STANDING)[number],
      at: NOW,
      actionId: 'a1',
      actorId: 'me',
      undo: null,
    };
    const view = render(
      <RecordSheetView
        {...props({
          selected: null,
          item: undefined,
          onSelect,
          list: { ...LIST, status: 'loading', rows: [] },
          restored: [restored],
        })}
      />,
    );
    expect(onSelect).not.toHaveBeenCalled();
    // Once the rows are in, the first row drawn is the one that opens.
    view.rerender(
      <RecordSheetView
        {...props({ selected: null, item: undefined, onSelect, restored: [restored] })}
      />,
    );
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

  it('a key pressed in a popover over the sheet (the Filter) pulls no lever', async () => {
    const onAct = vi.fn(async () => null);
    render(<RecordSheetView {...props({ keys: true, onAct })} />);
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const option = await screen.findByRole('button', { name: /Reports/ });
    option.focus();
    await userEvent.keyboard('r');
    expect(onAct).not.toHaveBeenCalled();
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
      actorId: 'me',
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

  it('a list narrowed to one kind holds only that kind’s restored rows', () => {
    const report = STANDING[0] as (typeof STANDING)[number];
    expect(report.targetType).toBe('report');
    const restored = {
      row: report,
      at: NOW,
      actionId: 'a1',
      actorId: 'me',
      undo: { needsReason: true },
    };
    const comments = STANDING.filter((r) => r.targetType === 'comment');
    render(
      <RecordSheetView
        {...props({
          kind: 'comment',
          list: { ...LIST, rows: comments },
          restored: [restored],
        })}
      />,
    );
    expect(document.querySelector('[data-slot="record-row"][data-back]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(document.querySelector('[data-slot="record-end"]')).toHaveTextContent(
      `All ${comments.length}`,
    );
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

  it('a report that came up since it was chosen is neither counted nor sent', async () => {
    const user = userEvent.setup();
    const onAct = vi.fn(async () => null);
    const view = render(<RecordSheetView {...chooserProps({ choices: CHOICES, onAct })} />);
    const boxes = within(chooser() as HTMLElement).getAllByRole('checkbox');
    await user.click(boxes[0] as HTMLElement);
    await user.click(boxes[1] as HTMLElement);
    // The live read moves on: m1 is up now (someone restored it on its own).
    const moved = {
      ...CHOICES,
      members: CHOICES.members.map((m) =>
        m.reportId === 'm1' ? { ...m, standing: 'visible' as const } : m,
      ),
    } as typeof CHOICES;
    view.rerender(<RecordSheetView {...chooserProps({ choices: moved, onAct })} />);
    const restore = within(chooser() as HTMLElement).getByRole('button', {
      name: /Restore with 1 report/,
    });
    await user.click(restore);
    expect(onAct).toHaveBeenCalledWith(post, { kind: 'restore', withReportIds: ['m2'] });
  });
});

describe('an open dialog follows the live answer', () => {
  const post = targetOf(ITEM_POST);

  it('the chooser: a report that came up while it was open lets the post restore with none chosen', async () => {
    const user = userEvent.setup();
    const onAct = vi.fn(async () => null);
    const view = render(
      <RecordSheetView
        {...props({ selected: post, item: ITEM_POST, chooser: post, choices: CHOICES, onAct })}
      />,
    );
    const restore = () =>
      document.querySelector<HTMLElement>('[data-slot="chooser-restore"]') as HTMLElement;
    expect(restore()).toBeDisabled();
    // Someone restored m1 on its own: a plain restore now brings the post back with it.
    const live = {
      ...CHOICES,
      plainRestoreBringsBack: true,
      prompt: null,
      members: CHOICES.members.map((m) =>
        m.reportId === 'm1' ? { ...m, status: 'visible', standing: 'visible' } : m,
      ),
    } as typeof CHOICES;
    view.rerender(
      <RecordSheetView
        {...props({ selected: post, item: ITEM_POST, chooser: post, choices: live, onAct })}
      />,
    );
    expect(restore()).toBeEnabled();
    expect(restore()).toHaveTextContent('Restore');
    await user.click(restore());
    // A plain restore: nothing chosen, nothing sent beside it.
    expect(onAct).toHaveBeenCalledWith(post, { kind: 'restore' });
  });

  it('the chooser: nothing left that can come back disables it, in the server’s words', () => {
    const view = render(
      <RecordSheetView
        {...props({ selected: post, item: ITEM_POST, chooser: post, choices: CHOICES })}
      />,
    );
    const gone = {
      ...CHOICES,
      restorable: false,
      prompt: 'Every report in this post was deleted by its author, so the post can’t be restored.',
      members: CHOICES.members.map((m) => ({ ...m, standing: 'author_deleted' })),
    } as typeof CHOICES;
    view.rerender(
      <RecordSheetView
        {...props({ selected: post, item: ITEM_POST, chooser: post, choices: gone })}
      />,
    );
    expect(document.querySelector('[data-slot="chooser-restore"]')).toBeDisabled();
    expect(document.querySelector('[data-slot="chooser-lead"]')).toHaveTextContent(
      'deleted by its author, so the post can’t be restored',
    );
  });

  it('the chooser closes when the post no longer offers Restore, and says why in its place', async () => {
    const onChooser = vi.fn();
    const view = render(
      <RecordSheetView
        {...props({ selected: post, item: ITEM_POST, chooser: post, choices: CHOICES, onChooser })}
      />,
    );
    view.rerender(
      <RecordSheetView
        {...props({
          selected: post,
          item: { ...ITEM_POST, can: { restore: { ok: false, why: 'This is already up.' } } },
          chooser: post,
          choices: CHOICES,
          onChooser,
        })}
      />,
    );
    expect(onChooser).toHaveBeenCalledWith(null);
    expect(document.querySelector('[data-slot="record-say"]')).toHaveTextContent(
      'This is already up.',
    );
  });

  type Change = [string, RecordLevers, 'closes' | 'stays', string | null];
  const DIALOGS: Array<[RecordAction, ItemRead, RegExp, Change[]]> = [
    [
      'hideAgain',
      ITEM_RESTORED,
      /Hide again/,
      [
        [
          'refused',
          { hideAgain: { ok: false, why: 'Only a moderator can change this.' } },
          'closes',
          'Only a moderator can change this.',
        ],
        [
          'another lever now',
          { restore: { ok: true, needsReason: false } },
          'closes',
          'This changed while it was open.',
        ],
        ['nothing on offer', {}, 'closes', 'This changed while it was open.'],
        ['no reason asked now', { hideAgain: { ok: true, needsReason: false } }, 'stays', null],
      ],
    ],
    [
      'keep',
      ITEM_WITHDRAWN,
      /Keep on the record/,
      [
        [
          'refused',
          { keep: { ok: false, why: 'A decision already keeps this on their record.' } },
          'closes',
          'A decision already keeps this on their record.',
        ],
        [
          'another lever now',
          { overturn: { ok: true, needsReason: false } },
          'closes',
          'This changed while it was open.',
        ],
        ['no reason asked now', { keep: { ok: true, needsReason: false } }, 'stays', null],
      ],
    ],
    [
      'overturn',
      ITEM_DELETED,
      /Overturn/,
      [
        [
          'refused',
          {
            overturn: {
              ok: false,
              why: 'Your account is being deleted, so you can no longer change this.',
            },
          },
          'closes',
          'Your account is being deleted, so you can no longer change this.',
        ],
        [
          'another lever now',
          { keep: { ok: true, needsReason: true } },
          'closes',
          'This changed while it was open.',
        ],
        ['a reason asked now', { overturn: { ok: true, needsReason: true } }, 'stays', null],
      ],
    ],
  ];

  for (const [action, item, confirmName, changes] of DIALOGS) {
    for (const [what, can, outcome, said] of changes) {
      it(`${action}, ${what} while it is open: it ${outcome}`, async () => {
        const user = userEvent.setup();
        const target = targetOf(item);
        const view = render(<RecordSheetView {...props({ selected: target, item })} />);
        await user.click(lever() as HTMLElement);
        await screen.findByRole('alertdialog');
        view.rerender(<RecordSheetView {...props({ selected: target, item: { ...item, can } })} />);
        if (outcome === 'closes') {
          await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
          const place = document.querySelector(
            '[data-slot="record-refusal"], [data-slot="record-say"]',
          );
          expect(place).toHaveTextContent(said as string);
          return;
        }
        // It stays, and asks a reason exactly when the live answer does.
        const dialog = screen.getByRole('alertdialog');
        const confirm = within(dialog).getByRole('button', { name: confirmName });
        const asked = (can[action] as { needsReason: boolean }).needsReason;
        if (asked) expect(confirm).toBeDisabled();
        else expect(confirm).toBeEnabled();
      });
    }
  }

  it('a dialog whose own write is out holds through the change its write makes', async () => {
    const user = userEvent.setup();
    const write = deferred();
    const target = targetOf(ITEM_DELETED);
    const onAct = vi.fn(() => write.promise);
    const view = render(
      <RecordSheetView {...props({ selected: target, item: ITEM_DELETED, onAct })} />,
    );
    await user.click(lever() as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /Overturn/ }));
    // Its own write landed on the server first: the lever is gone before the write answers.
    view.rerender(
      <RecordSheetView
        {...props({ selected: target, item: { ...ITEM_DELETED, can: {} }, onAct })}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await act(async () => {
      write.settle(null);
      await write.promise;
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.querySelector('[data-slot="record-refusal"]')).toBeNull();
  });

  it('a refusal for a write the answer moved under closes it, the refusal said in its place', async () => {
    const user = userEvent.setup();
    const write = deferred();
    const target = targetOf(ITEM_DELETED);
    const onAct = vi.fn(() => write.promise);
    const view = render(
      <RecordSheetView {...props({ selected: target, item: ITEM_DELETED, onAct })} />,
    );
    await user.click(lever() as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /Overturn/ }));
    // Someone else's answer lands while the write is out (held), and the write is refused.
    view.rerender(
      <RecordSheetView
        {...props({
          selected: target,
          item: { ...ITEM_DELETED, can: { keep: { ok: true, needsReason: true } } },
          onAct,
        })}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await act(async () => {
      write.settle('Someone kept this on the record.');
      await write.promise;
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.querySelector('[data-slot="record-refusal"]')).toHaveTextContent(
      'Someone kept this on the record.',
    );
  });

  it('a refused dialog, cancelled, never lends its refusal to a later close', async () => {
    const user = userEvent.setup();
    const target = targetOf(ITEM_DELETED);
    const onAct = vi.fn(async () => 'Not now.');
    const view = render(
      <RecordSheetView {...props({ selected: target, item: ITEM_DELETED, onAct })} />,
    );
    await user.click(lever() as HTMLElement);
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /Overturn/ }));
    expect(await within(dialog).findByText('Not now.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Opened again, and the answer moves under it: it says the change, not the old refusal.
    await user.click(lever() as HTMLElement);
    dialog = await screen.findByRole('alertdialog');
    view.rerender(
      <RecordSheetView
        {...props({
          selected: target,
          item: { ...ITEM_DELETED, can: { keep: { ok: true, needsReason: true } } },
          onAct,
        })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.querySelector('[data-slot="record-refusal"]')).toHaveTextContent(
      'This changed while it was open.',
    );
  });

  const POST_UP = { ...ITEM_POST, can: { hideAgain: { ok: true, needsReason: true } } } as ItemRead;

  it('the chooser’s landed restore holds nothing after it: Hide again on the post still follows', async () => {
    const user = userEvent.setup();
    const onAct = vi.fn(async () => null);
    const onChooser = vi.fn();
    const view = render(
      <RecordSheetView
        {...props({
          selected: post,
          item: ITEM_POST,
          chooser: post,
          choices: CHOICES,
          onAct,
          onChooser,
        })}
      />,
    );
    const chooser = document.querySelector('[data-slot="post-chooser"]') as HTMLElement;
    await user.click(within(chooser).getAllByRole('checkbox')[0] as HTMLElement);
    await user.click(document.querySelector('[data-slot="chooser-restore"]') as HTMLElement);
    await waitFor(() => expect(onChooser).toHaveBeenCalledWith(null));
    view.rerender(
      <RecordSheetView {...props({ selected: post, item: POST_UP, onAct, onChooser })} />,
    );
    await user.click(lever() as HTMLElement);
    await screen.findByRole('alertdialog');
    view.rerender(
      <RecordSheetView
        {...props({ selected: post, item: { ...POST_UP, can: {} }, onAct, onChooser })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('a closed Ask on the same post never lets go of the chooser’s write while it is out', async () => {
    const user = userEvent.setup();
    const write = deferred();
    const onAct = vi.fn((_: Target, w: RecordWrite) =>
      w.kind === 'hideAgain' ? Promise.resolve(null) : write.promise,
    );
    const onChooser = vi.fn();
    const view = render(
      <RecordSheetView {...props({ selected: post, item: POST_UP, onAct, onChooser })} />,
    );
    // Hidden again through its dialog: the Ask closes, and stays behind, closed.
    await user.click(lever() as HTMLElement);
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Still unsafe');
    await user.click(within(dialog).getByRole('button', { name: /Hide again/ }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Restored through the chooser: its own write lands (Hide again offered) before it answers.
    view.rerender(
      <RecordSheetView
        {...props({
          selected: post,
          item: ITEM_POST,
          chooser: post,
          choices: CHOICES,
          onAct,
          onChooser,
        })}
      />,
    );
    const chooser = document.querySelector('[data-slot="post-chooser"]') as HTMLElement;
    await user.click(within(chooser).getAllByRole('checkbox')[0] as HTMLElement);
    await user.click(document.querySelector('[data-slot="chooser-restore"]') as HTMLElement);
    view.rerender(
      <RecordSheetView
        {...props({
          selected: post,
          item: POST_UP,
          chooser: post,
          choices: CHOICES,
          onAct,
          onChooser,
        })}
      />,
    );
    expect(onChooser).not.toHaveBeenCalled();
    await act(async () => {
      write.settle(null);
      await write.promise;
    });
    expect(onChooser).toHaveBeenCalledWith(null);
    expect(document.querySelector('[data-slot="record-refusal"]')).toBeNull();
  });
});
