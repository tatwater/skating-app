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
        // Pre-bundled up front: a Base UI entry the optimizer discovers mid-run reloads the page
        // under test and fails the whole file ("Vite unexpectedly reloaded a test") — on a cold
        // cache, that is every CI run. Add a kit primitive's entry here when the kit adopts it.
        optimizeDeps: {
          include: [
            '@base-ui/react/alert-dialog',
            '@base-ui/react/button',
            '@base-ui/react/checkbox',
            '@base-ui/react/checkbox-group',
            '@base-ui/react/dialog',
            '@base-ui/react/field',
            '@base-ui/react/input',
            '@base-ui/react/merge-props',
            '@base-ui/react/popover',
            '@base-ui/react/radio',
            '@base-ui/react/radio-group',
            '@base-ui/react/switch',
            '@base-ui/react/tabs',
            '@base-ui/react/tooltip',
            '@base-ui/react/use-render',
            '@fortawesome/react-fontawesome',
            '@fortawesome/sharp-light-svg-icons',
            '@fortawesome/sharp-regular-svg-icons',
            '@fortawesome/sharp-solid-svg-icons',
          ],
        },
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
