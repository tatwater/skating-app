/**
 * Device-local theme-preference storage (D34 amendment) — the `expo-sqlite` glue behind the pure
 * logic in `themePreference.ts`, and a second tenant of the `skating-prefs.db` key-value table that
 * `prefsDb` owns (`feedFiltersStore` is the first).
 *
 * **The synchronous read is the whole point.** A theme fetched asynchronously means the first frame
 * paints with the default and then snaps to the user's choice — the flash-of-wrong-theme that web
 * pays a blocking inline script to avoid. `getFirstSync` lets the provider seed `useState` during
 * its first render instead, so a dark-mode user never sees a white flash on cold launch. Everything
 * here is best-effort in the `bodyCache` tradition: a storage failure costs the preference, never
 * the launch.
 */

import type { ThemePreference } from '@skating/design';
import { readPref, writePref } from './prefsDb';
import {
  DEFAULT_THEME_PREFERENCE,
  parseThemePreference,
  THEME_PREFERENCE_KEY,
} from './themePreference';

/** Read the stored preference. `'system'` on a missing row or any sqlite error. */
export function loadThemePreference(): ThemePreference {
  try {
    return parseThemePreference(readPref(THEME_PREFERENCE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/**
 * Persist the preference. Best-effort — a write failure leaves this session's in-memory choice
 * intact, so the toggle still visibly works and only the next launch forgets.
 *
 * `'system'` is written as a row rather than deleted. An explicit "follow the OS" and a never-opened
 * settings page are the same rendered theme but not the same intent, and keeping the row means a
 * later default change can't silently reclassify someone who deliberately chose to follow the OS.
 */
export function saveThemePreference(preference: ThemePreference): void {
  try {
    writePref(THEME_PREFERENCE_KEY, preference);
  } catch {
    // Best-effort — the in-memory preference still drives this session.
  }
}
