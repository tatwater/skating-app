import { describe, expect, it } from 'vitest';

import { undoOf } from './useDecisionRunner';

const target = { targetType: 'waterBodyRequest', targetId: 'r1' } as const;

describe('a receipt’s Undo', () => {
  it('offers none, and looks nothing up, for a write that decided nothing', () => {
    expect(
      undoOf({ target, answer: { actionId: 'a', undoable: true, undoNeedsReason: false } }, false),
    ).toEqual({ undoable: false });
  });

  it('takes the row and its reason rule from the write’s answer', () => {
    expect(
      undoOf(
        { target, answer: { actionId: 'a', undoable: true, undoNeedsReason: true } },
        undefined,
      ),
    ).toEqual({ actionId: 'a', undoNeedsReason: true });
  });

  it('says no Undo when the answer says it can’t be undone now', () => {
    expect(
      undoOf(
        { target, answer: { actionId: 'a', undoable: false, undoNeedsReason: false } },
        undefined,
      ),
    ).toEqual({ actionId: 'a', undoable: false });
  });

  it('leaves the shell to look the row up when the write gave no answer (the marked fallback)', () => {
    expect(undoOf({ target }, undefined)).toEqual({});
  });
});
