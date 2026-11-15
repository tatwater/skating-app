/**
 * `ReadBudget.waves` (B01-3h), as a property: over random items (each one or two reads of random real
 * weight, up to a document's), a random budget and a random order in which the reads settle —
 * the budget never goes below zero, nothing is read that wasn't reserved, every item gets an answer
 * (its read rows or the overflow), and the answer is the same whatever order the reads settle in.
 * Pinned seeds, plus one random run. `measured`'s serial behavior is tested in `readBudget.test.ts`.
 */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { DOC_MAX, OverBudget, ReadBudget, type Share, TX_CALLS, TX_DOCS } from './readBudget';

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

/** Rows past their kind's bound (written before its caps): the balance is still order-independent. */
const pastBounds = fc.asyncProperty(
  fc.array(fc.array(fc.integer({ min: 0, max: 3 * 12 * 1024 }), { minLength: 1, maxLength: 2 }), {
    maxLength: 8,
  }),
  fc.integer({ min: 0, max: 200 * 1024 }),
  fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 12 }),
  fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 12 }),
  async (items, budgetBytes, ticksA, ticksB) => {
    const run = async (ticks: number[]) => {
      const budget = new ReadBudget(budgetBytes);
      let k = 0;
      const answers = await budget.waves(
        items,
        (sizes) => ({ bytes: sizes.length * 12 * 1024, reads: sizes.length }),
        async (sizes, share) =>
          (
            await Promise.all(
              sizes.map((size) =>
                share.read('launch', () =>
                  settleAfter(ticks[k++ % ticks.length] ?? 0, rowOf(size)),
                ),
              ),
            )
          ).length,
        () => -1,
      );
      return { answers, left: budget.bytes };
    };
    expect(await run(ticksB)).toEqual(await run(ticksA));
  },
);

describe('ReadBudget.waves', () => {
  test('rows past their bound: the same answers and balance whatever the settling order', async () => {
    await fc.assert(pastBounds, { seed: 7, numRuns: 40 });
    await fc.assert(pastBounds, { numRuns: 20 });
  });

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

  test('a read that throws is handed back whole', async () => {
    const budget = new ReadBudget(2 * DOC_MAX);
    await expect(
      budget.waves(
        [1],
        () => ({ bytes: DOC_MAX, reads: 1 }),
        (_n, share) =>
          share.read('waterBody', async () => {
            throw new Error('gone');
          }),
        () => null,
      ),
    ).rejects.toThrow('gone');
    expect(budget.bytes).toBe(2 * DOC_MAX);
  });

  test('the calls an item didn’t make are handed back with its bytes', async () => {
    const budget = new ReadBudget(4 * DOC_MAX);
    // Declared two reads; made one (the other row already in hand).
    await budget.waves(
      [1],
      () => ({ bytes: 2 * DOC_MAX, reads: 2 }),
      (_n, share) => share.read('waterBody', () => settleAfter(0, rowOf(10))),
      () => null,
    );
    expect(budget.affordsCalls(TX_CALLS - 1, TX_CALLS - 1)).toBe(true);
    expect(budget.affordsCalls(TX_CALLS, 1)).toBe(false);
  });

  test('a row past its bound (written before its caps) is charged exactly what it weighs, never thrown', async () => {
    const launch = 12 * 1024;
    const budget = new ReadBudget(launch * 4);
    // One heavy old launch, then the hidden ones: the take still fits its declared plan.
    const got = await budget.waves(
      [1],
      () => ({ bytes: launch * 3, reads: 2, docs: 3 }),
      async (_n, share) => {
        const row = await share.read('launch', () => settleAfter(0, rowOf(launch * 5)));
        const hidden = await share.take('launch', 2, () => settleAfter(0, [rowOf(100)]));
        return [row.text.length, hidden.length];
      },
      () => null,
    );
    expect(got[0]?.[1]).toBe(1);
    // Charged exactly, past the reservation and the budget: what follows sees no room.
    expect(budget.bytes).toBeLessThan(0);
    expect(budget.affordsRead('small')).toBe(false);
  });

  test('a take reserves its documents, and hands back the ones it didn’t scan', async () => {
    const budget = new ReadBudget(4 * DOC_MAX);
    await expect(
      budget.waves(
        [1],
        () => ({ bytes: 2 * DOC_MAX, reads: 1 }),
        (_n, share) => share.take('small', 5, () => settleAfter(0, [])),
        () => null,
      ),
    ).rejects.toThrow(/declared/);
    await budget.waves(
      [1],
      () => ({ bytes: 2 * DOC_MAX, reads: 1, docs: 5 }),
      (_n, share) => share.take('small', 5, () => settleAfter(0, [rowOf(10)])),
      () => null,
    );
    // One document scanned of the five reserved: the other four came back.
    expect(budget.affordsCalls(1, TX_DOCS - 1)).toBe(true);
    expect(budget.affordsCalls(1, TX_DOCS)).toBe(false);
  });

  test('a share reads only while its item runs: a read after its answer is a plan error', async () => {
    const budget = new ReadBudget(2 * DOC_MAX);
    let kept: Share | undefined;
    await budget.waves(
      [1],
      () => ({ bytes: DOC_MAX, reads: 1 }),
      async (n, share) => {
        kept = share;
        return n;
      },
      () => 0,
    );
    await expect(
      (kept as Share).read('waterBody', () => settleAfter(0, rowOf(10))),
    ).rejects.toThrow(OverBudget);
    expect(budget.bytes).toBe(2 * DOC_MAX);
  });
});
