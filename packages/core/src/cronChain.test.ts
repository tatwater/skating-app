/**
 * A chained run's rules (D349). Mutation-checked: each mutation of `cronChain.ts` below was run and
 * seen to fail the tests named, then the source restored —
 *
 *  - **C1** the quiet's clamp dropped (`now − progressAt`): *a clock behind the server*;
 *  - **C2** `stopped` at the bare action limit (`CONVEX_ACTION_LIMIT_MS`, no minute's slack): *the
 *    edges* and *never stopped inside the action limit and its minute*;
 *  - **C3** `closed` read as `open < 0`: *closed only at open 0*;
 *  - **C4** `quiet` at `≥ CHAIN_QUIET_MS`: *the edges*;
 *  - **C5** a `Max` key summed: *a tally adds…* and *order-free*;
 *  - **C6** the tail's drop range to `tailFrom` rather than `min(tailFrom, before)`: *the model*;
 *  - **C7** the head kept through `seq <= CHAIN_LINES_HEAD`: *the model*.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CHAIN_LINES_HEAD,
  CHAIN_LINES_MAX,
  CHAIN_LINES_TAIL,
  CHAIN_QUIET_MS,
  type ChainLiveness,
  type ChainState,
  chainLiveness,
  foldCount,
  mergeChainCounts,
  planChainLines,
} from './cronChain';
import { CONVEX_ACTION_LIMIT_MS, CRON_KILLED_AFTER_MS } from './cronLiveness';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 11, 3, 7, 0);

const chain = (over: Partial<ChainState> = {}): ChainState => ({
  open: 1,
  steps: 3,
  progressAt: NOW,
  lines: 4,
  ...over,
});

const RANK: Record<ChainLiveness, number> = { running: 0, quiet: 1, stopped: 2, closed: 3 };

const chains: fc.Arbitrary<ChainState> = fc.record({
  open: fc.integer({ min: -2, max: 6 }),
  steps: fc.nat(500),
  progressAt: fc.integer({ min: NOW - 3 * 3_600_000, max: NOW + 3_600_000 }),
  lines: fc.nat(CHAIN_LINES_MAX),
});

describe('chainLiveness', () => {
  it('the constants are the design’s', () => {
    expect(CHAIN_QUIET_MS).toBe(15 * MINUTE);
    expect(CHAIN_LINES_MAX).toBe(300);
    expect(CHAIN_LINES_HEAD + CHAIN_LINES_TAIL).toBe(CHAIN_LINES_MAX);
  });

  it('the edges', () => {
    const c = chain();
    expect(chainLiveness(c, NOW)).toBe('running');
    expect(chainLiveness(c, NOW + CHAIN_QUIET_MS)).toBe('running');
    expect(chainLiveness(c, NOW + CHAIN_QUIET_MS + 1)).toBe('quiet');
    expect(chainLiveness(c, NOW + CONVEX_ACTION_LIMIT_MS + 1)).toBe('quiet');
    expect(chainLiveness(c, NOW + CRON_KILLED_AFTER_MS)).toBe('quiet');
    expect(chainLiveness(c, NOW + CRON_KILLED_AFTER_MS + 1)).toBe('stopped');
    expect(chainLiveness(chain({ open: 0 }), NOW + 10 * CRON_KILLED_AFTER_MS)).toBe('closed');
  });

  it('a clock behind the server reads running, never stopped', () => {
    expect(chainLiveness(chain({ progressAt: NOW + CRON_KILLED_AFTER_MS * 3 }), NOW)).toBe(
      'running',
    );
  });

  it('closed only at open 0 (or below), whatever the clock', () => {
    fc.assert(
      fc.property(chains, fc.integer({ min: NOW - 3_600_000, max: NOW + 9_000_000 }), (c, now) => {
        expect(chainLiveness(c, now) === 'closed').toBe(c.open <= 0);
      }),
    );
  });

  it('monotone in time: a clock moving forward only climbs running → quiet → stopped', () => {
    fc.assert(
      fc.property(
        chains,
        fc.integer({ min: NOW - 3_600_000, max: NOW + 9_000_000 }),
        fc.nat(9_000_000),
        (c, now, later) => {
          expect(RANK[chainLiveness(c, now + later)]).toBeGreaterThanOrEqual(
            RANK[chainLiveness(c, now)],
          );
        },
      ),
    );
  });

  it('never stopped inside the action limit and its minute; never quiet inside the quiet', () => {
    fc.assert(
      fc.property(
        chains.filter((c) => c.open > 0),
        fc.integer({ min: -3_600_000, max: CRON_KILLED_AFTER_MS }),
        (c, since) => {
          const state = chainLiveness(c, c.progressAt + since);
          expect(state).not.toBe('stopped');
          if (since <= CHAIN_QUIET_MS) expect(state).toBe('running');
        },
      ),
    );
  });
});

describe('mergeChainCounts', () => {
  it('a tally adds; a Max key keeps the larger; a Min or oldest key the smaller', () => {
    expect(
      mergeChainCounts(
        { cells: 40, fetchMsMax: 900, oldestOpenDay: 20, waitMin: 3 },
        { cells: 37, fetchMsMax: 400, oldestOpenDay: 10, waitMin: 5, added: 2 },
      ),
    ).toEqual({ cells: 77, fetchMsMax: 900, oldestOpenDay: 10, waitMin: 3, added: 2 });
    expect(foldCount('fetchMsMax', 1, 7)).toBe(7);
    expect(foldCount('oldestPartialDay', 9, 4)).toBe(4);
  });

  it('a count that isn’t a finite number is dropped; past maxKeys a new key is dropped', () => {
    expect(
      mergeChainCounts(undefined, { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 1 }),
    ).toEqual({ c: 1 });
    expect(mergeChainCounts({ a: 1, b: 1 }, { a: 1, c: 1 }, 2)).toEqual({ a: 2, b: 1 });
  });

  const keys = fc.constantFrom('cells', 'calls', 'fetchMsMax', 'oldestOpenDay', 'waitMin');
  const steps = fc.array(fc.dictionary(keys, fc.integer({ min: 0, max: 10_000 })), {
    maxLength: 12,
  });
  const fold = (xs: Record<string, number>[]) =>
    xs.reduce<Record<string, number>>((acc, x) => mergeChainCounts(acc, x), {});

  it('order-free: any order of a run’s steps folds to the same counts', () => {
    fc.assert(
      fc.property(
        steps.chain((s) =>
          fc.tuple(
            fc.constant(s),
            fc.shuffledSubarray(s, { minLength: s.length, maxLength: s.length }),
          ),
        ),
        ([s, shuffled]) => {
          expect(fold(shuffled)).toEqual(fold(s));
        },
      ),
    );
  });

  it('a tally is the sum of its steps', () => {
    fc.assert(
      fc.property(steps, (s) => {
        const sum = s.reduce((n, x) => n + (x.cells ?? 0), 0);
        if (s.some((x) => x.cells !== undefined)) expect(fold(s).cells).toBe(sum);
        else expect(fold(s).cells).toBeUndefined();
      }),
    );
  });
});

describe('planChainLines', () => {
  it('under the cap: every line, numbered on', () => {
    expect(planChainLines({ lines: 3 }, 2)).toEqual({
      insert: [
        { index: 0, seq: 3 },
        { index: 1, seq: 4 },
      ],
      drop: null,
      lines: 5,
      linesDropped: 0,
    });
  });

  it('past the cap: the head stays, the oldest of the tail goes, the newest come in', () => {
    const plan = planChainLines({ lines: CHAIN_LINES_MAX }, 3);
    expect(plan.insert.map((i) => i.seq)).toEqual([300, 301, 302]);
    expect(plan.drop).toEqual({ from: CHAIN_LINES_HEAD, to: CHAIN_LINES_HEAD + 3 });
    expect(plan).toMatchObject({ lines: CHAIN_LINES_MAX, linesDropped: 3 });
  });

  it('a step bigger than the window inserts only what stays', () => {
    const plan = planChainLines({ lines: 150 }, 1_000);
    expect(plan.insert).toHaveLength(50 + CHAIN_LINES_TAIL);
    expect(plan.insert.at(-1)).toEqual({ index: 999, seq: 1_149 });
    expect(plan.drop).toBeNull();
  });

  /**
   * The model: replay steps against a set of stored seqs, as `chainStep` does; after every step the
   * store holds exactly the first HEAD and the newest TAIL of every line ever sent (all of them while
   * under the cap), the counters agree with it, and no step writes past its bounds.
   */
  it('the model: the store is the head and the newest tail, always holding the last line', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(260), { minLength: 1, maxLength: 30 }), (sizes) => {
        const stored = new Set<number>();
        let state = { lines: 0, linesDropped: 0 };
        let sent = 0;
        for (const n of sizes) {
          const plan = planChainLines(state, n);
          expect(plan.insert.length).toBeLessThanOrEqual(CHAIN_LINES_MAX);
          if (plan.drop !== null) {
            expect(plan.drop.from).toBe(CHAIN_LINES_HEAD);
            let deleted = 0;
            for (const seq of [...stored]) {
              if (seq >= plan.drop.from && seq < plan.drop.to) {
                stored.delete(seq);
                deleted++;
              }
            }
            expect(deleted).toBeLessThanOrEqual(CHAIN_LINES_TAIL);
          }
          for (const { index, seq } of plan.insert) {
            expect(index).toBeLessThan(n);
            expect(seq).toBe(sent + index);
            expect(stored.has(seq)).toBe(false);
            stored.add(seq);
          }
          sent += n;
          state = { lines: plan.lines, linesDropped: plan.linesDropped };
          const want: number[] = [];
          for (let s = 0; s < sent; s++) {
            if (sent <= CHAIN_LINES_MAX || s < CHAIN_LINES_HEAD || s >= sent - CHAIN_LINES_TAIL) {
              want.push(s);
            }
          }
          expect([...stored].sort((a, b) => a - b)).toEqual(want);
          expect(state.lines).toBe(stored.size);
          expect(state.lines + state.linesDropped).toBe(sent);
          if (sent > 0) expect(stored.has(sent - 1)).toBe(true);
        }
      }),
    );
  });
});
