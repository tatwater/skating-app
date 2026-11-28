/**
 * PLACEHOLDER (B01-8c-1 seams): pins the stub's shape only. The chain's builder replaces this with
 * the rule's tests and its `fast-check` properties (monotone in time; never `stopped` inside the
 * action limit; `closed` only at `open === 0`).
 */

import { describe, expect, test } from 'vitest';
import { CHAIN_LINES_MAX, CHAIN_QUIET_MS, type ChainState, chainLiveness } from './cronChain';

const chain = (open: number): ChainState => ({ open, steps: 3, progressAt: 0, lines: 4 });

describe('the chain stub', () => {
  test('its constants are the design’s', () => {
    expect(CHAIN_QUIET_MS).toBe(15 * 60_000);
    expect(CHAIN_LINES_MAX).toBe(300);
  });

  test('closed at open 0, running otherwise', () => {
    expect(chainLiveness(chain(0), 1)).toBe('closed');
    expect(chainLiveness(chain(2), 1)).toBe('running');
  });
});
