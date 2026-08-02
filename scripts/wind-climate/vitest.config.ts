import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // `wtk.ts` is the tested logic; `load.ts` is subprocess + network glue. Mirrors the water
      // ETL, admin-areas and lake-depth configs.
      exclude: ['src/**/*.test.ts', 'src/load.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
