import { defineConfig } from 'vitest/config'

/**
 * Phase 0 testing is logic-only (D40): Vitest over pure helpers in `src/lib`, which
 * is where the safety-relevant bits live (the age-gate DOB parser). Component-level
 * `@testing-library/react-native` rendering under Vitest is deliberately deferred —
 * it needs extra RN transform config we'll add as real screens arrive. Most shared
 * logic already lives in `packages/*` and is covered there.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Only the tested pure-logic surface for now; widen as hooks/components land.
      include: ['src/lib/dob.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
})
