import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';

import { RecordBoard } from './recordBoard';
import {
  at,
  CHOICES,
  COUNTS_PENDING,
  DANA,
  DELETED,
  HIDDEN_CAPPED,
  HIDDEN_NONE,
  ITEM_DELETED,
  ITEM_ERASED,
  ITEM_HIDDEN,
  ITEM_LEAVING,
  ITEM_POST,
  ITEM_RESTORED,
  ITEM_UNDO_GONE,
  ITEM_WITHDRAWN,
  LEAVING,
  REVERSED,
  STANDING,
} from './recordFixtures';

/**
 * Boards 8.7–8.9: the record sheet over a person's page, at its 1000 px, on the pinned clock (Wed 14
 * Oct 2026), with the shell's undo toast over a fixture server. 8.7 at rest, 8.8 just after a
 * restore, then every frame of the states plate (8.9). Each story's `play` reads the sheet after it
 * settles.
 */
const meta = {
  title: 'Admin/People/Record sheet',
  component: RecordBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: {
    lists: {
      standing: { rows: STANDING },
      deleted: { rows: DELETED },
      reversed: { rows: REVERSED },
    },
    items: {
      'report:r4oct': ITEM_HIDDEN,
      'comment:cthermo': ITEM_DELETED,
      'comment:dstop': ITEM_WITHDRAWN,
      'report:xerased': ITEM_ERASED,
      'post:post': ITEM_POST,
      'comment:xguess': ITEM_UNDO_GONE,
    },
    restoredItems: { 'report:r4oct': ITEM_RESTORED },
    choices: CHOICES,
    keys: true,
    onWrite: fn(),
    onUndone: fn(),
  },
} satisfies Meta<typeof RecordBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${name}"]`));
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];
const rowTitles = (root: ParentNode) => slots(root, 'record-row-title').map((t) => t.textContent);
/** The sheet once its list and its item have drawn. */
async function settled(root: HTMLElement, item = true) {
  await waitFor(() => expect(slot(root, 'record-list')).toBeVisible());
  if (item) await waitFor(() => expect(slot(root, 'record-item')).toBeVisible());
}

/** Board 8.7 — his record at rest, the comment he deleted after it was hidden open: Overturn. */
export const AtRest: Story = {
  args: { initialSelected: { targetType: 'comment', targetId: 'cthermo' } },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
    await expect(slot(canvasElement, 'record-count')).toHaveTextContent('6 items');
    await expect(rowTitles(canvasElement)).toHaveLength(6);
    await expect(slot(canvasElement, 'record-end')).toHaveTextContent('All 6');
    // The list and the item sit side by side.
    const list = slot(canvasElement, 'record-list').getBoundingClientRect();
    const pane = slot(canvasElement, 'record-item').getBoundingClientRect();
    await expect(pane.left).toBeGreaterThanOrEqual(list.right - 1);
    // The open row is the comment; its pane says what an overturn would do, and offers it.
    const open = must(canvasElement.querySelector('[aria-current="true"]'));
    await expect(open).toHaveTextContent('Learn to read a thermometer.');
    await expect(slot(canvasElement, 'record-verdict')).toHaveTextContent('Deleted by Rob');
    await expect(slot(canvasElement, 'record-would')).toHaveTextContent(
      'The decision comes off Rob’s record',
    );
    const lever = slot(canvasElement, 'record-lever');
    await expect(lever).toHaveTextContent('Overturn');
    await expect(lever).toHaveAttribute('data-action', 'overturn');
    // Its life: posted, hidden, deleted, today, and what an overturn would do (dashed) — read once
    // the strip's measure settles: it draws across only after deciding the stations fit, and a late
    // face (a slow runner's) re-decides it, so a one-shot read can land on the stacked form.
    await waitFor(() => expect(slots(canvasElement, 'life-station')).toHaveLength(5));
  },
};

