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

import { danger, ice, neutral, success, warning } from './colors';

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
} as const;

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
} as const;

export const themes = { light, dark } as const;

/** Available theme names (D34). */
export const THEME_NAMES = ['light', 'dark'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/**
 * What the *user* chose, which is not the same thing as what gets rendered (D34 amendment).
 *
 * `'system'` is the default and means "keep following the OS" — it stays a live subscription, not a
 * snapshot of the OS setting at first launch. The two concrete names are an explicit override that
 * outranks the OS from then on. Resolving a preference to a `ThemeName` therefore needs the current
 * OS scheme as a second input; only `'system'` actually consumes it.
 *
 * Both surfaces speak these exact three strings: web because they're `next-themes`' own vocabulary,
 * mobile because `themePreference.ts` parses them out of the local prefs table. Keeping the union
 * here rather than in either app is what stops the two from drifting into `'auto'` vs `'system'`.
 */
export const THEME_PREFERENCES = ['system', ...THEME_NAMES] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * Narrow unknown storage/query-param input to a preference. A *guard*, not a parser — it reports
 * whether the value is one of the three and leaves the fallback to the caller, since where to fall
 * back to differs by surface (mobile's `parseThemePreference` picks `'system'`; web's toggle keeps
 * whatever `next-themes` already has).
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * The next preference in the cycle, for web's single-button control.
 *
 * Spelled out as a map rather than modular arithmetic over `THEME_PREFERENCES`: indexing that array
 * needs an unreachable `?? fallback` to satisfy `noUncheckedIndexedAccess`, and dead code in the one
 * function whose wrap-around is the entire point is the wrong trade. A test asserts this still
 * visits every preference, so it can't silently drift out of step with the array.
 */
const THEME_PREFERENCE_CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/**
 * `system → light → dark → system`.
 *
 * Lives here rather than in the button so the wrap-around is covered by a test — an off-by-one
 * would strand a user on `dark` with no way back, the exact failure the three-state control exists
 * to fix.
 */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  return THEME_PREFERENCE_CYCLE[current];
}

/**
 * Whatever the platform reports for the OS setting.
 *
 * Deliberately wider than `ThemeName | null`: React Native's `ColorSchemeName` also admits
 * `'unspecified'`, and web reads a `matchMedia` boolean. Rather than make every caller pre-narrow
 * into a shape neither platform actually produces, `resolveThemeName` accepts the raw value and
 * treats everything that isn't literally `'dark'` as light.
 */
export type SystemColorScheme = string | null | undefined;

/**
 * The preference → rendered-theme resolution both apps share.
 *
 * Only `'dark'` is load-bearing; `'light'`, `'unspecified'`, `null` (React Native before the OS
 * answers, or jsdom with no `matchMedia`) and anything unexpected all resolve to light. Treating the
 * unknowns as light rather than as "wait and see" is deliberate: light is the D34 default, and a
 * brief flash of the default beats rendering nothing at all.
 */
export function resolveThemeName(
  preference: ThemePreference,
  systemScheme: SystemColorScheme,
): ThemeName {
  if (preference !== 'system') return preference;
  return systemScheme === 'dark' ? 'dark' : 'light';
}

/** A semantic color role (e.g. `'primary'`, `'foregroundMuted'`). */
export type SemanticColorToken = keyof typeof light;
/** A resolved theme: every semantic role → a hex string. */
export type Theme = Record<SemanticColorToken, string>;
