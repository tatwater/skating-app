import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS_SECTION,
  homeSearchSchema,
  isSettingsSection,
  SETTINGS_SECTIONS,
  settingsSectionSchema,
  visibleSections,
} from './sections';

describe('settings sections', () => {
  it('lists the eight sections in the board order, account first', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toEqual([
      'account',
      'profile',
      'home',
      'notifications',
      'reporting',
      'blocked',
      'support',
      'data',
    ]);
    expect(DEFAULT_SETTINGS_SECTION).toBe('account');
  });

  it('validates the path segment', () => {
    expect(isSettingsSection('home')).toBe(true);
    expect(isSettingsSection('billing')).toBe(false);
    expect(settingsSectionSchema.safeParse('data').success).toBe(true);
  });

  it('drops the profile section while a deletion is pending', () => {
    expect(visibleSections(false)).toHaveLength(8);
    expect(visibleSections(true).map((s) => s.key)).not.toContain('profile');
  });

  it('reads the home views and degrades a bad value to the summary', () => {
    expect(homeSearchSchema.parse({ edit: true })).toEqual({ edit: true });
    expect(homeSearchSchema.parse({ travel: true })).toEqual({ travel: true });
    expect(homeSearchSchema.parse({ edit: 'yes', travel: 3 })).toEqual({
      edit: undefined,
      travel: undefined,
    });
  });
});
