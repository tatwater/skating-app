import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The tested logic is the part that can be wrong in a way that still looks right: paging
      // arithmetic, manifest drift severity, and the source registry's own claims about each state.
      // `cache.ts`, `lakeSources.ts` and `joinRunner.ts` are file/network/subprocess I/O, the CLIs
      // are argv + stderr shells, and `types.ts` is type-only. Each of those three I/O modules was
      // split OUT of a tested one — `manifest.ts`, `lakes.ts`, `joinQuery.ts` — so that the logic
      // which can be wrong in a way that still looks right stays measured. Mirrors the water-ETL,
      // admin-areas and lake-depth configs.
      //
      // Excluded from the *numbers* is not the same as untested: `cache.test.ts` covers
      // `decodeRawPage`, which is pure, and which is the decision the whole snapshot-resume path
      // turns on. Where a piece of an I/O module is decidable without a filesystem, test it anyway.
      exclude: [
        'src/**/*.test.ts',
        'src/cache.ts',
        'src/lakeSources.ts',
        'src/joinRunner.ts',
        'src/contour.ts',
        'src/build.ts',
        'src/fetch.ts',
        'src/probe.ts',
        'src/verify.ts',
        'src/provenanceCli.ts',
        'src/sweep.ts',
        'src/samples.ts',
        'src/join.ts',
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
