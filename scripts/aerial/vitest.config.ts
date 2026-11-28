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
      // Measured is every decision: the key layout, the flags, the shard contract, the tiles'
      // reconcile, the assembler, verify, and every stage's preflight and body (`src/stage/`, run
      // against the recording world). Excluded by name are the stage CLIs — argv + stderr shells over
      // that logic, one per stage, all under `src/cli/` — the real world they hand it
      // (`src/cli/world.ts`: rclone, `spawn.sh`, `convex run`, signals), and the assembler's one
      // process boundary, the `rclone rcat` stream (`src/assemble/upload.ts`); nothing else.
      exclude: [
        'src/**/*.test.ts',
        // The tests' recording world: test infrastructure, measured by the tests that use it.
        'src/stageHarness.ts',
        'src/cli/select.ts',
        'src/cli/foliage.ts',
        'src/cli/tiles.ts',
        'src/cli/assemble.ts',
        'src/cli/verify.ts',
        'src/cli/cleanup.ts',
        'src/cli/world.ts',
        'src/assemble/upload.ts',
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