/** Board 8.8 — just after a report was restored: the row keeps its place with its Undo. */
export const JustRestored: Story = {
  args: {
    standing: {
      ...HIDDEN_NONE,
      total: 5,
      byKind: { ...HIDDEN_NONE.byKind, report: 1, post: 1, comment: 2, accessAlert: 1 },
    },
    lists: {
      standing: { rows: STANDING.slice(1) },
      deleted: { rows: DELETED },
      reversed: { rows: REVERSED },
    },
    items: { 'report:r4oct': ITEM_RESTORED },
    initialSelected: { targetType: 'report', targetId: 'r4oct' },
    initialRestored: [
      {
        row: STANDING[0] as (typeof STANDING)[number],
        at: at(10, 14, 11, 52),
        actionId: 'a-r4oct',
        // The viewer the board restores as, and the item reads as its restorer.
        actorId: DANA.userId,
        undo: { needsReason: true },
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    await settled(canvasElement);
    await expect(slot(canvasElement, 'record-count')).toHaveTextContent('5 items');
    const restored = must(canvasElement.querySelector('[data-slot="record-row"][data-back]'));
    await expect(restored).toHaveTextContent('Restored · Dana');
    await expect(restored).toHaveTextContent('Was hidden: “Second unsafe claim this week”');
    await expect(restored).toHaveTextContent('11:52');
    // It keeps its place: first, where it stood.
    await expect(rowTitles(canvasElement)[0]).toContain('3½');
    await expect(slot(canvasElement, 'record-end')).toHaveTextContent('All 5 · 1 restored');
    await expect(slot(canvasElement, 'record-item')).toHaveTextContent('On Mascoma Lake again');
    await expect(slot(canvasElement, 'record-comes-back')).toHaveTextContent('Came back with it');
    await expect(slot(canvasElement, 'record-lever')).toHaveTextContent('Hide again');
    // The row's own Undo asks why (undoing a restore takes something away), then runs.
    await userEvent.click(within(restored as HTMLElement).getByRole('button', { name: 'Undo' }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Restored the wrong one');
    await userEvent.click(within(dialog).getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(args.onUndone).toHaveBeenCalledWith('a-r4oct'));
  },
};

/** 8.8's press — Restore from the foot: the toast, and the row kept with its Undo. */
export const RestoreAndKeep: Story = {
  args: { initialSelected: { targetType: 'report', targetId: 'r4oct' } },
  play: async ({ canvasElement, args }) => {
    await settled(canvasElement);
    const lever = slot(canvasElement, 'record-lever');
    await expect(lever).toHaveTextContent('Restore');
    // What a restore brings back with it: its comment and its thumbs.
    const back = slot(canvasElement, 'record-comes-back');
    await expect(back).toHaveTextContent('Comes back with it');
    await expect(back).toHaveTextContent('1 comment');
    await expect(back).toHaveTextContent('2 thumbs');
    await userEvent.click(lever);
    await expect(args.onWrite).toHaveBeenCalledWith(
      { targetType: 'report', targetId: 'r4oct' },
      { kind: 'restore' },
    );
    await waitFor(() =>
      expect(slot(canvasElement, 'toast')).toHaveTextContent('The report is back on Mascoma Lake'),
    );
    await expect(slot(canvasElement, 'toast')).toHaveTextContent(
      'Its 1 comment and 2 thumbs came back with it',
    );
    await expect(
      within(slot(canvasElement, 'toast')).getByRole('button', { name: /Undo/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(slot(canvasElement, 'record-lever')).toHaveTextContent('Hide again'),
    );
    const kept = must(canvasElement.querySelector('[data-slot="record-row"][data-back]'));
    await expect(kept).toHaveTextContent('Restored · Dana');
    // Focus stayed in the item.
    await waitFor(() =>
      expect(slot(canvasElement, 'record-pane').contains(document.activeElement)).toBe(true),
    );
  },
};

/** 8.9 — deleted by them, held by nothing: Keep on the record asks a reason. */
export const DeletedByThem: Story = {
  args: { initialTab: 'deleted', initialSelected: { targetType: 'comment', targetId: 'dstop' } },
  play: async ({ canvasElement, args }) => {
    await settled(canvasElement);
    await expect(rowTitles(canvasElement)).toHaveLength(2);
    await expect(slot(canvasElement, 'record-rows')).toHaveTextContent(
      'Deleted 9 Oct · erased 8 Nov unless kept',
    );
    await expect(slot(canvasElement, 'record-would')).toHaveTextContent('If kept');
    await userEvent.click(slot(canvasElement, 'record-lever'));
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Keep this on the record?');
    const confirm = within(dialog).getByRole('button', { name: /Keep on the record/ });
    // A takeaway: no reason, no keep.
    await expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Evidence for the appeal');
    await userEvent.click(confirm);
    await expect(args.onWrite).toHaveBeenCalledWith(
      { targetType: 'comment', targetId: 'dstop' },
      { kind: 'keep', reason: 'Evidence for the appeal' },
    );
    await waitFor(() =>
      expect(slot(canvasElement, 'toast')).toHaveTextContent(
        'The comment is on Rob Tremblay’s record',
      ),
    );
    // Keep has no undo in place: the receipt offers none.
    await expect(
      within(slot(canvasElement, 'toast')).queryByRole('button', { name: /Undo/ }),
    ).toBeNull();
  },
};

/** 8.9 *A post* — Restore asks which reports come back; nothing chosen, the deleted one never. */
export const PostChooser: Story = {
  args: { initialSelected: { targetType: 'post', targetId: 'post' } },
  play: async ({ canvasElement, args }) => {
    await settled(canvasElement);
    await userEvent.click(slot(canvasElement, 'record-lever'));
    const chooser = await waitFor(() => slot(canvasElement, 'post-chooser'));
    await expect(chooser).toHaveTextContent('Restore the post');
    await expect(slot(chooser, 'chooser-lead')).toHaveTextContent('Choose at least one report');
    const members = slots(chooser, 'chooser-member');
    await expect(members).toHaveLength(3);
    const boxes = within(chooser).getAllByRole('checkbox');
    // Nothing chosen; the one its author deleted can never be.
    for (const box of boxes) await expect(box).not.toBeChecked();
    await expect(boxes[2]).toHaveAttribute('aria-disabled', 'true');
    await expect(must(members[2]?.closest('[data-slot="checkbox-row"]'))).toHaveTextContent(
      'Deleted by its author 28 Sep',
    );
    const restore = slot(chooser, 'chooser-restore');
    await expect(restore).toHaveTextContent('Restore with 0 reports');
    await expect(restore).toBeDisabled();
    await userEvent.click(must(boxes[1]));
    await expect(restore).toHaveTextContent('Restore with 1 report');
    await userEvent.click(restore);
    await expect(args.onWrite).toHaveBeenCalledWith(
      { targetType: 'post', targetId: 'post' },
      { kind: 'restore', withReportIds: ['m2'] },
    );
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="post-chooser"]')).toBeNull(),
    );
    await waitFor(() =>
      expect(slot(canvasElement, 'toast')).toHaveTextContent('1 report came back with it'),
    );
  },
};

/** 8.9 — nothing standing: the head says 0 items, the end tab what is empty. */
export const NothingStanding: Story = {
  args: { standing: HIDDEN_NONE, lists: { standing: { rows: [] } } },
  play: async ({ canvasElement }) => {
    await settled(canvasElement, false);
    await expect(slot(canvasElement, 'record-count')).toHaveTextContent('0 items');
    await expect(slot(canvasElement, 'record-end')).toHaveTextContent('Nothing on the record');
    await expect(canvasElement.querySelector('[data-slot="record-item"]')).toBeNull();
  },
};

/** 8.9 — the list couldn't be read: said in its place, with Try again. */
export const ListFailed: Story = {
  args: { lists: { standing: { rows: [], failed: true } }, onRetry: fn() },
  play: async ({ canvasElement, args }) => {
    await settled(canvasElement, false);
    const note = slot(canvasElement, 'record-list-failed');
    await expect(note).toHaveTextContent('The record couldn’t be read');
    await expect(canvasElement.querySelector('[data-slot="record-end"]')).toBeNull();
    await userEvent.click(within(note).getByRole('button', { name: /Try again/ }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
};

/** 8.9 — still being prepared: the count isn't a number yet, and the end tab says so far. */
export const StillPreparing: Story = {
  args: {
    pending: true,
    counts: COUNTS_PENDING,
    lists: { standing: { rows: STANDING.slice(0, 2), pending: true } },
  },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
    await expect(slot(canvasElement, 'record-count')).toHaveTextContent('Still being prepared');
    await expect(slot(canvasElement, 'record-preparing')).toHaveTextContent(
      'decisions made before the record began are being added',
    );
    await expect(slot(canvasElement, 'record-end')).toHaveTextContent('2 so far');
  },
};

/** 8.9 — a floor: 500+ items, and the list keeps loading — no end tab while more can come. */
export const Floor: Story = {
  args: {
    standing: HIDDEN_CAPPED,
    lists: { standing: { rows: STANDING.slice(0, 3), status: 'more' } },
  },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
    await expect(slot(canvasElement, 'record-count')).toHaveTextContent('500+ items');
    await expect(slot(canvasElement, 'record-more')).toBeInTheDocument();
    await expect(canvasElement.querySelector('[data-slot="record-end"]')).toBeNull();
    // The filter keeps no count it can't promise.
    await userEvent.click(slot(canvasElement, 'record-filter'));
    const menu = await within(document.body).findByRole('dialog', { name: 'Filter' });
    await expect(menu).not.toHaveTextContent('412');
    await userEvent.keyboard('{Escape}');
  },
};

/** 8.9 — erased: the words are gone, the decision stays in the history; nothing to press. */
export const Erased: Story = {
  args: { initialTab: 'reversed', initialSelected: { targetType: 'report', targetId: 'xerased' } },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
    await expect(slot(canvasElement, 'record-end')).toHaveTextContent('All 2');
    await expect(slot(canvasElement, 'record-plate')).toHaveTextContent(
      'The words were erased Fri 6 Mar',
    );
    await expect(slot(canvasElement, 'record-verdict')).toHaveTextContent(
      'Appeal upheld: wrong lake in the photo',
    );
    await expect(canvasElement.querySelector('[data-slot="record-lever"]')).toBeNull();
  },
};

/** 8.9 — an undo that ran out: drawn off, and it says why. */
export const UndoRanOut: Story = {
  args: { initialTab: 'reversed', initialSelected: { targetType: 'comment', targetId: 'xguess' } },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
    const off = slot(canvasElement, 'record-undo-end');
    await expect(off).toHaveTextContent('Undo the restore');
    await expect(off).toHaveAttribute('aria-disabled', 'true');
    await userEvent.hover(off);
    const tip = await waitFor(() => slot(document, 'tooltip-content'));
    await expect(tip).toHaveTextContent('Can’t undo');
    await expect(tip).toHaveTextContent('Its author deleted this, so it stays as they left it.');
    await userEvent.unhover(off);
  },
};

/** 8.9 — the overturn's confirm: nothing required, Overturn live with the field empty. */
export const OverturnConfirm: Story = {
  args: { initialSelected: { targetType: 'comment', targetId: 'cthermo' } },
  play: async ({ canvasElement, args }) => {
    await settled(canvasElement);
    // O, the lever's key, opens it as a press does.
    slot(canvasElement, 'record-pane').focus();
    await userEvent.keyboard('o');
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Overturn this decision?');
    await expect(dialog).toHaveTextContent(
      'It comes off Rob Tremblay’s record. The comment stays deleted and is erased Sun 25 Oct.',
    );
    await expect(dialog).toHaveTextContent('Reason · optional · kept in the audit log');
    const confirm = within(dialog).getByRole('button', { name: /Overturn/ });
    await expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await expect(args.onWrite).toHaveBeenCalledWith(
      { targetType: 'comment', targetId: 'cthermo' },
      { kind: 'overturn' },
    );
    await waitFor(() =>
      expect(slot(canvasElement, 'toast')).toHaveTextContent(
        'The decision is off Rob Tremblay’s record',
      ),
    );
  },
};

/** 8.9 — a viewer who can see, not act: the foot says why; nothing to press. */
export const SeeNotAct: Story = {
  args: {
    items: { 'report:r4oct': ITEM_LEAVING },
    initialSelected: { targetType: 'report', targetId: 'r4oct' },
  },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
    await expect(slot(canvasElement, 'record-say')).toHaveTextContent(LEAVING);
    await expect(canvasElement.querySelector('[data-slot="record-lever"]')).toBeNull();
  },
};

/**
 * 8.9 — Restoring: the press on its way keeps its place and its focus; a refusal comes back as a
 * toast naming the person, held until dismissed, and nothing of it is printed in the sheet.
 */
export const Restoring: Story = {
  args: {
    initialSelected: { targetType: 'report', targetId: 'r4oct' },
    onWrite: fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('This is already up.'), 400);
        }),
    ),
  },
  play: async ({ canvasElement }) => {
    await settled(canvasElement);
    const lever = slot(canvasElement, 'record-lever');
    await userEvent.click(lever);
    await waitFor(() => expect(lever).toHaveAttribute('aria-busy', 'true'));
    await expect(lever).toHaveAccessibleName(/Restoring/);
    // Focus stays on the lever through its pending state (read in a retry: a press is asynchronous).
    await waitFor(() => expect(document.activeElement).toBe(lever));
    // The server's own words come back in the toast, naming the person; the sheet prints none.
    await waitFor(() =>
      expect(slot(canvasElement, 'toast')).toHaveTextContent(
        'Not saved · Rob TremblayThis is already up.',
      ),
    );
    await expect(slot(canvasElement, 'record-sheet')).not.toHaveTextContent('This is already up.');
    await expect(slot(canvasElement, 'toast-dismiss')).toHaveTextContent('Dismiss');
    await waitFor(() => expect(lever).not.toHaveAttribute('aria-busy'));
  },
};

