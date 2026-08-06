import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The transform is the tested logic. `cli.ts`/`load.ts` are subprocess + file-I/O glue
      // (untestable shells; all real work is in the covered transform + `@skating/core`), and
      // `types.ts` is type-only. Mirrors the water ETL's coverage config (Phase 1).
      //
      // ⚠ `buildRegion.ts` is excluded on the same grounds — `ogr2ogr` plus file writes — but it is
      // the largest file in the package and it does carry decisions: `nearRegion`, `needsClipping`,
      // `maskFeature` and the union/subtract pair all choose what the region *is*. `merge.ts` in the
      // water ETL was excluded for exactly this reason, grew a merge rule, and ended up deciding
      // 27,074 rows untested (see `mergeRules.ts`, extracted 2026-08-05). If this file keeps
      // growing, split its geometry rules out and drop the exclusion rather than widening it.
      exclude: [
        'src/**/*.test.ts',
        'src/buildRegion.ts',
        'src/cli.ts',
        'src/fetchStates.ts',
        'src/load.ts',
        'src/tiger.ts',
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
