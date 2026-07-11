/**
 * Semantic color themes — the roles UI actually consumes.
 *
 * Two first-class themes (D34): `light` is the **high-contrast bright-outdoor**
 * mode (readability in glare is a safety feature), `dark` is for evening
 * planning. Both are flat maps of the same keys — Tailwind (web) and Tamagui
 * (mobile) each project them into their own config (D7).
 *
 * Every text/fill pair here is held to WCAG AA by `themes.test.ts`; keep new
 * tokens in sync across both themes and re-run the contrast test before shipping.
 */

import { danger, ice, neutral, success, warning } from './colors'

/** The high-contrast, bright-outdoor theme (default). */
export const light = {
  /** App backdrop. */
  background: neutral[50],
  /** Cards, sheets, panels raised above the backdrop. */
  surface: '#ffffff',
  /** Recessed/secondary surface (inputs, subtle fills). */
  surfaceMuted: neutral[100],
  /** Primary body text / icons. */
  foreground: neutral[950],
  /** Secondary text, captions, placeholders. */
  foregroundMuted: neutral[600],
  /** Subtle, decorative dividers/outlines — NOT a control's sole boundary. */
  border: neutral[200],
  /** Load-bearing boundary — use when a border alone identifies a control (≥3:1). */
  borderStrong: neutral[500],
  /** Brand fill — primary buttons, active states, links. */
  primary: ice[700],
  /** Text/icon on top of `primary`. */
  primaryForeground: '#ffffff',
  /** Focus ring (held to WCAG non-text 3:1 against the backdrop). */
  ring: ice[600],
  /** Hazard / destructive fill. */
  danger: danger[600],
  dangerForeground: '#ffffff',
  /** Caution / aging-report fill. */
  warning: warning[500],
  warningForeground: neutral[950],
  /** Fresh / good-condition / confirmation fill. */
  success: success[700],
  successForeground: '#ffffff',
} as const

/** The dark theme — evening planning at home. */
export const dark = {
  background: neutral[950],
  surface: neutral[900],
  surfaceMuted: neutral[800],
  foreground: neutral[50],
  foregroundMuted: neutral[300],
  border: neutral[800],
  borderStrong: neutral[400],
  primary: ice[400],
  primaryForeground: neutral[950],
  ring: ice[400],
  danger: danger[600],
  dangerForeground: '#ffffff',
  warning: warning[500],
  warningForeground: neutral[950],
  success: success[700],
  successForeground: '#ffffff',
} as const

export const themes = { light, dark } as const

/** Available theme names (D34). */
export const THEME_NAMES = ['light', 'dark'] as const
export type ThemeName = (typeof THEME_NAMES)[number]

/** A semantic color role (e.g. `'primary'`, `'foregroundMuted'`). */
export type SemanticColorToken = keyof typeof light
/** A resolved theme: every semantic role → a hex string. */
export type Theme = Record<SemanticColorToken, string>
