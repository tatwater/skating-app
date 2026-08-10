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
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // Start realistic; ratchet upward over time (D40). Core is pure logic and
      // should stay near-total.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
