import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Storybook's own Vite config. The app's `vite.config.ts` carries TanStack Start, Nitro and Sentry,
 * which want a server entry and a route tree — none of which a component bench has. Kit components
 * take props, not Convex or routes, so React, Tailwind and the `@` alias are all a story needs.
 * Shared with the Vitest `storybook` project (`vitest.config.ts`), so stories build the same way
 * in the browser and under test.
 */
export const storybookPlugins = () => [tailwindcss(), viteReact()];
export const alias = { '@': fileURLToPath(new URL('../src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  plugins: storybookPlugins(),
});
