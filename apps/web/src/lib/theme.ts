import { isThemePreference, type ThemeName, type ThemePreference } from '@skating/design';

/**
 * The theme cookie (D241) — one stored preference, two consumers.
 *
 * B03 replaces next-themes' localStorage with a cookie so the preference is readable anywhere
 * (including, later, by the server) and shared by both surfaces (§1.0 of the phase doc): the
 * skater shell sets `data-surface="skater"`, the console keeps its own, and *this* module owns
 * only the mode. The vocabulary — `'system' | 'light' | 'dark'` and its resolution — is
 * `@skating/design`'s (`ThemePreference`, `resolveThemeName`); this module adds only the cookie
 * round-trip and the DOM application. The DOM contract comes from the design package's emitted
 * CSS:
 *
 * - **`data-mode` absent means "follow the OS"** — the token sheet carries a
 *   `prefers-color-scheme` block scoped to `:root:not([data-mode])`, so `system` is expressed by
 *   *removing* the attribute, never by writing a third value.
 * - **`data-mode="light" | "dark"`** states an override and wins over the media query.
 * - The **`.dark` class stays in sync with the resolved mode** until the last old `/admin` page
 *   retires (on the console's own pages too, so a hop to an old page never paints the wrong mode):
 *   the pre-B01 Tailwind styles and Clerk's appearance switch key off it, and they have no
 *   media-query fallback — which is why `system` still needs the init script below even though
 *   the token sheet would handle it alone.
 *
 * First paint is kept honest by {@link THEME_INIT_SCRIPT}, a blocking inline script the
 * ThemeProvider renders *before* any content (the next-themes mechanism): it reads the cookie and
 * sets both `data-mode` and `.dark` before the browser paints, so there is no flash in any mode
 * and no dependence on a server cookie API.
 */

export const THEME_COOKIE = 'gli-theme';

/** One year. The preference is harmless to keep and annoying to lose. */
const THEME_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

/**
 * Reads the preference out of a `document.cookie`-shaped string. Tolerant of surrounding cookies
 * and whitespace; a missing or mangled cookie is `system`, the default.
 */
export function readThemePreferenceFromCookie(cookies: string): ThemePreference {
  const value = cookies.match(new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=([^;]*)`))?.[1];
  return isThemePreference(value) ? value : 'system';
}

/**
 * The `document.cookie` assignment string for a preference. `system` is the default, so choosing
 * it *deletes* the cookie rather than storing a third value — an absent cookie and "system" must
 * stay indistinguishable or the two drift.
 */
export function themeCookieString(preference: ThemePreference): string {
  if (preference === 'system') return `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
  return `${THEME_COOKIE}=${preference}; path=/; max-age=${THEME_COOKIE_MAX_AGE_S}; samesite=lax`;
}

/**
 * Applies a preference to the root element: `data-mode` stated only when overriding (see module
 * doc), `.dark` always stating the resolved theme for the legacy consumers.
 */
export function applyThemePreference(
  preference: ThemePreference,
  resolved: ThemeName,
  root: HTMLElement,
): void {
  if (preference === 'system') root.removeAttribute('data-mode');
  else root.setAttribute('data-mode', preference);
  root.classList.toggle('dark', resolved === 'dark');
}

/**
 * The before-paint initializer. A constant with no interpolation on purpose: nothing
 * user-controlled can reach the markup, and the cookie value is only ever compared against the
 * two literals. Wrapped in try/catch because a theme must never be the thing that crashes the
 * page (cookies can be disabled; `matchMedia` is absent in some embedders).
 *
 * It also states the surface: `data-surface="admin"` on the console's own pages, removed on the
 * old admin pages still standing (they don't read the tokens, and absent keeps their look), and
 * `skater` everywhere else. Each shell re-states its own after hydration. The old pages' list is a
 * copy of `OLD_SHELL_TREES` (`components/admin/shell/consoleNav.ts`) — a string constant can't
 * import it — and `oldShellPredicate.test.tsx` fails if the two disagree; when a mode lands, both
 * narrow together.
 */
export const THEME_INIT_SCRIPT = `(function () {
  try {
    var match = document.cookie.match(/(?:^|;\\s*)gli-theme=(dark|light)(?:;|$)/);
    var root = document.documentElement;
    if (match) root.setAttribute('data-mode', match[1]);
    else root.removeAttribute('data-mode');
    var dark = match
      ? match[1] === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', dark);
    var path = location.pathname;
    var under = function (tree) { return path === tree || path.indexOf(tree + '/') === 0; };
    var oldTrees = ['/admin/flags', '/admin/users', '/admin/water', '/admin/features',
      '/admin/recurrence', '/admin/ice-calibration', '/admin/seasons', '/admin/support',
      '/admin/tuning', '/admin/imports'];
    var old = false;
    for (var i = 0; i < oldTrees.length; i++) if (under(oldTrees[i])) old = true;
    if (!under('/admin')) root.setAttribute('data-surface', 'skater');
    else if (old) root.removeAttribute('data-surface');
    else root.setAttribute('data-surface', 'admin');
  } catch (e) {}
})();`;
