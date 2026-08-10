import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 20s, not vitest's 5s default — see the note in `packages/convex/vitest.config.ts`. The
    // flaking set is load-dependent: turbo runs the packages at once and CI is ~8x slower than
    // local, so whichever test loses the race times out while being fast in isolation. A hang is
    // unbounded and still fails; this only stops green code reporting red.
    //
    // **This package is the 12th config and there is still no shared base to put this in**, so it
    // had to be added by hand — which is exactly how it was missed: the file was copied from
    // `scripts/lake-depth` before that fix landed on main.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The transform is the tested logic. `cli.ts`/`load.ts` are subprocess + file-I/O glue
      // (untestable shells; all real work is in the covered transform + `@skating/core`), and
      // `types.ts` is type-only. Mirrors the water ETL and admin-areas configs.
      exclude: [
        'src/archiveCli.ts',
        'src/**/*.test.ts',
        'src/cli.ts',
        'src/corroborateAlsc.ts', // read-only census joining the ALSC archive to the merge artifacts
        'src/load.ts',
        'src/loadElevation.ts', // reads the archive + writes; the rules are in elevationArchive/epqs
        'src/snapshotAlsc.ts', // serial fetch + file I/O; the parser is in alsc.ts and covered
        'src/snapshotCslap.ts', // one query + file I/O; the parser is in cslap.ts and covered
        'src/snapshotNhBands.ts', // paged query + file I/O; the rules are in nhBands.ts and covered
        'src/snapshotElevation.ts', // argv + concurrency + file I/O; the rules are in epqs/elevationArchive
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
