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
      exclude: [
        'src/archiveCli.ts',
        'src/**/*.test.ts',
        'src/cli.ts',
        'src/corroborateAlsc.ts', // read-only census joining the ALSC archive to the merge artifacts
        'src/load.ts',
        'src/loadElevation.ts',
        'src/snapshotAlsc.ts', // serial fetch + file I/O; the parser is in alsc.ts and covered
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
