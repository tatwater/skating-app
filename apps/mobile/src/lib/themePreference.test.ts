import { THEME_PREFERENCES } from '@skating/design';
import { describe, expect, it } from 'vitest';
import { FEED_FILTERS_KEY } from './feedFilters';
import {
  DEFAULT_THEME_PREFERENCE,
  parseThemePreference,
  THEME_PREFERENCE_KEY,
  THEME_PREFERENCE_LABELS,
} from './themePreference';

// Resolution itself (`resolveThemeName`, the cycle, the type guard) is covered in `@skating/design`
// where it lives. This file covers only what mobile adds on top: the storage contract.

describe('parseThemePreference', () => {
  it('round-trips every preference the picker can produce', () => {
    for (const preference of THEME_PREFERENCES) {
      expect(parseThemePreference(preference)).toBe(preference);
    }
  });

  it('defaults to following the OS when nothing is stored', () => {
    expect(parseThemePreference(undefined)).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
    expect(DEFAULT_THEME_PREFERENCE).toBe('system');
  });

  it('degrades unrecognized stored values rather than throwing', () => {
    // A row written by an older build, a partial write, or a hand-edited database. A theme is
    // cosmetic — none of these is worth failing a launch over.
    for (const junk of ['auto', '', 'Dark', 'system ', '{"theme":"dark"}']) {
      expect(parseThemePreference(junk)).toBe('system');
    }
  });
});

describe('storage contract', () => {
  it('shares the prefs table with the feed filters without colliding', () => {
    // Both live in the one `prefs` table in `skating-prefs.db`, keyed by string. A collision would
    // have one setting silently overwrite the other, so assert against the *other key itself* —
    // pinning the literal alone would stay green if `FEED_FILTERS_KEY` were ever renamed onto it.
    expect(THEME_PREFERENCE_KEY).not.toBe(FEED_FILTERS_KEY);
    // …and the literal matters on its own: it's deliberately the string `next-themes` writes to
    // `localStorage` on web, so a future preference sync has one name to carry.
    expect(THEME_PREFERENCE_KEY).toBe('theme');
  });

  it('labels every preference the picker renders', () => {
    for (const preference of THEME_PREFERENCES) {
      expect(THEME_PREFERENCE_LABELS[preference]).toBeTruthy();
    }
  });
});
