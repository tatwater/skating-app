import { describe, expect, it } from 'vitest';
import {
  applyThemePreference,
  readThemePreferenceFromCookie,
  THEME_COOKIE,
  THEME_INIT_SCRIPT,
  themeCookieString,
} from './theme';

describe('readThemePreferenceFromCookie', () => {
  it('reads an override out of a cookie string', () => {
    expect(readThemePreferenceFromCookie('gli-theme=dark')).toBe('dark');
    expect(readThemePreferenceFromCookie('gli-theme=light')).toBe('light');
  });

  it('finds the cookie among others', () => {
    expect(readThemePreferenceFromCookie('a=b; gli-theme=dark; c=d')).toBe('dark');
    expect(readThemePreferenceFromCookie('a=b;gli-theme=light')).toBe('light');
  });

  it('is system when the cookie is absent, empty, or mangled', () => {
    expect(readThemePreferenceFromCookie('')).toBe('system');
    expect(readThemePreferenceFromCookie('a=b; c=d')).toBe('system');
    expect(readThemePreferenceFromCookie('gli-theme=')).toBe('system');
    expect(readThemePreferenceFromCookie('gli-theme=purple')).toBe('system');
    // `system` is expressed by deleting the cookie, so a literal 'system' value is also tolerated.
    expect(readThemePreferenceFromCookie('gli-theme=system')).toBe('system');
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(readThemePreferenceFromCookie('xgli-theme=dark')).toBe('system');
  });
});

describe('themeCookieString', () => {
  it('stores an override for a year, scoped to the site', () => {
    const value = themeCookieString('dark');
    expect(value).toContain(`${THEME_COOKIE}=dark`);
    expect(value).toContain('path=/');
    expect(value).toContain(`max-age=${60 * 60 * 24 * 365}`);
    expect(value).toContain('samesite=lax');
  });

  it('deletes the cookie for system — absent and "system" must stay indistinguishable', () => {
    const value = themeCookieString('system');
    expect(value).toContain(`${THEME_COOKIE}=;`);
    expect(value).toContain('max-age=0');
  });

  it('round-trips through the reader', () => {
    // document.cookie assignment keeps only the name=value pair when read back.
    const pair = (s: string) => s.split(';')[0] ?? '';
    expect(readThemePreferenceFromCookie(pair(themeCookieString('dark')))).toBe('dark');
    expect(readThemePreferenceFromCookie(pair(themeCookieString('light')))).toBe('light');
    expect(readThemePreferenceFromCookie(pair(themeCookieString('system')))).toBe('system');
  });
});

describe('applyThemePreference', () => {
  const root = () => document.createElement('html');

  it('states data-mode only for an override', () => {
    const el = root();
    applyThemePreference('dark', 'dark', el);
    expect(el.getAttribute('data-mode')).toBe('dark');
    expect(el.classList.contains('dark')).toBe(true);

    applyThemePreference('light', 'light', el);
    expect(el.getAttribute('data-mode')).toBe('light');
    expect(el.classList.contains('dark')).toBe(false);
  });

  it('removes data-mode for system — the token sheet follows the OS when the attribute is absent', () => {
    const el = root();
    applyThemePreference('dark', 'dark', el);
    applyThemePreference('system', 'dark', el);
    expect(el.hasAttribute('data-mode')).toBe(false);
    // The legacy `.dark` class still states the *resolved* theme: it has no media-query fallback.
    expect(el.classList.contains('dark')).toBe(true);

    applyThemePreference('system', 'light', el);
    expect(el.classList.contains('dark')).toBe(false);
  });
});

describe('THEME_INIT_SCRIPT', () => {
  const run = (cookie: string, prefersDark: boolean) => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the init script reads document.cookie
    document.cookie = `${THEME_COOKIE}=; max-age=0`; // reset between cases
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the init script reads document.cookie
    if (cookie) document.cookie = cookie;
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      // biome-ignore lint/security/noGlobalEval: executing our own constant is the test's point
      eval(THEME_INIT_SCRIPT);
    } finally {
      window.matchMedia = original;
    }
    return document.documentElement;
  };

  it('applies a stored override before paint', () => {
    const el = run(`${THEME_COOKIE}=dark`, false);
    expect(el.getAttribute('data-mode')).toBe('dark');
    expect(el.classList.contains('dark')).toBe(true);
  });

  it('follows the OS when no override is stored', () => {
    const el = run('', true);
    expect(el.hasAttribute('data-mode')).toBe(false);
    expect(el.classList.contains('dark')).toBe(true);
  });

  it('clears a stale state when the override is light', () => {
    const el = run(`${THEME_COOKIE}=light`, true);
    expect(el.getAttribute('data-mode')).toBe('light');
    expect(el.classList.contains('dark')).toBe(false);
  });

  describe('the surface', () => {
    const at = (path: string) => {
      const before = window.location.pathname;
      window.history.replaceState(null, '', path);
      try {
        return run('', false);
      } finally {
        window.history.replaceState(null, '', before);
      }
    };

    it('states the skater surface on a skater path', () => {
      document.documentElement.removeAttribute('data-surface');
      expect(at('/lakes/abc').getAttribute('data-surface')).toBe('skater');
    });

    it.each(['/admin/flags', '/admin/water/review'])(
      'leaves the attribute absent on an old admin page (%s)',
      (path) => {
        document.documentElement.setAttribute('data-surface', 'skater');
        expect(at(path).hasAttribute('data-surface')).toBe(false);
      },
    );

    // The full table, against the console's own predicate, is `oldShellPredicate.test.tsx`'s.
    it.each(['/admin', '/admin/inbox'])('states the console surface on %s', (path) => {
      document.documentElement.removeAttribute('data-surface');
      expect(at(path).getAttribute('data-surface')).toBe('admin');
    });

    it('treats a path that only starts with "admin" as a skater path', () => {
      expect(at('/administer').getAttribute('data-surface')).toBe('skater');
    });
  });

  it('names the same cookie the runtime reads', () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_COOKIE);
  });
});
