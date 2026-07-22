import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // convex-test runs functions in a simulated Convex backend; the edge-runtime
    // environment matches Convex's V8 isolate more closely than jsdom/node.
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
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
