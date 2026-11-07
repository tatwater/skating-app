import { resolveThemeName, type ThemeName, type ThemePreference } from '@skating/design';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  applyThemePreference,
  readThemePreferenceFromCookie,
  THEME_INIT_SCRIPT,
  themeCookieString,
} from '../lib/theme';

/**
 * Two first-class themes (D34, amended by D241): high-contrast bright-outdoor (light) + evening
 * (dark). The preference lives in the theme **cookie** (`lib/theme.ts`), not localStorage — B03
 * replaced next-themes with this provider so both surfaces read one store and the first paint is
 * settled by the inline init script below rather than by a client library's hydration pass.
 *
 * The API deliberately matches the next-themes shape the app already consumed —
 * `{ theme, setTheme, resolvedTheme }` — so the swap was an import change, not a rewrite:
 * `resolvedTheme` is `undefined` until the client knows the OS preference, and every consumer
 * already treats that as "fall back to light" (the D34 default).
 */

interface ThemeContextValue {
  /** The stored preference. */
  theme: ThemePreference;
  setTheme: (preference: ThemePreference) => void;
  /** What's actually on screen — `undefined` on the server and until the first client effect. */
  resolvedTheme: ThemeName | undefined;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  setTheme: () => {},
  resolvedTheme: undefined,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The cookie is readable synchronously on the client, so the first client render already knows
  // the preference; the server renders `system` and the init script has corrected the DOM before
  // paint. (`suppressHydrationWarning` on <html> absorbs the attribute difference, as it did for
  // next-themes.)
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    typeof document === 'undefined' ? 'system' : readThemePreferenceFromCookie(document.cookie),
  );
  const [systemScheme, setSystemScheme] = useState<ThemeName | undefined>(undefined);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const read = (matches: boolean): ThemeName => (matches ? 'dark' : 'light');
    setSystemScheme(read(query.matches));
    const onChange = (event: MediaQueryListEvent) => setSystemScheme(read(event.matches));
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme =
    systemScheme === undefined ? undefined : resolveThemeName(theme, systemScheme);

  // Re-apply on every change *after* first paint (the init script owns the paint itself). This is
  // what moves `data-mode` and `.dark` when the user picks a mode or the OS flips at dusk.
  useEffect(() => {
    if (resolvedTheme === undefined) return;
    applyThemePreference(theme, resolvedTheme, document.documentElement);
  }, [theme, resolvedTheme]);

  const setTheme = useCallback((preference: ThemePreference) => {
    setThemeState(preference);
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from Firefox; the theme cookie must be readable by the pre-paint script
    document.cookie = themeCookieString(preference);
  }, []);

  const value = useMemo(
    () => ({ theme, setTheme, resolvedTheme }),
    [theme, setTheme, resolvedTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {/* Before-paint theme application (D241). Rendered as the provider's first child — ahead of
          all content in document order — so the browser executes it before painting anything the
          app renders. The script is a constant with no interpolation; see `lib/theme.ts`. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constant script, no interpolation */}
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} suppressHydrationWarning />
      {children}
    </ThemeContext.Provider>
  );
}
