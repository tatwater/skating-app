import { describe, expect, it } from 'vitest';

import { nextFolded } from './record-lockup';

describe('the lockup’s fold', () => {
  it('folds past a few pixels and unfolds only back at the top', () => {
    expect(nextFolded(false, 10)).toBe(false);
    expect(nextFolded(false, 25)).toBe(true);
    expect(nextFolded(true, 10)).toBe(true);
    expect(nextFolded(true, 2)).toBe(false);
    expect(nextFolded(true, 0)).toBe(false);
  });
});
