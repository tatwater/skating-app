/**
 * `ReadBudget.waves` (B01-3h), as a property: over random items (each one or two reads of random real
 * weight, up to a document's), a random budget and a random order in which the reads settle —
 * the budget never goes below zero, nothing is read that wasn't reserved, every item gets an answer
 * (its read rows or the overflow), and the answer is the same whatever order the reads settle in.
 * Pinned seeds, plus one random run. `measured`'s serial behaviour is `readBudget.test.ts`'s, unchanged.
 */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { DOC_MAX, ReadBudget } from './readBudget';

/** A row that weighs about `bytes` (a string field of that length). */
const rowOf = (bytes: number) => ({ text: 'x'.repeat(Math.max(0, bytes - 64)) });

/** Settle after `ticks` turns of the microtask queue — the order reads settle in. */
const settleAfter = async <D>(ticks: number, value: D): Promise<D> => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
  return value;
};

interface Item {
  sizes: number[];
}

async function runWaves(budgetBytes: number, items: Item[], ticks: number[]) {
  const budget = new ReadBudget(budgetBytes);
  let k = 0;
  let lowest = budget.bytes;
  const answers = await budget.waves(
    items,
    (item) => ({ bytes: item.sizes.length * DOC_MAX, reads: item.sizes.length }),
    async (item, share) => {
      const got = await Promise.all(
        item.sizes.map((size) =>
          share.read('waterBody', () => {
            // Nothing is read below zero: the reservation is already out of the budget.
            lowest = Math.min(lowest, budget.bytes);
            return settleAfter(ticks[k++ % ticks.length] ?? 0, rowOf(size));
          }),
        ),
      );
      return got.map((row) => row.text.length) as number[] | 'overflow';
    },
    (): number[] | 'overflow' => 'overflow',
  );
  return { answers, lowest, left: budget.bytes };
}

const item = fc.record({
  sizes: fc.array(fc.integer({ min: 0, max: DOC_MAX }), { minLength: 1, maxLength: 2 }),
});
const scenario = fc.record({
  budgetBytes: fc.integer({ min: 0, max: 5 * DOC_MAX }),
  items: fc.array(item, { maxLength: 10 }),
  ticksA: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 20 }),
  ticksB: fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 20 }),
});

const property = fc.asyncProperty(scenario, async ({ budgetBytes, items, ticksA, ticksB }) => {
  const a = await runWaves(budgetBytes, items, ticksA);
  const b = await runWaves(budgetBytes, items, ticksB);
  // Every item answered; the same answers and the same budget left, whatever the settling order.
  expect(a.answers).toHaveLength(items.length);
  expect(a.answers.every((x) => x !== undefined)).toBe(true);
  expect(b.answers).toEqual(a.answers);
  expect(b.left).toBe(a.left);
  // Never below zero, and everything not really read handed back.
  expect(a.lowest).toBeGreaterThanOrEqual(0);
  expect(a.left).toBeGreaterThanOrEqual(0);
  expect(a.left).toBeLessThanOrEqual(budgetBytes);
  // The overflow is a suffix: once an item can't be reserved, no later one is read.
  const first = a.answers.indexOf('overflow');
  if (first >= 0) expect(a.answers.slice(first).every((x) => x === 'overflow')).toBe(true);
});

describe('ReadBudget.waves', () => {
  for (const seed of [1, 42, 20_261_115]) {
    test(`exact, total and order-independent (seed ${seed})`, async () => {
      await fc.assert(property, { seed, numRuns: 60 });
    });
  }
  test('exact, total and order-independent (a random seed)', async () => {
    await fc.assert(property, { numRuns: 60 });
  });

  test('a throwing item hands its reservation back and the page throws only after every hand-back', async () => {
    const budget = new ReadBudget(3 * DOC_MAX);
    await expect(
      budget.waves(
        [1, 2, 3],
        () => ({ bytes: DOC_MAX, reads: 1 }),
        async (n, share) => {
          await share.read('waterBody', () => settleAfter(n, rowOf(10)));
          if (n === 1) throw new Error('boom');
          return n;
        },
        () => 0,
      ),
    ).rejects.toThrow('boom');
    expect(budget.bytes).toBeGreaterThan(3 * DOC_MAX - 3 * 1024);
  });

  test('an item reading past what it declared is a plan error, and still hands back', async () => {
    const budget = new ReadBudget(2 * DOC_MAX);
    await expect(
      budget.waves(
        [1],
        () => ({ bytes: DOC_MAX, reads: 1 }),
        async (_n, share) => {
          await share.read('waterBody', () => settleAfter(0, rowOf(10)));
          return share.read('waterBody', () => settleAfter(0, rowOf(10)));
        },
        () => null,
      ),
    ).rejects.toThrow(/declared/);
    expect(budget.bytes).toBeGreaterThan(2 * DOC_MAX - 1024);
  });
});
