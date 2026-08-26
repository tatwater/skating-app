/**
 * The app's single source of truth for "which theme are we in" (D34 amendment).
 *
 * Before this existed, `useColorScheme()` was called independently by `Providers` (for Tamagui) and
 * by `MapView` (for the basemap flavor). Two readers of the same OS setting happened to agree, but
 * two readers of a *user preference* would not have: the map would have kept following the OS while
 * the rest of the app followed the choice. Everything that needs the theme now reads it from here.
 *
 * `preference` is what the user picked (`'system' | 'light' | 'dark'`); `resolved` is what to
 * render. While the preference is `'system'` this stays subscribed to `useColorScheme()`, so the app
 * re-themes live when the OS flips at sunset rather than only on the next cold launch.
 */

import { resolveThemeName, type ThemeName, type ThemePreference } from '@skating/design';
import { createContext, type ReactNode, use, useCallback, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { loadThemePreference, saveThemePreference } from '../lib/themePreferenceStore';

type ThemeContextValue = {
  /** What the user chose. `'system'` until they choose otherwise. */
  preference: ThemePreference;
  /** What to actually render — the preference with `'system'` resolved against the OS. */
  resolved: ThemeName;
  /** Convenience for the many `x === 'dark' ? a : b` call sites. */
  isDark: boolean;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemePreferenceProvider({ children }: { children: ReactNode }) {
  // Seeded from sqlite *during* the first render, not in an effect — see the note in
  // `themePreferenceStore`. The lazy initializer keeps the read to one per mount.
  const [preference, setPreferenceState] = useState<ThemePreference>(loadThemePreference);
  const systemScheme = useColorScheme();

  const setPreference = useCallback((next: ThemePreference) => {
    // State first so the UI turns over immediately; the write is best-effort and must never be
    // what a user waits on to see the theme change.
    setPreferenceState(next);
    saveThemePreference(next);
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const resolved = resolveThemeName(preference, systemScheme);
    return { preference, resolved, isDark: resolved === 'dark', setPreference };
  }, [preference, systemScheme, setPreference]);

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

/**
 * Read the resolved theme + the preference.
 *
 * Throws outside the provider rather than falling back to light. A silent fallback would render a
 * light-themed subtree inside a dark app and look like a styling bug anywhere but here.
 */
export function useThemePreference(): ThemeContextValue {
  const value = use(ThemeContext);
  if (value === null) {
    throw new Error('useThemePreference must be used within <ThemePreferenceProvider>');
  }
  return value;
}
