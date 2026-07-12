import type { Theme as DesignTheme } from '@skating/design'
import { themes as designThemes, radius, space, zIndex } from '@skating/design'
import { defaultConfig } from '@tamagui/config/v5'
import { createTamagui } from 'tamagui'

/**
 * Tamagui config for the mobile app. Per D7 we share design *tokens*, not UI:
 * `@skating/design` owns the values; here we project them into Tamagui's shape.
 *
 * Barebones Phase 0 scope: we override the color **themes** (the visible brand —
 * the icy/FUI palette, both high-contrast light + dark, D34) and layer our named
 * space/radius/z-index tokens on top of the v5 defaults. The v5 numeric token
 * scales are kept so Tamagui's built-in components keep working; projecting our
 * full spacing/typography scale is a follow-up for the styling deep-dive PR.
 */

/** Map our flat semantic roles onto the Tamagui theme keys components expect. */
function toTamaguiTheme(t: DesignTheme) {
  return {
    // Every one of our semantic roles first, so `$primary`, `$danger`, etc. resolve
    // (this supplies `background`)…
    ...t,
    // …then the Tamagui-standard keys built-in components read.
    backgroundHover: t.surfaceMuted,
    backgroundPress: t.surfaceMuted,
    backgroundFocus: t.surfaceMuted,
    backgroundStrong: t.surface,
    color: t.foreground,
    colorHover: t.foreground,
    colorPress: t.foreground,
    colorFocus: t.foreground,
    placeholderColor: t.foregroundMuted,
    borderColor: t.border,
    borderColorHover: t.borderStrong,
    borderColorFocus: t.ring,
    outlineColor: t.ring,
  }
}

export const config = createTamagui({
  ...defaultConfig,
  // The v5 base enforces shorthand-only style props; relax that so screens can use
  // conventional long-form names (padding, alignItems, backgroundColor, …).
  settings: {
    ...defaultConfig.settings,
    onlyAllowShorthands: false,
  },
  themes: {
    light: toTamaguiTheme(designThemes.light),
    dark: toTamaguiTheme(designThemes.dark),
  },
  tokens: {
    ...defaultConfig.tokens,
    space: { ...defaultConfig.tokens.space, ...space },
    size: { ...defaultConfig.tokens.size, ...space },
    radius: { ...defaultConfig.tokens.radius, ...radius },
    zIndex: { ...defaultConfig.tokens.zIndex, ...zIndex },
  },
})

export type AppTamaguiConfig = typeof config

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppTamaguiConfig {}
}

export default config
