import { describe, expect, it } from 'vitest';
import { contrastRatio, WCAG_AA_LARGE, WCAG_AA_NORMAL } from './contrast';
import {
  dark,
  isThemePreference,
  light,
  nextThemePreference,
  resolveThemeName,
  type SemanticColorToken,
  THEME_NAMES,
  THEME_PREFERENCES,
  type Theme,
  themes,
} from './themes';

const HEX = /^#[0-9a-fA-F]{6}$/;

// Surfaces anything can render on top of. Body text and graphical tokens are swept
// against ALL of these, so a token that only passes on the page backdrop can't slip
// through by never being tested on a card.
const BACKGROUND_TOKENS = ['background', 'surface', 'surfaceMuted'] as const;

// Body-text / icon tokens: legible on any surface at AA normal (4.5:1).
const BODY_TEXT_TOKENS = ['foreground', 'foregroundMuted'] as const;

// Non-text tokens that carry meaning: the focus ring and the load-bearing border must
// hold the graphical-object minimum (3:1, WCAG 1.4.11) on any surface they sit on.
const GRAPHICAL_TOKENS = ['ring', 'borderStrong'] as const;

// Intentionally exempt: `border` is a decorative divider, never a control's sole
// boundary (that's `borderStrong`), so WCAG 1.4.11 doesn't apply (D34).
const EXEMPT_TOKENS = ['border'] as const;

/**
 * `*Foreground` tokens paired with the fill they sit on, derived from the theme's own
 * keys (`primaryForeground` → `primary`). Deriving — rather than hand-listing — means a
 * newly added `xForeground` token is contrast-tested automatically; it can't be
 * forgotten. Body-text `foreground`/`foregroundMuted` are lowercase and excluded here.
 */
function foregroundPairs(theme: Theme): Array<[string, string]> {
  return Object.keys(theme)
    .filter((key) => /[a-z]Foreground$/.test(key))
    .map((fg) => [fg, fg.replace(/Foreground$/, '')] as [string, string]);
}

describe('theme structure', () => {
  it('exposes exactly the named themes', () => {
    expect(Object.keys(themes).sort()).toEqual([...THEME_NAMES].sort());
  });

  it('keeps light and dark in perfect key parity', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('resolves every token to a 6-digit hex string', () => {
    for (const theme of Object.values(themes)) {
      for (const [token, value] of Object.entries(theme)) {
        expect(value, token).toMatch(HEX);
      }
    }
  });

  it('categorizes every token so none escapes the contrast sweep', () => {
    // If you add a token, it must fall into a tested category (background, body text,
    // graphical, a `*Foreground`/its fill) or be explicitly exempt — else this fails.
    const covered = new Set<string>([
      ...BACKGROUND_TOKENS,
      ...BODY_TEXT_TOKENS,
      ...GRAPHICAL_TOKENS,
      ...EXEMPT_TOKENS,
      ...foregroundPairs(light).flat(),
    ]);
    const uncovered = (Object.keys(light) as SemanticColorToken[]).filter((t) => !covered.has(t));
    expect(uncovered, `uncategorized token(s): ${uncovered.join(', ')}`).toEqual([]);
  });
});

describe.each(THEME_NAMES)('%s theme contrast (D34)', (name) => {
  const theme = themes[name];

  it.each(
    BODY_TEXT_TOKENS.flatMap((fg) => BACKGROUND_TOKENS.map((bg) => [fg, bg] as const)),
  )('body text %s on %s meets WCAG AA normal (4.5:1)', (fg, bg) => {
    expect(contrastRatio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it.each(
    foregroundPairs(theme),
  )('foreground %s on its fill %s meets WCAG AA normal (4.5:1)', (fg, fill) => {
    expect(
      contrastRatio(theme[fg as SemanticColorToken], theme[fill as SemanticColorToken]),
    ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it.each(
    GRAPHICAL_TOKENS.flatMap((fg) => BACKGROUND_TOKENS.map((bg) => [fg, bg] as const)),
  )('graphical %s on %s meets WCAG non-text (3:1)', (fg, bg) => {
    expect(contrastRatio(theme[fg], theme[bg])).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
  });
});

describe('theme preference resolution (D34 amendment)', () => {
  it('offers system plus every concrete theme, with system first', () => {
    // Order is the render order of the mobile picker, and `system` leads because it's the default.
    expect(THEME_PREFERENCES).toEqual(['system', ...THEME_NAMES]);
  });

  it('accepts exactly the three preference strings', () => {
    for (const preference of THEME_PREFERENCES) expect(isThemePreference(preference)).toBe(true);
    // `'auto'` is the near-miss worth pinning: it's the other obvious name for the same idea, and
    // the two surfaces silently disagreeing on which one they store is the drift this guards.
    for (const notAPreference of ['auto', 'Dark', '', 'system ', null, undefined, 0, {}]) {
      expect(isThemePreference(notAPreference)).toBe(false);
    }
  });

  it('lets an explicit choice outrank the OS in both directions', () => {
    expect(resolveThemeName('light', 'dark')).toBe('light');
    expect(resolveThemeName('dark', 'light')).toBe('dark');
  });

  it('follows the OS while the preference is system', () => {
    expect(resolveThemeName('system', 'dark')).toBe('dark');
    expect(resolveThemeName('system', 'light')).toBe('light');
  });

  it('treats an unknown OS scheme as light rather than stalling', () => {
    // `useColorScheme()` is null before the OS answers, as is jsdom with no `matchMedia`.
    expect(resolveThemeName('system', null)).toBe('light');
    expect(resolveThemeName('system', undefined)).toBe('light');
  });

  it('ignores the OS entirely once overridden, even when unknown', () => {
    expect(resolveThemeName('dark', null)).toBe('dark');
    expect(resolveThemeName('light', undefined)).toBe('light');
  });

  it('cycles system → light → dark → system without stranding anyone', () => {
    // The wrap-around is the point: web's old two-state toggle could reach `dark` and never return
    // to `system`, so a user who tried dark once lost "follow my OS" permanently.
    expect(nextThemePreference('system')).toBe('light');
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
  });

  it('reaches every preference from every starting point', () => {
    for (const start of THEME_PREFERENCES) {
      const seen = new Set([start]);
      let at = start;
      for (let i = 0; i < THEME_PREFERENCES.length - 1; i++) {
        at = nextThemePreference(at);
        seen.add(at);
      }
      expect(seen.size).toBe(THEME_PREFERENCES.length);
      // …and one more step returns to where it started.
      expect(nextThemePreference(at)).toBe(start);
    }
  });

  it('resolves to a theme that actually exists in the config', () => {
    // Guards the Tamagui/Tailwind handoff: the resolved name is used as a theme *key*, so a name
    // with no matching entry would render an unstyled tree rather than fail loudly.
    for (const preference of THEME_PREFERENCES) {
      for (const scheme of ['light', 'dark', null] as const) {
        expect(themes[resolveThemeName(preference, scheme)]).toBeDefined();
      }
    }
  });
});
