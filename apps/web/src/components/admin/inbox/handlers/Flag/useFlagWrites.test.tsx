import { renderHook } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, test, vi } from 'vitest';

import { createToastManager } from '@/components/kit/toast';

import {
  ALERT_ITEM,
  DOWN_ITEM,
  GONE_ITEM,
  LANDED,
  LANDED_ACROSS_LANES,
  SAFETY_ITEM,
  SAFETY_MANY,
} from './flagFixtures';
import {
  argsOf,
  closedWords,
  type FlagServer,
  type FlagWrite,
  receiptTitle,
  undoTargetOf,
  useFlagWrites,
} from './useFlagWrites';

const fakeServer = (answer: () => Promise<typeof LANDED>): FlagServer => ({
  dismissFlags: vi.fn(answer),
  takeDown: vi.fn(answer),
  alertVerdict: vi.fn(answer),
  restoreAndDismiss: vi.fn(answer),
});

function setup(item = SAFETY_ITEM, answer: () => Promise<typeof LANDED> = async () => LANDED) {
  const manager = createToastManager();
  const added: unknown[] = [];
  const add = manager.add.bind(manager);
  manager.add = ((options: unknown) => {
    added.push(options);
    return add(options as never);
  }) as typeof manager.add;
  const server = fakeServer(answer);
  const announce = vi.fn(async () => {});
  const here = () => true;
  const { result } = renderHook(() => useFlagWrites({ item, server, announce, here, manager }));
  return { write: result.current, server, announce, added };
}

describe('the write path', () => {
  test('each lever reaches its write, a reason only where one was typed', async () => {
    const { write, server } = setup();
    await write({ kind: 'dismiss' });
    expect(server.dismissFlags).toHaveBeenCalledWith({ itemId: SAFETY_ITEM.itemId });
    await write({ kind: 'dismiss', reason: '  a joke  ' });
    expect(server.dismissFlags).toHaveBeenLastCalledWith({
      itemId: SAFETY_ITEM.itemId,
      reason: 'a joke',
    });
    await write({ kind: 'takeDown', status: 'hidden', reason: ' why ' });
    expect(server.takeDown).toHaveBeenCalledWith({
      itemId: SAFETY_ITEM.itemId,
      status: 'hidden',
      reason: 'why',
    });
    await write({ kind: 'alert', verb: 'retract', reason: 'gone' });
    expect(server.alertVerdict).toHaveBeenCalledWith({
      itemId: SAFETY_ITEM.itemId,
      verb: 'retract',
      reason: 'gone',
    });
    await write({ kind: 'restore' });
    expect(server.restoreAndDismiss).toHaveBeenCalledWith({ itemId: SAFETY_ITEM.itemId });
  });

  test('a landing raises the receipt with its Undo, named and targeted, no lookup', async () => {
    const { write, announce } = setup();
    expect(await write({ kind: 'takeDown', status: 'hidden', reason: 'why' })).toBe(true);
    expect(announce).toHaveBeenCalledWith(
      {
        title: 'Hidden',
        description: 'Closes 1 flag',
        target: { targetType: 'report', targetId: SAFETY_ITEM.target.targetId },
        actionId: LANDED.actionId,
        undoNeedsReason: false,
        subject: 'Mascoma Lake',
      },
      expect.any(Function),
    );
  });

  test('a write that says it can’t be undone now offers no Undo', async () => {
    const { write, announce } = setup(
      SAFETY_ITEM,
      async () =>
        ({
          itemId: LANDED.itemId,
          actionId: LANDED.actionId,
          flagsClosed: 2,
          undoable: false,
        }) as never,
    );
    await write({ kind: 'dismiss' });
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Dismissed',
        // A dismissal reaches only this item's flags: never "in other lanes".
        description: 'Dismisses 2 flags',
        undoable: false,
        target: { targetType: 'contentFlag', targetId: 'f_sarah' },
      }),
      expect.any(Function),
    );
  });

  // The server's own refusals (inboxWrites, lib/inboxRules, lib/ownContent): each one toast, never
  // printed in place, and nothing announced.
  test.each([
    ['You filed this, so another staff member decides it.'],
    ['This has already been decided.'],
    ['No such item.'],
    ['This item is not a flag on content.'],
    ['That isn’t a choice for this item.'],
    ['This content is already down.'],
    ['Its author already took this alert down.'],
  ])('a refusal is one toast in the server’s words: %s', async (sentence) => {
    const { write, announce, added } = setup(SAFETY_ITEM, async () => {
      throw new ConvexError(sentence);
    });
    expect(await write({ kind: 'takeDown', status: 'removed', reason: 'x' })).toBe(false);
    expect(announce).not.toHaveBeenCalled();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      title: 'Not changed · Mascoma Lake',
      description: sentence,
      // Held until dismissed (a refusal's toast).
      timeout: 0,
    });
  });

  test('a pin says its flags were dismissed, every lane’s', async () => {
    const { write, announce, server } = setup(ALERT_ITEM, async () => LANDED_ACROSS_LANES);
    await write({ kind: 'alert', verb: 'pin', reason: 'It is true' });
    expect(server.alertVerdict).toHaveBeenCalledWith({
      itemId: ALERT_ITEM.itemId,
      verb: 'pin',
      reason: 'It is true',
    });
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Pinned',
        description: 'Dismisses 3 flags, 2 in other lanes',
        target: { targetType: 'accessAlert', targetId: 'aa_fairlee' },
      }),
      expect.any(Function),
    );
  });

  test('a takedown says how many flags it closed in other lanes', async () => {
    const { write, announce } = setup(SAFETY_ITEM, async () => LANDED_ACROSS_LANES);
    await write({ kind: 'takeDown', status: 'hidden', reason: 'why' });
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Closes 3 flags, 2 in other lanes' }),
      expect.any(Function),
    );
    expect(closedWords(SAFETY_ITEM, 1)).toBe('Closes 1 flag');
    expect(closedWords(SAFETY_MANY, 2)).toBe('Closes 2 flags');
    expect(closedWords(SAFETY_ITEM, 0)).toBe('Closes 0 flags');
    // A pin sides with the alert: its flags close dismissed.
    expect(closedWords(SAFETY_ITEM, 3, true)).toBe('Dismisses 3 flags, 2 in other lanes');
    expect(closedWords(SAFETY_ITEM, 3, true, false)).toBe('Dismisses 3 flags');
  });

  test('a failed send says the plain line', async () => {
    const { write, added } = setup(SAFETY_ITEM, async () => {
      throw new Error('network');
    });
    expect(await write({ kind: 'dismiss' })).toBe(false);
    expect(added[0]).toMatchObject({ title: 'Not changed · Mascoma Lake', timeout: 0 });
  });
});

