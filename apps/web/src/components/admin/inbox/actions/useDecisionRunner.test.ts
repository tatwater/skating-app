import { describe, expect, it } from 'vitest';

import { undoOf } from './useDecisionRunner';

const target = { targetType: 'waterBodyRequest', targetId: 'r1' } as const;

describe('a receipt’s Undo', () => {
  it('takes the row and its reason rule from the write’s answer', () => {
    expect(
      undoOf({ target, answer: { actionId: 'a', undoable: true, undoNeedsReason: true } }),
    ).toEqual({ actionId: 'a', undoNeedsReason: true });
  });

  it('says no Undo when the answer says it can’t be undone now', () => {
    expect(undoOf({ target, answer: { actionId: 'a', undoable: false } })).toEqual({
      actionId: 'a',
      undoable: false,
    });
  });

  it('offers none, and looks nothing up, for a write that decided nothing (a lookup)', () => {
    expect(undoOf({ target, answer: null })).toEqual({ undoable: false });
  });
});
