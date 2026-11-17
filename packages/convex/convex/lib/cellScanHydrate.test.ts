/**
 * **The ranked candidates hydrated in waves** (B01-3q). `bodiesCoveringBox` read its ranked
 * candidates one after another until its limit filled — each a whole body, a round trip each; that
 * and the cell walk are where the largest lakes' tiles spent their 0.7–1.2 s on dev. `hydrateRanked`
 * reads them a wave at a time, each wave exactly as many as could still be kept, so it reads exactly
 * the candidates the old loop read — never one more — and keeps the same ones in the same order.
 * Checked here against the old loop, kept as the reference.
 */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { HYDRATE_WAVE_MAX, hydrateRanked } from './cellScan';

type Doc = { id: string; keep: boolean } | null;

/** The old loop, as `bodiesCoveringBox` had it before B01-3q. */
async function reference(ranked: readonly string[], limit: number, docs: Map<string, Doc>) {
  const read: string[] = [];
  const kept: string[] = [];
  let truncated = false;
  for (const id of ranked) {
    if (kept.length >= limit) {
      truncated = true;
      break;
    }
    read.push(id);
    const doc = docs.get(id) ?? null;
    if (doc === null || !doc.keep) continue;
    kept.push(doc.id);
  }
  return { read, kept, truncated };
}

const world = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 60 })
  .chain((ranked) =>
    fc.record({
      ranked: fc.constant(ranked),
      fates: fc.array(fc.constantFrom('keep', 'reject', 'gone'), {
        minLength: ranked.length,
        maxLength: ranked.length,
      }),
      limit: fc.integer({ min: 0, max: 25 }),
    }),
  );

const same = fc.asyncProperty(world, async ({ ranked, fates, limit }) => {
  const docs = new Map<string, Doc>(
    ranked.map((id, k) => [id, fates[k] === 'gone' ? null : { id, keep: fates[k] === 'keep' }]),
  );
  const want = await reference(ranked, limit, docs);
  const read: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const got = await hydrateRanked(
    ranked,
    limit,
    async (id) => {
      read.push(id);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return docs.get(id) ?? null;
    },
    (doc) => doc.keep,
  );
  expect(got.kept.map((d) => d.id)).toEqual(want.kept);
  expect(got.truncated).toBe(want.truncated);
  // Exactly the reads the old loop made: never one it would not have.
  expect([...read].sort()).toEqual([...want.read].sort());
  // The first wave is the widest, and it is the whole room: concurrent, not one read a round.
  expect(peak).toBe(Math.min(limit, ranked.length, HYDRATE_WAVE_MAX));
});

describe('hydrateRanked', () => {
  test.each([8, 64, 2026])(
    'keeps and reads exactly what the old loop did (seed %i)',
    async (seed) => {
      await fc.assert(same, { seed, numRuns: 300 });
    },
  );
  test('keeps and reads exactly what the old loop did (a random seed, logged)', async () => {
    const seed = Date.now() % 2_147_483_647;
    console.info(`ranked hydration: seed ${seed}`);
    await fc.assert(same, { seed, numRuns: 300 });
  });

  test('all kept: one wave of the limit, not one read a round', async () => {
    let rounds = 0;
    let inFlight = 0;
    const got = await hydrateRanked(
      Array.from({ length: 30 }, (_, k) => `b${k}`),
      13,
      async (id) => {
        if (inFlight === 0) rounds++;
        inFlight++;
        await Promise.resolve();
        inFlight--;
        return { id };
      },
      () => true,
    );
    expect(got.kept).toHaveLength(13);
    expect(got.truncated).toBe(true);
    expect(rounds).toBe(1);
  });

  test.each([2.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a limit of %d ends with what the old loop kept and read',
    async (limit) => {
      const ranked = Array.from({ length: 12 }, (_, k) => `b${k}`);
      const docs = new Map<string, Doc>(
        ranked.map((id, k) => [id, k % 3 === 2 ? null : { id, keep: k % 3 === 0 }]),
      );
      const want = await reference(ranked, limit, docs);
      const read: string[] = [];
      const got = await hydrateRanked(
        ranked,
        limit,
        async (id) => {
          read.push(id);
          return docs.get(id) ?? null;
        },
        (doc) => doc.keep,
      );
      expect(got.kept.map((d) => d.id)).toEqual(want.kept);
      expect(got.truncated).toBe(want.truncated);
      expect([...read].sort()).toEqual([...want.read].sort());
    },
  );

  test('a wide limit reads at most HYDRATE_WAVE_MAX at once, and keeps what the old loop kept', async () => {
    const ranked = Array.from({ length: 200 }, (_, k) => `b${k}`);
    const docs = new Map<string, Doc>(ranked.map((id, k) => [id, { id, keep: k % 5 !== 0 }]));
    const want = await reference(ranked, 150, docs);
    let rounds = 0;
    let inFlight = 0;
    let peak = 0;
    const got = await hydrateRanked(
      ranked,
      150,
      async (id) => {
        if (inFlight === 0) rounds++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return docs.get(id) ?? null;
      },
      (doc) => doc.keep,
    );
    expect(got.kept.map((d) => d.id)).toEqual(want.kept);
    expect(got.truncated).toBe(want.truncated);
    expect(peak).toBe(HYDRATE_WAVE_MAX);
    expect(rounds).toBeLessThanOrEqual(5);
  });
});
