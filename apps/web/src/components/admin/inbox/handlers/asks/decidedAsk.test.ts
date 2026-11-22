import { describe, expect, it } from 'vitest';

import { decidedAsk } from './decidedAsk';

describe('the ask a decision is written on', () => {
  it('is the oldest open one, past a closed first', () => {
    const asks = [
      { id: 'a', status: 'closed' },
      { id: 'b', status: 'open' },
      { id: 'c', status: 'open' },
    ] as const;
    expect(decidedAsk(asks)?.id).toBe('b');
  });

  it('is the first when none is open (a decided item), and none when there are no asks', () => {
    expect(decidedAsk([{ id: 'a', status: 'closed' }] as const)?.id).toBe('a');
    expect(decidedAsk([])).toBeNull();
  });
});
