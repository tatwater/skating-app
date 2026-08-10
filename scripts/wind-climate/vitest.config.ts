import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 20s, not vitest's 5s default — see the note in `packages/convex/vitest.config.ts`. The
    // flaking set is load-dependent: turbo runs 11 packages at once and CI is ~8x slower than
    // local, so whichever test loses the race times out while being fast in isolation. A hang is
    // unbounded and still fails; this only stops green code reporting red.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // `wtk.ts` and `archive.ts` are the tested logic; `snapshot.ts` and `derive.ts` are argv,
      // network and file glue. Mirrors the water ETL, admin-areas and lake-depth configs.
      //
      // **Thresholds raised to match every other package** (N7-3). They sat at 80/75 while the rest
      // of the repo ran at 90/85, which is not a decision anybody took — it is where they landed
      // when this package held one file. A lower bar on the pass that costs 7.7 hours to re-run is
      // the wrong way round.
      exclude: ['src/**/*.test.ts', 'src/snapshot.ts', 'src/derive.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
