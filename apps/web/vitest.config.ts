import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';
import { alias, storybookPlugins } from './.storybook/vite.config';
import { parkPointer } from './src/test/pointer.commands';

/**
 * Web tests (D40), three projects under one `vitest run`:
 *
 * - **unit** — jsdom + Testing Library for components (every `*.test.tsx`) and the few logic files
 *   that need the DOM (`src/test/domTests.json`). We don't load the app's Vite plugins here —
 *   component tests render plain React.
 * - **unit-node** — every other `*.test.ts` (logic, a token-parity test that reads the CSS file)
 *   under Node: no jsdom to build per file. `packages/guards/src/webTestEnvironments.test.ts` keeps
 *   the split honest. `--project 'unit*'` runs both.
 * - **storybook** — every story under `src/` runs as a test in headless Chromium (the Storybook
 *   Vitest addon): it must render, and its `play` function's assertions must pass. The kit's
 *   measurement stories (D234's junctions) live here, because only a real layout engine measures.
 *   Needs Playwright's Chromium: `pnpm --filter @skating/web exec playwright install chromium`.
 */
/**
 * The logic tests that need the DOM (`src/test/domTests.json`), read as data — the split's guard
 * (`packages/guards/src/webTestEnvironments.test.ts`) reads the same file. A list, never an import:
 * Vite's native config loader warns on an extensionless import, and a JSON import needs a flag.
 */
const DOM_TS_TESTS: string[] = JSON.parse(
  readFileSync(new URL('./src/test/domTests.json', import.meta.url), 'utf8'),
);

/**
 * Vitest's default test files (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`), split between the two unit
 * projects so together they match exactly what the default matched — a `.spec` file, or a test
 * outside `src/`, still runs: JSX ones under jsdom, the rest under Node unless listed as needing it.
 */
const JSX_TESTS = '**/*.{test,spec}.{tsx,jsx}';
const LOGIC_TESTS = '**/*.{test,spec}.{ts,mts,cts,js,mjs,cjs}';

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
      include: [
        'src/lib/**/*.ts',
        'src/components/kit/**/*.{ts,tsx}',
        'src/components/skater/**/*.{ts,tsx}',
        // The console (B01), mode by mode; the old admin pages it replaces stay out until they go.
        'src/components/admin/{shell,overview,metrics,season,bodies,body,reads,people,inbox}/**/*.{ts,tsx}',
      ],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.stories.tsx'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: [JSX_TESTS, ...DOM_TS_TESTS],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-node',
          environment: 'node',
          include: [LOGIC_TESTS],
          exclude: [...configDefaults.exclude, ...DOM_TS_TESTS],
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
            '@base-ui/react/autocomplete',
            '@base-ui/react/avatar',
            '@base-ui/react/button',
            '@base-ui/react/checkbox',
            '@base-ui/react/checkbox-group',
            '@base-ui/react/collapsible',
            '@base-ui/react/combobox',
            '@base-ui/react/dialog',
            '@base-ui/react/drawer',
            '@base-ui/react/field',
            '@base-ui/react/input',
            '@base-ui/react/menu',
            '@base-ui/react/merge-props',
            '@base-ui/react/meter',
            '@base-ui/react/number-field',
            '@base-ui/react/otp-field',
            '@base-ui/react/popover',
            '@base-ui/react/radio',
            '@base-ui/react/radio-group',
            '@base-ui/react/scroll-area',
            '@base-ui/react/select',
            '@base-ui/react/separator',
            '@base-ui/react/slider',
            '@base-ui/react/switch',
            '@base-ui/react/tabs',
            '@base-ui/react/toast',
            '@base-ui/react/toggle',
            '@base-ui/react/toggle-group',
            '@base-ui/react/toolbar',
            '@base-ui/react/tooltip',
            '@base-ui/react/use-render',
            '@fortawesome/react-fontawesome',
            '@fortawesome/sharp-light-svg-icons',
            '@fortawesome/sharp-regular-svg-icons',
            '@fortawesome/sharp-solid-svg-icons',
            '@tanstack/react-hotkeys',
            '@tanstack/react-table',
            '@tanstack/react-virtual',
            // Reached only through the report sheet's stories, and only by dynamic import (the photo
            // pipeline's lazy codecs, the instrument map's lazy canvas): a deps cache built before
            // the sheet existed discovers them mid-run.
            'browser-image-compression',
            'exifr',
            'heic2any',
            'pmtiles',
            'react-resizable-panels',
            'recharts',
            // The hazard flow's drawing tools, also behind a lazy import: a cold cache optimized
            // them mid-run and the reload broke nine story files.
            'terra-draw',
            'terra-draw-maplibre-gl-adapter',
            'zustand',
          ],
        },
        test: {
          name: 'storybook',
          // Park the real pointer before each story (`src/test/pointer.commands.ts` says why).
          setupFiles: ['./src/test/storybook.setup.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            commands: { parkPointer },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
