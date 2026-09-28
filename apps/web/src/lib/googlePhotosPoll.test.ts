import { describe, expect, it } from 'vitest';
import { CLOSED_WINDOW_GRACE_POLLS, nextPickStep } from './googlePhotosPoll';

const picking = { phase: 'picking' as const, pollIntervalMs: 4000 };

describe('nextPickStep', () => {
  it('adds once the person has picked, even with the window already closed', () => {
    expect(nextPickStep({ phase: 'picked' }, true, 2)).toEqual({ kind: 'add' });
  });

  it('ends when the pick is gone — declined, expired, failed', () => {
    expect(nextPickStep({ phase: 'gone' }, false, 0)).toEqual({ kind: 'end', reason: 'gone' });
  });

  it("waits on Google's own interval while the window is open", () => {
    expect(nextPickStep(picking, false, 2)).toEqual({ kind: 'wait', ms: 4000, closedPolls: 0 });
    expect(nextPickStep({ phase: 'consent', pollIntervalMs: 2000 }, false, 0)).toEqual({
      kind: 'wait',
      ms: 2000,
      closedPolls: 0,
    });
  });

  it('gives a closed window a few looks — the picker closes itself just before it says so', () => {
    let closed = 0;
    for (let i = 0; i < CLOSED_WINDOW_GRACE_POLLS; i++) {
      const step = nextPickStep(picking, true, closed);
      expect(step.kind).toBe('wait');
      closed = step.kind === 'wait' ? step.closedPolls : closed;
    }
    expect(nextPickStep(picking, true, closed)).toEqual({ kind: 'end', reason: 'walked-away' });
  });
});
