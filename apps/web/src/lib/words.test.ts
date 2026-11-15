import { describe, expect, it } from 'vitest';

import { listWords } from './words';

describe('listWords', () => {
  it('names a list as a sentence does, with no serial comma', () => {
    expect(listWords([])).toBe('');
    expect(listWords(['the bays'])).toBe('the bays');
    expect(listWords(['the bays', 'the lots'])).toBe('the bays and the lots');
    expect(listWords(['the bays', 'the put-ins', 'the lots'])).toBe(
      'the bays, the put-ins and the lots',
    );
  });
});
