/**
 * Pure theme-preference logic (D34 amendment) — the mobile half of "system by default, an explicit
 * choice wins". The union, the guard, and the resolution rule itself live in `@skating/design` so
 * web and mobile cannot disagree about what `'system'` means; this module is only the storage
 * contract around them, kept separate from the `expo-sqlite` glue in `themePreferenceStore.ts` so it
 * stays testable without a native database (the `feedFilters` / `feedFiltersStore` split).
 */

import { isThemePreference, type ThemePreference } from '@skating/design';

/**
 * The row key inside the shared `prefs` table. Deliberately the string `next-themes` writes to
 * `localStorage` on web: the two stores are physically unrelated, but a developer grepping for where
 * the theme is kept should land on both, and a future preference sync has one name to carry.
 */
export const THEME_PREFERENCE_KEY = 'theme';

/** The D34 default — follow the OS until the user says otherwise. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/**
 * Parse a stored value into a preference.
 *
 * Anything unrecognized — a missing row, a value written by an older build, a half-finished write —
 * degrades to `'system'` rather than throwing. A theme is cosmetic; there is no failure here worth
 * blocking a launch over, and falling back to "follow the OS" is the least surprising wrong answer.
 */
export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
}

/** Human-facing labels for the picker, in the order they're rendered. */
export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
