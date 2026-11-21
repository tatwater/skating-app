import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 20s, not vitest's 5s default — see the note in `packages/convex/vitest.config.ts`: turbo runs
    // the packages at once and CI is slower than local, so a fast test can lose the race.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // `cli.ts` is the subprocess and file glue around the tested loops (`seed.ts`) and arguments
      // (`args.ts`), excluded like every other script's CLI.
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 95,
        statements: 100,
      },
    },
  },
});
