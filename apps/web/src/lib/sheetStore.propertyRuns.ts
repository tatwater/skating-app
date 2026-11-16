/**
 * The sheet's property tests share one seed policy. Every property runs a fixed set of seeds on every
 * build, so a red build is reproducible and a regression one of them reaches is caught on the branch
 * that made it — and one random seed, so the search keeps widening. A failure prints its seed and
 * path. `SHEET_PROPERTY_SEED` replays one seed and `SHEET_PROPERTY_RUNS` widens every property's
 * run; both are local knobs, unset on CI (run through `vitest` directly: turbo's strict env mode
 * drops them under `pnpm test`).
 *
 * The first pinned seed is the CI run that found a lost blob the tab had rewritten
 * (`sheetStore.properties.test.ts`'s first resend case); the arbitraries have changed since, so it
 * no longer reaches that sequence — the named case does.
 */

import fc from 'fast-check';
import { it } from 'vitest';

const PINNED_SEEDS = [1236490619, 20261114, 4242, 7];
// An unset, empty or unreadable knob is the default, never zero runs that check nothing.
const RUNS_KNOB = Math.max(0, Math.trunc(Number(process.env.SHEET_PROPERTY_RUNS)) || 0);
const SEED_KNOB = process.env.SHEET_PROPERTY_SEED?.trim() ?? '';
const REPLAYED = SEED_KNOB === '' ? Number.NaN : Number(SEED_KNOB);
const REPLAYING = Number.isInteger(REPLAYED);
const SEEDS: readonly (number | undefined)[] = REPLAYING
  ? [REPLAYED]
  : [...PINNED_SEEDS, undefined];

/**
 * One `it` per seed: `build` makes the property, `numRuns` is the random seed's share. No `examples`:
 * fast-check counts them against `numRuns`, so a named case passed in would take a random case's
 * place on every seed — the named cases run as their own `it`s instead.
 */
export function property<Ts>(
  name: string,
  build: () => fc.IAsyncProperty<Ts>,
  { numRuns, timeoutMs = 120_000 }: { numRuns: number; timeoutMs?: number },
): void {
  const runs = RUNS_KNOB > 0 ? RUNS_KNOB : numRuns;
  for (const seed of SEEDS) {
    it(
      `${name} (seed ${seed ?? 'random'})`,
      async () => {
        await fc.assert(build(), {
          // A replayed seed runs as many cases as the random one that printed it, or a counterexample
          // it found past the pinned seeds' half would never be reached again.
          numRuns: seed === undefined || REPLAYING ? runs : Math.ceil(runs / 2),
          ...(seed !== undefined ? { seed } : {}),
        });
      },
      timeoutMs,
    );
  }
}
