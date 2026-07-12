import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { themes } from '@skating/design'
import { describe, expect, it } from 'vitest'

/**
 * Token-parity guard (D7/D34): the Tailwind CSS variables in `app.css` are hand-mirrored
 * from `@skating/design` (Tailwind v4 wants static CSS, so we can't import the TS tokens
 * directly the way the mobile Tamagui bridge does). This test fails if any theme color in
 * the design package is missing from the CSS — the alarm that keeps the two surfaces'
 * palettes from drifting, mirroring the design package's own `themes.test.ts` ethos.
 */
// Read from the package root (the test runner's cwd) rather than import.meta.url — the
// Start Vite plugin rewrites import.meta.url in test transforms to a non-file scheme.
const css = readFileSync(join(process.cwd(), 'src/styles/app.css'), 'utf-8').toLowerCase()

describe('Tailwind theme tokens mirror @skating/design', () => {
  for (const [name, theme] of Object.entries(themes)) {
    it(`includes every color value from the ${name} theme`, () => {
      for (const value of Object.values(theme)) {
        expect(css).toContain(value.toLowerCase())
      }
    })
  }
})
