import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 20s, not vitest's 5s default — see the note in `packages/convex/vitest.config.ts`. The
    // flaking set is load-dependent: turbo runs 11 packages at once and CI is ~8x slower than
    // local, so whichever test loses the race times out while being fast in isolation. A hang is
    // unbounded and still fails; this only stops green code reporting red.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // Tokens are mostly data; the logic that matters (contrast math) and the
      // theme-parity/AA invariants are exercised in full. Keep parity with core.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
