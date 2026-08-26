import type { Theme as DesignTheme } from '@skating/design';
import { themes as designThemes, radius, space, zIndex } from '@skating/design';
import { defaultConfig } from '@tamagui/config/v5';
import { createTamagui } from 'tamagui';

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
  };
}

export const config = createTamagui({
  ...defaultConfig,
  settings: {
    ...defaultConfig.settings,
    // The v5 base enforces shorthand-only style props; relax that so screens can use
    // conventional long-form names (padding, alignItems, backgroundColor, …).
    onlyAllowShorthands: false,
    /**
     * Off, though the v5 base turns it on (D34 amendment). It's an **iOS** optimization: on a
     * light↔dark change Tamagui hands styled components a `DynamicColorIOS({light, dark})` value
     * and then *skips their re-render*, letting the platform pick the shade. That's only correct
     * while the app's theme is the device's theme — `DynamicColorIOS` resolves against the OS
     * appearance, which since D34 the user can override. `Appearance.setColorScheme` in
     * `ThemeProvider` keeps the two in agreement, so this would usually still be right; turning it
     * off means an iOS build doesn't silently freeze half its colors if that call ever no-ops.
     *
     * Costs a re-render on a theme change, which happens when a person taps a button.
     *
     * Not the cause of the Android staleness this was found alongside — that path is gated on
     * `supportsDynamicColorIOS`, which is false off iOS. See `ThemedInputs.tsx` for that one.
     */
    fastSchemeChange: false,
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
});

export type AppTamaguiConfig = typeof config;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppTamaguiConfig {}
}

export default config;
