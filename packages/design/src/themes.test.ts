import { describe, expect, it } from 'vitest'
import { contrastRatio, WCAG_AA_LARGE, WCAG_AA_NORMAL } from './contrast'
import { dark, light, type SemanticColorToken, THEME_NAMES, themes } from './themes'

const HEX = /^#[0-9a-fA-F]{6}$/

/** Text/icon pairs held to AA normal (4.5:1). */
const TEXT_PAIRS: Array<[SemanticColorToken, SemanticColorToken]> = [
  ['foreground', 'background'],
  ['foreground', 'surface'],
  ['foreground', 'surfaceMuted'],
  ['foregroundMuted', 'background'],
  ['foregroundMuted', 'surface'],
  ['foregroundMuted', 'surfaceMuted'],
  ['primaryForeground', 'primary'],
  ['dangerForeground', 'danger'],
  ['warningForeground', 'warning'],
  ['successForeground', 'success'],
]

/**
 * Non-text UI pairs held to the graphical-object minimum (3:1, WCAG 1.4.11).
 * `borderStrong` is the load-bearing boundary token, so it must stay legible on
 * whatever it sits on (page or card); `border` is decorative and exempt.
 */
const NON_TEXT_PAIRS: Array<[SemanticColorToken, SemanticColorToken]> = [
  ['ring', 'background'],
  ['borderStrong', 'background'],
  ['borderStrong', 'surface'],
  ['borderStrong', 'surfaceMuted'],
]

describe('theme structure', () => {
  it('exposes exactly the named themes', () => {
    expect(Object.keys(themes).sort()).toEqual([...THEME_NAMES].sort())
  })

  it('keeps light and dark in perfect key parity', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
  })

  it('resolves every token to a 6-digit hex string', () => {
    for (const theme of Object.values(themes)) {
      for (const [token, value] of Object.entries(theme)) {
        expect(value, token).toMatch(HEX)
      }
    }
  })
})

describe.each(THEME_NAMES)('%s theme contrast (D34)', (name) => {
  const theme = themes[name]

  it.each(TEXT_PAIRS)('%s on %s meets WCAG AA for normal text', (fg, bg) => {
    expect(contrastRatio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(WCAG_AA_NORMAL)
  })

  it.each(NON_TEXT_PAIRS)('%s on %s meets WCAG non-text contrast', (fg, bg) => {
    expect(contrastRatio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(WCAG_AA_LARGE)
  })
})
