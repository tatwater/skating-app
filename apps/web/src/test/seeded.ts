import fc from 'fast-check';

/**
 * Test support: a fast-check property run on pinned seeds, then once at random. The pinned runs
 * make a failure seen once reproduce on every machine (and in CI) without hunting for its seed; the
 * random run keeps finding new cases. A failure names its seed, so a random find can be pinned here.
 */
export const PINNED_SEEDS = [1, 42, 20261115] as const;

/**
 * Synchronous properties only: `fc.assert` hands an async property's verdict back as a promise,
 * which this would drop — a failure would pass. An async property runs one `it` per seed and awaits
 * each, as `sheetStore.properties.test.ts` does.
 */
export function assertSeeded<Ts>(property: fc.IProperty<Ts>, params: fc.Parameters<Ts> = {}): void {
  for (const seed of PINNED_SEEDS) fc.assert(property, { ...params, seed });
  fc.assert(property, params);
}
