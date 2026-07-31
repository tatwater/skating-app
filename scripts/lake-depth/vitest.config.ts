import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The transform is the tested logic. `cli.ts`/`load.ts` are subprocess + file-I/O glue
      // (untestable shells; all real work is in the covered transform + `@skating/core`), and
      // `types.ts` is type-only. Mirrors the water ETL and admin-areas configs.
      exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/load.ts', 'src/types.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
