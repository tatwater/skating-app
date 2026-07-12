import { defineConfig } from 'vitest/config'

/**
 * Web tests (D40): jsdom + Testing Library for component/logic, plus a token-parity test
 * that fails if the Tailwind CSS variables drift from `@skating/design` (the web analog of
 * the mobile Tamagui bridge). Coverage is scoped to the pure/bridge surface for now and
 * widened as real screens land. We don't load the app's Vite plugins here — the token
 * parity test just reads the CSS file, and component tests render plain React.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/lib/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  },
})