/** 8.9 — a narrow screen: the list is the whole sheet; an item opens with the way back. */
export const Narrow: Story = {
  args: { narrow: true, keys: false, width: '24.375rem', height: '45rem' },
  play: async ({ canvasElement }) => {
    await settled(canvasElement, false);
    await expect(canvasElement.querySelector('[data-slot="record-item"]')).toBeNull();
    // A phone shows no key hints; Close stays.
    await expect(slot(canvasElement, 'record-sheet')).not.toHaveTextContent('Esc');
    const comment = must(
      slots(canvasElement, 'record-row-button').find((b) => b.textContent?.includes('thermometer')),
    );
    await userEvent.click(comment);
    await waitFor(() => expect(slot(canvasElement, 'record-item')).toBeVisible());
    await expect(canvasElement.querySelector('[data-slot="record-list"]')).toBeNull();
    // Its life reads top to bottom.
    await expect(slot(canvasElement, 'life-list')).toBeInTheDocument();
    await userEvent.click(
      within(slot(canvasElement, 'record-back')).getByRole('button', { name: 'The record' }),
    );
    await waitFor(() => expect(slot(canvasElement, 'record-list')).toBeVisible());
    await waitFor(() => expect(document.activeElement).toHaveTextContent('thermometer'));
  },
};
