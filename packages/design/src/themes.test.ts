import { describe, expect, it } from 'vitest';
import { contrastRatio, WCAG_AA_LARGE, WCAG_AA_NORMAL } from './contrast';
import { dark, light, type SemanticColorToken, THEME_NAMES, type Theme, themes } from './themes';

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
