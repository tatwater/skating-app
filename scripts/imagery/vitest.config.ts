import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 20s rather than vitest's 5s default, for the reason the sibling ETL configs give: the flaking
    // set is load-dependent, CI runs ~8× slower than local, and bounding whichever test happened to
    // lose the race chases the symptom. A hang is still unbounded and still fails.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Measured here is the logic that can be wrong in a way that still looks right: which granules
      // a season selects, and the mask geometry the archive is cut against. The CLIs are argv +
      // stderr shells over that logic, and `corpus.ts` is a subprocess boundary (`convex run`).
      exclude: [
        'src/**/*.test.ts',
        'src/bakeMasks.ts',
        'src/selectGranules.ts',
        'src/ingestWindowCli.ts',
        'src/buildIndex.ts',
        'src/corpus.ts',
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
