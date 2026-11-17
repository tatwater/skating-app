import type { ThemePreference } from '@skating/design';
import { useCallback } from 'react';

import { useAnalytics } from '@/lib/analytics';

import { useTheme } from './theme-provider';

/**
 * The theme choice as every picker uses it — the skater app's avatar menu and phone sheet, and the
 * console's own menu: `useTheme()`'s preference, and a setter that writes the cookie (D241) and
 * records `theme_changed` — only for a real change, never for re-pressing the chosen option. One
 * copy for both surfaces, so the console and the app remember the same preference the same way.
 */
export function useThemeChoice(): {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
} {
  const { theme, setTheme } = useTheme();
  const { capture } = useAnalytics();
  const onThemeChange = useCallback(
    (next: ThemePreference) => {
      if (next === theme) return;
      setTheme(next);
      capture('theme_changed', { mode: next });
    },
    [theme, setTheme, capture],
  );
  return { theme, onThemeChange };
}
