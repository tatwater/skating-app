import { describe, expect, it } from 'vitest';
import { nextPickStep } from './googlePhotosPoll';

describe('nextPickStep', () => {
  it('adds once the person has picked', () => {
    expect(nextPickStep({ phase: 'picked' })).toEqual({ kind: 'add' });
  });

  it('ends when the pick is gone — declined, expired, failed', () => {
    expect(nextPickStep({ phase: 'gone' })).toEqual({ kind: 'end' });
  });

  it("waits on Google's own interval while consenting or picking", () => {
    expect(nextPickStep({ phase: 'picking', pollIntervalMs: 4000 })).toEqual({
      kind: 'wait',
      ms: 4000,
    });
    expect(nextPickStep({ phase: 'consent', pollIntervalMs: 2000 })).toEqual({
      kind: 'wait',
      ms: 2000,
    });
  });
});
