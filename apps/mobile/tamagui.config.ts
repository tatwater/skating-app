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

/**
 * `defaultConfig.tokens` back into the shape `createTamagui` expects as *input*.
 *
 * `defaultConfig` is an already-built config, so its token keys carry the `$` and its values are
 * `Variable` objects. `createTamagui` prefixes every key it's given (`const prefixedKey = '$' + key`),
 * so spreading them straight back in produced `$$4`, `$$true`, … — keys nothing ever looks up. The
 * whole Tamagui base scale was silently absent, and only our own bare-keyed scales below survived as
 * real tokens. Stripping the `$` and unwrapping the `Variable` hands them back as plain input.
 */
/**
 * The key mapping, in the type system too. A plain `Record<string, …>` return would erase the
 * literal keys and leave `borderRadius="$4"` a type error even though the value is there at runtime.
 */
type Unprefixed<T> = {
  [K in keyof T as K extends `$${infer Rest}` ? Rest : K]: number | string;
};

function baseScale<T extends Record<string, unknown>>(created: T): Unprefixed<T> {
  return Object.fromEntries(
    Object.entries(created).map(([key, value]) => [
      key.startsWith('$') ? key.slice(1) : key,
      value !== null && typeof value === 'object' && 'val' in value
        ? (value as { val: number | string }).val
        : (value as number | string),
    ]),
  ) as Unprefixed<T>;
}

const baseTokens = {
  space: baseScale(defaultConfig.tokens.space),
  size: baseScale(defaultConfig.tokens.size),
  radius: baseScale(defaultConfig.tokens.radius),
  zIndex: baseScale(defaultConfig.tokens.zIndex),
};

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
    ...baseTokens,
    // Ours over Tamagui's, on the same numeric keys — a 4px rhythm against their ~4.5px one, so the
    // values barely move (their `$4` is 18 to our 16) and the scale becomes ours to reason about.
    space: { ...baseTokens.space, ...space },
    /**
     * **Tamagui's, untouched.** This used to be `{ ...defaultConfig.tokens.size, ...space }` — the
     * *space* scale fed into the *size* slot, which is a different quantity: space is padding and
     * gaps (4, 8, 12…), size is control heights (20, 28, 36, 44…). It made `size="$2"` an 8dp button
     * and `size="$3"` a 12dp one, and worse, it dropped `$true` entirely — our space scale has no
     * `true` key. `<Button>` defaults to `size: '$true'`, so every default-size button in the app
     * resolved its height and padding from a token that did not exist and collapsed onto its own
     * label. That is what "you have to tap the text, not the button" was.
     */
    size: baseTokens.size,
    // Named keys (`sm`, `full`, `overlay`) that don't collide with Tamagui's numeric ones, so these
    // two are genuinely additive rather than overriding.
    radius: { ...baseTokens.radius, ...radius },
    zIndex: { ...baseTokens.zIndex, ...zIndex },
  },
});

export type AppTamaguiConfig = typeof config;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppTamaguiConfig {}
}

export default config;
