import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // The transform is the tested logic. `cli.ts`/`load.ts` are subprocess + file-I/O
      // glue (untestable shells; all real work is in the covered transform + `@skating/core`),
      // and `types.ts` is type-only. Excluding the glue is not coverage-gaming — the gate
      // still bites on every line of transform logic (settled note, phase-1 plan).
      exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/load.ts', 'src/types.ts'],
      // Matches @skating/core + @skating/convex; ratchet upward over time (D40).
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
})
