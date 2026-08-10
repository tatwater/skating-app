import { defineConfig } from 'vitest/config';

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
    // 20s, not vitest's 5s default — see the note in `packages/convex/vitest.config.ts`. The
    // flaking set is load-dependent: turbo runs 11 packages at once and CI is ~8x slower than
    // local, so whichever test loses the race times out while being fast in isolation. A hang is
    // unbounded and still fails; this only stops green code reporting red.
    testTimeout: 20_000,
    passWithNoTests: true,
  },
});
