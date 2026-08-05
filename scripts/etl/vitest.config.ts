import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The transform is the tested logic. `cli.ts`/`load.ts`/`pruneFloor.ts` are subprocess +
      // file-I/O glue (untestable shells; all real work is in the covered transform, the rule in
      // `@skating/core`'s `meetsAreaFloor`, and `waterBodies.pruneBelowAreaFloor`'s own tests),
      // and `types.ts` is type-only. Excluding the glue is not coverage-gaming — the gate
      // still bites on every line of transform logic (settled note, phase-1 plan).
      exclude: [
        'src/**/*.test.ts',
        'src/auditArchives.ts',
        // Subprocess + file-I/O glue. Every classification decision it reports is made by
        // `@skating/core`'s `waterClass`, which is tested there against named real bodies.
        'src/classifyDryRun.ts',
        'src/cli.ts',
        'src/merge.ts',
        'src/fetchExtract.ts',
        'src/fetch3dhp.ts',
        'src/gnisArchive.ts',
        'src/fetchNhd.ts',
        'src/load.ts',
        'src/loadReconciliation.ts',
        'src/measure3dhp.ts',
        'src/loadDepths.ts',
        'src/pruneFloor.ts',
        'src/reconcileNhd.ts',
        'src/types.ts',
      ],
      // Matches @skating/core + @skating/convex; ratchet upward over time (D40).
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
