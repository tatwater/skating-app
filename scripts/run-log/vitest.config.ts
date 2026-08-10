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
      // `convexRun.ts` is subprocess glue (same exclusion the other script packages make for their
      // loaders); `index.ts` is the barrel. The tested surface is the run-logger's own logic —
      // deployment resolution, failure capping, stage assembly, and never letting a bookkeeping
      // failure take down the import it is bookkeeping.
      exclude: [
        'src/**/*.test.ts',
        'src/convexRun.ts',
        'src/index.ts',
        'src/types.ts',
        'src/cli.ts',
        'src/backfillArchives.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
