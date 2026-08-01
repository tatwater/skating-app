import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The tested logic is the part that can be wrong in a way that still looks right: paging
      // arithmetic, manifest drift severity, and the source registry's own claims about each state.
      // `cache.ts` is file/network I/O, the three CLIs are argv + stderr shells, and `types.ts` is
      // type-only. Mirrors the water-ETL, admin-areas and lake-depth configs.
      exclude: [
        'src/**/*.test.ts',
        'src/cache.ts',
        'src/fetch.ts',
        'src/probe.ts',
        'src/verify.ts',
        'src/provenanceCli.ts',
        'src/sweep.ts',
        'src/samples.ts',
        'src/types.ts',
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
