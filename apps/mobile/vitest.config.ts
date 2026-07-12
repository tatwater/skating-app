import { defineConfig } from 'vitest/config'

/**
 * The mobile app carries no unit tests of its own: all pure, safety-relevant logic lives in
 * `packages/*` (the DOB parser and the auth-route resolver were lifted to `@skating/core`,
 * D7/D40) and is covered there. Screens are RN components — `@testing-library/react-native`
 * rendering under Vitest is deferred until real screens land (needs extra RN transform
 * config). So we keep the runner wired (every surface stays test-ready) but pass when there
 * are no specs, rather than failing CI on an intentionally empty suite.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
})
