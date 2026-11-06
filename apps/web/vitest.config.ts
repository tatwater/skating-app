import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { alias, storybookPlugins } from './.storybook/vite.config';

/**
 * Web tests (D40), two projects under one `vitest run`:
 *
 * - **unit** — jsdom + Testing Library for component/logic, plus a token-parity test that fails if
 *   the Tailwind CSS variables drift from `@skating/design`. We don't load the app's Vite plugins
 *   here — the token parity test just reads the CSS file, and component tests render plain React.
 * - **storybook** — every story under `src/` runs as a test in headless Chromium (the Storybook
 *   Vitest addon): it must render, and its `play` function's assertions must pass. The kit's
 *   measurement stories (D234's junctions) live here, because only a real layout engine measures.
 *   Needs Playwright's Chromium: `pnpm --filter @skating/web exec playwright install chromium`.
 */
export default defineConfig({
  // Mirror the app's `@` → `src` alias (vite.config.ts) so shadcn/ui's `@/…` imports resolve
  // under Vitest too, letting component tests render the ui primitives.
  resolve: { alias },
  test: {
    // 20s, not vitest's 5s default — see the note in `packages/convex/vitest.config.ts`. The
    // flaking set is load-dependent: turbo runs 11 packages at once and CI is ~8x slower than
    // local, so whichever test loses the race times out while being fast in isolation. A hang is
    // unbounded and still fails; this only stops green code reporting red.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/lib/**/*.ts', 'src/components/kit/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.stories.tsx'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        plugins: [
          ...storybookPlugins(),
          storybookTest({ configDir: fileURLToPath(new URL('./.storybook', import.meta.url)) }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
