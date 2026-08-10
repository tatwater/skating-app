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
    // convex-test runs functions in a simulated Convex backend; the edge-runtime
    // environment matches Convex's V8 isolate more closely than jsdom/node.
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    // A benign default `fetch` stub so scheduled weather actions never hit the real network in tests.
    setupFiles: ['./test.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['convex/**/*.ts'],
      // Generated code and tests aren't our logic; schema/enums/validators are pure
      // data exercised on import.
      exclude: [
        'convex/_generated/**',
        'convex/**/*.test.ts',
        'convex/**/*.d.ts',
        'convex/**/*.config.ts', // deployment config (auth.config.ts), not testable logic
      ],
      // Matches @skating/core's baseline; functions are at 100% now. Ratchet upward
      // as more functions land (D40).
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
