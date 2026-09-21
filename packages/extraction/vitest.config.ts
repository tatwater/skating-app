import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The two network clients are exercised by the eval harness against the real APIs, not here.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/claude/client.ts', 'src/jev/client.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
