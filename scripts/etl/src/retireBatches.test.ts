import { describe, expect, test } from 'vitest';
import {
  NEVER_FITS,
  type PairRef,
  type RetireArgs,
  type RetireResult,
  retireInBatches,
} from './retireBatches';

const pair = (n: number): PairRef => ({
  survivor: { source: 'osm', externalId: `s${n}` },
  absorbed: { source: 'osm', externalId: `a${n}` },
});

/**
 * A stand-in for `waterBodies:retireAbsorbedBodies`: each call retires pairs while `room(pair, i)`
 * says the i-th merge of the call fits, deferring that pair and the rest once it doesn't — as the
 * mutation does — and never defers a call's first pair unless `never` names it.
 */
function server(
  room: (p: PairRef, mergedHere: number) => boolean,
  never: ReadonlySet<string> = new Set(),
) {
  const calls: RetireArgs[] = [];
  const call = (args: RetireArgs): RetireResult => {
    // A loop that never ends fails here rather than hanging the suite.
    if (calls.length >= 50) throw new Error('the pass never finished');
    calls.push(args);
    const retiredKeys: string[] = [];
    let deferred: PairRef[] = [];
    for (const [i, p] of args.pairs.entries()) {
      const key = `${p.absorbed.source}:${p.absorbed.externalId}`;
      const fits = !never.has(key) && (retiredKeys.length === 0 || room(p, retiredKeys.length));
      if (!fits) {
        deferred = args.pairs.slice(i);
        break;
      }
      retiredKeys.push(key);
    }
    return {
      applied: args.apply === true,
      scanned: args.pairs.length - deferred.length,
      retired: retiredKeys.length,
      samples: retiredKeys.map((k) => ({ absorbed: k, into: 'x', name: k })),
      retiredKeys,
      taken: [],
      skipped: {},
      skippedSamples: [],
      deferred,
    };
  };
  return { call, calls };
}

describe('retireInBatches', () => {
  test('all fit: one call a batch, every pair retired, nothing sent twice', () => {
    const s = server(() => true);
    const out = retireInBatches([1, 2, 3, 4, 5].map(pair), { batch: 2, apply: true }, s.call);
    expect(out).toMatchObject({ scanned: 5, retired: 5, calls: 3, skipped: {} });
    expect(s.calls.map((c) => c.pairs.length)).toEqual([2, 2, 1]);
    // The resolved keys carried forward, so one row is retired once across batches.
    expect(s.calls[2]?.alreadyRetired).toEqual(['osm:a1', 'osm:a2', 'osm:a3', 'osm:a4']);
  });

  test('some deferred: sent again first, then taken — every pair retired once', () => {
    // One merge a call fits.
    const s = server((_p, mergedHere) => mergedHere < 1);
    const out = retireInBatches([1, 2, 3].map(pair), { batch: 3, apply: true }, s.call);
    expect(out).toMatchObject({ scanned: 3, retired: 3, calls: 3, skipped: {} });
    expect(s.calls.map((c) => c.pairs.map((p) => p.absorbed.externalId))).toEqual([
      ['a1', 'a2', 'a3'],
      ['a2', 'a3'],
      ['a3'],
    ]);
  });

  test('one that never fits: reported skipped by name, never retried for ever', () => {
    const s = server(() => true, new Set(['osm:a2']));
    const progress: number[] = [];
    const out = retireInBatches(
      [1, 2, 3].map(pair),
      { batch: 3, apply: true, campaignId: 'c1' },
      s.call,
      (t) => progress.push(t.calls),
    );
    expect(out.retired).toBe(2);
    expect(out.scanned).toBe(3);
    expect(out.skipped).toEqual({ [NEVER_FITS]: 1 });
    expect(out.skippedSamples).toEqual([{ pair: 'osm:a2 → osm:s2', why: NEVER_FITS }]);
    // Bounded: a2 given up on once it couldn't run even first; a3 sent again and taken.
    expect(s.calls.map((c) => c.pairs.map((p) => p.absorbed.externalId))).toEqual([
      ['a1', 'a2', 'a3'],
      ['a2', 'a3'],
      ['a3'],
    ]);
    expect(progress).toEqual([1, 2, 3]);
    expect(s.calls[0]).toMatchObject({ campaignId: 'c1', apply: true });
  });

  test('a dry run sends no apply, and a server from before deferral reads as nothing deferred', () => {
    const calls: RetireArgs[] = [];
    const out = retireInBatches([pair(1), pair(2)], { batch: 1, apply: false }, (args) => {
      calls.push(args);
      return {
        applied: false,
        scanned: 1,
        retired: 1,
        samples: [],
        retiredKeys: ['osm:a1'],
        taken: [{ key: 'osm:s1', pins: [], aliases: ['A'], links: [] }],
        skipped: { 'already merged': 0 },
        skippedSamples: [{ pair: 'p', why: 'w' }],
      };
    });
    expect(calls[0]).not.toHaveProperty('apply');
    // The survivors' lists carried into the next call, so its cap check reads them by now.
    expect(calls[1]?.taken).toEqual([{ key: 'osm:s1', pins: [], aliases: ['A'], links: [] }]);
    expect(out).toMatchObject({ retired: 2, scanned: 2, calls: 2 });
    expect(out.skippedSamples).toHaveLength(2);
  });

  test('samples stop at 25 each, a never-fitting pair still counted past them', () => {
    const many = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({ absorbed: `${tag}${i}`, into: 'x', name: 'n' }));
    let first = true;
    let calls = 0;
    const out = retireInBatches([pair(1), pair(2)], { batch: 1, apply: true }, (args) => {
      if (++calls > 50) throw new Error('the pass never finished');
      const head = args.pairs[0] as PairRef;
      const result = {
        applied: true,
        scanned: 1,
        retired: first ? 1 : 0,
        samples: many(30, 'r'),
        retiredKeys: first ? ['osm:a1'] : [],
        // A server that sends no lists carried forward.
        taken: undefined as never,
        skipped: {},
        skippedSamples: many(30, 's').map((x) => ({ pair: x.absorbed, why: 'w' })),
        deferred: first ? [] : [head],
      };
      first = false;
      return result;
    });
    expect(out.samples).toHaveLength(25);
    expect(out.skippedSamples).toHaveLength(25);
    expect(out.skipped).toEqual({ [NEVER_FITS]: 1 });
    expect(out).toMatchObject({ retired: 1, scanned: 2, calls: 2 });
  });
});
