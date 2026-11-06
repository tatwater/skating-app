import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

/**
 * The kit's bench (research doc §2): Storybook 10 on Vite, local only. Stories live beside their
 * components (`*.stories.tsx`); the docs pages are MDX under `src/components/kit`. The Vitest addon
 * runs every story as a browser test (`pnpm --filter @skating/web test`).
 */
const config: StorybookConfig = {
  framework: {
    name: '@storybook/react-vite',
    options: {
      builder: {
        // Not the app's vite.config.ts (TanStack Start + Nitro) — see `.storybook/vite.config.ts`.
        viteConfigPath: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      },
    },
  },
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-vitest', 'storybook-addon-pseudo-states'],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
};

export default config;
