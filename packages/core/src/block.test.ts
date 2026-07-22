import { describe, expect, it } from 'vitest';
import { canBlock } from './block';

describe('canBlock (D32)', () => {
  it('allows blocking another user', () => {
    expect(canBlock('a', 'b')).toBe(true);
  });

  it('forbids blocking yourself', () => {
    expect(canBlock('a', 'a')).toBe(false);
  });
});
