import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