describe('the receipt', () => {
  test('titles', () => {
    const cases: [FlagWrite, number, string][] = [
      [{ kind: 'dismiss' }, 1, 'Dismissed'],
      [{ kind: 'dismiss' }, 3, 'Dismissed'],
      [{ kind: 'takeDown', status: 'removed', reason: '' }, 1, 'Removed'],
      [{ kind: 'alert', verb: 'unpin', reason: '' }, 1, 'Unpinned'],
      [{ kind: 'alert', verb: 'retract', reason: '' }, 1, 'Retracted'],
      [{ kind: 'alert', verb: 'pin', reason: '' }, 1, 'Pinned'],
      [{ kind: 'restore' }, 1, 'Restored'],
    ];
    for (const [w, , title] of cases) expect(receiptTitle(w)).toBe(title);
  });
  test('undo targets: the content for a takedown, the alert for a verdict, the first flag else', () => {
    expect(undoTargetOf(ALERT_ITEM, { kind: 'alert', verb: 'unpin', reason: 'x' }, 'f')).toEqual({
      targetType: 'accessAlert',
      targetId: 'aa_fairlee',
    });
    expect(undoTargetOf(DOWN_ITEM, { kind: 'restore' }, 'f')).toEqual({
      targetType: 'comment',
      targetId: 'c_thermo',
    });
    expect(undoTargetOf(GONE_ITEM, { kind: 'restore' }, null)).toEqual({
      targetType: 'contentFlag',
      targetId: 'c_gone',
    });
  });
  test('args', () => {
    expect(argsOf('i', { kind: 'restore', reason: ' back ' })).toEqual({
      kind: 'restore',
      args: { itemId: 'i', reason: 'back' },
    });
    // A dismissal's reason is optional on the server: none typed sends none, a blank one too.
    expect(argsOf('i', { kind: 'dismiss' })).toEqual({ kind: 'dismiss', args: { itemId: 'i' } });
    expect(argsOf('i', { kind: 'dismiss', reason: '   ' })).toEqual({
      kind: 'dismiss',
      args: { itemId: 'i' },
    });
    expect(argsOf('i', { kind: 'dismiss', reason: ' a joke ' })).toEqual({
      kind: 'dismiss',
      args: { itemId: 'i', reason: 'a joke' },
    });
  });
});
