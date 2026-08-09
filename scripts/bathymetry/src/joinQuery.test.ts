import { describe, expect, it, vi } from 'vitest';
import {
  inAdaptiveBatches,
  isReadLimitError,
  type JoinCandidate,
  joinInBatches,
} from './joinQuery';

const READ_LIMIT =
  'Uncaught Error: Too many bytes read in a single function execution (limit: 16777216 bytes).';

function candidates(n: number): JoinCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `lake-${i}`,
    point: { lat: 44 + i / 1000, lng: -72 },
  }));
}

function matched(batch: readonly JoinCandidate[]) {
  return {
    matches: batch.map((c) => ({
      key: c.key,
      waterBodyId: `body-${c.key}`,
      source: 'osm',
      name: c.key,
    })),
    rejects: [],
  };
}

describe('isReadLimitError', () => {
  it('recognises the cap by its own wording', () => {
    expect(isReadLimitError(READ_LIMIT)).toBe(true);
    expect(isReadLimitError('Read too much data in a single query')).toBe(true);
  });

  it('does not claim an unrelated failure', () => {
    expect(isReadLimitError('Could not find public function')).toBe(false);
    expect(isReadLimitError('ECONNREFUSED')).toBe(false);
  });
});

describe('joinInBatches', () => {
  it('resolves everything in one pass when nothing trips the cap', async () => {
    const run = vi.fn(async (batch: readonly JoinCandidate[]) => matched(batch));
    const result = await joinInBatches(candidates(10), 4, run);
    expect(result.matches).toHaveLength(10);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('splits a batch that trips the cap and still resolves every lake', async () => {
    // The failure that made this module exist: a batch of 20 blew the 16 MB limit on the first real
    // run, and the error arrives as an opaque server 500 rather than as a validation message.
    const run = vi.fn(async (batch: readonly JoinCandidate[]) => {
      if (batch.length > 2) throw new Error(READ_LIMIT);
      return matched(batch);
    });
    const result = await joinInBatches(candidates(8), 8, run);
    expect(result.matches.map((m) => m.key).sort()).toEqual(
      candidates(8)
        .map((c) => c.key)
        .sort(),
    );
    expect(result.rejects).toEqual([]);
  });

  it('names the one expensive lake rather than losing it', async () => {
    // A point in the middle of Champlain reads every body in a dense cell plus a multi-megabyte
    // shoreline. Alone it still fails — and that is a finding about the corpus, not a lake to drop.
    const run = vi.fn(async (batch: readonly JoinCandidate[]) => {
      if (batch.some((c) => c.key === 'lake-3')) throw new Error(READ_LIMIT);
      return matched(batch);
    });
    const result = await joinInBatches(candidates(6), 6, run);
    expect(result.matches).toHaveLength(5);
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]?.key).toBe('lake-3');
    expect(result.rejects[0]?.reason).toContain('Too many bytes read');
  });

  it('does not split on an unrelated failure — it rejects the batch and moves on', async () => {
    // Splitting a genuinely broken query would retry it once per lake for the whole corpus.
    const run = vi.fn(async () => {
      throw new Error('Could not find public function waterBodies:matchBathymetryLakes');
    });
    const result = await joinInBatches(candidates(4), 4, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.rejects).toHaveLength(4);
  });

  it('passes rejects from the query through untouched', async () => {
    const run = vi.fn(async (batch: readonly JoinCandidate[]) => ({
      matches: [],
      rejects: batch.map((c) => ({ key: c.key, reason: 'no listed body at this point' })),
    }));
    const result = await joinInBatches(candidates(3), 3, run);
    expect(result.rejects.map((r) => r.reason)).toEqual([
      'no listed body at this point',
      'no listed body at this point',
      'no listed body at this point',
    ]);
  });

  it('reports progress only for batches that actually landed', async () => {
    const seen: number[] = [];
    const run = async (batch: readonly JoinCandidate[]) => matched(batch);
    await joinInBatches(candidates(6), 2, run, (done) => seen.push(done));
    expect(seen).toEqual([2, 4, 6]);
  });

  it('handles an empty input without calling the deployment', async () => {
    const run = vi.fn(async (batch: readonly JoinCandidate[]) => matched(batch));
    expect(await joinInBatches([], 10, run)).toEqual({ matches: [], rejects: [] });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('inAdaptiveBatches — the splitting core both lanes share', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => i);
  const readLimit = () => new Error('Too many bytes read in a single function execution');

  it('runs every item exactly once when nothing fails', () => {
    const seen: number[] = [];
    return inAdaptiveBatches(
      items(10),
      3,
      async (batch) => {
        seen.push(...batch);
      },
      () => expect.unreachable('nothing should fail'),
    ).then(() => {
      expect(seen.sort((a, b) => a - b)).toEqual(items(10));
    });
  });

  it('halves a batch that trips the read cap, losing no item', async () => {
    const seen: number[] = [];
    let firstCall = true;
    await inAdaptiveBatches(
      items(8),
      8,
      async (batch) => {
        // The whole batch fails once; both halves then succeed.
        if (firstCall) {
          firstCall = false;
          throw readLimit();
        }
        seen.push(...batch);
      },
      () => expect.unreachable('a halved batch should succeed'),
    );
    expect(seen.sort((a, b) => a - b)).toEqual(items(8));
  });

  it('stops splitting at one item and reports it rather than recursing forever', async () => {
    const failed: number[] = [];
    await inAdaptiveBatches(
      items(4),
      4,
      async () => {
        throw readLimit();
      },
      (batch) => failed.push(...batch),
    );
    // Every item ends up named — the alternative is an ETL that resolves 60% and looks complete.
    expect(failed.sort((a, b) => a - b)).toEqual(items(4));
  });

  it('does not split an error that is not about the read cap', async () => {
    let calls = 0;
    const failed: number[] = [];
    await inAdaptiveBatches(
      items(8),
      8,
      async () => {
        calls++;
        throw new Error('function not found');
      },
      (batch) => failed.push(...batch),
    );
    // One attempt, one failure report. Halving a broken query just fails 8 times instead of once.
    expect(calls).toBe(1);
    expect(failed).toHaveLength(8);
  });

  it('counts progress only for batches that succeeded', async () => {
    const progress: number[] = [];
    await inAdaptiveBatches(
      items(4),
      2,
      async (batch) => {
        if (batch[0] === 0) throw new Error('nope');
      },
      () => undefined,
      (done) => progress.push(done),
    );
    // The first pair failed and must not count toward "done" — a progress line that advances on
    // failure is how a half-finished run reads as complete.
    expect(progress).toEqual([2]);
  });

  it('does nothing at all for an empty list', async () => {
    const run = vi.fn(async () => undefined);
    await inAdaptiveBatches([], 10, run, () => undefined);
    expect(run).not.toHaveBeenCalled();
  });
});
