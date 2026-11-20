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
      // The loader is measured at its Convex boundary. The transform CLI is smoke-tested at
      // the process boundary. Region construction and TIGER acquisition still need fixture coverage
      // for their GDAL, Turf, and network orchestration; their extracted region rules are measured.
      exclude: [
        'src/**/*.test.ts',
        'src/buildRegion.ts',
        'src/cli.ts',
        'src/fetchStates.ts',
        'src/tiger.ts',
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
