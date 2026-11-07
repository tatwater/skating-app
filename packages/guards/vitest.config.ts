import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * 20s, not vitest's 5s default — the repo-wide reason is in `packages/core/vitest.config.ts`:
     * turbo runs every package at once and CI is ~8x slower than local, so whichever test loses
     * the race times out while being fast in isolation. These guards are under a second together,
     * but two of them shell out to `git ls-files`, one also to `pnpm -r list`, and one walks every
     * markdown file under `plans/`, so they are exactly the shape that loses a loaded race.
     */
    testTimeout: 20_000,
    /**
     * No coverage, and no thresholds. These tests assert over documents and the repo's own layout;
     * the only `src/**` they import is `@skating/core`'s vocabulary constants, which core's own
     * suite already covers. A coverage report here would measure another package.
     */
    coverage: { enabled: false },
  },
});
