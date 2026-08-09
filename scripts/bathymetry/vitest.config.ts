import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * 20s, not vitest's 5s default.
     *
     * **The flaking set is load-dependent, which is why per-test bounds could not fix it.** Three
     * different tests timed out across three consecutive full-suite runs — a 60-bay convex-test
     * import, a 140,000-point density probe, a union-find chain sized to the call stack — and none
     * of them is slow in isolation (0.3-0.5s). They lose the race only when turbo runs 11 packages
     * at once on a machine already doing something else, and CI is measured at ~8x slower than
     * local. Bounding whichever test happened to lose is chasing the symptom.
     *
     * This does not hide a hang: a hang is unbounded and still fails, 15 seconds later. What it
     * stops is a green suite reporting red for reasons that have nothing to do with the code.
     */
    testTimeout: 20_000,
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
        // Both were **included and at 0%**, which is worse than excluded: the config's stated rule is
        // that a CLI shell is exempt, so an unexempted one silently spent everybody else's coverage
        // budget and read as though somebody had decided it was worth measuring. Each is argv,
        // `readAllLakes()`, a file and a run row; the decisions are in `lakes.ts` and `lakeDepths.ts`,
        // both at 100%.
        'src/exportSoundings.ts',
        'src/exportDepths.ts',
        'src/snapshotMidas.ts', // paged query + file I/O; the rules are in midasCrosswalk.ts
        'src/sweep.ts',
        'src/samples.ts',
        'src/join.ts',
        'src/types.ts',
        'src/coverage.ts',
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
